import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
