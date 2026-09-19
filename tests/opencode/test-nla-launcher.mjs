import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-launcher-test-'));
const bin = path.join(root, 'bin');
const capture = path.join(root, 'args');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$NLA_TEST_CAPTURE"\nprintf "%s\\n" "$NLA_HOME" "$OPENCODE_CONFIG" "${NLA_MODEL_POOLS_PATH-unset}" "${NLA_BROWSER_CONFIG_PATH-unset}" > "$NLA_TEST_CAPTURE.env"\n', { mode: 0o755 });
const launcher = path.resolve('scripts/nla');
const cleanEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: `${bin}:${process.env.PATH}`, NLA_TEST_CAPTURE: capture };
for (const key of ['NLA_HOME', 'OPENCODE_CONFIG', 'NLA_MODEL_POOLS_PATH', 'NLA_BROWSER_CONFIG_PATH']) delete cleanEnv[key];
const run = (args, overrides = {}) => spawnSync(launcher, args, { cwd: root, env: { ...cleanEnv, ...overrides }, encoding: 'utf8' });
try {
  let result = run(['run', 'hello']);
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), ['-m', 'opencode-go/gpt-5.6-luna', 'run', 'hello']);
  result = run(['serve', '--hostname', '127.0.0.1', '--port', '18766']);
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), ['serve', '--hostname', '127.0.0.1', '--port', '18766']);
  result = run(['models']);
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), ['models']);
  assert.deepEqual(fs.readFileSync(capture + '.env', 'utf8').trim().split('\n'), [path.resolve('.'), path.resolve('opencode.json'), 'unset', 'unset']);
  result = run(['run', '--model', 'custom/model', 'hello']);
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), ['run', '--model', 'custom/model', 'hello']);
  const privateDir = path.join(root, 'config/nla'); fs.mkdirSync(privateDir, { recursive: true });
  for (const name of ['model-pools.json', 'browser.json']) fs.writeFileSync(path.join(privateDir, name), '{}');
  run(['serve']);
  assert.deepEqual(fs.readFileSync(capture + '.env', 'utf8').trim().split('\n').slice(2), [path.join(privateDir, 'model-pools.json'), path.join(privateDir, 'browser.json')]);
  run(['serve'], { NLA_MODEL_POOLS_PATH: '/explicit/missing.json' });
  assert.equal(fs.readFileSync(capture + '.env', 'utf8').split('\n')[2], '/explicit/missing.json');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('NLA launcher dispatch regression passed');
