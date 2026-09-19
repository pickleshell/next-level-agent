import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBrowserConfig } from '../../.opencode/plugins/nla-browser.mjs';
import { resolveModelPools } from '../../.opencode/plugins/nla-model-pools.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-setup-'));
try {
  const backend = path.join(root, 'backend');
  fs.mkdirSync(path.join(backend, 'node_modules/@playwright/mcp'), { recursive: true });
  fs.mkdirSync(path.join(backend, 'node_modules/playwright'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'node_modules/@playwright/mcp/cli.js'), '// fixture');
  fs.writeFileSync(path.join(backend, 'node_modules/playwright/index.js'), `exports.chromium = { executablePath: () => ${JSON.stringify(process.execPath)} };`);
  const configDir = path.join(root, 'private');
  const env = { ...process.env }; delete env.NLA_MODEL_POOLS_PATH;
  const run = (...extra) => spawnSync(process.execPath, ['scripts/configure-browser.mjs', '--backend-dir', backend, '--config-dir', configDir, '--model', 'test/browser', '--origin', 'https://example.com', ...extra], { env, encoding: 'utf8' });
  assert.equal(run('--origin', 'file:///tmp').status, 1);
  assert.equal(fs.existsSync(configDir), false);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const browserFile = path.join(configDir, 'browser.json');
  const poolFile = path.join(configDir, 'model-pools.json');
  assert.equal(fs.statSync(browserFile).mode & 0o777, 0o600);
  const config = loadBrowserConfig({ NLA_BROWSER_CONFIG_PATH: browserFile });
  assert.ok(config.command.includes('--isolated'));
  assert.deepEqual(config.allowed_origins, ['https://example.com']);
  const pools = resolveModelPools({ explicitPath: poolFile });
  assert.equal(pools.roles.browser.enabled, true);
  assert.deepEqual(pools.roles.browser.models, ['test/browser']);
  assert.ok(pools.roles.architect);
  const saved = fs.readFileSync(poolFile, 'utf8');
  assert.equal(run('--model', 'other/model').status, 1);
  assert.equal(fs.readFileSync(poolFile, 'utf8'), saved);
  console.log('Browser setup: fresh configuration, runtime parsing, permissions, invalid input and no overwrite PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
