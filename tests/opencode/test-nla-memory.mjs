import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contextTokens, initializeNotebook, loadLedger, normalizeLedger, readNotebook,
  restorePacket, saveLedger, thresholdState, writeNotebookPage,
} from '../../.opencode/plugins/nla-memory.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-memory-test-'));
try {
  const state = normalizeLedger({
    goal: 'Test durable state', tier: 3, workflow_stage: 'implementation',
    acceptance_criteria: ['works'], approved_decisions: ['approved'],
    next_step: 'run tests',
  }, 'ses_test_12345678', '/tmp/project');
  const file = saveLedger(root, state);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadLedger(root, state.session_id).next_step, 'run tests');
  assert.equal(normalizeLedger({ active_task: [] }, 'ses_test_87654321', '/tmp/project').active_task, null);
  assert.match(restorePacket(state), /NLA_RESTORE_PACKET/);

  const notebook = path.join(root, 'assistant-notebook');
  initializeNotebook(notebook);
  writeNotebookPage(notebook, 'Project', '# Project\n\nVerified status.');
  const restored = readNotebook(notebook, 'Project');
  assert.match(restored.contents, /NLA system/);
  assert.match(restored.content, /Verified status/);
  assert.throws(() => writeNotebookPage(notebook, '../escape', 'bad'));
  assert.throws(() => writeNotebookPage(notebook, 'Secrets', 'api_key=abc123'));

  assert.equal(contextTokens({ tokens: { input: 45000, cache: { read: 6000 } } }), 51000);
  assert.equal(thresholdState(51000, 50000, 70000), 'soft');
  assert.equal(thresholdState(71000, 50000, 70000), 'hard');
  console.log('NLA memory tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
