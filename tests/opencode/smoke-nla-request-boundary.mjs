// Opt-in transport integration against installed OpenCode. Local fake LLM only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-request-live-'));
const plugin = fileURLToPath(new URL('../../.opencode/plugins/next-level-agent.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [], results = [];
let server, stderr = '';
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const name = body.model;
  const call = { name, start: Date.now() }; calls.push(call);
  res.on('close', () => { call.closedAfter = Date.now() - call.start; });
  const first = calls.filter(c => c.name === name).length === 1;
  if (name === 'headers' && first) return; // provider must abort waiting for headers
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: name, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (name === 'stall' && first) { chunk({ role: 'assistant', content: 'partial' }); return; }
  if (name === 'tools' && !body.messages.some(m => m.role === 'tool')) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'slow_tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 2', description: 'Local disposable test delay' }) } }] });
    chunk({}, 'tool_calls');
  } else {
    // Total generation exceeds a per-chunk timeout but each chunk arrives in time.
    for (const content of ['REQUEST_', 'BOUNDARY_', 'OK']) { await sleep(450); chunk({ content }); }
    chunk({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(r => [r, { enabled: r !== 'nla', models: ['fixture/stream'], idle_timeout_ms: 5 }]));
  fs.writeFileSync(path.join(root, 'pools.json'), JSON.stringify({ version: 1, roles }));
  const models = Object.fromEntries(['stream','headers','stall','tools'].map(id => [id, { name: id, limit: { context: 131072, output: 8192 } }]));
  const config = { plugin: [plugin], model: 'fixture/stream', small_model: 'fixture/stream', default_agent: 'nla', enabled_providers: ['fixture'], compaction: { auto: false }, permission: { '*': 'allow' },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture', headerTimeout: 1000, chunkTimeout: 1000 }, models } },
    agent: { nla: { mode: 'primary', model: 'fixture/stream' }, architect: { mode: 'subagent', model: 'fixture/stream' } } };
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify(config));
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: {
    PATH: process.env.PATH, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG: path.join(root, 'opencode.json'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    NLA_MEMORY_DIR: path.join(root, 'memory'), NLA_MODEL_POOLS_PATH: path.join(root, 'pools.json'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', c => { stdout += c; }); server.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 45000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) { if (Date.now() > deadline || server.exitCode !== null) throw Error('server startup: ' + stderr.slice(-1000)); await sleep(50); }
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = async (url, body) => { const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); if (!r.ok) throw Error(await r.text()); return r.json(); };
  // Child sessions avoid title-generation requests and use actual subagent loops.
  const parent = await api('/session', { title: 'Request timeout test' });
  for (const name of ['stream', 'tools', 'headers', 'stall']) {
    const session = await api('/session', { parentID: parent.id, title: name });
    const started = Date.now();
    const response = await api(`/session/${session.id}/message`, { agent: 'architect', model: { providerID: 'fixture', modelID: name }, parts: [{ type: 'text', text: 'Local transport fixture. Complete the requested test.' }] });
    results.push({ name, elapsed: Date.now() - started, response });
    if (['stream','tools'].includes(name)) {
      assert.ok(!response.info?.error, JSON.stringify(response.info?.error));
      assert.ok(response.parts?.some(p => p.text === 'REQUEST_BOUNDARY_OK'), name);
      if (name === 'tools') assert.ok(response.parts?.some(p => p.type === 'text'), 'tool cycle returned final answer');
    } else {
      // OpenCode may retry transient transport failures internally. The retry
      // gets a healthy response; no need to wait through its whole retry policy.
      assert.ok(response.info?.error || calls.filter(c => c.name === name).length >= 2, `${name} must fail or retry the model request`);
      assert.ok(calls.some(c => c.name === name && c.closedAfter >= 800 && c.closedAfter < 3000), `${name} transport aborted near per-request timeout`);
    }
  }
  assert.ok(calls.filter(c => c.name === 'tools').length >= 2, 'tool execution completed and a fresh model request followed');
  console.log(JSON.stringify({ result: 'PASS', root, calls, results: results.map(({ response, ...r }) => r) }));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', root, error: error.message, calls, stderr: stderr.slice(-1000) })); process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ calls, results }, null, 2));
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), sleep(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  model.closeAllConnections(); model.close();
}
