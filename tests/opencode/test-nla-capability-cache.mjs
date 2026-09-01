import assert from 'node:assert/strict';
import {
  capabilityHash, parseCapabilityCache, resolveRoleCapabilityProfile, serializeCapabilityCache,
} from '../../.opencode/plugins/nla-capability-cache.mjs';
import { deterministicToolShortlist, ROLE_TOOL_CEILINGS } from '../../.opencode/plugins/nla-prompt-optimizer.mjs';

const catalog = ROLE_TOOL_CEILINGS.implementer.map((id) => ({
  id, description: `${id} description`, parameters: { type: 'object', properties: { value: { type: 'string' } } },
}));
const base = {
  role: 'implementer', ceiling: ROLE_TOOL_CEILINGS.implementer, required: ['read', 'edit'],
  catalog, configSignature: capabilityHash({ config: 1 }),
};

const empty = parseCapabilityCache('');
const miss = resolveRoleCapabilityProfile({ ...base, cache: empty });
assert.equal(miss.source, 'cache-miss');
assert.deepEqual(miss.tools, ROLE_TOOL_CEILINGS.implementer);

const roundTripped = parseCapabilityCache(serializeCapabilityCache(miss.cache));
const hit = resolveRoleCapabilityProfile({ ...base, cache: roundTripped });
assert.equal(hit.source, 'cache-hit');
assert.deepEqual(hit.tools, miss.tools);

const truncatedEntry = structuredClone(roundTripped);
truncatedEntry.entries.implementer.tools = ['read', 'grep', 'edit'];
const truncatedMiss = resolveRoleCapabilityProfile({ ...base, cache: truncatedEntry });
assert.equal(truncatedMiss.source, 'cache-miss');
assert.deepEqual(truncatedMiss.tools, ROLE_TOOL_CEILINGS.implementer);

const changedCatalog = catalog.map((item) => item.id === 'bash'
  ? { ...item, parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
  : item);
const invalidated = resolveRoleCapabilityProfile({ ...base, catalog: changedCatalog, cache: hit.cache });
assert.equal(invalidated.source, 'cache-miss');
assert.notEqual(invalidated.key, hit.key);

const corrupted = parseCapabilityCache('{not-json');
const rebuilt = resolveRoleCapabilityProfile({ ...base, cache: corrupted });
assert.equal(rebuilt.source, 'cache-miss');
assert.deepEqual(rebuilt.tools, ROLE_TOOL_CEILINGS.implementer);

assert.throws(
  () => resolveRoleCapabilityProfile({ role: 'unknown', ceiling: undefined, required: [], catalog, cache: empty, configSignature: 'x' }),
  /No safe tool policy/,
);
assert.throws(
  () => resolveRoleCapabilityProfile({ ...base, catalog: catalog.filter((item) => item.id !== 'edit'), cache: empty }),
  /missing a required implementer capability/,
);

const reducedProfile = ['read', 'grep', 'edit', 'bash'];
const shortlist = deterministicToolShortlist('implementer', 'Edit existing source and run tests.', reducedProfile);
assert.ok(shortlist.every((id) => reducedProfile.includes(id)));
assert.ok(shortlist.length <= reducedProfile.length);
assert.ok(shortlist.length <= 5);
assert.throws(
  () => deterministicToolShortlist('implementer', 'Create a new file.', ['read', 'grep', 'edit', 'bash']),
  /lacks a tool required by the bounded step: write/,
);

console.log('NLA capability cache tests passed');
