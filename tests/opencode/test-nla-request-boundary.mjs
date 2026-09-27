import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { configureRequestTimeouts } from '../../.opencode/plugins/nla-request-timeouts.mjs';

const config = { provider: { custom: { options: { headerTimeout: 1234, chunkTimeout: false, timeout: 9999, apiKey: 'fixture' } } } };
configureRequestTimeouts(config, ['fixture/model']);
assert.deepEqual(config.provider.fixture.options, { headerTimeout: 300000, chunkTimeout: 300000, timeout: false });
assert.deepEqual(config.provider.custom.options, { headerTimeout: 1234, chunkTimeout: false, timeout: 9999, apiKey: 'fixture' });
configureRequestTimeouts(config, ['fixture/model']);
assert.equal(config.provider.fixture.options.timeout, false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-request-boundary-'));
const previous = { NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH, NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR };
let plugin;
try {
  process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
  process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
  const roles = Object.fromEntries(['nla', 'router', 'supervisor', 'scout', 'explorer', 'architect', 'implementer', 'reviewer', 'compactor'].map(role => [role, {
    enabled: role !== 'nla', selection_mode: 'fallback', models: ['fixture/model'], idle_timeout_ms: 5,
  }]));
  fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
  let calls = 0, aborts = 0;
  plugin = await NextLevelAgentPlugin({ directory: dir, client: { session: {
    create: async () => ({ data: { id: 'child_boundary' } }),
    abort: async () => { aborts++; return { data: true }; },
    prompt: async () => {
      calls++;
      // session.prompt encompasses many LLM requests and tool executions.
      for (let i = 0; i < 3; i++) {
        await plugin['tool.execute.before']({ tool: 'read', sessionID: 'child_boundary', callID: `read_${i}` }, { args: {} });
        await new Promise(resolve => setTimeout(resolve, 20));
        await plugin['tool.execute.after']({ tool: 'read', sessionID: 'child_boundary', callID: `read_${i}`, args: {} }, { output: 'file', metadata: {} });
      }
      return { data: { parts: [{ type: 'text', text: 'completed after multiple requests and tools' }] } };
    },
  } } });
  await plugin['chat.message']({ sessionID: 'primary_boundary', agent: 'nla', directory: dir });
  const result = await plugin.tool.nla_task.execute({ role: 'architect', description: 'Read architecture', prompt: 'Inspect repository files read-only.' }, { sessionID: 'primary_boundary', directory: dir, abort: new AbortController().signal });
  assert.match(result.output, /completed after multiple/);
  assert.equal(calls, 1);
  assert.equal(aborts, 0, 'legacy idle timeout must never abort a working subagent');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.opencode/agent-run.log'), 'utf8'), /model_attempt_failed|model_cooldown_started/);
  console.log('NLA subagent lifetime has no timeout: PASS');
} finally {
  await plugin?.dispose();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(dir, { recursive: true, force: true });
}
