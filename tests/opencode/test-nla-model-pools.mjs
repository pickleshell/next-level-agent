import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelPoolSummary } from '../../.opencode/plugins/nla-model-pools.mjs';
import { ModelHealthManager, classifyProviderError } from '../../.opencode/plugins/nla-model-health.mjs';
import { availablePoolModels, effectiveModelPools, formatModelPools, modelCooldownMs, modelPoolsPath, retryableProviderError } from '../../.opencode/plugins/next-level-agent.js';

const defaultPath = path.resolve('config/model-pools.json');
const original = process.env.NLA_MODEL_POOLS_PATH;
try {
  delete process.env.NLA_MODEL_POOLS_PATH;
  const resolved = effectiveModelPools();
  assert.equal(resolved.source, defaultPath);
  assert.equal(resolved.resolution, 'repository/package default');
  assert.ok(Object.values(resolved.roles).every((pool) => !pool.models.some((model) => /hy3/i.test(model))));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-pool-test-'));
  try {
    const override = path.join(tempDir, 'pools.json');
    fs.writeFileSync(override, JSON.stringify({ roles: { explorer: { enabled: true, models: ['fixture/primary', 'fixture/fallback'] } } }));
    process.env.NLA_MODEL_POOLS_PATH = override;
    const overridden = effectiveModelPools();
    assert.equal(overridden.source, override);
    assert.equal(overridden.resolution, 'NLA_MODEL_POOLS_PATH');
    assert.deepEqual(overridden.roles.explorer.models, ['fixture/primary', 'fixture/fallback']);
    assert.match(formatModelPools(overridden), /fixture\/primary.*fixture\/fallback/s);
    const explicit = path.join(tempDir, 'explicit.json');
    fs.writeFileSync(explicit, JSON.stringify({ roles: { explorer: { models: ['fixture/explicit'] } } }));
    assert.deepEqual(effectiveModelPools({ explicitPath: explicit }).roles.explorer.models, ['fixture/explicit']);
    process.env.NLA_MODEL_POOLS_PATH = path.join(tempDir, 'missing.json');
    assert.throws(() => effectiveModelPools(), /Could not load model pools/);
  } finally { fs.rmSync(tempDir, { recursive: true }); }
} finally {
  if (original === undefined) delete process.env.NLA_MODEL_POOLS_PATH;
  else process.env.NLA_MODEL_POOLS_PATH = original;
}
process.env.NLA_MODEL_POOLS_PATH = '~/machine-local/model-pools.json';
assert.equal(modelPoolsPath('/tmp/nla-home'), '/tmp/nla-home/machine-local/model-pools.json');
if (original === undefined) delete process.env.NLA_MODEL_POOLS_PATH;
else process.env.NLA_MODEL_POOLS_PATH = original;
assert.equal(retryableProviderError(new Error('Unexpected server error')), true);
assert.equal(retryableProviderError(new Error('permission denied')), false);
const health = new Map([['provider/down', { until: 2_000, reason: '502 overloaded' }]]);
assert.deepEqual(availablePoolModels(['provider/down', 'provider/backup'], 2, health, 1_000), ['provider/backup']);
assert.deepEqual(availablePoolModels(['provider/down'], 1, health, 1_000), ['provider/down']);
assert.equal(modelCooldownMs({ cooldown_ms: 1234 }, {}), 1234);
console.log('NLA model-pool resolution, introspection, and retry tests passed');
assert.equal(modelPoolSummary({ roles: { explorer: { models: ['fixture/model'] } } })[0].enabled, false);
assert.equal(modelPoolSummary({ roles: { explorer: { enabled: true, models: ['fixture/model'] } } })[0].enabled, true);
assert.equal(classifyProviderError(new Error('Rate limit exceeded. Please try again later.')).category, 'transient');
assert.equal(classifyProviderError({ data: { statusCode: 410 }, message: 'gone' }).category, 'defective');
const clock = { value: 1000 };
const healthManager = new ModelHealthManager({ now: () => clock.value });
healthManager.failure('p/a', new Error('429 rate limit'));
assert.deepEqual(healthManager.candidates(['p/a', 'p/b'], 2).models, ['p/b']);
assert.equal(healthManager.candidates(['p/a'], 1).models.length, 0);
healthManager.failure('p/b', new Error('model not found'));
assert.equal(healthManager.candidates(['p/b'], 1).allQuarantined, true);
healthManager.reset('p/b');
assert.equal(healthManager.candidates(['p/b'], 1).models[0], 'p/b');
