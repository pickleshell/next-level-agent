import assert from 'node:assert/strict';
import { intelligentCheckpoint } from '../../.opencode/plugins/nla-compaction.mjs';
import { runUtilityModel } from '../../.opencode/plugins/nla-utility-runtime.mjs';

if (process.env.NLA_OLLAMA_INTEGRATION !== '1') {
  console.log('NLA Ollama integration skipped (set NLA_OLLAMA_INTEGRATION=1)');
  process.exit(0);
}

const started = Date.now();
const pool = {
  enabled: true, runtime: 'utility', backend: 'ollama',
  provider: { api: 'native', base_url: process.env.NLA_OLLAMA_BASE_URL || 'http://127.0.0.1:11434' },
  models: [process.env.NLA_OLLAMA_MODEL || 'qwen3:4b'], request_timeout_ms: 120000, max_failovers: 0,
  output_format: 'json',
};
const ledger = {
  goal: 'Verify local utility compaction', tier: 2, workflow_stage: 'verification',
  acceptance_criteria: ['preserve verified facts'], approved_decisions: ['use bounded Ollama HTTP'],
  completed_tasks: ['utility runtime implemented'], active_task: null,
  changed_files: ['.opencode/plugins/nla-utility-runtime.mjs'], verification: ['focused tests passed'], blockers: [],
  pending_gate: 'lifecycle', next_step: 'run persistent lifecycle',
};
const result = await intelligentCheckpoint({
  ledger, sessionID: 'ses_ollama_integration', directory: process.cwd(), pool,
  runCompactor: (prompt) => runUtilityModel({ role: 'compactor', pool, prompt }),
});
assert.equal(result.mode, 'intelligent', result.reason);
assert.equal(result.checkpoint.goal, ledger.goal);
assert.deepEqual(result.checkpoint.verification, ledger.verification);
console.log(`NLA Ollama integration passed in ${Date.now() - started}ms`);
