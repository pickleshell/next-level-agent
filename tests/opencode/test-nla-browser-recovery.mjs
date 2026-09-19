import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { beginBrowserRecovery, browserRequirementHash, canonicalBrowserContract, claimBrowserRecoveryTask, createBrowserRecovery, listBrowserRecoveries, loadBrowserRecovery, recoveryEvidence, releaseBrowserRecoveryTask, validateBrowserRecovery } from '../../.opencode/plugins/nla-browser-recovery.mjs';

const owner = 'primary_123';
const task = {
  goal: 'Complete A then B', origins: ['https://example.test'],
  permissions: { navigation: true, interaction: false, authentication: false, uploads: false, downloads: false, external_mutation: false },
  success_criteria: [
    { id: 'A', check: 'text_equals', locator: { test_id: 'a' }, expected: 'done', mandatory: true },
    { id: 'B', check: 'text_equals', locator: { test_id: 'b' }, expected: 'pending', mandatory: true },
  ],
};
const blocked = fn => assert.throws(fn, error => error.code === 'NLA_BROWSER_RECOVERY_BLOCKED');
const fixture = async fn => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-recovery-'));
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
function run(root, id, contract = task, statuses = ['PASS', 'NOT_RUN'], result = 'NOT_RUN', child = `child-${id}`, reason = null) {
  const session = { run_id: `run-${id}`, id: `browser-${id}`, child, revision: { head: 'abc' } };
  const checks = contract.success_criteria.map((c, i) => ({ id: c.id, status: statuses[i], mandatory: c.mandatory !== false }));
  const evidence = path.join(root, `evidence-${id}.json`);
  fs.writeFileSync(evidence, JSON.stringify({ run_id: session.run_id, task_id: child, session_id: session.id, revision: session.revision, result, reason, checks }));
  return { session, checks, result: { metadata: { evidence, browser_result: result } } };
}
function save(root, record, attempt, contract = task, original = task, token) {
  return createBrowserRecovery(root, owner, contract, attempt.session, attempt.result, attempt.checks, original, record.task_id, token);
}

