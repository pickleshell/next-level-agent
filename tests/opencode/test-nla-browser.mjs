import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserCapability, BROWSER_TOOLS, browserOrigin, loadBrowserConfig, validateBrowserTask } from '../../.opencode/plugins/nla-browser.mjs';
import { BrowserMcpClient, BrowserError } from '../../.opencode/plugins/nla-browser-mcp.mjs';
import { PlaywrightMcpBackend } from '../../.opencode/plugins/nla-browser-playwright.mjs';
import { deterministicToolShortlist } from '../../.opencode/plugins/nla-prompt-optimizer.mjs';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';

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
  const notRun = await manager.begin(task(), 'parent', root); manager.bind(notRun, 'no-preflight');
  assert.equal(JSON.parse((await manager.finish(notRun)).output).result, 'NOT_RUN');

  let clock = 0;
  const expiring = make({ now: () => clock });
  const retained = await expiring.begin(task({ keep_session: true }), 'parent', root);
  expiring.bind(retained, 'lease'); await expiring.finish(retained);
  clock = 1001; await expiring.reap(); assert.equal(expiring.sessions.size, 0);

  let closed = 0;
  const unavailable = make({ backendFactory: () => ({ start: async () => { throw new BrowserError('AUTH_REQUIRED'); }, close: async () => { closed++; } }) });
  await assert.rejects(unavailable.begin(task(), 'parent', root), e => e.code === 'AUTH_REQUIRED');
  assert.equal(unavailable.sessions.size, 0); assert.equal(closed, 1);
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
  const routed = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Universal browser research', prompt: 'Extract current state', browser: JSON.stringify(task({ success_criteria: [{ id: 'wrong', check: 'text_equals', locator: { test_id: 'result' }, expected: 'Wrong' }] })) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(routed.output).result, 'FAIL'); assert.equal(prompts, 1);
  mutationFailure = true;
  const interrupted = await plugin.tool.nla_task.execute({ role: 'browser', description: 'Do not replay submit', prompt: 'Submit once', browser: JSON.stringify(task()) }, { sessionID: 'parent_123', directory: root, abort: new AbortController().signal });
  assert.equal(JSON.parse(interrupted.output).result, 'BLOCKED');
  assert.equal(JSON.parse(interrupted.output).reason, 'BROWSER_OUTCOME_UNVERIFIED');
  assert.equal(prompts, 2, 'provider failure after mutation must not replay on fallback');
  await plugin.dispose(); plugin = null;
  delete process.env.NLA_BROWSER_CONFIG_PATH;
  plugin = await NextLevelAgentPlugin({ directory: root, client: {} });
  await plugin['chat.message']({ sessionID: 'parent_123', agent: 'nla', directory: root });
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
