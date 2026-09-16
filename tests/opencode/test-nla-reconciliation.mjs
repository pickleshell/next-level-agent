import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileGitWorkspace, reconcileWorkState } from '../../.opencode/plugins/nla-reconciliation.mjs';
const run = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const commit = (repo, name, content) => { fs.writeFileSync(path.join(repo, 'file.txt'), content); run(repo, 'add', 'file.txt'); run(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', name); return run(repo, 'rev-parse', 'HEAD'); };
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-git-test-'));
run(repo, 'init', '-b', 'main');
const first = commit(repo, 'first', 'one');
try {
  const equal = reconcileGitWorkspace(repo, { head: first, branch: 'main', worktree: 'clean' });
  assert.equal(equal.observed.head, first); assert.equal(equal.observed.worktree, 'clean'); assert.deepEqual(equal.observed.changed_files, []); assert.deepEqual(equal.conflicts, []);
  const second = commit(repo, 'second', 'two');
  const advanced = reconcileGitWorkspace(repo, { head: first, branch: 'main', worktree: 'clean' });
  assert.deepEqual(advanced.observed.commits_since_saved_head, { status: 'ancestor', commits: [second] }); assert.ok(advanced.conflicts.includes('head_advanced_or_changed'));
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
  const dirty = reconcileGitWorkspace(repo, { head: second, branch: 'main', worktree: 'clean' });
  assert.equal(dirty.observed.worktree, 'dirty'); assert.deepEqual(dirty.observed.changed_files, ['dirty.txt']); assert.ok(dirty.conflicts.includes('worktree_state_changed'));
  fs.rmSync(path.join(repo, 'dirty.txt')); assert.equal(reconcileGitWorkspace(repo, dirty.observed).observed.worktree, 'clean');
  run(repo, 'checkout', '-b', 'feature');
  assert.ok(reconcileGitWorkspace(repo, { head: second, branch: 'main', worktree: 'clean' }).conflicts.includes('branch_changed'));
  assert.equal(reconcileGitWorkspace(repo, { head: 'deadbeef', branch: 'main', worktree: 'clean' }).observed.commits_since_saved_head.status, 'unavailable_or_non_ancestor');
  const ledger = reconcileWorkState({ workflow_stage: 'implementation', verification: ['tests passed'], verification_evidence: [{ head: first, command: 'tests' }], repository_state: { head: first, branch: 'main', worktree: 'clean' }, next_step: 'review' }, repo);
  assert.equal(ledger.workflow_stage, 'implementation'); assert.equal(ledger.repository_state.head, second); assert.equal(ledger.verification_status.all_current, false); assert.equal(ledger.verification_status.evidence[0].current, false);
} finally { fs.rmSync(repo, { recursive: true, force: true }); }
console.log('NLA Git reconciliation and revision-bound verification tests passed');
