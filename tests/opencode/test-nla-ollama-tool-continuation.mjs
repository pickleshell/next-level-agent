import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-ollama-continuation-'));
const previous = {
  pools: process.env.NLA_MODEL_POOLS_PATH,
  memory: process.env.NLA_MEMORY_DIR,
};
let plugin;

try {
  process.env.NLA_MODEL_POOLS_PATH = path.join(fixture, 'model-pools.json');
  process.env.NLA_MEMORY_DIR = path.join(fixture, 'memory');
  fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({
    roles: {
      explorer: {
        enabled: true,
        models: ['ollama/qwen3.8:latest', 'fixture/fallback'],
        idle_timeout_ms: 0,
      },
    },
  }));

  const calls = [];
  plugin = await NextLevelAgentPlugin({
    directory: fixture,
    client: {
      tool: {
        list: async () => ({
          data: [
            { id: 'read', description: 'read', parameters: {} },
            { id: 'grep', description: 'grep', parameters: {} },
            { id: 'glob', description: 'glob', parameters: {} },
          ],
        }),
      },
      session: {
        create: async () => ({ data: { id: 'explorer_child' } }),
        abort: async () => true,
        prompt: async (request) => {
          const binding = `${request.body.model.providerID}/${request.body.model.modelID}`;
          calls.push(binding);
          if (binding.startsWith('ollama/')) {
            return {
              data: {
                info: {
                  error: {
                    name: 'AI_APICallError',
                    data: { statusCode: 500, message: 'no user query found in messages' },
                  },
                },
              },
            };
          }
          return { data: { parts: [{ type: 'text', text: 'fallback completed' }] } };
        },
      },
    },
  });

  await plugin['chat.message']({ sessionID: 'primary_123', agent: 'nla', directory: fixture });
  const result = await plugin.tool.nla_task.execute(
    { role: 'explorer', description: 'tool continuation regression', prompt: 'Inspect with tools and report.' },
    { sessionID: 'primary_123', directory: fixture, abort: new AbortController().signal },
  );

  assert.deepEqual(calls, ['ollama/qwen3.8:latest', 'fixture/fallback']);
  assert.equal(result.output, 'fallback completed');
  const health = (await plugin.tool.nla_models.execute({}, { sessionID: 'primary_123' })).metadata.health;
  assert.equal(health.find((entry) => entry.binding === 'ollama/qwen3.8:latest').state, 'quarantined');
  assert.equal(health.find((entry) => entry.binding === 'ollama/qwen3.8:latest').reason, 'provider_message_validation_failed');
} finally {
  await plugin?.dispose();
  for (const [key, value] of [['NLA_MODEL_POOLS_PATH', previous.pools], ['NLA_MEMORY_DIR', previous.memory]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('NLA Ollama Explorer tool-continuation fallback regression passed');