// Subprocess barrier makes first initialization and read-modify-write races real.
if (process.argv[2] === 'claim-worker') {
  let held;
  process.on('message', message => {
    try {
      if (message.operation === 'claim') {
        const { root, taskID } = message;
        held = { root, taskID, ...claimBrowserRecoveryTask(root, owner, taskID) };
        // The test parent never needs the token; only the claiming process has it.
        process.send({ status: 'claimed', pending: held.record.pending_criteria });
      } else if (message.operation === 'release') {
        releaseBrowserRecoveryTask(held.root, owner, held.taskID, held.token);
        held = null;
        process.send({ status: 'released' });
      } else if (message.operation === 'exit') process.disconnect();
    } catch (error) { process.send({ status: 'blocked', code: error.code }); }
  });
  process.send({ status: 'ready' });
} else if (process.argv[2] === 'worker') {
  process.send('ready');
  process.once('message', ({ root, worker, taskID }) => {
    try {
      for (let i = 0; i < 3; i++) {
        const record = taskID ? validateBrowserRecovery(root, owner, taskID) : beginBrowserRecovery(root, owner, task);
        save(root, record, run(root, `worker-${worker}-${i}`, task, ['FAIL', 'NOT_RUN'], 'FAIL'));
      }
      process.send('done');
      process.disconnect();
    } catch (error) { console.error(error); process.exit(1); }
  });
} else {
  test('explicit tasks isolate sequential identical/different contracts and reused criterion IDs', () => fixture(root => {
    const a = beginBrowserRecovery(root, owner, task);
    save(root, a, run(root, 'first', task, ['PASS', 'PASS'], 'PASS'));
    const bContract = { ...task, goal: 'Independent task B' };
    const b = beginBrowserRecovery(root, owner, bContract);
    const repeated = beginBrowserRecovery(root, owner, task);
    assert.equal(new Set([a.task_id, b.task_id, repeated.task_id]).size, 3);
    assert.deepEqual(b.pending_criteria, ['A', 'B']);
    assert.deepEqual(repeated.evidence, []);
    assert.deepEqual(validateBrowserRecovery(root, owner, a.task_id).pending_criteria, []);
    assert.equal(validateBrowserRecovery(root, owner).tasks.length, 3);
    blocked(() => beginBrowserRecovery(root, owner, bContract, a.task_id));
    blocked(() => beginBrowserRecovery(root, 'other_123', task, a.task_id));
    blocked(() => beginBrowserRecovery(root, owner, task, 'unknown-id'));
    const attemptedSubstitution = run(root, 'first', task, ['PASS', 'PASS'], 'PASS');
    blocked(() => save(root, repeated, attemptedSubstitution));
    assert.deepEqual(validateBrowserRecovery(root, owner, repeated.task_id).evidence, []);
    const ambiguous = run(root, 'ambiguous', task, ['FAIL', 'FAIL'], 'FAIL');
    blocked(() => createBrowserRecovery(root, owner, task, ambiguous.session, ambiguous.result, ambiguous.checks));
  }));

  test('canonical definitions and full policy survive restart, including optional criteria', () => fixture(root => {
    const contract = { ...task, success_criteria: [...task.success_criteria, { ...task.success_criteria[0], id: 'optional', mandatory: false }], upload_files: ['/tmp/granted'] };
    const record = beginBrowserRecovery(root, owner, contract);
    assert.deepEqual(record.contract, canonicalBrowserContract(contract));
    assert.equal(beginBrowserRecovery(root, owner, record.contract, record.task_id).task_id, record.task_id);
    assert.deepEqual(loadBrowserRecovery(root, owner, record.task_id).contract, record.contract);
    for (const changed of [
      { ...contract, origins: ['https://other.test'] },
      { ...contract, permissions: { ...contract.permissions, external_mutation: true } },
      { ...contract, upload_files: [] },
      { ...contract, success_criteria: contract.success_criteria.slice(0, 2) },
      { ...contract, success_criteria: contract.success_criteria.map(c => ({ ...c, expected: 'changed' })) },
    ]) {
      assert.notEqual(browserRequirementHash(contract), browserRequirementHash(changed));
      blocked(() => beginBrowserRecovery(root, owner, changed, record.task_id));
    }
  }));

  test('every negative outcome, cancellation, and mixed partial run survives fresh module import', () => fixture(async root => {
    const record = beginBrowserRecovery(root, owner, task);
    for (const [id, statuses, result, reason] of [
      ['fail', ['FAIL', 'NOT_RUN'], 'FAIL', null],
      ['blocked', ['BLOCKED', 'NOT_RUN'], 'BLOCKED', 'POLICY_DENIED'],
      ['not-run', ['NOT_RUN', 'NOT_RUN'], 'NOT_RUN', null],
      ['cancel', ['NOT_RUN', 'NOT_RUN'], 'BLOCKED', 'CANCELLED'],
      ['partial', ['PASS', 'FAIL'], 'FAIL', null],
    ]) save(root, record, run(root, id, task, statuses, result, `child-${id}`, reason));
    const restarted = await import(`../../.opencode/plugins/nla-browser-recovery.mjs?restart=${Date.now()}`);
    const restored = restarted.validateBrowserRecovery(root, owner, record.task_id);
    assert.deepEqual(restored.pending_criteria, ['B']);
    assert.equal(restored.criteria[0].completed_run_id, 'run-partial');
    assert.deepEqual(restarted.recoveryEvidence(root, owner).map(e => e.result), ['FAIL', 'BLOCKED', 'NOT_RUN', 'BLOCKED', 'FAIL']);
    assert.equal(restored.attempts[3].reason, 'CANCELLED');
    const continuation = { ...restored.contract, success_criteria: restored.contract.success_criteria.filter(c => restored.pending_criteria.includes(c.id)) };
    const finished = save(root, restored, run(root, 'finish', continuation, ['PASS'], 'PASS'), continuation);
    assert.deepEqual(finished.pending_criteria, []);
    assert.equal(finished.criteria[0].completed_run_id, 'run-partial');
    assert.equal(recoveryEvidence(root, owner).length, 6);
    blocked(() => save(root, record, run(root, 'replay', task, ['PASS', 'PASS'], 'PASS')));
    assert.equal(recoveryEvidence(root, owner).length, 6);
  }));

  test('optional-only contracts retain checks without assuming a mandatory criterion', () => fixture(root => {
    const optional = { ...task, success_criteria: task.success_criteria.map(c => ({ ...c, mandatory: false })) };
    const record = beginBrowserRecovery(root, owner, optional);
    assert.deepEqual(record.pending_criteria, ['A', 'B']);
    const completed = save(root, record, run(root, 'optional', optional, ['PASS', 'PASS'], 'NOT_RUN'), optional, optional);
    assert.equal(completed.next_pending, null);
    assert.equal(completed.evidence[0].result, 'NOT_RUN');
    assert.ok(completed.criteria.every(c => c.mandatory === false));
    blocked(() => beginBrowserRecovery(root, owner, { ...task, success_criteria: [] }));
  }));

  test('interruption is durable and same-task duplicate attempts reject before effects', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const interrupted = run(root, 'interrupted', task, ['NOT_RUN', 'NOT_RUN'], 'BLOCKED', null, 'INTERRUPTED');
    const { token } = claimBrowserRecoveryTask(root, owner, record.task_id);
    assert.equal(validateBrowserRecovery(root, owner, record.task_id).execution_state, 'UNKNOWN');
    assert.deepEqual(recoveryEvidence(root, owner), []);
    blocked(() => claimBrowserRecoveryTask(root, owner, record.task_id));
    const other = beginBrowserRecovery(root, owner, task);
    claimBrowserRecoveryTask(root, owner, other.task_id);
    save(root, record, interrupted, task, task, token);
    const next = run(root, 'retry', task, ['PASS', 'FAIL'], 'FAIL');
    const { token: nextToken } = claimBrowserRecoveryTask(root, owner, record.task_id);
    save(root, record, next, task, task, nextToken);
    const restored = validateBrowserRecovery(root, owner, record.task_id);
    assert.deepEqual(restored.attempts.map(a => a.result), ['BLOCKED', 'FAIL']);
    assert.equal(restored.attempts[0].child_id, null);
    assert.deepEqual(restored.pending_criteria, ['B']);
  }));

  test('no PASS facts without child provenance; keep-session captured child remains valid', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    blocked(() => save(root, record, run(root, 'no-child', task, ['PASS', 'NOT_RUN'], 'BLOCKED', null)));
    blocked(() => save(root, record, run(root, 'no-child-result', task, ['NOT_RUN', 'NOT_RUN'], 'PASS', null)));
    save(root, record, run(root, 'preparation-failed', task, ['NOT_RUN', 'NOT_RUN'], 'BLOCKED', null));
    const final = run(root, 'keep', task, ['PASS', 'PASS'], 'PASS', 'captured-child');
    assert.deepEqual(save(root, record, final).pending_criteria, []);
    assert.equal(recoveryEvidence(root, owner)[1].provenance.child_id, 'captured-child');
  }));

  test('mismatched manifest identities/checks/policy reject without writing state', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const index = path.join(root, 'browser-recovery', 'index.json');
    const before = fs.readFileSync(index);
    for (const field of ['run_id', 'session_id', 'task_id', 'result']) {
      const attempt = run(root, `wrong-${field}`, task, ['FAIL', 'FAIL'], 'FAIL');
      const manifest = JSON.parse(fs.readFileSync(attempt.result.metadata.evidence));
      manifest[field] = 'different';
      fs.writeFileSync(attempt.result.metadata.evidence, JSON.stringify(manifest));
      blocked(() => save(root, record, attempt));
      assert.deepEqual(fs.readFileSync(index), before);
    }
    const attempt = run(root, 'checks', task, ['FAIL', 'FAIL'], 'FAIL');
    blocked(() => save(root, record, { ...attempt, checks: [{ id: 'A', status: 'PASS' }, { id: 'B', status: 'FAIL' }] }));
    blocked(() => save(root, record, attempt, { ...task, permissions: { ...task.permissions, uploads: true } }));
    assert.deepEqual(fs.readFileSync(index), before);
  }));

  for (const target of ['index.json', 'authentication.key', '../.browser-recovery.required']) {
    for (const damage of ['missing', 'corrupt']) {
      test(`${damage} ${target} fails closed for readers and writers without key regeneration`, () => fixture(root => {
        const record = beginBrowserRecovery(root, owner, task);
        save(root, record, run(root, 'auth', task, ['FAIL', 'NOT_RUN'], 'FAIL'));
        const file = path.resolve(root, 'browser-recovery', target);
        if (damage === 'missing') fs.unlinkSync(file); else fs.writeFileSync(file, 'corrupt');
        const keyFile = path.join(root, 'browser-recovery', 'authentication.key');
        const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null;
        blocked(() => validateBrowserRecovery(root, owner));
        blocked(() => loadBrowserRecovery(root, owner));
        blocked(() => recoveryEvidence(root, owner));
        blocked(() => beginBrowserRecovery(root, owner, task));
        blocked(() => save(root, record, run(root, 'after-damage', task, ['FAIL', 'FAIL'], 'FAIL')));
        assert.deepEqual(fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null, key);
      }));
    }
  }

  test('tampered signed data is never laundered by a valid subsequent update', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    save(root, record, run(root, 'original', task, ['PASS', 'FAIL'], 'FAIL'));
    const index = path.join(root, 'browser-recovery', 'index.json');
    const bytes = fs.readFileSync(index);
    for (const mutate of [
      r => { r.records[0].policy.permissions.external_mutation = true; },
      r => { r.records[0].criteria[0].status = 'pending'; },
      r => { r.records[0].attempts[0].run_id = 'forged'; },
      r => { r.records[0].evidence = []; },
      r => { r.records = []; },
    ]) {
      const broken = JSON.parse(bytes); mutate(broken);
      fs.writeFileSync(index, JSON.stringify(broken));
      const damaged = fs.readFileSync(index);
      blocked(() => beginBrowserRecovery(root, owner, task));
      blocked(() => validateBrowserRecovery(root, owner));
      assert.deepEqual(fs.readFileSync(index), damaged);
    }
  }));

  test('manifest mutation/deletion invalidates negative evidence too', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const attempt = run(root, 'negative', task, ['FAIL', 'NOT_RUN'], 'FAIL');
    save(root, record, attempt);
    fs.writeFileSync(attempt.result.metadata.evidence, '{}');
    blocked(() => recoveryEvidence(root, owner));
    blocked(() => beginBrowserRecovery(root, owner, task));
    fs.unlinkSync(attempt.result.metadata.evidence);
    blocked(() => validateBrowserRecovery(root, owner));
  }));

  test('independent witness and expectedKnown detect whole-store and total loss', () => fixture(root => {
    assert.equal(validateBrowserRecovery(root, owner), null);
    blocked(() => validateBrowserRecovery(root, owner, true));
    const record = beginBrowserRecovery(root, owner, task);
    blocked(() => validateBrowserRecovery(root, owner, { taskIds: ['missing-task'] }));
    assert.equal(listBrowserRecoveries(root, owner, { taskIds: [record.task_id] }).length, 1);
    fs.rmSync(path.join(root, 'browser-recovery'), { recursive: true });
    blocked(() => validateBrowserRecovery(root, owner));
    blocked(() => beginBrowserRecovery(root, owner, task));
    fs.unlinkSync(path.join(root, '.browser-recovery.required'));
    blocked(() => validateBrowserRecovery(root, owner, { expectedKnown: true }));
    blocked(() => validateBrowserRecovery(root, owner, record.task_id));
  }));

  test('legacy storage lacking canonical contracts blocks without migration or replacement', () => fixture(root => {
    const directory = path.join(root, 'browser-recovery');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, `${owner}.json`), JSON.stringify({ version: 1 }));
    blocked(() => beginBrowserRecovery(root, owner, task));
    assert.equal(fs.existsSync(path.join(directory, 'authentication.key')), false);
  }));

  test('safe legacy single-task call shapes retain authenticated read support', () => fixture(root => {
    const attempt = run(root, 'legacy', task, ['FAIL', 'FAIL'], 'FAIL');
    const record = createBrowserRecovery(root, owner, task, attempt.session, attempt.result, attempt.checks);
    assert.equal(loadBrowserRecovery(root, owner).task_id, record.task_id);
    assert.deepEqual(validateBrowserRecovery(root, owner).pending_criteria, ['A', 'B']);
    assert.equal(recoveryEvidence(root, owner).length, 1);
  }));

  test('claims require exact owner/task/token and never expose claim secrets', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const other = beginBrowserRecovery(root, owner, task);
    blocked(() => claimBrowserRecoveryTask(root, owner));
    blocked(() => claimBrowserRecoveryTask(root, 'other_123', record.task_id));
    blocked(() => claimBrowserRecoveryTask(root, owner, 'missing-task'));
    const { token, record: acquired } = claimBrowserRecoveryTask(root, owner, record.task_id);
    const { token: otherToken } = claimBrowserRecoveryTask(root, owner, other.task_id);
    const file = path.join(root, 'browser-recovery', 'index.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(before.includes(token), false, 'raw token must not be persisted');
    const claimHash = JSON.parse(before).records[0].execution_claim;
    for (const data of [acquired, validateBrowserRecovery(root, owner), validateBrowserRecovery(root, owner, record.task_id), listBrowserRecoveries(root, owner), loadBrowserRecovery(root, owner), recoveryEvidence(root, owner)]) {
      const visible = JSON.stringify(data);
      assert.equal(visible.includes(token), false);
      assert.equal(visible.includes(claimHash), false);
      assert.equal(visible.includes('execution_claim'), false);
    }
    assert.deepEqual(acquired.pending_criteria, ['A', 'B']);
    assert.equal(validateBrowserRecovery(root, owner, record.task_id).execution_state, 'UNKNOWN');
    for (const wrong of [undefined, '', 'wrong', '0'.repeat(64), otherToken]) blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, wrong));
    blocked(() => releaseBrowserRecoveryTask(root, 'other_123', record.task_id, token));
    blocked(() => releaseBrowserRecoveryTask(root, owner, other.task_id, token));
    blocked(() => claimBrowserRecoveryTask(root, owner, record.task_id));
    blocked(() => beginBrowserRecovery(root, owner, task, record.task_id));
    const attempt = run(root, 'without-claim', task, ['FAIL', 'FAIL'], 'FAIL');
    blocked(() => save(root, record, attempt));
    blocked(() => save(root, record, attempt, task, task, otherToken));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(releaseBrowserRecoveryTask(root, owner, record.task_id, token), true);
    blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, token));
    assert.equal(validateBrowserRecovery(root, owner, record.task_id).execution_state, 'IDLE');
    const replacement = claimBrowserRecoveryTask(root, owner, record.task_id);
    blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, token));
    blocked(() => save(root, record, attempt, task, task, token));
    releaseBrowserRecoveryTask(root, owner, record.task_id, replacement.token);
    blocked(() => save(root, record, attempt, task, task, replacement.token));
    releaseBrowserRecoveryTask(root, owner, other.task_id, otherToken);
  }));

  test('claim returns fresh pending criteria after stale pre-claim validation and partial completion', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const stale = beginBrowserRecovery(root, owner, task, record.task_id);
    const { token } = claimBrowserRecoveryTask(root, owner, record.task_id);
    const partial = save(root, record, run(root, 'claimed-partial', task, ['PASS', 'FAIL'], 'FAIL'), task, task, token);
    assert.equal(partial.execution_state, 'IDLE');
    assert.deepEqual(partial.pending_criteria, ['B']);
    assert.equal(JSON.stringify(partial).includes(token), false);
    blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, token));
    const { token: nextToken, record: resumed } = claimBrowserRecoveryTask(root, owner, stale.task_id);
    assert.deepEqual(stale.pending_criteria, ['A', 'B']);
    assert.deepEqual(resumed.pending_criteria, ['B']);
    const pending = { ...resumed.contract, success_criteria: resumed.contract.success_criteria.filter(c => resumed.pending_criteria.includes(c.id)) };
    save(root, resumed, run(root, 'claimed-complete', pending, ['PASS'], 'PASS'), pending, task, nextToken);
    blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, nextToken));
    assert.equal(recoveryEvidence(root, owner).length, 2);
    assert.deepEqual(validateBrowserRecovery(root, owner, record.task_id).pending_criteria, []);
    blocked(() => claimBrowserRecoveryTask(root, owner, record.task_id));
  }));

  test('claim acquisition/release authenticate storage and retain claims on write failure', () => fixture(root => {
    const record = beginBrowserRecovery(root, owner, task);
    const { token } = claimBrowserRecoveryTask(root, owner, record.task_id);
    const file = path.join(root, 'browser-recovery', 'index.json');
    const before = fs.readFileSync(file);
    const terminal = run(root, 'atomic-terminal', task, ['PASS', 'PASS'], 'PASS');
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = () => { throw Object.assign(new Error('fixture write failure'), { code: 'EIO' }); };
      blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, token));
      blocked(() => save(root, record, terminal, task, task, token));
    } finally { fs.renameSync = originalRename; }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(validateBrowserRecovery(root, owner, record.task_id).evidence, []);
    blocked(() => claimBrowserRecoveryTask(root, owner, record.task_id));
    const broken = JSON.parse(before); delete broken.records[0].execution_claim;
    fs.writeFileSync(file, JSON.stringify(broken));
    const damaged = fs.readFileSync(file);
    blocked(() => claimBrowserRecoveryTask(root, owner, record.task_id));
    blocked(() => releaseBrowserRecoveryTask(root, owner, record.task_id, token));
    assert.deepEqual(fs.readFileSync(file), damaged);
  }));

  async function claimWorker() {
    const child = fork(fileURLToPath(import.meta.url), ['claim-worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    assert.equal((await once(child, 'message'))[0].status, 'ready');
    return child;
  }
  async function ask(child, message) {
    const reply = once(child, 'message');
    child.send(message);
    return (await reply)[0];
  }
  async function stop(child, kill = false) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (kill) child.kill('SIGKILL'); else child.send({ operation: 'exit' });
    await exited;
  }
  test('competing processes grant exactly one task claim; only its holder releases it', { timeout: 15000 }, () => fixture(async root => {
    const record = beginBrowserRecovery(root, owner, task);
    const children = await Promise.all(Array.from({ length: 6 }, () => claimWorker()));
    try {
      const results = await Promise.all(children.map(child => ask(child, { operation: 'claim', root, taskID: record.task_id })));
      assert.equal(results.filter(r => r.status === 'claimed').length, 1);
      assert.ok(results.filter(r => r.status !== 'claimed').every(r => r.status === 'blocked' && r.code === 'NLA_BROWSER_RECOVERY_BLOCKED'));
      const winner = results.findIndex(r => r.status === 'claimed');
      assert.equal((await ask(children[winner], { operation: 'release' })).status, 'released');
      const next = children[(winner + 1) % children.length];
      assert.equal((await ask(next, { operation: 'claim', root, taskID: record.task_id })).status, 'claimed');
      assert.equal((await ask(next, { operation: 'release' })).status, 'released');
    } finally { await Promise.all(children.map(child => stop(child))); }
  }));

  test('killed claim owner leaves UNKNOWN across process recreation without blocking distinct work', { timeout: 15000 }, () => fixture(async root => {
    const record = beginBrowserRecovery(root, owner, task);
    const holder = await claimWorker();
    let restarted;
    try {
      assert.equal((await ask(holder, { operation: 'claim', root, taskID: record.task_id })).status, 'claimed');
      await stop(holder, true);
      restarted = await claimWorker();
      assert.equal((await ask(restarted, { operation: 'claim', root, taskID: record.task_id })).status, 'blocked');
      const restored = validateBrowserRecovery(root, owner, record.task_id);
      assert.equal(restored.execution_state, 'UNKNOWN');
      assert.deepEqual(restored.pending_criteria, ['A', 'B']);
      assert.deepEqual(restored.evidence, []);
      blocked(() => beginBrowserRecovery(root, owner, task, record.task_id));
      const distinct = beginBrowserRecovery(root, owner, { ...task, goal: 'Independent new workflow' });
      assert.equal((await ask(restarted, { operation: 'claim', root, taskID: distinct.task_id })).status, 'claimed');
      assert.equal((await ask(restarted, { operation: 'release' })).status, 'released');
      assert.equal(validateBrowserRecovery(root, owner, record.task_id).execution_state, 'UNKNOWN');
    } finally {
      await stop(holder, true);
      if (restarted) await stop(restarted);
    }
  }));

  async function concurrent(root, taskID) {
    const children = Array.from({ length: 6 }, (_, worker) => {
      const child = fork(fileURLToPath(import.meta.url), ['worker'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const ready = new Promise(resolve => child.once('message', resolve));
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `worker ${worker} exited ${code}`)));
      });
      return { child, ready, done, worker };
    });
    try {
      await Promise.all(children.map(c => c.ready));
      for (const c of children) c.child.send({ root, taskID, worker: c.worker });
      await Promise.all(children.map(c => c.done));
    } finally { for (const c of children) if (c.child.exitCode === null) c.child.kill(); }
  }
  test('concurrent processes initialize one key and preserve distinct task records', { timeout: 15000 }, () => fixture(async root => {
    await concurrent(root);
    assert.equal(listBrowserRecoveries(root, owner).length, 18);
    assert.equal(recoveryEvidence(root, owner).length, 18);
    assert.equal(fs.statSync(path.join(root, 'browser-recovery', 'authentication.key')).mode & 0o777, 0o600);
  }));
  test('concurrent process updates retain every attempt without lost writes', { timeout: 15000 }, () => fixture(async root => {
    const record = beginBrowserRecovery(root, owner, task);
    const key = fs.readFileSync(path.join(root, 'browser-recovery', 'authentication.key'));
    await concurrent(root, record.task_id);
    assert.equal(validateBrowserRecovery(root, owner, record.task_id).attempts.length, 18);
    assert.equal(recoveryEvidence(root, owner).length, 18);
    assert.deepEqual(fs.readFileSync(path.join(root, 'browser-recovery', 'authentication.key')), key);
  }));
}
