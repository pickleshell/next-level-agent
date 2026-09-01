import assert from 'node:assert/strict';
import { modelPoolsPath, retryableProviderError } from '../../.opencode/plugins/next-level-agent.js';

const original = process.env.NLA_MODEL_POOLS_PATH;
try {
  process.env.NLA_MODEL_POOLS_PATH = '~/machine-local/model-pools.json';
  assert.equal(modelPoolsPath('/tmp/nla-home'), '/tmp/nla-home/machine-local/model-pools.json');
} finally {
  if (original === undefined) delete process.env.NLA_MODEL_POOLS_PATH;
  else process.env.NLA_MODEL_POOLS_PATH = original;
}

assert.equal(retryableProviderError(new Error('Unexpected server error. Check server logs for details.')), true);
assert.equal(retryableProviderError(new Error('permission denied')), false);

// Provider rejection remains a deterministic test fixture; public role pools
// must not depend on a deliberately broken live endpoint to exercise failover.
const providerGoneFixture = new Error('Provider model returned HTTP 410');
assert.equal(retryableProviderError(providerGoneFixture), true);

console.log('NLA model-pool override and retry tests passed');
