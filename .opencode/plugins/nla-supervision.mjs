import { recordRoleReport, recordRoleDecision } from './nla-execution-store.mjs';
import { assertNoSecrets } from './nla-system-database.mjs';

export const REPORTING_ROLES = new Set(['scout', 'explorer', 'architect', 'implementer', 'reviewer']);
export const REPORT_GUIDANCE = `Use nla_report at meaningful step boundaries, not before every tool. Report kind=start before a substantive step, completed after it with evidence call IDs, issue for a failure, plan_change before changing the approved plan, or handoff when another role is needed. Supply a stable report_id for retries, a short step and summary (no secrets, transcripts or raw output). Reports are claims, not verified acceptance. Normal start/completed reports are recorded without an LLM gate. For deviations await Supervisor's decision; do not execute parallel work while it is pending. A blocked/handoff decision is returned to the coordinator, not permission to delegate yourself. Keep the required final result contract.`;

const bounded = (s, n) => typeof s === 'string' && s.trim() && s.length <= n;
export function validateRoleReport(value) {
  if (!value || !['start','completed','issue','plan_change','handoff'].includes(value.kind)
    || !/^[\w:-]{1,100}$/.test(value.report_id || '') || !bounded(value.step, 100) || !bounded(value.summary, 300)
    || Object.keys(value).some(k => !['report_id','kind','step','summary','evidence'].includes(k))) throw new Error('Application error: invalid role report');
  const evidence = value.evidence || [];
  if (!Array.isArray(evidence) || evidence.length > 10 || evidence.some(x => !/^[\w:-]{1,100}$/.test(x))) throw new Error('Application error: invalid evidence call IDs');
  const report = { report_id: value.report_id, kind: value.kind, step: value.step, summary: value.summary, evidence };
  assertNoSecrets(report, 'Role report');
  return report;
}

export function parseSupervisionDecision(output) {
  if (typeof output !== 'string' || output.length > 2000) throw new Error('Invalid Supervisor decision');
  const value = JSON.parse(output);
  if (!value || !['continue','guidance','switch','blocked','handoff'].includes(value.action) || !bounded(value.reason, 300)
    || Object.keys(value).some(k => !['action','reason','guidance','role'].includes(k))
    || value.guidance !== undefined && !bounded(value.guidance, 300)
    || value.action === 'guidance' && !value.guidance
    || value.action === 'handoff' && !REPORTING_ROLES.has(value.role)
    || value.action !== 'handoff' && value.role !== undefined) throw new Error('Invalid Supervisor decision');
  assertNoSecrets(value, 'Supervisor decision');
  return value;
}

export function supervisionStop(decision) {
  const code = decision.action === 'switch' ? 'NLA_SUPERVISOR_SWITCH' : 'NLA_SUPERVISOR_REQUIRED';
  return Object.assign(new Error(`Supervisor ${decision.action}: ${decision.reason}${decision.role ? `; recommended role=${decision.role}` : ''}`), { code });
}

// One reporter per managed task, shared across its attempts and directory-scoped
// plugin instances. No polling model, recursive Supervisor, or subagent timer.
export function createRoleReporter({ file, taskID, attempt, evidence, audit, alive, halt }) {
  let pending = null, stopped = null, guidance = '', audits = 0;
  const results = new Map();
  const apply = decision => {
    if (['switch','blocked','handoff'].includes(decision.action)) { stopped = decision; halt(supervisionStop(decision)); }
    guidance = `${decision.guidance || decision.reason}${decision.role ? `; recommended role=${decision.role}` : ''}`;
    return decision;
  };
  const persist = write => {
    try { return write(); }
    catch (error) {
      if (error.code === 'NLA_EXECUTION_STORAGE_FAILED') {
        stopped = { action: 'blocked', reason: 'Report persistence failed; reconciliation required' };
        halt(error);
      }
      throw error;
    }
  };
  return {
    get guidance() { return guidance; },
    get pending() { return pending; },
    async barrier() { if (pending) await pending; if (stopped) throw supervisionStop(stopped); },
    nextAttempt() { if (pending) throw new Error('Application error: Supervisor decision still pending'); if (stopped?.action === 'switch') stopped = null; },
    async submit(value) {
      const report = validateRoleReport(value);
      const fingerprint = JSON.stringify(report);
      const same = results.get(report.report_id);
      if (same) {
        if (same.fingerprint !== fingerprint) throw new Error('Application error: conflicting report_id');
        return same.promise;
      }
      if (pending || stopped || !alive()) throw new Error('Application error: task is paused, stopped or no longer active');
      const currentAttempt = attempt();
      const saved = persist(() => recordRoleReport(file, taskID, currentAttempt, report));
      if (saved.duplicate) {
        const decision = saved.decision || { action: 'blocked', reason: 'Prior report has no durable decision; reconcile before resuming' };
        return apply(decision);
      }
      if (['start','completed'].includes(report.kind)) {
        const decision = persist(() => recordRoleDecision(file, taskID, currentAttempt, report.report_id, { action: 'continue', reason: 'Recorded claim within delegated scope; not acceptance', source: 'runtime' }));
        results.set(report.report_id, { fingerprint, promise: Promise.resolve(decision) });
        return decision;
      }
      // Defer model work one microtask so later dispatch hooks see the barrier.
      // Earlier dispatched tools remain subject to the uncertain-effects guard.
      const run = Promise.resolve().then(async () => {
        let decision;
        const facts = evidence();
        if (facts.uncertain_effects) decision = { action: 'blocked', reason: 'Uncertain tool effects require reconciliation before continuation' };
        else if (audits >= 3) decision = { action: 'blocked', reason: 'Bounded incident budget exhausted; coordinator reconciliation required' };
        else {
          audits++;
          try { decision = parseSupervisionDecision(await audit(report, facts)); }
          catch { decision = { action: 'blocked', reason: 'Supervisor unavailable or invalid verdict; no approval inferred' }; }
        }
        if (!alive() || attempt() !== currentAttempt) decision = { action: 'blocked', reason: 'Task attempt changed or was cancelled during assessment' };
        if (evidence().uncertain_effects) decision = { action: 'blocked', reason: 'Tool effects became uncertain during assessment' };
        // Persist before releasing the barrier or requesting a model switch.
        const durable = recordRoleDecision(file, taskID, currentAttempt, report.report_id, { ...decision, source: 'supervisor_gate' });
        return apply(durable);
      }).catch(error => { stopped = { action: 'blocked', reason: 'Incident persistence failed; reconciliation required' }; halt(Object.assign(error, { code: 'NLA_EXECUTION_STORAGE_FAILED' })); throw error; });
      pending = run;
      const promise = run.finally(() => { pending = null; });
      results.set(report.report_id, { fingerprint, promise });
      return promise;
    },
  };
}
