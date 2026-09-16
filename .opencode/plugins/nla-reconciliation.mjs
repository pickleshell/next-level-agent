import { execFileSync } from 'node:child_process';

function git(directory, args) { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function changedFiles(directory) { const output = git(directory, ['status', '--porcelain=v1', '--untracked-files=all']); return output ? output.split('\n').map((line) => line.slice(3).trim()).filter(Boolean) : []; }
function commitsSince(directory, savedHead, currentHead) {
  if (!savedHead) return { status: 'not_recorded', commits: [] };
  try {
    execFileSync('git', ['-C', directory, 'merge-base', '--is-ancestor', savedHead, currentHead], { stdio: 'ignore' });
    const output = git(directory, ['log', '--format=%H', `${savedHead}..${currentHead}`]);
    return { status: 'ancestor', commits: output ? output.split('\n') : [] };
  } catch { return { status: 'unavailable_or_non_ancestor', commits: [] }; }
}

export function reconcileGitWorkspace(directory, saved = null) {
  try {
    const head = git(directory, ['rev-parse', 'HEAD']);
    const branch = git(directory, ['branch', '--show-current']) || null;
    const files = changedFiles(directory);
    const observed = { git_backed: true, branch, head, worktree: files.length ? 'dirty' : 'clean', changed_files: files, commits_since_saved_head: commitsSince(directory, saved?.head || null, head) };
    const conflicts = [];
    if (saved?.head && saved.head !== head) conflicts.push('head_advanced_or_changed');
    if (saved?.branch && saved.branch !== branch) conflicts.push('branch_changed');
    if (saved?.worktree && saved.worktree !== observed.worktree) conflicts.push('worktree_state_changed');
    return { observed, saved: saved || null, conflicts };
  } catch (error) { return { observed: { git_backed: false, error: `git state unavailable: ${error.message}` }, saved: saved || null, conflicts: ['git_state_unavailable'] }; }
}

export function reconcileWorkState(ledger, directory = ledger.directory) {
  const saved = ledger.repository_state && typeof ledger.repository_state === 'object' ? ledger.repository_state : null;
  const reconciliation = reconcileGitWorkspace(directory, saved);
  const currentHead = reconciliation.observed.head || null;
  const evidence = Array.isArray(ledger.verification_evidence) ? ledger.verification_evidence : [];
  const verification = evidence.length ? evidence.map((item) => ({ ...item, current: Boolean(item && item.head && item.head === currentHead) })) : (ledger.verification || []).map((item) => ({ evidence: item, head: null, current: false, reason: 'legacy evidence has no recorded HEAD' }));
  return { ...ledger, repository_state: reconciliation.observed, repository_reconciliation: { saved: reconciliation.saved, conflicts: reconciliation.conflicts, commits_since_saved_head: reconciliation.observed.commits_since_saved_head }, verification_status: { current_head: currentHead, evidence: verification, all_current: verification.length > 0 && verification.every((item) => item.current) } };
}
