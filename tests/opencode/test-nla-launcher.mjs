import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-launcher-test-'));
const bin = path.join(root, 'bin');
const capture = path.join(root, 'args');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$NLA_TEST_CAPTURE"\n', { mode: 0o755 });
const launcher = path.resolve('scripts/nla');
const run = args => spawnSync(launcher, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NLA_TEST_CAPTURE: capture }, encoding: 'utf8' });
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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('NLA launcher dispatch regression passed');
