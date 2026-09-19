// Opt-in real-browser smoke. Reuses an operator-provided MCP/browser installation.
// Never downloads browser software and never visits an application under development.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserCapability } from '../../.opencode/plugins/nla-browser.mjs';

if (!process.env.NLA_SMOKE_MCP_CLI || !process.env.NLA_SMOKE_BROWSER_EXECUTABLE) {
  console.log('Browser real smoke NOT_RUN: set NLA_SMOKE_MCP_CLI and NLA_SMOKE_BROWSER_EXECUTABLE to existing installations');
  process.exit(0);
}
let forbiddenRequests = 0;
const forbidden = http.createServer((_, response) => { forbiddenRequests++; response.end('Forbidden'); });
await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve));
const forbiddenURL = `http://127.0.0.1:${forbidden.address().port}/`;
const secretCanary = 'REAL_PLAYWRIGHT_SECRET_CANARY';
const html = `<!doctype html><title>Browser fixture</title>
<a href='/article'>Relevant source</a><h1>Source data</h1><p data-testid='fact'>Answer: 42</p>
<section data-testid='secret-container'>Container <span data-secret>${secretCanary} suffix</span></section>
<form><label>Name<input id='name'></label><button>Submit</button></form>
<p data-testid='result'>Ready</p><p data-testid='hostile'></p>
<script>document.querySelector('[data-testid=result]').textContent=localStorage.result||'Ready';
document.querySelector('[data-testid=hostile]').textContent='<img src=x onerror=alert(1)>';
document.querySelector('form').onsubmit=async e=>{e.preventDefault(); await fetch('/submit',{method:'POST'});localStorage.result='Submitted';document.querySelector('[data-testid=result]').textContent='Submitted';};</script>`;
const server = http.createServer((request, response) => {
  if (request.url === '/redirect-denied') { response.writeHead(302, { Location: forbiddenURL }); response.end(); }
  else if (request.url === '/redirect-allowed') { response.writeHead(302, { Location: '/article' }); response.end(); }
  else if (request.url === '/submit') response.end('OK');
  else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-real-'));
const config = { command: [process.env.NLA_SMOKE_NODE || process.execPath, process.env.NLA_SMOKE_MCP_CLI, '--isolated', '--headless', '--executable-path', process.env.NLA_SMOKE_BROWSER_EXECUTABLE], allowed_origins: [origin], timeout_ms: 30000, action_timeout_ms: 5000 };
if (process.env.NLA_SMOKE_BROKER_SOCKET) {
  config.broker_socket = process.env.NLA_SMOKE_BROKER_SOCKET;
  config.broker_allow_private_addresses = true;
}
const capability = new BrowserCapability({ config, root });
const permissions = { navigation: true, interaction: true, external_mutation: true };
const task = (criteria, extras = {}) => ({ goal: 'Find a relevant source, extract a fact and verify it', origins: [origin], permissions, success_criteria: criteria, ...extras });
const check = (id, expected, test_id = 'result') => ({ id, check: 'text_equals', expected, locator: { test_id }, wait_ms: 1000 });
const invoke = (session, category, request) => capability.execute(session.child, session.id, category, request);
const start = async (input, child) => { const session = await capability.begin(input, 'parent', root); capability.bind(session, child); await invoke(session, 'session', { operation: 'preflight' }); return session; };
try {
  const research = await start(task([check('fact', 'Answer: 42', 'fact'), { id: 'no-alert', check: 'no_dialogs' }]), 'research');
  assert.equal((await invoke(research, 'action', { operation: 'navigate', url: origin + '/search' })).status, 'PASS');
  const found = await invoke(research, 'observe', { locator: { role: 'link', name: 'Relevant source' } }); assert.equal(found.visible, true);
  assert.equal((await invoke(research, 'action', { operation: 'click', locator: { role: 'link', name: 'Relevant source' } })).status, 'PASS');
  const extracted = await invoke(research, 'observe', { locator: { test_id: 'fact' } }); assert.equal(extracted.text, 'Answer: 42');
  assert.equal(JSON.parse((await capability.finish(research)).output).result, 'PASS');
  console.log('Real smoke 1: research → source → extraction → deterministic check PASS');

  const form = await start(task([check('submitted', 'Submitted')], { keep_session: true }), 'form');
  await invoke(form, 'action', { operation: 'navigate', url: origin + '/form' });
  assert.equal((await invoke(form, 'action', { operation: 'fill', locator: { label: 'Name' }, text: 'Ada' })).status, 'PASS');
  assert.equal((await invoke(form, 'action', { operation: 'click', locator: { role: 'button', name: 'Submit' } })).status, 'PASS');
  await invoke(form, 'action', { operation: 'screenshot' });
  const saved = JSON.parse((await capability.finish(form)).output); assert.equal(saved.result, 'PASS'); assert.ok(saved.session_id);
  console.log('Real smoke 2: interaction/form → state confirmation → evidence PASS');

  const resumed = await start(task([check('retained', 'Submitted')], { session_id: saved.session_id }), 'resume');
  assert.equal((await invoke(resumed, 'observe', { locator: { test_id: 'result' } })).text, 'Submitted');
  assert.equal(JSON.parse((await capability.finish(resumed)).output).result, 'PASS');
  const fresh = await start(task([check('isolated', 'Ready')]), 'fresh');
  await invoke(fresh, 'action', { operation: 'navigate', url: origin + '/form' });
  assert.equal(JSON.parse((await capability.finish(fresh)).output).result, 'PASS');
  console.log('Real smoke 3: explicit resume retains storage; new task starts fresh PASS');

  const secret = await start(task([{ id: 'secret-contains', check: 'text_contains', expected: secretCanary, locator: { test_id: 'secret-container' }, wait_ms: 1000 }]), 'secret');
  await invoke(secret, 'action', { operation: 'navigate', url: origin + '/secret' });
  const secretCheck = await invoke(secret, 'check', { id: 'secret-contains', check: 'text_contains', expected: secretCanary, locator: { test_id: 'secret-container' }, wait_ms: 1000 });
  assert.equal(secretCheck.status, 'PASS');
  assert.equal(secretCheck.observed, '[REDACTED]');
  assert.equal(secretCheck.expected, '[REDACTED]');
  assert.ok(!JSON.stringify(secretCheck).includes(secretCanary));
  const secretResult = JSON.parse((await capability.finish(secret)).output);
  assert.ok(!JSON.stringify(secretResult).includes(secretCanary));
  assert.ok(!fs.readFileSync(secretResult.evidence, 'utf8').includes(secretCanary));
  console.log('Real smoke secret container/text_contains redaction PASS');
  if (process.env.NLA_SMOKE_SECRET_ONLY === '1') { console.log(`Real browser evidence: ${root}`); }
  else {
  const policy = await start(task([check('ready', 'Ready')]), 'policy');
  assert.equal((await invoke(policy, 'action', { operation: 'navigate', url: origin + '/redirect-allowed' })).status, 'PASS');
  const denied = await invoke(policy, 'action', { operation: 'navigate', url: origin + '/redirect-denied' });
  assert.equal(denied.status, 'BLOCKED'); assert.equal(denied.reason, 'POLICY_DENIED');
  if (config.broker_socket) assert.equal(forbiddenRequests, 0);
  await capability.finish(policy);
  console.log(config.broker_socket
    ? 'Real smoke network boundary: forbidden redirect request_count=0 PASS'
    : `Real smoke direct-mode policy detection PASS; preventive containment NOT_SUPPORTED; forbidden_requests=${forbiddenRequests}`);
  console.log(`Real browser evidence: ${root}`);
  }
} finally {
  await capability.dispose();
  server.closeAllConnections(); forbidden.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => forbidden.close(resolve))]);
}
