export const CHILD_RECOVERY_GUIDANCE = 'Continue the existing assignment, not a fresh implementation. Earlier tools may have changed files even if the previous model returned no final report. Inspect the current worktree and tool evidence first; preserve existing changes. Separate recorded tests from tests you reproduce. Do not repeat external side effects or expand permissions. Keep the approved scope, constraints, blockers and exact next step. A partial answer is not task completion.';

export function incompleteChildResult(result, contextWindow = 0) {
  const info = result?.data?.info || {};
  if (info.error) {
    if (info.error.name === 'ContextOverflowError') return 'context_limit';
    return null;
  }
  if (info.finish === 'length') {
    const t = info.tokens || {};
    const total = t.total || (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
    return contextWindow > 0 && total >= contextWindow ? 'context_limit' : 'output_limit';
  }
  const text = (result?.data?.parts || []).some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim());
  return text ? null : 'empty_result';
}

export function childRecoveryError(reason) {
  return Object.assign(new Error(`NLA child result incomplete: ${reason}; prior tool effects must be inspected`), { code: 'NLA_CHILD_INCOMPLETE', recoveryReason: reason });
}

// Called only after session.prompt has settled. Unlike mid-turn compaction,
// awaiting summarize here cannot wait on our own running child tool hook.
export async function recoverChildResult({ initial, invoke, compact, signal, contextWindow, report = () => {} }) {
  const checkCancelled = () => { if (signal.aborted) throw new Error('NLA pooled task aborted by caller'); };
  checkCancelled();
  const reason = incompleteChildResult(initial, contextWindow);
  if (!reason) return initial;
  report('child_result_incomplete', reason);
  try {
    checkCancelled();
    if (reason !== 'empty_result') {
      await compact();
      checkCancelled();
      report('child_context_compacted', reason);
    }
    const result = await invoke();
    checkCancelled();
    const remaining = incompleteChildResult(result, contextWindow);
    if (remaining) throw childRecoveryError(remaining);
    if (!result?.data?.info?.error) report('child_recovery_completed', reason);
    return result;
  } catch (error) {
    checkCancelled();
    if (error.code === 'NLA_CHILD_INCOMPLETE') throw error;
    // Transport/compaction errors here do not prove the task model is faulty.
    // The caller confirms child stop before attempting another eligible model.
    throw childRecoveryError('recovery_failed');
  }
}
