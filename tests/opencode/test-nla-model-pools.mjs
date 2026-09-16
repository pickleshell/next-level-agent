import assert from 'node:assert/strict';
import { modelPoolsPath, loadModelPools, retryableProviderError } from '../../.opencode/plugins/next-level-agent.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const original = process.env.NLA_MODEL_POOLS_PATH;
try {
  delete process.env.NLA_MODEL_POOLS_PATH;
  const expected = {"nla":["opencode-go/gpt-5.6-luna"],"router":["opencode/mimo-v2.5-free","opencode/nemotron-3-ultra-free","opencode-go/gpt-5.6-luna"],"supervisor":["opencode/nemotron-3-ultra-free","opencode-go/gpt-5.6-terra"],"scout":["opencode/mimo-v2.5-free","ollama/qwen3.8:latest"],"explorer":["ollama/qwen3.8:latest","opencode/mimo-v2.5-free"],"architect":["opencode/nemotron-3-ultra-free","ollama/qwen3.8:latest"],"implementer":["opencode/big-pickle","ollama/qwen3.8:latest"],"reviewer":["opencode/nemotron-3-ultra-free","opencode/big-pickle","opencode-go/gpt-5.6-luna"],"compactor":["qwen3.8:latest"]};
  assert.deepEqual(Object.fromEntries(Object.entries(loadModelPools()).map(([role, pool]) => [role, pool.models])), expected);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-pool-test-'));
  try {
    const override = path.join(tempDir, 'pools.json');
    fs.writeFileSync(override, JSON.stringify({ roles: { explorer: { models: ['fixture/override'] } } }));
    process.env.NLA_MODEL_POOLS_PATH = override;
    assert.deepEqual(loadModelPools(), { explorer: { models: ['fixture/override'] } });
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
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
