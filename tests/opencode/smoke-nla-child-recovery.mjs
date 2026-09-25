// Real isolated OpenCode, deterministic local HTTP models, no cloud credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-child-live-'));
const plugin = fileURLToPath(new URL('../../.opencode/plugins/next-level-agent.js', import.meta.url));
const artifact = path.join(root, 'artifact.txt');
const unknownContext = process.argv.includes('--unknown-context');
const calls = []; let worker = 0, primary = 0, server, stderr = '';
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  let content, tool, finish = 'stop', input = 100, output = 20;
  const names = (body.tools || []).map(t => t.function?.name);
  if (body.model === 'coordinator') {
    if (++primary === 1) { calls.push('delegate'); tool = { index: 0, id: 'delegate', type: 'function', function: { name: 'nla_task', arguments: JSON.stringify({ role: 'implementer', description: 'Write fixture and recover', prompt: `Write exactly preserved to ${artifact}, then provide a verified report. Preserve existing changes. This is an isolated test.` }) } }; }
    else { calls.push('root-done'); content = 'ROOT_OK'; }
  } else if (!names.length) { calls.push('summary'); content = `Original task: write ${artifact}. The write tool completed; file content is preserved. Previous response hit a length limit and is not an acceptance report. Next: inspect retained work and finish reporting. No external effects authorized.`; }
  else if (++worker === 1) {
    calls.push('write'); tool = { index: 0, id: 'write_fixture', type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: artifact, content: 'preserved' }) } };
  } else if (worker === 2) { calls.push('length'); content = 'INCOMPLETE — must not be accepted as final report'; finish = 'length'; input = 54000; output = 11536; }
  else { calls.push('recovered'); content = 'RECOVERED_REPORT: prior write preserved; no independent acceptance claimed.'; }
  if (tool) finish = 'tool_calls';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [tool] } : { content }) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } },
  ]) res.write('data: ' + JSON.stringify({ id: `fixture_${calls.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...chunk }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(r => [r, { enabled: !['nla','compactor'].includes(r), models: [r === 'nla' ? 'fixture/coordinator' : 'fixture/worker'] }]));
  roles.implementer.model_facts = { 'fixture/worker': { context_window: 65536 } };
  fs.writeFileSync(path.join(root, 'pools.json'), JSON.stringify({ version: 1, roles }));
  const config = { plugin: [plugin], model: 'fixture/coordinator', small_model: 'fixture/coordinator', default_agent: 'nla', enabled_providers: ['fixture'], compaction: { auto: true, prune: true }, permission: { '*': 'allow' },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: Object.fromEntries(['coordinator','worker'].map(id => [id, { name: id, cost: { input: 0, output: 0 }, limit: { context: unknownContext && id === 'worker' ? 0 : 65536, output: 16384 } }])) } },
    agent: { nla: { mode: 'primary', model: 'fixture/coordinator' }, implementer: { mode: 'subagent', model: 'fixture/worker' }, compaction: { model: 'fixture/worker' } } };
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify(config));
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: {
    PATH: process.env.PATH, LANG: 'C.UTF-8', XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG: path.join(root, 'opencode.json'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    NLA_MEMORY_DIR: path.join(root, 'memory'), NLA_MODEL_POOLS_PATH: path.join(root, 'pools.json'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', c => { stdout += c; }); server.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 45000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) { if (Date.now() > deadline || server.exitCode !== null) throw Error('server startup: ' + stderr.slice(-1000)); await new Promise(r => setTimeout(r, 50)); }
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = async (url, body) => { const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); if (!r.ok) throw Error(await r.text()); return r.json(); };
  const session = await api('/session', { title: 'Child recovery smoke' });
  await api(`/session/${session.id}/message`, { agent: 'nla', model: { providerID: 'fixture', modelID: 'coordinator' }, parts: [{ type: 'text', text: 'Delegate the isolated write/recovery test.' }] });
  const messages = await api(`/session/${session.id}/message`);
  const log = fs.readFileSync(path.join(root, '.opencode/agent-run.log'), 'utf8');
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ calls, messages, log }, null, 2));
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'preserved');
  assert.deepEqual(calls, ['delegate','write','length','summary','recovered','root-done']);
  if (unknownContext) {
    assert.match(log, /child_context_compacted/);
    assert.match(log, /child_recovery_completed/);
  }
  assert.doesNotMatch(log, /model_attempt_failed|model_cooldown_started/);
  assert.ok(messages.some(m => m.parts?.some(p => p.type === 'tool' && p.tool === 'nla_task' && p.state?.status === 'completed' && JSON.stringify(p.state).includes('RECOVERED_REPORT'))));
  console.log(JSON.stringify({ result: 'PASS', root, unknownContext, calls }));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', root, calls, error: error.message, stderr: stderr.slice(-1500) })); process.exitCode = 1; }
finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 3000))]); if (server.exitCode === null) server.kill('SIGKILL'); }
  model.closeAllConnections(); model.close();
}
