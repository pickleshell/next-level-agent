import assert from 'node:assert/strict';
import { Mem0HttpClient, mem0Config } from '../../.opencode/plugins/nla-mem0-client.mjs';

if (process.env.NLA_MEM0_E2E !== '1') {
  console.log('NLA Mem0 real E2E skipped (set NLA_MEM0_E2E=1)');
  process.exit(0);
}

const config = mem0Config(process.env);
const userID = `nla-mem0-e2e-${Date.now()}`;
const marker = `NLA-MEM0-${Date.now()}-EXACT`;
const firstSession = new Mem0HttpClient(config);
const added = await firstSession.add({
  text: `The durable marker ${marker} is stored in the silver cabinet.`,
  userID,
  infer: false,
});
assert.ok(Array.isArray(added.results) && added.results.length > 0, 'Mem0 must extract a memory');
assert.match(added.results[0].memory, new RegExp(marker), 'Mem0 must preserve the exact marker');
const memoryID = added.results[0].id;

const freshSession = new Mem0HttpClient(config);
const found = await freshSession.search({ query: `Where is ${marker} stored?`, userID });
assert.ok(found.results.some((item) => item.memory.includes(marker)), 'fresh client must retrieve the durable marker');
assert.ok((await freshSession.list({ userID })).results.some((item) => item.id === memoryID));
assert.equal((await freshSession.get({ memoryID, userID })).id, memoryID);
const replacement = `The durable marker ${marker} is stored in the gold vault.`;
assert.equal((await freshSession.update({ memoryID, userID, text: replacement })).memory.memory, replacement);
assert.equal((await freshSession.get({ memoryID, userID })).memory, replacement);
assert.deepEqual((await freshSession.history({ memoryID, userID })).results.map((event) => event.event), ['ADD', 'UPDATE']);
assert.ok((await freshSession.search({ query: marker, userID })).results.some((item) => item.memory === replacement));
assert.equal((await freshSession.delete({ memoryID, userID })).message, 'Memory deleted successfully!');
await assert.rejects(() => freshSession.get({ memoryID, userID }), /Mem0 HTTP 404/);
assert.ok(!(await freshSession.list({ userID })).results.some((item) => item.id === memoryID));
console.log(JSON.stringify({ user_id: userID, marker, memory_id: memoryID, history: ['ADD', 'UPDATE'], deleted: true }));
console.log('NLA Mem0 real E2E passed');
