import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserRequirementHash, createBrowserRecovery, loadBrowserRecovery, validateBrowserRecovery } from '../../.opencode/plugins/nla-browser-recovery.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-recovery-'));
const task = {
  goal: 'Complete A then B', origins: ['https://example.test'],
  permissions: { navigation: true, interaction: false, authentication: false, uploads: false, downloads: false, external_mutation: false },
  success_criteria: [
    { id: 'A', check: 'text_equals', locator: { test_id: 'a' }, expected: 'done', mandatory: true },
    { id: 'B', check: 'text_equals', locator: { test_id: 'b' }, expected: 'pending', mandatory: true },
  ],
};
const result = { metadata: { evidence: path.join(root, 'evidence.json'), browser_result: 'NOT_RUN' } };
fs.writeFileSync(result.metadata.evidence, '{"trusted":true}\n');
try {
  const record = createBrowserRecovery(root, 'primary_123', task, { run_id: 'run-1', id: 'browser-1', child: 'child-1', revision: { head: 'abc' }, events: [] }, result, [
    { id: 'A', status: 'PASS', mandatory: true }, { id: 'B', status: 'NOT_RUN', mandatory: true },
  ]);
  assert.equal(record.next_pending.criterion_id, 'B');
  assert.notEqual(browserRequirementHash(task), browserRequirementHash({ ...task, origins: ['https://other.test'] }));
  assert.notEqual(browserRequirementHash(task), browserRequirementHash({ ...task, permissions: { ...task.permissions, external_mutation: true } }));
  assert.notEqual(browserRequirementHash(task), browserRequirementHash({ ...task, upload_files: ['/tmp/granted'] }));
  assert.deepEqual(validateBrowserRecovery(root, 'primary_123').pending_criteria, ['B']);
  assert.equal(loadBrowserRecovery(root, 'primary_123').owner_session_id, 'primary_123');
  for (const mutate of [
    r => { delete r.policy.origins; },
    r => { r.policy.permissions.external_mutation = true; },
    r => { r.criteria[0].status = 'pending'; },
    r => { r.evidence[0].run_id = 'forged'; },
    r => { r.authentication_tag = 'forged'; },
  ]) {
    const broken = structuredClone(record); mutate(broken);
    const file = path.join(root, 'browser-recovery', 'primary_123.json');
    fs.writeFileSync(file, JSON.stringify(broken));
    assert.throws(() => validateBrowserRecovery(root, 'primary_123'), error => error.code === 'NLA_BROWSER_RECOVERY_BLOCKED');
  }
  fs.writeFileSync(path.join(root, 'browser-recovery', 'primary_123.json'), JSON.stringify(record));
  assert.equal(validateBrowserRecovery(root, 'primary_123').next_pending.criterion_id, 'B');
  fs.rmSync(path.join(root, 'browser-recovery', 'primary_123.json'));
  assert.throws(() => validateBrowserRecovery(root, 'primary_123'), error => error.code === 'NLA_BROWSER_RECOVERY_BLOCKED');
  fs.writeFileSync(path.join(root, 'browser-recovery', 'primary_123.json'), JSON.stringify(record));
  fs.rmSync(path.join(root, 'browser-recovery', 'authentication.key'));
  assert.throws(() => validateBrowserRecovery(root, 'primary_123'), error => error.code === 'NLA_BROWSER_RECOVERY_BLOCKED');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('NLA Browser runtime recovery invariants passed');
