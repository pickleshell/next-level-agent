import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { normalizeLedger, saveLedger } from '../../.opencode/plugins/nla-memory.mjs';
import { hasSystemRestoreBlock } from '../../.opencode/plugins/nla-system-database.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-r7-test-'));
const old = Object.fromEntries(['NLA_MODEL_POOLS_PATH', 'NLA_MEMORY_DIR', 'NLA_BROWSER_CONFIG_PATH'].map(key => [key, process.env[key]]));
try {
  const pool = path.join(root, 'models.json');
  const roles = Object.fromEntries(['nla', 'router', 'supervisor', 'scout', 'explorer', 'architect', 'implementer', 'reviewer', 'compactor']
    .map((role) => [role, { enabled: role !== 'nla', models: ['fixture/model'] }]));
  fs.writeFileSync(pool, JSON.stringify({ roles }));
  process.env.NLA_MODEL_POOLS_PATH = pool;
  process.env.NLA_MEMORY_DIR = root;
  const systemDatabase = path.join(root, 'system.sqlite');

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
  const db = new DatabaseSync(systemDatabase);
  const restoreMarker = db.prepare('SELECT reason, code FROM restore_blocks WHERE session_id = ?').get(sessionID);
  db.close();
  assert.equal(restoreMarker.reason, 'restore transport failed');
  assert.equal(restoreMarker.code, 'NLA_CONTEXT_RESTORE_BLOCKED');
  await restorePlugin.dispose();

  // Child compaction is owned by the child runtime, not the primary NLA
  // ledger. It must not create a persistent restore block or deny tools.
  const childPlugin = await NextLevelAgentPlugin({
    directory: root,
    client: { session: { prompt: async () => ({ data: true }) } },
  });
  for (const childID of ['r7-child-compaction-1', 'r7-child-compaction-2', 'r7-child-compaction-3']) {
    await childPlugin['chat.message']({ sessionID: childID, agent: 'implementer', directory: root });
    await childPlugin.event({ event: { type: 'session.compacted', properties: { sessionID: childID } } });
    await childPlugin['tool.execute.before']({ sessionID: childID, tool: 'read' }, { args: {} });
    assert.equal(hasSystemRestoreBlock(systemDatabase, root, childID), false);
  }
  await childPlugin.dispose();

  // Malformed persisted JSON must take the same fail-closed path.
  const malformedID = 'r7-malformed';
  const malformedFile = path.join(root, 'sessions', `${malformedID}.json`);
  const malformedPlugin = await NextLevelAgentPlugin({
    directory: root,
    client: { session: { prompt: async () => ({ data: true }) } },
  });
  await malformedPlugin['chat.message']({ sessionID: malformedID, agent: 'nla', directory: root });
  fs.mkdirSync(path.dirname(malformedFile), { recursive: true });
  fs.writeFileSync(malformedFile, '{not-json');
  await malformedPlugin.event({ event: { type: 'session.compacted', properties: { sessionID: malformedID } } });
  await assert.rejects(
    malformedPlugin['chat.message']({ sessionID: malformedID, agent: 'nla', directory: root }),
    error => error.code === 'NLA_CONTEXT_RESTORE_BLOCKED',
  );
  await malformedPlugin.dispose();
} finally {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('NLA R7 adversarial invariants passed');
