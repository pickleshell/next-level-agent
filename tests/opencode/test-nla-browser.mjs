import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { BrowserCapability, BROWSER_TOOLS, browserOrigin, loadBrowserConfig, validateBrowserTask } from '../../.opencode/plugins/nla-browser.mjs';
import { BrowserMcpClient, BrowserError } from '../../.opencode/plugins/nla-browser-mcp.mjs';
import { operation } from '../../.opencode/plugins/nla-browser-playwright.mjs';
import { deterministicToolShortlist } from '../../.opencode/plugins/nla-prompt-optimizer.mjs';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { normalizeLedger, saveLedger } from '../../.opencode/plugins/nla-memory.mjs';
import { createBrowserRecovery } from '../../.opencode/plugins/nla-browser-recovery.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-test-'));
const config = { command: [process.execPath, path.resolve('tests/opencode/fixtures/browser-mcp-server.mjs'), '--isolated'], allowed_origins: ['http://example.test'], timeout_ms: 1000, session_ttl_ms: 1000 };
const task = (overrides = {}) => ({ goal: 'Find the relevant page and extract its state', permissions: { navigation: true, interaction: true, external_mutation: true }, origins: ['http://example.test'], success_criteria: [{ id: 'ready', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Ready' }], ...overrides });
const managers = []; const make = opts => { const m = new BrowserCapability({ config, root, ...opts }); managers.push(m); return m; };
let plugin;
const old = Object.fromEntries(['NLA_BROWSER_CONFIG_PATH', 'NLA_MODEL_POOLS_PATH', 'NLA_MEMORY_DIR'].map(k => [k, process.env[k]]));
try {
  assert.equal(loadBrowserConfig({}), null);
  assert.throws(() => loadBrowserConfig({ NLA_BROWSER_CONFIG_PATH: path.join(root, 'missing') }), e => e.code === 'NOT_CONFIGURED');
  assert.equal(browserOrigin('http://example.test/path'), 'http://example.test');
  for (const url of ['file:///tmp/a', 'https://user:password@example.test', 'javascript:alert(1)']) assert.throws(() => browserOrigin(url), e => e.code === 'POLICY_DENIED');
  assert.throws(() => validateBrowserTask(task({ origins: ['http://forbidden.test'] }), config), e => e.code === 'POLICY_DENIED');
  assert.throws(() => validateBrowserTask(task({ permissions: { navigation: 'yes' } }), config));
  assert.throws(() => validateBrowserTask(task({ success_criteria: [{ id: 'unsafe', check: 'eval' }] }), config));
  assert.deepEqual(deterministicToolShortlist('browser', 'click fill screenshot and observe'), BROWSER_TOOLS);

  // Broker requests must not half-close the client before a delayed response.
  // This reproduces the real OpenCode failure where create received EPIPE and
  // the client observed an empty response before launch was sent.
  const brokerSocket = path.join(root, 'broker.sock');
  let requestNumber = 0; let endedBeforeResponse = false;
  const broker = net.createServer(socket => {
    let buffer = '';
    let responded = false;
    socket.on('end', () => { if (!responded) endedBeforeResponse = true; });
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer); buffer = '';
      const op = request.op; const n = ++requestNumber;
      const response = op === 'create'
        ? { ok: true, session: { session_id: 'broker-session', session_token: 'broker-token' } }
        : op === 'launch' ? { ok: true, endpoint: '/tmp/fake-mcp.sock' } : { ok: true };
      setTimeout(() => { responded = true; socket.end(JSON.stringify({ ...response, request: n }) + '\n'); }, 30);
    });
  });
  await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(brokerSocket, resolve); });
  const brokerManager = new BrowserCapability({
    config: { ...config, broker_socket: brokerSocket, broker_allow_private_addresses: true },
    root,
    backendFactory: () => ({ start: async () => ({}), invoke: async () => ({ status: 'PASS' }), close: async () => {} }),
  });
  const brokerSession = await brokerManager.begin(task(), 'broker-parent', root);
  brokerManager.bind(brokerSession, 'broker-child');
  await brokerManager.execute('broker-child', brokerSession.id, 'session', { operation: 'preflight' });
  assert.equal(JSON.parse((await brokerManager.finish(brokerSession)).output).result, 'PASS');
  assert.equal(endedBeforeResponse, false, 'broker client must remain open until delayed response arrives');
  assert.equal(requestNumber, 3);
  const cancelledBroker = new BrowserCapability({
    config: { ...config, broker_socket: brokerSocket, broker_allow_private_addresses: true },
    root,
    backendFactory: () => ({ start: async () => ({}), invoke: async () => ({ status: 'PASS' }), close: async () => {} }),
  });
  const cancelController = new AbortController();
  setTimeout(() => cancelController.abort(), 5);
  await assert.rejects(cancelledBroker.begin(task(), 'cancel-parent', root, cancelController.signal), e => e.code === 'CANCELLED');
  assert.equal(requestNumber, 5, 'cancellation during broker create must destroy the created network session');
  await cancelledBroker.dispose();
  const constructionFailure = new BrowserCapability({
    config: { ...config, broker_socket: brokerSocket, broker_allow_private_addresses: true },
    root,
    backendFactory: () => { throw new Error('backend construction failed'); },
  });
  await assert.rejects(constructionFailure.begin(task(), 'construction-parent', root), /backend construction failed/);
  assert.equal(requestNumber, 8, 'backend construction failure must destroy the launched network session');
  await constructionFailure.dispose();
  await brokerManager.dispose();
  await new Promise(resolve => broker.close(resolve));

  // Cleanup failures must be observable and can never become a clean PASS.
  const cleanupBrokerSocket = path.join(root, 'cleanup-failure-broker.sock');
  const cleanupBroker = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer); buffer = '';
      const response = request.op === 'create'
        ? { ok: true, session: { session_id: 'cleanup-session', session_token: 'cleanup-token' } }
        : request.op === 'launch' ? { ok: true, endpoint: '/tmp/fake-mcp.sock' }
          : request.op === 'destroy' ? { ok: false, error: 'namespace still exists after cleanup' }
            : { ok: true };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise((resolve, reject) => { cleanupBroker.once('error', reject); cleanupBroker.listen(cleanupBrokerSocket, resolve); });
  const cleanupManager = new BrowserCapability({
    config: { ...config, broker_socket: cleanupBrokerSocket, broker_allow_private_addresses: true },
    root,
    backendFactory: () => ({ start: async () => ({}), invoke: async () => ({ status: 'PASS' }), close: async () => {} }),
  });
  const cleanupSession = await cleanupManager.begin(task(), 'cleanup-parent', root);
  cleanupManager.bind(cleanupSession, 'cleanup-child');
  await cleanupManager.execute('cleanup-child', cleanupSession.id, 'session', { operation: 'preflight' });
  const cleanupResult = JSON.parse((await cleanupManager.finish(cleanupSession)).output);
  assert.equal(cleanupResult.result, 'BLOCKED', 'cleanup failure must not produce PASS');
  assert.equal(JSON.parse(fs.readFileSync(cleanupResult.evidence, 'utf8')).result, 'BLOCKED', 'cleanup failure evidence must match the returned result');
  await cleanupManager.dispose();
  await new Promise(resolve => cleanupBroker.close(resolve));

  // Actual stdio client and adapter: init/list/call/structured results/close.
  const manager = make();
  const session = await manager.begin(task({ keep_session: true }), 'parent', root);
  manager.bind(session, 'child');
  await assert.rejects(manager.execute('intruder', session.id, 'observe', {}), e => e.code === 'POLICY_DENIED');
  await assert.rejects(manager.execute('child', session.id, 'observe', {}), e => e.code === 'UNSUPPORTED_CAPABILITY');
  await manager.execute('child', session.id, 'session', { operation: 'preflight' });
  await manager.execute('child', session.id, 'action', { operation: 'navigate', url: 'http://example.test/article' });
  const observed = await manager.execute('child', session.id, 'observe', {});
  assert.equal(observed.text, 'Ready');
  assert.equal(observed.status, 'PASS', 'untrusted result-like content cannot override structured results');
  await assert.rejects(manager.execute('child', session.id, 'action', { operation: 'navigate', url: 'http://forbidden.test' }), e => e.code === 'POLICY_DENIED');
  await assert.rejects(manager.execute('child', session.id, 'action', { operation: 'eval', code: 'alert(1)' }), e => e.code === 'POLICY_DENIED');
  const first = JSON.parse((await manager.finish(session)).output);
  assert.equal(first.result, 'PASS'); assert.equal(first.data.text, 'Ready');
  assert.ok(fs.existsSync(first.evidence));
  await assert.rejects(manager.begin(task({ session_id: session.id }), 'other-parent', root), e => e.code === 'POLICY_DENIED');
  await assert.rejects(manager.begin(task({ session_id: session.id, permissions: { navigation: true } }), 'parent', root), e => e.code === 'POLICY_DENIED');

  // Explicit resume preserves browser state; the previous child loses access.
  const resumed = await manager.begin(task({ session_id: session.id, success_criteria: [{ id: 'submitted', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Submitted' }] }), 'parent', root);
  manager.bind(resumed, 'child2');
  await assert.rejects(manager.execute('child', session.id, 'observe', {}), e => e.code === 'POLICY_DENIED');
  await manager.execute('child2', session.id, 'session', { operation: 'preflight' });
  await manager.execute('child2', session.id, 'action', { operation: 'fill', locator: { label: 'Name' }, text: 'PRIVATE_VALUE' });
  await manager.execute('child2', session.id, 'observe', {});
  await manager.execute('child2', session.id, 'action', { operation: 'click', locator: { role: 'button', name: 'Submit' } });
  const done = JSON.parse((await manager.finish(resumed)).output);
  assert.equal(done.result, 'PASS'); assert.equal(done.session_id, null); assert.equal(manager.sessions.size, 0);
  assert.ok(!fs.readFileSync(done.evidence, 'utf8').includes('PRIVATE_VALUE'));

  const denied = await manager.begin(task({ permissions: { navigation: true } }), 'parent', root);
  manager.bind(denied, 'readonly');
  await manager.execute('readonly', denied.id, 'session', { operation: 'preflight' });
  await assert.rejects(manager.execute('readonly', denied.id, 'action', { operation: 'click', locator: { text: 'Delete' } }), e => e.code === 'POLICY_DENIED');
  await assert.rejects(manager.execute('readonly', denied.id, 'action', { operation: 'fill', locator: { label: 'Password' }, text: 'secret', sensitive: true }), e => e.code === 'POLICY_DENIED');
  await manager.finish(denied);

  const failed = await manager.begin(task({ success_criteria: [{ id: 'missing', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Different' }] }), 'parent', root);
  manager.bind(failed, 'failed'); await manager.execute('failed', failed.id, 'session', { operation: 'preflight' });
  assert.equal(JSON.parse((await manager.finish(failed)).output).result, 'FAIL');
  const tampered = await manager.begin(task({ success_criteria: [{ id: 'truth', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Correct' }] }), 'parent', root);
  manager.bind(tampered, 'tampered');
  await manager.execute('tampered', tampered.id, 'session', { operation: 'preflight' });
  await assert.rejects(manager.execute('tampered', tampered.id, 'check', { id: 'truth', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Ready' }), e => e.code === 'POLICY_DENIED');
  await manager.execute('tampered', tampered.id, 'session', { operation: 'close' });
  const tamperedResult = JSON.parse((await manager.finish(tampered)).output);
  assert.equal(tamperedResult.result, 'BLOCKED'); assert.equal(tamperedResult.reason, 'SESSION_CLOSED');
  assert.equal(tamperedResult.checks[0].status, 'NOT_RUN');

  // Exercise the actual reviewed backend check code without a transport timeout.
  let reads = 0; let becomesTrue = true;
  const checkedPage = {
    context: () => ({ __nlaBrowser: { console: [], dialogs: 0 } }),
    getByTestId: () => ({ innerText: async () => (++reads >= 2 && becomesTrue ? 'Correct' : 'Wrong') }),
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
  const checkInput = { kind: 'check', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Correct', limit: 100, wait_ms: 200 };
  assert.equal((await operation(checkedPage, checkInput)).status, 'PASS');
  becomesTrue = false;
  assert.equal((await operation(checkedPage, { ...checkInput, wait_ms: 20 })).status, 'FAIL');
  const { wait_ms, ...noWaitInput } = checkInput;
  const beforeNoWait = Date.now();
  assert.equal((await operation(checkedPage, noWaitInput)).status, 'FAIL');
  assert.ok(Date.now() - beforeNoWait < 3000, 'omitted wait_ms must terminate inside the backend');
  let savedDownload;
  const downloadPage = {
    context: () => ({ __nlaBrowser: { console: [], dialogs: 0 } }),
    url: () => 'http://example.test/download',
    getByRole: () => ({ getAttribute: async () => null, click: async () => {} }),
    waitForEvent: async () => ({ saveAs: async artifact => { savedDownload = artifact; } }),
  };
  const download = await operation(downloadPage, { kind:'download', locator:{role:'link',name:'Download'}, artifact:path.join(root,'download.bin'), permissions:{downloads:true,authentication:false} });
  assert.equal(download.status,'PASS'); assert.equal(download.artifact,savedDownload,'A saved download must have an evidence reference');
  // Screenshot evidence must describe real mask regions, not a static list of
  // possible selectors. This keeps the artifact claim tied to the backend call.
  let screenshotOptions;
  const screenshotPage = {
    context: () => ({ __nlaBrowser: { console: [], dialogs: 0 } }),
    url: () => 'http://example.test/secret',
    locator: selector => ({ count: async () => selector === 'input[type="password"]' ? 1 : 0 }),
    screenshot: async options => { screenshotOptions = options; },
  };
  const screenshot = await operation(screenshotPage, { kind: 'screenshot', artifact: path.join(root, 'screenshot.png') });
  assert.deepEqual(screenshot.secret_regions_masked, ['input[type="password"]']);
  assert.equal(screenshotOptions.mask.length, 1);
  const notRun = await manager.begin(task(), 'parent', root); manager.bind(notRun, 'no-preflight');
  // Body observation must use the backend secret-region scrubber rather than
  // copying sensitive DOM text into evidence.
  let observedSelector;
  const observePage = {
    context: () => ({ __nlaBrowser: { console: [], network: [], dialogs: 0, blocks: 0 } }),
    url: () => 'http://example.test/secret', title: async () => 'Secret fixture',
    locator: selector => ({ evaluate: async (_fn, secretSelector) => { observedSelector = [selector, secretSelector]; return 'Visible [REDACTED]'; } }),
  };
  const observedSecret = await operation(observePage, { kind: 'observe', limit: 100 });
  assert.equal(observedSecret.text, 'Visible [REDACTED]');
  assert.equal(observedSelector[0], 'body');
  assert.match(observedSelector[1], /data-secret/);

  assert.equal(JSON.parse((await manager.finish(notRun)).output).result, 'NOT_RUN');

  let clock = 0;
  const expiring = make({ now: () => clock });
  const retained = await expiring.begin(task({ keep_session: true }), 'parent', root);
  expiring.bind(retained, 'lease'); await expiring.finish(retained);
  clock = 1001; await expiring.reap(); assert.equal(expiring.sessions.size, 0);

  let failureClock = 0;
  const cleanupFailure = make({ config: { ...config, session_ttl_ms: 1000 }, now: () => failureClock,
    backendFactory: () => ({ start: async () => ({}), invoke: async () => ({ status: 'PASS' }), close: async () => { throw new BrowserError('UNREACHABLE', 'fixture cleanup failure'); } }),
  });
  const expiringFailure = await cleanupFailure.begin(task({ keep_session: true }), 'parent', root);
  cleanupFailure.bind(expiringFailure, 'lease-failure'); await cleanupFailure.finish(expiringFailure);
  failureClock = 1001;
  await assert.rejects(cleanupFailure.reap(), /reaper cleanup failed/);
  assert.ok(cleanupFailure.diagnostics.some(event => event.event === 'browser_cleanup_failed'));
  assert.ok(cleanupFailure.diagnostics.some(event => event.event === 'browser_reaper_cleanup_failed'));

  const disposeFailure = make({
    backendFactory: () => ({ start: async () => ({}), invoke: async () => ({ status: 'PASS' }), close: async () => { throw new BrowserError('UNREACHABLE', 'fixture dispose failure'); } }),
  });
  const activeFailure = await disposeFailure.begin(task(), 'parent', root);
  disposeFailure.bind(activeFailure, 'dispose-failure');
  await assert.rejects(disposeFailure.dispose(), /dispose cleanup failed/);

  let closed = 0;
  const unavailable = make({ backendFactory: () => ({ start: async () => { throw new BrowserError('AUTH_REQUIRED'); }, close: async () => { closed++; } }) });
  await assert.rejects(unavailable.begin(task(), 'parent', root), e => e.code === 'AUTH_REQUIRED');
  assert.equal(unavailable.sessions.size, 0); assert.equal(closed, 1);
  const blockedPreflight = make({ backendFactory: () => ({ start: async () => ({}), invoke: async () => ({status:'BLOCKED',reason:'UNREACHABLE'}), close: async () => {} }) });
  const blockedChild = await blockedPreflight.begin(task(), 'parent', root);
  blockedPreflight.bind(blockedChild, 'blocked-child');
  await assert.rejects(blockedPreflight.execute('blocked-child', blockedChild.id, 'session', {operation:'preflight'}), e => e.code === 'UNREACHABLE');
  assert.equal(blockedChild.preflight, false);
  assert.equal(JSON.parse((await blockedPreflight.finish(blockedChild)).output).result, 'BLOCKED');

  const poisoned = make({ backendFactory: () => ({
    start: async () => ({}),
    invoke: async input => { if (input.kind === 'navigate') throw new BrowserError('UNREACHABLE'); return { status:'PASS', expected:input.expected, observed:'Ready' }; },
    close: async () => {},
  }) });
  const poisonedSession = await poisoned.begin(task(), 'parent', root); poisoned.bind(poisonedSession, 'poisoned');
  await poisoned.execute('poisoned', poisonedSession.id, 'session', {operation:'preflight'});
  assert.equal((await poisoned.execute('poisoned', poisonedSession.id, 'action', {operation:'navigate',url:'http://example.test/'})).status, 'BLOCKED');
  assert.equal(JSON.parse((await poisoned.finish(poisonedSession)).output).result, 'BLOCKED', 'A failed backend operation cannot PASS using an old DOM');
  const controller = new AbortController();
  const cancelled = await manager.begin(task(), 'parent', root, controller.signal);
  manager.bind(cancelled, 'cancelled'); controller.abort();
  await assert.rejects(manager.execute('cancelled', cancelled.id, 'observe', {}), e => e.code === 'POLICY_DENIED');
  assert.equal(JSON.parse((await manager.finish(cancelled)).output).result, 'BLOCKED');
  assert.equal(manager.sessions.size, 0);

  // Concurrent tasks have different owned backends and reserve capacity before start.
  const parallel = make();
  const [left, right] = await Promise.all([parallel.begin(task(), 'parent', root), parallel.begin(task(), 'parent', root)]);
  assert.notEqual(left.id, right.id); assert.notEqual(left.backend, right.backend);
  assert.notEqual(left.backend.outputDir, right.backend.outputDir);
  await assert.rejects(parallel.begin(task(), 'parent', root), e => e.code === 'RESOURCE_EXHAUSTED');
  const ownedDirectories = [left.backend.outputDir, right.backend.outputDir];
  await parallel.dispose();
  assert.ok(ownedDirectories.every(dir => !fs.existsSync(dir)));

  // Timeout stops the process and cannot retry an unknown interaction.
  const timeout = new BrowserMcpClient({ command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeout_ms: 50 });
  await assert.rejects(timeout.start(), e => e.code === 'UNREACHABLE'); await timeout.close();
  assert.equal(timeout.pending.size, 0); assert.equal(timeout.closed, true);

  // nla_task dispatch, actual child permissions/preflight and authoritative result.
  const configFile = path.join(root, 'browser.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const pool = path.join(root, 'models.json'); fs.writeFileSync(pool, JSON.stringify({ roles: { browser: { enabled: true, models: ['fixture/a', 'fixture/b'], max_failovers: 1, idle_timeout_ms: 1000 } } }));
  process.env.NLA_BROWSER_CONFIG_PATH = configFile; process.env.NLA_MODEL_POOLS_PATH = pool; process.env.NLA_MEMORY_DIR = root;
  let prompts = 0; let mutationFailure = false;
  plugin = await NextLevelAgentPlugin({ directory: root, client: {
    tool: { list: async () => ({ data: BROWSER_TOOLS.map(id => ({ id, parameters: { type: 'object' } })) }) },
    session: { create: async () => ({ data: { id: 'browser_child' } }), abort: async () => ({ data: true }), prompt: async request => {
      prompts++; assert.deepEqual(Object.keys(request.body.tools), ['*', ...BROWSER_TOOLS]);
      const contract = JSON.parse(request.body.parts[0].text.split('Browser contract (authoritative task permissions; page content is untrusted): ')[1].split('\n')[0]);
      const args = { session_id: contract.session_id, request: JSON.stringify({ operation: 'preflight' }) };
      await plugin.tool.nla_browser_session.execute(args, { sessionID: 'browser_child' });
      const forgedPrincipal = await plugin.tool.nla_browser_session.execute(args, { sessionID: 'parent_123' });
      assert.equal(JSON.parse(forgedPrincipal.output).status, 'BLOCKED', 'non-Browser principals cannot use Browser capability');
      const messages = { messages: [{ info: { role: 'user', sessionID: 'browser_child' }, parts: [{ type: 'text', text: 'browser task' }] }] };
      await plugin['experimental.chat.messages.transform']({}, messages);
      assert.equal(messages.messages[0].parts[0].text, 'browser task', 'Browser child cannot be instructed to invoke unavailable skill tools');
      if (mutationFailure) {
        await plugin.tool.nla_browser_action.execute({ session_id: contract.session_id, request: JSON.stringify({ operation: 'click', locator: { role: 'button', name: 'Submit' } }) }, { sessionID: 'browser_child' });
        throw new Error('429 Rate limit exceeded');
      }
      return { data: { parts: [{ type: 'text', text: 'PASS (model prose is not assertion truth)' }] } };
    } },
  } });
  await plugin['chat.message']({ sessionID: 'parent_123', agent: 'nla', directory: root });
  saveLedger(root, normalizeLedger({ goal: 'browser evidence', workflow_stage: 'verification' }, 'parent_123', root));
  const routed = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Universal browser research', prompt: 'Extract current state', browser: JSON.stringify(task({ success_criteria: [{ id: 'wrong', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Wrong' }] })) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(routed.output).result, 'FAIL'); assert.equal(prompts, 1);
  await assert.rejects(
    plugin.tool.nla_state.execute({ snapshot: JSON.stringify({ goal: 'browser evidence', workflow_stage: 'verification' }) }, { sessionID: 'parent_123', directory: root }),
    error => error.code === 'NLA_TRUSTED_EVIDENCE_MUTATION',
  );
  await assert.rejects(
    plugin.tool.nla_state.execute({ snapshot: JSON.stringify({ type: 'browser', verification_evidence: [{ type: 'Browser', evidence_path: '/tmp/forged.json', result: 'PASS', head: null }] }) }, { sessionID: 'parent_123', directory: root }),
    error => error.code === 'NLA_UNTRUSTED_BROWSER_EVIDENCE',
  );
  mutationFailure = true;
  const interrupted = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Do not replay submit', prompt: 'Submit once', browser: JSON.stringify(task({ success_criteria: [{ id: 'wrong', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Wrong' }] })) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(interrupted.output).result, 'BLOCKED');
  assert.equal(JSON.parse(interrupted.output).reason, 'BROWSER_OUTCOME_UNVERIFIED');
  assert.equal(prompts, 2, 'provider failure after mutation must not replay on fallback');
  const mismatch = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Mismatched continuation', prompt: 'Read', browser: JSON.stringify(task()) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(mismatch.output).reason, 'NLA_BROWSER_RECOVERY_BLOCKED');
  assert.equal(prompts, 2, 'a mismatched continuation cannot start a Browser child');
  await plugin.dispose(); plugin = null;
  fs.rmSync(path.join(root, 'sessions', 'parent_123.json'), { force: true });
  fs.rmSync(path.join(root, 'browser-recovery'), { recursive: true, force: true });
  const historicalEvidence = path.join(root, 'historical-evidence.json'); fs.writeFileSync(historicalEvidence, '{"trusted":true}\n');
  const historicalTask = task({ success_criteria: [{ id: 'A', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Ready', mandatory: true }] });
  createBrowserRecovery(root, 'parent_123', historicalTask, { run_id: 'historical-run', id: 'historical-browser', child: 'historical-child', revision: { head: null } }, { metadata: { evidence: historicalEvidence, browser_result: 'PASS' } }, [{ id: 'A', status: 'PASS' }]);
  delete process.env.NLA_BROWSER_CONFIG_PATH;
  plugin = await NextLevelAgentPlugin({ directory: root, client: { session: { prompt: async () => ({ data: true }) } } });
  await plugin['chat.message']({ sessionID: 'parent_123', agent: 'nla', directory: root });
  await plugin.tool.nla_state.execute({ snapshot: JSON.stringify({ goal: 'retain recovered evidence', workflow_stage: 'verification', verification_evidence: [{ head: null, type: 'browser', evidence: historicalEvidence, result: 'PASS', provenance: { source: 'browser-capability', trusted: true, run_id: 'historical-run', session_id: 'historical-browser', child_id: 'historical-child', owner_session_id: 'parent_123' } }] }) }, { sessionID: 'parent_123', directory: root });
  const blocked = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Absent browser', prompt: 'Read', browser: JSON.stringify(task()) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(blocked.output).reason, 'NOT_CONFIGURED');
  assert.ok(plugin.tool.nla_models);
} finally {
  await plugin?.dispose();
  for (const m of managers) await m.dispose();
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('NLA Browser contract, MCP lifecycle, permissions, isolation/resume, evidence and child routing passed');
