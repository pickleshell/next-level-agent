import assert from 'node:assert/strict';
import {
  deterministicToolShortlist, optimizeInvocation, parseCompactorToolOutput,
  ROLE_TOOL_CEILINGS, toolPermissionMap,
} from '../../.opencode/plugins/nla-prompt-optimizer.mjs';

assert.deepEqual(
  deterministicToolShortlist('implementer', 'Implement the patch, add a new file, and run focused tests.'),
  ['read', 'edit', 'write', 'bash'],
);
assert.deepEqual(deterministicToolShortlist('explorer', 'Inspect repository files and locate references.'), ['read', 'grep', 'glob']);
assert.deepEqual(deterministicToolShortlist('reviewer', 'Review the changed source and run tests.'), ['read', 'grep', 'bash']);
assert.deepEqual(deterministicToolShortlist('router', 'Route this task.'), []);
assert.deepEqual(deterministicToolShortlist('implementer', 'Tool-free reasoning only; use no tools.'), []);

assert.throws(() => parseCompactorToolOutput('{"tools":["read","task"]}', 'explorer'), /outside the role/);
assert.throws(() => parseCompactorToolOutput('not json', 'explorer'), /invalid JSON/);
assert.throws(() => parseCompactorToolOutput('{"tools":["read"]}', 'explorer'), /2-5/);
assert.throws(() => parseCompactorToolOutput('{"tools":["read","glob"]}', 'explorer'), /required deterministic/);
assert.throws(() => deterministicToolShortlist('unknown', 'Do something.'), /No safe tool policy/);
assert.throws(
  () => parseCompactorToolOutput('{"tools":["read","edit","write"]}', 'implementer', ['read', 'edit'], ['read', 'edit']),
  /outside the role capability ceiling/,
);

const bounded = 'Goal: preserve this exact task. Acceptance: tests pass. Provenance: user request.';
const optimized = await optimizeInvocation({
  role: 'implementer', prompt: bounded,
  runCompactor: async () => ({ output: '{"tools":["read","edit","bash"]}', metadata: { usage: { prompt_tokens: 12 } } }),
});
assert.equal(optimized.prompt, bounded);
assert.deepEqual(optimized.tools, ['read', 'edit', 'bash']);
assert.equal(optimized.source, 'utility-compactor');
assert.deepEqual(optimized.compactorMetadata.usage, { prompt_tokens: 12 });

const invalidFallback = await optimizeInvocation({
  role: 'reviewer', prompt: 'Review source changes and run tests.', runCompactor: async () => '{"tools":["read","edit"]}',
});
assert.deepEqual(invalidFallback.tools, ['read', 'grep', 'bash']);
assert.equal(invalidFallback.source, 'deterministic-fallback');

const insufficientFallback = await optimizeInvocation({
  role: 'implementer', prompt: 'Implement a new file and run tests.', runCompactor: async () => '{"tools":["read","edit"]}',
});
assert.deepEqual(insufficientFallback.tools, ['read', 'edit', 'write', 'bash']);
assert.equal(insufficientFallback.source, 'deterministic-fallback');

const unavailableFallback = await optimizeInvocation({ role: 'explorer', prompt: 'Inspect repository files and locate references.' });
assert.equal(unavailableFallback.source, 'deterministic');

const permissions = toolPermissionMap(['read', 'grep']);
assert.deepEqual(permissions, { '*': false, read: true, grep: true });
assert.equal(Object.keys(permissions).length, 3, 'permission map must not enumerate or restore a full catalog');
for (const roleTools of Object.values(ROLE_TOOL_CEILINGS)) assert.ok(roleTools.length <= 5);

const policy = { exclude_models: ['ollama/*', 'opencode/mimo-v2.5-free'] };
let compactorCalls = 0;
const runCompactor = async () => { compactorCalls++; return '{"tools":["read","grep"]}'; };
for (const model of ['ollama/qwen3.8:latest', 'opencode/mimo-v2.5-free']) {
  const result = await optimizeInvocation({ role: 'explorer', prompt: bounded, model, policy, runCompactor });
  assert.equal(result.source, 'deterministic-policy');
  assert.equal(result.prompt, bounded);
  assert.deepEqual(result.tools, ['read', 'grep']);
}
assert.equal(compactorCalls, 0);
await optimizeInvocation({ role: 'explorer', prompt: bounded, model: 'opencode-go/gpt-5.6-luna', policy, runCompactor });
assert.equal(compactorCalls, 1, 'paid fallback must recompute policy for its own model');
await optimizeInvocation({ role: 'explorer', prompt: bounded, model: 'opencode-go/gpt-5.6-luna', policy: { enabled: false }, runCompactor });
assert.equal(compactorCalls, 1);
await assert.rejects(optimizeInvocation({ role: 'explorer', prompt: bounded, policy: { exclude_models: [42] }, runCompactor }), /Invalid/);
console.log('NLA prompt optimizer tests passed');
