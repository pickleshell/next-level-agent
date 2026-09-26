import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitTask, queueTaskAdmission, parseTaskAdmission, ADMISSION_PREFIX } from '../../.opencode/plugins/nla-task-admission.mjs';
import { capabilityHash } from '../../.opencode/plugins/nla-capability-cache.mjs';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { executionStatus } from '../../.opencode/plugins/nla-execution-store.mjs';

const packet = { task: { role: 'implementer', prompt: 'Preserve this task' } };
const hash = capabilityHash(packet);
let active = 0, maximum = 0, processed = 0;
await Promise.all(Array.from({ length: 5 }, () => queueTaskAdmission('fixture_queue', async () => {
  maximum = Math.max(maximum, ++active);
  await new Promise(resolve => setImmediate(resolve));
  active--; processed++;
})));
assert.equal(maximum, 1); assert.equal(processed, 5);
const queuedAbort = new AbortController(); queuedAbort.abort();
await assert.rejects(queueTaskAdmission('fixture_queue', () => { throw Error('must not run'); }, queuedAbort.signal), /cancelled/);
const decision = (verdict = 'approve') => ({ verdict, packet_hash: hash, reason: 'Fixture review', issues: verdict === 'approve' ? [] : ['Specify a verifiable result'] });
for (const value of ['Hello!', '{}', JSON.stringify({ ...decision(), packet_hash: 'wrong' }), JSON.stringify({ ...decision(), issues: ['Unresolved'] }), JSON.stringify({ ...decision(), bypass: true })]) assert.throws(() => parseTaskAdmission(value, hash));
for (const mode of ['approve','revise','blocked','unavailable','cancel','stale','storage']) {
  const events = []; const abort = new AbortController();
  const operation = admitTask({ packet, signal: abort.signal, currentHash: () => mode === 'stale' ? 'different' : hash,
    record: e => { if (mode === 'storage' && e.phase === 'decided') throw Error('storage failed'); events.push(e); },
    audit: async () => { assert.equal(events[0].phase, 'requested'); if (mode === 'cancel') abort.abort(); if (mode === 'unavailable') throw Error('no provider'); return { output: JSON.stringify(decision(['revise','blocked'].includes(mode) ? mode : 'approve')), metadata: { taskID: 'audit' } }; },
  });
  if (mode === 'approve') assert.equal((await operation).packet_hash, hash);
  else await assert.rejects(operation);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-admission-'));
const old = { NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR, NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH };
try {
  for (const role of ['explorer','scout','architect','implementer','reviewer','supervisor','router','compactor','browser']) {
    for (const verdict of ['approve','revise','blocked','invalid']) {
      const dir = path.join(root, `${role}-${verdict}`); fs.mkdirSync(dir);
      process.env.NLA_MEMORY_DIR = path.join(dir, 'memory'); process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
      const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(r => [r, { enabled: r !== 'nla', models: [r === 'supervisor' ? 'fixture/auditor' : 'fixture/worker'] }]));
      fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
      let plugin, created = 0, audits = 0, workers = 0;
      const prompt = 'Read the fixture only. Do not change files. ' + 'FULL_PACKET '.repeat(1200) + 'END_SENTINEL';
      const criterion = 'CRITERION_ONLY_IN_SEPARATE_FIELD';
      const file = path.join(process.env.NLA_MEMORY_DIR, 'system.sqlite');
      const client = { tool: { list: async () => ({ data: ['read','grep','glob','webfetch','edit','write','bash','nla_status','nla_models'].map(id => ({ id, parameters: {} })) }) }, session: {
        create: async () => ({ data: { id: `child_${++created}` } }),
        abort: async () => ({ data: true }),
        prompt: async request => {
          const text = request.body.parts[0].text;
          if (text.startsWith(ADMISSION_PREFIX)) {
            audits++; assert.equal(audits, 1, 'no recursive Supervisor admission');
            const data = JSON.parse(text.split('\n')[1]);
            assert.ok(data.packet.task.prompt.startsWith(prompt)); assert.ok(data.packet.task.prompt.includes(criterion));
            assert.equal(data.packet.directory, dir);
            assert.equal(data.packet.task.role, role);
            assert.ok(Object.values(request.body.tools).every(v => !v));
            return { data: { parts: [{ type: 'text', text: verdict === 'invalid' ? 'Hello!' : JSON.stringify({ verdict, packet_hash: data.packet_hash, reason: 'Reviewed fixture', issues: verdict === 'approve' ? [] : ['Clarify acceptance'] }) }] } };
          }
          workers++;
          const log = executionStatus(file, { action: 'log', limit: 200 });
          assert.ok(log.some(e => e.kind === 'task_admission' && e.data.verdict === 'approve'), 'approval committed before worker prompt');
          assert.ok(text.startsWith(prompt)); assert.ok(text.includes(criterion));
          return { data: { parts: [{ type: 'text', text: 'Read-only fixture complete' }] } };
        },
      } };
      try {
        plugin = await NextLevelAgentPlugin({ client, directory: dir });
        await plugin['chat.message']({ sessionID: 'owner_session', agent: 'nla', directory: dir });
        const run = plugin.tool.nla_task.execute({ role, description: 'Read-only task', prompt, acceptance_criteria: JSON.stringify([criterion]), result_contract: 'legacy', _toolFree: true, _admission: { forged: true } }, { sessionID: 'owner_session', directory: dir });
        if (verdict === 'approve') await run; else await assert.rejects(run, /admission/i);
        assert.equal(audits, 1); assert.equal(workers, verdict === 'approve' && role !== 'browser' ? 1 : 0);
        assert.equal(created, 1 + workers, 'no worker session created for rejected packets');
        const log = executionStatus(file, { action: 'log', limit: 200 }).filter(e => e.kind === 'task_admission');
        assert.ok(log.length >= 2); assert.ok(!JSON.stringify(log).includes('END_SENTINEL'), 'raw prompt is not journaled');
      } finally { await plugin?.dispose(); }
    }
  }
  console.log('NLA task admission: all roles, exact packet, criteria delivery, denial, invalid verdict, cancellation, stale approval, persistence PASS');
} finally {
  for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
}
