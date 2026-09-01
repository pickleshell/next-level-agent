import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { configuredUtilityPool, parseUtilityResponse, runUtilityModel } from '../../.opencode/plugins/nla-utility-runtime.mjs';

assert.equal(parseUtilityResponse({ message: { content: '{"ok":true}', thinking: 'ignore me' } }, 'native'), '{"ok":true}');
assert.equal(parseUtilityResponse({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }], reasoning: 'ignore me' } }] }, 'openai-compatible'), '{"ok":true}');
assert.throws(() => parseUtilityResponse({ message: { content: '', thinking: 'answer maybe' } }, 'native'), /reasoning but no answer/);

const requests = [];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push({ url: request.url, body: JSON.parse(body) });
  if (requests.length === 1) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"model missing"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"message":{"content":"{\\"ok\\":true}","thinking":"not output"}}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = `http://127.0.0.1:${server.address().port}`;
const pool = {
  enabled: true, runtime: 'utility', backend: 'ollama',
  provider: { api: 'native', base_url: baseURL }, models: ['missing', 'working'],
  request_timeout_ms: 1000, max_failovers: 1, output_format: 'json',
};
assert.equal(configuredUtilityPool(pool), true);
const result = await runUtilityModel({ role: 'compactor', pool, prompt: 'Return JSON' });
assert.equal(result.output, '{"ok":true}');
assert.equal(result.metadata.model, 'working');
assert.equal(requests[0].url, '/api/chat');
assert.equal(requests[0].body.stream, false);
assert.equal(requests[0].body.think, false);
assert.equal(requests[0].body.format, 'json');
server.close();
await once(server, 'close');

const timeoutPool = { ...pool, models: ['slow'], max_failovers: 0, request_timeout_ms: 10 };
await assert.rejects(
  runUtilityModel({
    role: 'compactor', pool: timeoutPool, prompt: 'wait',
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  }),
  /timed out after 10ms/,
);

for (const invalid of [
  { ...pool, backend: 'other' },
  { ...pool, provider: { ...pool.provider, api: 'other' } },
  { ...pool, provider: { ...pool.provider, base_url: '' } },
  { ...pool, request_timeout_ms: 0 },
]) assert.equal(configuredUtilityPool(invalid), false);

console.log('NLA utility-model runtime tests passed');
