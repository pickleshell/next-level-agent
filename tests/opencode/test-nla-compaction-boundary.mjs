import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { enqueueNativeCompaction } from '../../.opencode/plugins/nla-compaction-queue.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-compact-boundary-'));
const env = { NLA_MEMORY_DIR: path.join(root, 'memory'), NLA_MODEL_POOLS_PATH: path.join(root, 'pools.json'), NLA_CONTEXT_SOFT_TOKENS: '100', NLA_CONTEXT_HARD_TOKENS: '200' };
const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
Object.assign(process.env, env);
const roles = Object.fromEntries(['nla', 'router', 'supervisor', 'scout', 'explorer', 'architect', 'implementer', 'reviewer', 'compactor'].map(role => [role, { enabled: !['nla', 'compactor'].includes(role), models: ['fixture/model'] }]));
fs.writeFileSync(env.NLA_MODEL_POOLS_PATH, JSON.stringify({ version: 1, roles }));
let plugin;
const queue = [], order = [];
let finishSummary, child = 0, failRestore = false;
const client = {
  config: { providers: async () => ({ data: { providers: [{ id: 'fixture', models: { model: { limit: { context: 131072 } } } }] } }) },
  session: {
    create: async () => ({ data: { id: `child_${++child}` } }),
    abort: async () => { throw new Error('Compaction must not abort sessions'); },
    prompt: async req => {
      if (req.body.noReply) {
        if (failRestore) throw new Error('fixture restore failure');
        order.push('restore'); return { data: {} };
      }
      order.push('audit'); return { data: { parts: [{ type: 'text', text: 'CONTINUE' }] } };
    },
    messages: async () => ({ data: queue }),
    summarize: req => {
      assert.equal(req.body.auto, true);
      order.push('queued');
      queue.push({ parts: [{ id: `compact_${queue.length}`, type: 'compaction' }] });
      return new Promise(resolve => { finishSummary = resolve; });
    },
  },
};
const sessionID = 'boundary_primary';
const context = { sessionID, directory: root };
const snapshot = JSON.stringify({ goal: 'Continue a bounded task', workflow_stage: 'implementation', next_step: 'Read remaining files' });
const before = (tool, callID) => plugin['tool.execute.before']({ ...context, tool, callID }, { args: {} });
const after = (tool, callID) => plugin['tool.execute.after']({ ...context, tool, callID });
const usage = input => plugin.event({ event: { type: 'message.updated', properties: { info: { id: `usage_${input}`, role: 'assistant', sessionID, tokens: { input, cache: { read: 0 } } } } } });
try {
  plugin = await NextLevelAgentPlugin({ directory: root, client });
  await plugin['chat.message']({ ...context, agent: 'nla', model: { providerID: 'fixture', modelID: 'model' } });
  await usage(50);
  await before('nla_state', 'low');
  await plugin.tool.nla_state.execute({ snapshot }, context);
  await after('nla_state', 'low');
  assert.equal(queue.length, 0, 'normal context does not compact');
  await usage(150);
  await before('nla_state', 'state');
  await before('mcp_fixture_read', 'parallel');
  await plugin.tool.nla_state.execute({ snapshot }, context);
  await after('nla_state', 'state');
  assert.equal(queue.length, 0, 'wait for other tools, not just nla_task');
  await after('mcp_fixture_read', 'parallel');
  assert.equal(queue.length, 1, 'queued before session.idle, without waiting for summarize completion');
  assert.deepEqual(order, ['audit', 'queued']);
  await after('read', 'duplicate');
  assert.equal(queue.length, 1, 'no duplicate queue requests');
  const compactContext = { context: [] };
  await plugin['experimental.session.compacting']({ sessionID }, compactContext);
  assert.match(compactContext.context.join('\n'), /Read remaining files/);
  const continuation = { enabled: true };
  await plugin['experimental.compaction.autocontinue']({ sessionID }, continuation);
  assert.equal(continuation.enabled, true);
  assert.equal(order.at(-1), 'restore', 'restoration precedes native continuation');
  await plugin.event({ event: { type: 'session.compacted', properties: { sessionID } } });
  assert.equal(order.filter(x => x === 'restore').length, 1, 'event does not restore twice');
  finishSummary({ data: true });
  await before('nla_state', 'stale');
  await plugin.tool.nla_state.execute({ snapshot }, context);
  await after('nla_state', 'stale');
  assert.equal(queue.length, 1, 'old token count cannot trigger another compact');
  await usage(250);
  await before('read', 'hard');
  await after('read', 'hard');
  assert.equal(queue.length, 2, 'hard monitor works without another nla_state');
  failRestore = true;
  const blocked = { enabled: true };
  await plugin['experimental.compaction.autocontinue']({ sessionID }, blocked);
  assert.equal(blocked.enabled, false, 'failed restore prevents auto continuation');
  await assert.rejects(before('read', 'blocked'), /blocked/);
  finishSummary({ data: true });

  let requests = 0;
  await assert.rejects(enqueueNativeCompaction({ client: { session: {
    messages: async () => ({ data: [] }),
    summarize: async () => { requests++; throw new Error('queue failed'); },
  } }, sessionID, model: {}, onError() {}, timeoutMs: 100 }), /queue failed/);
  assert.equal(requests, 1);
  await assert.rejects(enqueueNativeCompaction({ client: { session: {
    messages: async () => ({ data: [] }), summarize: () => new Promise(() => {}),
  } }, sessionID, model: {}, onError() {}, timeoutMs: 30 }), /acknowledgement timed out/);
  console.log('NLA compaction tool-batch boundary, queue acknowledgement, restore and continuation tests passed');
} finally {
  await plugin?.dispose();
  for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
}
