import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { normalizeLedger, saveLedger } from '../../.opencode/plugins/nla-memory.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-r7-test-'));
const old = Object.fromEntries(['NLA_MODEL_POOLS_PATH', 'NLA_MEMORY_DIR', 'NLA_BROWSER_CONFIG_PATH'].map(key => [key, process.env[key]]));
try {
  const pool = path.join(root, 'models.json');
  fs.writeFileSync(pool, JSON.stringify({ roles: { explorer: { enabled: true, models: ['fixture/model'], max_failovers: 0 } } }));
  process.env.NLA_MODEL_POOLS_PATH = pool;
  process.env.NLA_MEMORY_DIR = root;

  // A child created before tool/model preparation must be rolled back.
  let aborts = 0;
  const prepPlugin = await NextLevelAgentPlugin({
    directory: root,
    client: {
      tool: { list: async () => { throw new Error('tool preparation failed'); } },
      session: {
        create: async () => ({ data: { id: 'prep-child' } }),
        abort: async ({ path: requestPath }) => { assert.equal(requestPath.id, 'prep-child'); aborts += 1; return { data: true }; },
      },
    },
  });
  await prepPlugin['chat.message']({ sessionID: 'r7-parent', agent: 'nla', directory: root });
  await assert.rejects(prepPlugin.tool.nla_task.execute({ role: 'explorer', description: 'prep failure', prompt: 'inspect' }, { sessionID: 'r7-parent', directory: root, abort: new AbortController().signal }));
  assert.equal(aborts, 1, 'preparation failure must abort the created child exactly once');
  await prepPlugin.dispose();

  // A failed restore blocks subsequent NLA execution instead of continuing
  // with a partially reconstructed snapshot.
  const sessionID = 'r7-compaction';
  const restorePlugin = await NextLevelAgentPlugin({
    directory: root,
    client: { session: { prompt: async () => { throw new Error('restore transport failed'); } } },
  });
  await restorePlugin['chat.message']({ sessionID, agent: 'nla', directory: root });
  saveLedger(root, normalizeLedger({ goal: 'recover safely', workflow_stage: 'verification', next_step: 'continue' }, sessionID, root));
  await restorePlugin.event({ event: { type: 'session.compacted', properties: { sessionID } } });
  await assert.rejects(
    restorePlugin['chat.message']({ sessionID, agent: 'nla', directory: root }),
    error => error.code === 'NLA_CONTEXT_RESTORE_BLOCKED',
  );
  await restorePlugin.dispose();
} finally {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('NLA R7 adversarial invariants passed');
