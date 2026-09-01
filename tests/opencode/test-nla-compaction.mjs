import assert from 'node:assert/strict';
import { intelligentCheckpoint, parseCompactorOutput } from '../../.opencode/plugins/nla-compaction.mjs';

const ledger = {
  goal: 'Ship safe compaction', tier: 2, workflow_stage: 'verification',
  acceptance_criteria: ['fallback always works'], approved_decisions: ['use role pools'],
  completed_tasks: ['implementation complete'], active_task: null,
  changed_files: ['src/compact.js'], verification: ['pytest: passed'], blockers: [],
  pending_gate: 'review', next_step: 'run reviewer',
};
const sessionID = 'ses_compactor_test';
const directory = '/tmp/project';
const pool = { enabled: true, models: ['provider/model'] };

const intelligent = { ...ledger, completed_tasks: ['Implementation complete; see src/compact.js.'] };
let calls = 0;
const success = await intelligentCheckpoint({
  ledger, sessionID, directory, pool,
  runCompactor: async () => { calls += 1; return { output: JSON.stringify(intelligent) }; },
});
assert.equal(success.mode, 'intelligent');
assert.deepEqual(success.checkpoint.completed_tasks, intelligent.completed_tasks);
assert.equal(calls, 1);

for (const disabledPool of [undefined, { enabled: false, models: ['provider/model'] }, { enabled: true, models: [] }]) {
  const result = await intelligentCheckpoint({
    ledger, sessionID, directory, pool: disabledPool,
    runCompactor: async () => { throw new Error('must not run'); },
  });
  assert.equal(result.mode, 'deterministic');
  assert.equal(result.reason, 'compactor_not_configured');
  assert.equal(result.checkpoint, ledger);
}

for (const failure of [new Error('model unavailable'), new Error('timed out'), new Error('provider error')]) {
  const result = await intelligentCheckpoint({
    ledger, sessionID, directory, pool,
    runCompactor: async () => { throw failure; },
  });
  assert.equal(result.mode, 'deterministic');
  assert.equal(result.checkpoint, ledger);
  assert.match(result.reason, new RegExp(failure.message));
}

for (const output of [
  'not json',
  JSON.stringify({ ...intelligent, next_step: undefined }),
  JSON.stringify({ ...intelligent, goal: 'Ship something else' }),
  JSON.stringify({ ...intelligent, pending_gate: 'complete' }),
  JSON.stringify({ ...intelligent, verification: [] }),
  JSON.stringify({ ...intelligent, verification: ['tests probably passed'] }),
  JSON.stringify({ ...intelligent, changed_files: [] }),
]) {
  const result = await intelligentCheckpoint({
    ledger, sessionID, directory, pool, runCompactor: async () => ({ output }),
  });
  assert.equal(result.mode, 'deterministic');
  assert.equal(result.checkpoint, ledger);
}

assert.throws(
  () => parseCompactorOutput(JSON.stringify({ ...intelligent, changed_files: ['other.js'] }), ledger, sessionID, directory),
  /changed_files provenance/,
);

console.log('NLA Compactor tests passed');
