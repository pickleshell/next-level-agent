import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Mem0HttpClient, mem0Config, resolveMem0UserID } from '../../.opencode/plugins/nla-mem0-client.mjs';
import { NlaMem0Plugin } from '../../.opencode/plugins/nla-mem0.js';

const memories = new Map();
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  response.setHeader('content-type', 'application/json');
  if (request.url === '/memories') {
    const items = memories.get(body.user_id) || [];
    const memory = { id: `memory-${items.length + 1}`, memory: body.text, event: 'ADD' };
    items.push(memory);
    memories.set(body.user_id, items);
    response.end(JSON.stringify({ results: [memory] }));
    return;
  }
  if (request.url === '/search') {
    response.end(JSON.stringify({ results: memories.get(body.user_id) || [] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ detail: 'missing' }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const address = server.address();
  const config = mem0Config({
    NLA_MEM0_URL: `http://127.0.0.1:${address.port}`,
    NLA_MEM0_TIMEOUT_MS: '2000',
    NLA_MEM0_USER_ID: 'stable-user',
  });
  const previous = {
    url: process.env.NLA_MEM0_URL,
    timeout: process.env.NLA_MEM0_TIMEOUT_MS,
    user: process.env.NLA_MEM0_USER_ID,
  };
  process.env.NLA_MEM0_URL = config.baseURL.href;
  process.env.NLA_MEM0_TIMEOUT_MS = String(config.timeoutMs);
  process.env.NLA_MEM0_USER_ID = config.userID;
  const firstSession = await NlaMem0Plugin();
  const addedToolResult = await firstSession.tool.memory_add.execute({ text: 'The compass is in the blue drawer.' });
  assert.equal(JSON.parse(addedToolResult.output).results[0].event, 'ADD');

  const freshSession = await NlaMem0Plugin();
  const foundToolResult = await freshSession.tool.memory_search.execute({ query: 'Where is the compass?' });
  assert.equal(JSON.parse(foundToolResult.output).results[0].memory, 'The compass is in the blue drawer.');
  for (const [name, value] of [['NLA_MEM0_URL', previous.url], ['NLA_MEM0_TIMEOUT_MS', previous.timeout], ['NLA_MEM0_USER_ID', previous.user]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const client = new Mem0HttpClient(config);
  assert.equal(resolveMem0UserID(undefined, config.userID), 'stable-user');
  assert.throws(() => mem0Config({ NLA_MEM0_URL: 'file:///tmp/mem0' }), /HTTP or HTTPS/);
  assert.throws(() => mem0Config({ NLA_MEM0_URL: 'http://token@127.0.0.1:8765' }), /must not contain credentials/);
  assert.throws(() => client.search({ query: 'x', userID: 'u', limit: 21 }), /1 to 20/);
  console.log('NLA Mem0 client tests passed');
} finally {
  server.close();
  await once(server, 'close');
}
