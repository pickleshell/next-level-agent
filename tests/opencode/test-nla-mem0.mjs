import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Mem0HttpClient, mem0Config, resolveMem0UserID } from '../../.opencode/plugins/nla-mem0-client.mjs';
import { NlaMem0Plugin } from '../../.opencode/plugins/nla-mem0.js';

const memories = new Map();
const history = new Map();
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'POST' && url.pathname === '/memories') {
    const items = memories.get(body.user_id) || [];
    const memory = { id: `memory-${items.length + 1}`, memory: body.text, user_id: body.user_id };
    items.push(memory);
    memories.set(body.user_id, items);
    history.set(memory.id, [{ event: 'ADD', memory_id: memory.id, new_memory: body.text }]);
    response.end(JSON.stringify({ results: [{ ...memory, event: 'ADD' }] }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/search') {
    response.end(JSON.stringify({ results: memories.get(body.user_id) || [] }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/memories') {
    response.end(JSON.stringify({ results: (memories.get(url.searchParams.get('user_id')) || []).slice(0, Number(url.searchParams.get('limit'))) }));
    return;
  }
  const historyMatch = url.pathname.match(/^\/memories\/([^/]+)\/history$/);
  const memoryMatch = url.pathname.match(/^\/memories\/([^/]+)$/);
  const memoryID = decodeURIComponent((historyMatch || memoryMatch || [])[1] || '');
  const queryUserID = url.searchParams.get('user_id');
  const findMemory = (userID) => (memories.get(userID) || []).find((item) => item.id === memoryID);
  if (request.method === 'GET' && historyMatch && findMemory(queryUserID)) {
    response.end(JSON.stringify({ results: history.get(memoryID) || [] }));
    return;
  }
  if (request.method === 'GET' && memoryMatch && findMemory(queryUserID)) {
    response.end(JSON.stringify(findMemory(queryUserID)));
    return;
  }
  if (request.method === 'PUT' && memoryMatch && findMemory(body.user_id)) {
    const memory = findMemory(body.user_id);
    const old = memory.memory;
    memory.memory = body.text;
    history.get(memoryID).push({ event: 'UPDATE', memory_id: memoryID, old_memory: old, new_memory: body.text });
    response.end(JSON.stringify({ message: 'Memory updated successfully!', memory }));
    return;
  }
  if (request.method === 'DELETE' && memoryMatch && findMemory(queryUserID)) {
    memories.set(queryUserID, memories.get(queryUserID).filter((item) => item.id !== memoryID));
    response.end(JSON.stringify({ message: 'Memory deleted successfully!' }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ detail: 'Memory not found' }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const defaultConfig = JSON.parse(await readFile(new URL('../../opencode.json', import.meta.url), 'utf8'));
  assert.ok(defaultConfig.plugin.includes('./.opencode/plugins/nla-mem0.js'), 'default config must include the optional Mem0 plugin');
  const originalURL = process.env.NLA_MEM0_URL;
  process.env.NLA_MEM0_URL = 'http://127.0.0.1:1';
  const offlinePlugin = await NlaMem0Plugin();
  assert.equal(Object.keys(offlinePlugin.tool).length, 7, 'plugin must load without contacting the optional service');
  if (originalURL === undefined) delete process.env.NLA_MEM0_URL;
  else process.env.NLA_MEM0_URL = originalURL;

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
  const memoryID = JSON.parse(addedToolResult.output).results[0].id;
  assert.equal(JSON.parse(addedToolResult.output).results[0].event, 'ADD');

  const freshSession = await NlaMem0Plugin();
  const foundToolResult = await freshSession.tool.memory_search.execute({ query: 'Where is the compass?' });
  assert.equal(JSON.parse(foundToolResult.output).results[0].memory, 'The compass is in the blue drawer.');
  assert.equal(JSON.parse((await freshSession.tool.memory_list.execute({})).output).results.length, 1);
  assert.equal(JSON.parse((await freshSession.tool.memory_get.execute({ memory_id: memoryID })).output).id, memoryID);
  const updated = JSON.parse((await freshSession.tool.memory_update.execute({ memory_id: memoryID, text: 'The compass is in the green vault.' })).output);
  assert.equal(updated.memory.memory, 'The compass is in the green vault.');
  const events = JSON.parse((await freshSession.tool.memory_history.execute({ memory_id: memoryID })).output).results;
  assert.deepEqual(events.map((event) => event.event), ['ADD', 'UPDATE']);
  assert.equal(JSON.parse((await freshSession.tool.memory_search.execute({ query: 'compass' })).output).results[0].memory, 'The compass is in the green vault.');
  assert.equal(JSON.parse((await freshSession.tool.memory_delete.execute({ memory_id: memoryID })).output).message, 'Memory deleted successfully!');
  await assert.rejects(() => freshSession.tool.memory_get.execute({ memory_id: memoryID }), /Mem0 HTTP 404/);
  for (const [name, value] of [['NLA_MEM0_URL', previous.url], ['NLA_MEM0_TIMEOUT_MS', previous.timeout], ['NLA_MEM0_USER_ID', previous.user]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const client = new Mem0HttpClient(config);
  assert.equal(resolveMem0UserID(undefined, config.userID), 'stable-user');
  assert.throws(() => mem0Config({ NLA_MEM0_URL: 'file:///tmp/mem0' }), /HTTP or HTTPS/);
  assert.throws(() => mem0Config({ NLA_MEM0_URL: 'http://token@127.0.0.1:8765' }), /must not contain credentials/);
  assert.throws(() => client.search({ query: 'x', userID: 'u', limit: 21 }), /1 to 20/);
  assert.throws(() => client.list({ userID: 'u', limit: 101 }), /1 to 100/);
  console.log('NLA Mem0 client tests passed');
} finally {
  server.close();
  await once(server, 'close');
}
