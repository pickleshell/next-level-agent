// Opt-in real OpenCode server, local deterministic HTTP model only. No credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-compact-live-'));
const plugin = fileURLToPath(new URL('../../.opencode/plugins/next-level-agent.js', import.meta.url));
const calls = [];
let mainCalls = 0, server, stderr = '';
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const text = JSON.stringify(body.messages || []);
  const names = (body.tools || []).map(x => x.function?.name);
  let content, tool;
  if (/Pre-compaction workflow audit|Audit this NLA session ledger/.test(text)) { content = 'CONTINUE'; calls.push('audit'); }
  else if (names.includes('nla_state')) {
    mainCalls++;
    if (mainCalls === 1) {
      calls.push('read');
      tool = { index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: path.join(root, 'fixture.txt') }) } };
    } else if (mainCalls === 2) {
      calls.push('state');
      tool = { index: 0, id: 'call_checkpoint', type: 'function', function: { name: 'nla_state', arguments: JSON.stringify({ snapshot: JSON.stringify({ goal: 'Test automatic continuation', workflow_stage: 'implementation', next_step: 'Return BOUNDARY_OK after compact' }) }) } };
    } else { calls.push('continued'); content = 'BOUNDARY_OK'; }
  } else { calls.push('summary'); content = 'Task: test automatic continuation. Checkpoint saved. Next: return BOUNDARY_OK. No user approval pending.'; }
  const usage = { prompt_tokens: tool ? 1500 : 50, completion_tokens: 20, total_tokens: tool ? 1520 : 70 };
  if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [tool] } : { content }) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage },
  ]) res.write('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...chunk }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(r => [r, { enabled: !['nla','compactor'].includes(r), models: ['fixture/model'] }]));
  fs.writeFileSync(path.join(root, 'pools.json'), JSON.stringify({ version: 1, roles }));
  const config = { plugin: [plugin], model: 'fixture/model', small_model: 'fixture/model', default_agent: 'nla', enabled_providers: ['fixture'], compaction: { auto: false },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: { model: { name: 'Fixture', limit: { context: 131072, output: 8192 } } } } },
    agent: { nla: { mode: 'primary', prompt: 'Use nla_state then continue.', model: 'fixture/model' }, supervisor: { mode: 'subagent', model: 'fixture/model' } } };
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'Test fixture only.');
  // Separate config/data/state trees; do not read or write the user's OpenCode DB.
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: {
    PATH: process.env.PATH, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG: path.join(root, 'opencode.json'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    NLA_MEMORY_DIR: path.join(root, 'memory'), NLA_MODEL_POOLS_PATH: path.join(root, 'pools.json'), NLA_CONTEXT_SOFT_TOKENS: '1000', NLA_CONTEXT_HARD_TOKENS: '2000',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', c => { stdout += c; }); server.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 45000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) { if (Date.now() > deadline || server.exitCode !== null) throw Error('server startup: ' + stderr.slice(-1200)); await new Promise(r => setTimeout(r, 50)); }
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = async (url, body) => { const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); if (!r.ok) throw Error(await r.text()); return r.json(); };
  const session = await api('/session', { title: 'Deterministic compaction test' });
  await api(`/session/${session.id}/message`, { agent: 'nla', model: { providerID: 'fixture', modelID: 'model' }, parts: [{ type: 'text', text: 'Save checkpoint using nla_state then continue automatically.' }] });
  const messages = await api(`/session/${session.id}/message`);
  const logPath = path.join(root, '.opencode/agent-run.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ calls, messages, log }, null, 2));
  assert.ok(calls.includes('summary'), 'native compaction occurred');
  assert.ok(calls.indexOf('continued') > calls.indexOf('summary'), 'continued only after summary');
  assert.match(log, /context_restored/);
  assert.ok(messages.some(m => m.parts?.some(p => p.text === 'BOUNDARY_OK')));
  console.log(JSON.stringify({ result: 'PASS', root, calls }));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', root, calls, error: error.message, stderr: stderr.slice(-1500) })); process.exitCode = 1; }
finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 3000))]); if (server.exitCode === null) server.kill('SIGKILL'); }
  model.closeAllConnections(); model.close();
}
