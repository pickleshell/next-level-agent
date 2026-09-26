import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeSystemDatabase, loadSystemEvaluations, withSystemDatabase } from '../../.opencode/plugins/nla-system-database.mjs';
import { createTask, bindTask, startAttempt, endAttempt, finishTask, recordTaskEvent, recordTaskReview, recordTaskLatency, executionStatus, getTask, recoverInterruptedTasks } from '../../.opencode/plugins/nla-execution-store.mjs';
import { createProgressMonitor, parseTaskReport, repositoryRevision } from '../../.opencode/plugins/nla-execution-monitor.mjs';
import { NextLevelAgentPlugin } from './fixture-task-admission.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-execution-test-'));
const project = path.join(dir, 'project'); fs.mkdirSync(project);
execFileSync('git', ['init','-q',project]);
execFileSync('git', ['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Fixture']);
fs.writeFileSync(path.join(project, 'file.txt'), 'before');
const file = initializeSystemDatabase({ stateRoot: path.join(dir, 'state') });
const owner = 'owner_123';
const fixtureTask = (role = 'implementer') => createTask(file, { owner, root: owner, role, orchestra: 'go', directory: project, description: 'Fixture', criteria: ['File exists'] });
try {
  const revision = repositoryRevision(project);
  assert.ok(revision);
  fs.writeFileSync(path.join(project, 'file.txt'), 'changed');
  assert.notEqual(repositoryRevision(project), revision, 'dirty/untracked contents are revision-bound');
  fs.writeFileSync(path.join(project, 'file.txt'), 'before');
  const task = fixtureTask(); bindTask(file, task, 'child_123');
  const attempt = startAttempt(file, task, 1, 'fixture/model');
  recordTaskEvent(file, task, attempt, 'tool_observed', { tool: 'read', input: 'secret payload' }, 'event_123');
  recordTaskEvent(file, task, attempt, 'tool_observed', {}, 'event_123');
  assert.equal(executionStatus(file, { action: 'recent' }).filter(e => e.event_key === 'event_123').length, 1);
  assert.ok(!JSON.stringify(executionStatus(file, { action: 'recent' })).includes('secret payload'));
  assert.equal(recordTaskLatency(file, task, attempt, 'fixture/model', 'message_123', 500), true);
  assert.equal(recordTaskLatency(file, task, attempt, 'fixture/model', 'message_123', 40000), false);
  assert.equal(loadSystemEvaluations(file).models['fixture/model'].scores.latency, 10);
  endAttempt(file, attempt, 'returned');
  const report = { status: 'completed', summary: 'Read file', artifacts: ['file.txt'], checks: [{ claim: 'All tests pass' }], remaining: [], blockers: [] };
  const parsed = parseTaskReport(JSON.stringify(report), project);
  assert.equal(parsed.checks[0].evidence, 'reported_only', 'a claim is not proof');
  assert.throws(() => parseTaskReport('Hello!', project));
  assert.throws(() => parseTaskReport(JSON.stringify({ ...report, blockers: ['blocked'] }), project));
  assert.throws(() => parseTaskReport(JSON.stringify({ ...report, artifacts: ['../outside'] }), project));
  fs.symlinkSync('/etc/hosts', path.join(project, 'outside'));
  assert.throws(() => parseTaskReport(JSON.stringify({ ...report, artifacts: ['outside'] }), project));
  fs.unlinkSync(path.join(project, 'outside'));
  finishTask(file, task, 'report_ready', { report: parsed, revision });
  const reviewer = fixtureTask('reviewer');
  const verdict = { verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 }, evidence: { acceptance_criteria_met: true, tests_passed: false } };
  recordTaskReview(file, task, reviewer, verdict, revision);
  const scores = loadSystemEvaluations(file);
  assert.equal(getTask(file, task).status, 'review_pass');
  assert.equal(recordTaskReview(file, task, reviewer, { ...verdict, scores: { coding: 2, reasoning: 2, tool_use: 2 } }, revision).duplicate, true);
  assert.deepEqual(loadSystemEvaluations(file), scores);
  for (const cause of ['stale','multiple']) {
    const target = fixtureTask(); const a = startAttempt(file, target, 1, 'fixture/model'); endAttempt(file, a, 'failed');
    if (cause === 'multiple') endAttempt(file, startAttempt(file, target, 2, 'fixture/other'), 'returned');
    finishTask(file, target, 'report_ready', { report: parsed, revision });
    const result = recordTaskReview(file, target, reviewer, verdict, cause === 'stale' ? 'changed' : revision);
    assert.equal(result.evaluation_status, 'skipped');
    assert.deepEqual(loadSystemEvaluations(file), scores);
  }
  const interrupted = fixtureTask(); startAttempt(file, interrupted, 1, 'fixture/model');
  recoverInterruptedTasks(file, 'new-process');
  assert.equal(getTask(file, interrupted).status, 'recovery_required');
  assert.equal(getTask(file, interrupted).attempts[0].status, 'interrupted');
  assert.equal(getTask(file, task).status, 'review_pass');
  assert.equal(executionStatus(file, { root: 'unrelated' }).length, 0);
  const monitor = createProgressMonitor();
  const part = n => ({ type: 'tool', callID: 'call_' + n, messageID: 'msg_123', tool: 'read', state: { status: 'completed', input: { file: 'x' }, output: 'same result' } });
  assert.equal(monitor.observe(part(1)).suspected_loop, false);
  assert.equal(monitor.observe(part(1)), null);
  monitor.observe(part(2));
  assert.equal(monitor.observe(part(3)).suspected_loop, true);
  assert.match(monitor.advisory, /slow/);
  assert.ok(monitor.messagesWithTools.has('msg_123'));
  monitor.observe(part(4)); monitor.observe(part(5));
  assert.equal(monitor.observe(part(6)).review_needed, true);
  const unsafe = createProgressMonitor();
  unsafe.observe({ type: 'tool', callID: 'write_1', tool: 'bash', state: { status: 'running' } });
  assert.equal(unsafe.uncertainEffects, true);
  unsafe.observe({ type: 'tool', callID: 'write_1', tool: 'bash', state: { status: 'error', error: 'connection lost' } });
  assert.equal(unsafe.uncertainEffects, true, 'failed mutation cannot be blindly replayed');
  const missing = path.join(dir, 'missing.sqlite');
  assert.throws(() => executionStatus(missing)); assert.equal(fs.existsSync(missing), false);
  const cli = execFileSync('node', ['scripts/nla-events.mjs','--database',file], { cwd: process.cwd(), encoding: 'utf8' });
  assert.ok(cli.includes('review_recorded'));
  // Inject a write failure: review receipt and scores must rollback together.
  const atomicTarget = fixtureTask(); endAttempt(file, startAttempt(file, atomicTarget, 1, 'fixture/model'), 'returned');
  finishTask(file, atomicTarget, 'report_ready', { report: parsed, revision });
  withSystemDatabase(file, db => db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON task_reviews BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;"), { write: true });
  assert.throws(() => recordTaskReview(file, atomicTarget, reviewer, { ...verdict, scores: { coding: 1, reasoning: 1, tool_use: 1 } }, revision));
  assert.deepEqual(loadSystemEvaluations(file), scores);
  assert.equal(getTask(file, atomicTarget).review, null);
  console.log('Execution store: persistence, privacy, idempotence, attribution, revision and rollback PASS');
  const upgradeRoot = path.join(dir, 'upgrade');
  const upgradeFile = initializeSystemDatabase({ stateRoot: upgradeRoot });
  withSystemDatabase(upgradeFile, db => db.exec("DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES(4,'fixture'); DROP TABLE task_reviews; DROP TABLE task_events; DROP TABLE task_attempts; DROP TABLE task_runs; DROP TABLE runtime_events;"), { write: true });
  initializeSystemDatabase({ stateRoot: upgradeRoot });
  assert.equal(fs.existsSync(upgradeFile + '.before-v5'), true);
  assert.equal(fs.statSync(upgradeFile + '.before-v5').mode & 0o777, 0o600);
  assert.deepEqual(executionStatus(upgradeFile), []);

  const old = { NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR, NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH };
  let plugin;
  try {
    process.env.NLA_MEMORY_DIR = path.join(dir, 'runtime');
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(role => [role, { enabled: role !== 'nla', models: ['fixture/model'] }]));
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
    let children = 0, calls = 0, progressMode = false, progressCalls = 0, diagnosticMode = false, diagnosticSession;
    const client = { tool: { list: async () => ({ data: ['nla_status','nla_models','read','grep','glob','bash','apply_patch'].map(id => ({ id, parameters: {} })) }) }, session: {
      create: async () => ({ data: { id: `session_${++children}` } }), abort: async () => ({ data: true }),
      prompt: async request => {
        calls++;
        if (diagnosticMode && request.body.agent === 'supervisor') {
          diagnosticSession = request.path.id;
          const ctx = { sessionID: diagnosticSession, directory: project };
          assert.equal(request.body.tools.nla_status, true);
          assert.equal(request.body.tools.nla_models, true);
          assert.equal(request.body.tools.read, true);
          assert.equal(request.body.tools['*'], false);
          assert.ok(!request.body.tools.bash && !request.body.tools.write && !request.body.tools.nla_task);
          const records = JSON.parse((await plugin.tool.nla_status.execute({ action: 'summary' }, ctx)).output);
          assert.ok(records.some(row => row.role === 'implementer'), 'Supervisor sees parent workflow, not only its child');
          await plugin.tool.nla_status.execute({ action: 'recent', history: true }, ctx);
          await plugin.tool.nla_models.execute({}, ctx);
          await plugin['tool.execute.before']({ sessionID: diagnosticSession, tool: 'read' }, { args: {} });
          for (const tool of ['bash','write','edit','task','nla_task','nla_state','nla_models_reload']) {
            await assert.rejects(plugin['tool.execute.before']({ sessionID: diagnosticSession, tool }, { args: {} }), /read-only capability/);
          }
          await assert.rejects(plugin.tool.nla_models_reload.execute({}, ctx), /primary/);
          await assert.rejects(plugin.tool.nla_state.execute({ snapshot: '{}' }, ctx), /primary/);
          return { data: { parts: [{ type: 'text', text: 'CONTINUE: independent read-only inspection complete' }] } };
        }
        if (progressMode && request.body.agent === 'supervisor') {
          assert.deepEqual(request.body.tools, { '*': false }, 'automatic audit remains tool-free');
          await assert.rejects(plugin.tool.nla_status.execute({}, { sessionID: request.path.id }), /primary/);
          return { data: { parts: [{ type: 'text', text: '{"action":"continue"}' }] } };
        }
        if (progressMode && request.body.agent === 'explorer' && ++progressCalls === 1) {
          for (let n = 0; n < 6; n++) await plugin.event({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'read', callID: `repeat_${n}`, sessionID: request.path.id, state: { status: 'completed', input: { file: 'file.txt' }, output: 'same result' } } } } });
          return new Promise(() => {});
        }
        if (request.body.agent === 'reviewer') return { data: { parts: [{ type: 'text', text: JSON.stringify(verdict) }] } };
        return { data: { parts: [{ type: 'text', text: calls === 1 ? 'Hello!' : JSON.stringify(report) }] } };
      },
    } };
    plugin = await NextLevelAgentPlugin({ client, directory: project });
    await plugin['chat.message']({ sessionID: owner, agent: 'nla', directory: project });
    const context = { sessionID: owner, directory: project, abort: new AbortController().signal };
    const result = await plugin.tool.nla_task.execute({ role: 'implementer', description: 'Read fixture', prompt: 'Read file.txt without changes.', acceptance_criteria: '["File exists"]' }, context);
    assert.equal(calls, 2, 'malformed report receives one report-only repair');
    assert.equal(result.metadata.outcome, 'report_ready');
    await plugin.dispose();
    plugin = await NextLevelAgentPlugin({ client, directory: project });
    await plugin['chat.message']({ sessionID: owner, agent: 'nla', directory: project });
    await plugin.tool.nla_task.execute({ role: 'reviewer', description: 'Review fixture', prompt: 'Review the implementation independently.' }, context);
    const status = JSON.parse((await plugin.tool.nla_status.execute({ action: 'task', task_id: result.metadata.taskID }, context)).output);
    assert.equal(status[0].review.evaluation_status, 'applied', 'automatic unique target survives plugin recreation');
    assert.equal(status[0].status, 'review_pass');
    assert.ok(JSON.stringify(status).includes('task_id'));
    fs.writeFileSync(path.join(project, 'file.txt'), 'new revision');
    const stale = JSON.parse((await plugin.tool.nla_status.execute({ action: 'task', task_id: result.metadata.taskID }, context)).output);
    assert.equal(stale[0].status, 'review_stale');
    diagnosticMode = true;
    const diagnostic = await plugin.tool.nla_task.execute({ role: 'supervisor', description: 'Inspect execution incident', prompt: 'Inspect task status and read relevant project files; diagnose without changes.' }, context);
    assert.match(diagnostic.output, /independent read-only/);
    await assert.rejects(plugin.tool.nla_status.execute({}, { sessionID: diagnosticSession }), /primary/, 'capability expires with task');
    await assert.rejects(plugin.tool.nla_models.execute({}, { sessionID: 'forged_supervisor', agent: 'supervisor' }), /primary/);
    diagnosticMode = false;
    progressMode = true;
    const monitored = await plugin.tool.nla_task.execute({ role: 'explorer', description: 'Monitor fixture', prompt: 'Read file.txt without changes.' }, context);
    assert.equal(progressCalls, 2, 'Supervisor authorizes exactly one same-model resume');
    const progress = JSON.parse((await plugin.tool.nla_status.execute({ action: 'recent', task_id: monitored.metadata.taskID }, context)).output);
    assert.ok(progress.some(e => e.kind === 'supervisor_decision' && e.data.action === 'continue'));
    assert.equal(monitored.metadata.outcome, 'report_ready');
    console.log('Execution runtime: report repair, persistent automatic review target and nla_status PASS');
  } finally {
    await plugin?.dispose();
    for (const [key,value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
