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
});
assert.ok(Array.isArray(added.results) && added.results.length > 0, 'Mem0 must extract a memory');
assert.match(added.results[0].memory, new RegExp(marker), 'Mem0 must preserve the exact marker');

const freshSession = new Mem0HttpClient(config);
const found = await freshSession.search({ query: `Where is ${marker} stored?`, userID });
assert.ok(found.results.some((item) => item.memory.includes(marker)), 'fresh client must retrieve the durable marker');
console.log(JSON.stringify({ user_id: userID, marker, added: added.results[0], search_results: found.results.length }));
console.log('NLA Mem0 real E2E passed');
