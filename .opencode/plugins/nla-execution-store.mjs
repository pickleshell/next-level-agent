import { randomUUID, createHash } from 'node:crypto';
import { withSystemDatabase as accessDatabase, assertNoSecrets } from './nla-system-database.mjs';
import { parseReviewerEvaluation, updateEvaluationScores, latencyScoreFromMs } from './nla-model-evaluations.mjs';
import { sanitizeTelemetry } from './nla-telemetry.mjs';

export const PROCESS_EPOCH = randomUUID();
const time = () => new Date().toISOString();
const id = value => { if (typeof value !== 'string' || !/^[\w:-]{1,160}$/.test(value)) throw new Error('Invalid execution identifier'); return value; };
const text = (value, max = 2000) => { if (typeof value !== 'string' || value.length > max) throw new Error('Invalid bounded execution text'); assertNoSecrets(value, 'Execution record'); return value; };
const decode = row => {
  if (!row) return null;
  const { criteria_json, report_json, ...rest } = row;
  return { ...rest, criteria: JSON.parse(criteria_json), report: report_json ? JSON.parse(report_json) : null };
};
const ACTIVE = ['created', 'running', 'awaiting_report'];
function withSystemDatabase(file, callback, options) {
  try { return accessDatabase(file, callback, options); }
  catch (error) {
    if (/SQLITE|database|disk|readonly|no such table|I\/O/i.test(`${error.code || ''} ${error.message}`)) {
      throw Object.assign(new Error('Application error: execution storage unavailable'), { code: 'NLA_EXECUTION_STORAGE_FAILED', cause: error });
    }
    throw error;
  }
}

function event(db, taskID, kind, data = {}, key = randomUUID(), attemptID = null) {
  const encoded = JSON.stringify(sanitizeTelemetry(data));
  db.prepare('INSERT OR IGNORE INTO task_events(event_key,task_id,attempt_id,kind,data_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(id(key), id(taskID), attemptID, id(kind), encoded, time());
}

export function recoverInterruptedTasks(file, epoch = PROCESS_EPOCH) {
  return withSystemDatabase(file, db => {
    const rows = db.prepare("SELECT task_id FROM task_runs WHERE process_epoch <> ? AND status IN ('created','running','awaiting_report')").all(epoch);
    for (const row of rows) {
      db.prepare("UPDATE task_runs SET status='recovery_required',updated_at=? WHERE task_id=?").run(time(), row.task_id);
      db.prepare("UPDATE task_attempts SET status='interrupted',ended_at=? WHERE task_id=? AND status='running'").run(time(), row.task_id);
      event(db, row.task_id, 'recovery_required', { reason: 'process_restarted_no_automatic_replay' });
    }
    return rows.length;
  }, { write: true });
}

export function createTask(file, value) {
  const taskID = randomUUID();
  const criteria = value.criteria || [];
  if (!Array.isArray(criteria) || criteria.length > 20) throw new Error('Invalid acceptance criteria');
  criteria.forEach(item => text(item, 1000));
  return withSystemDatabase(file, db => {
    db.prepare(`INSERT INTO task_runs(task_id,owner_session_id,root_session_id,role,orchestra,directory,description,criteria_json,status,process_epoch,review_target,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'created',?,?,?,?)`).run(taskID, id(value.owner), id(value.root), id(value.role), text(value.orchestra, 64), text(value.directory), text(value.description, 120), JSON.stringify(criteria), PROCESS_EPOCH, value.reviewTarget || null, time(), time());
    event(db, taskID, 'task_created', { role: value.role, orchestra: value.orchestra });
    return taskID;
  }, { write: true });
}

export function bindTask(file, taskID, childID) {
  return withSystemDatabase(file, db => {
    db.prepare("UPDATE task_runs SET child_session_id=?,status='running',updated_at=? WHERE task_id=? AND status='created'").run(id(childID), time(), id(taskID));
    event(db, taskID, 'child_bound', { session_id: childID });
  }, { write: true });
}

export function startAttempt(file, taskID, ordinal, binding) {
  const attemptID = randomUUID();
  return withSystemDatabase(file, db => {
    const task = db.prepare('SELECT status FROM task_runs WHERE task_id=?').get(id(taskID));
    if (!task || !ACTIVE.includes(task.status)) throw new Error('Task is not dispatchable');
    db.prepare("INSERT INTO task_attempts(attempt_id,task_id,ordinal,binding,status,started_at) VALUES(?,?,?,?,'running',?)").run(attemptID, taskID, ordinal, text(binding, 256), time());
    event(db, taskID, 'attempt_started', { binding, ordinal }, randomUUID(), attemptID);
    return attemptID;
  }, { write: true });
}

export function endAttempt(file, attemptID, status, reason = '') {
  if (!['returned', 'failed', 'cancelled', 'uncertain'].includes(status)) throw new Error('Invalid attempt status');
  return withSystemDatabase(file, db => {
    const attempt = db.prepare('SELECT * FROM task_attempts WHERE attempt_id=?').get(id(attemptID));
    if (!attempt || attempt.status !== 'running') return;
    db.prepare('UPDATE task_attempts SET status=?,reason=?,ended_at=? WHERE attempt_id=?').run(status, text(reason, 180), time(), attemptID);
    event(db, attempt.task_id, 'attempt_finished', { status, reason }, randomUUID(), attemptID);
  }, { write: true });
}

export function finishTask(file, taskID, status, { report = null, revision = null, reason = '' } = {}) {
  if (!['report_ready','report_unverified','blocked','failed','cancelled','recovery_required'].includes(status)) throw new Error('Invalid task outcome');
  assertNoSecrets(report, 'Task report');
  const encoded = report ? JSON.stringify(report) : null;
  if (encoded?.length > 24000) throw new Error('Task report too large');
  return withSystemDatabase(file, db => {
    const row = db.prepare('SELECT status FROM task_runs WHERE task_id=?').get(id(taskID));
    if (!row || !ACTIVE.includes(row.status)) return;
    db.prepare('UPDATE task_runs SET status=?,report_json=?,revision=?,updated_at=? WHERE task_id=?').run(status, encoded, revision, time(), taskID);
    event(db, taskID, 'task_finished', { status, reason });
  }, { write: true });
}

export function recordTaskEvent(file, taskID, attemptID, kind, data, key) {
  return withSystemDatabase(file, db => event(db, taskID, kind, data, key, attemptID), { write: true });
}

// Role reports are claims; runtime observations stay separate. The report is
// durable before any model is asked to judge it. No new parallel task ledger.
function reportKey(taskID, reportID) {
  return `report:${createHash('sha256').update(`${id(taskID)}:${id(reportID)}`).digest('hex')}`;
}

export function recordRoleReport(file, taskID, attemptID, report) {
  assertNoSecrets(report, 'Role report');
  report = { ...report, evidence_status: 'reported_only' };
  const key = reportKey(taskID, report.report_id);
  const payload = JSON.stringify(sanitizeTelemetry(report));
  return withSystemDatabase(file, db => {
    const prior = db.prepare('SELECT data_json FROM task_events WHERE event_key=?').get(key);
    if (prior) {
      if (prior.data_json !== payload) throw new Error('Application error: conflicting report_id; use a new ID for a changed report');
      const decision = db.prepare('SELECT data_json FROM task_events WHERE event_key=?').get(`${key}:decision`);
      return { duplicate: true, decision: decision ? JSON.parse(decision.data_json) : null };
    }
    const task = db.prepare('SELECT status FROM task_runs WHERE task_id=?').get(id(taskID));
    const attempt = db.prepare('SELECT status FROM task_attempts WHERE attempt_id=? AND task_id=?').get(id(attemptID), taskID);
    if (!task || !ACTIVE.includes(task.status) || attempt?.status !== 'running') throw new Error('Application error: report requires a running task attempt');
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND kind='role_report'").get(taskID).n;
    if (count >= 100) throw new Error('Application error: task report limit reached; return a bounded final report');
    event(db, taskID, 'role_report', report, key, attemptID);
    return { duplicate: false, decision: null };
  }, { write: true });
}

export function recordRoleDecision(file, taskID, attemptID, reportID, decision) {
  assertNoSecrets(decision, 'Supervisor decision');
  const key = reportKey(taskID, reportID);
  return withSystemDatabase(file, db => {
    if (!db.prepare('SELECT sequence FROM task_events WHERE event_key=?').get(key)) throw new Error('Application error: missing durable role report');
    const prior = db.prepare('SELECT data_json FROM task_events WHERE event_key=?').get(`${key}:decision`);
    if (prior) return JSON.parse(prior.data_json);
    event(db, taskID, 'role_report_decision', decision, `${key}:decision`, attemptID);
    return decision;
  }, { write: true });
}

export function recordRuntimeEvent(file, entry) {
  const clean = sanitizeTelemetry(entry);
  return withSystemDatabase(file, db => db.prepare('INSERT INTO runtime_events(root_session_id,kind,data_json,created_at) VALUES(?,?,?,?)')
    .run(entry.root_session_id || null, id(entry.event), JSON.stringify(clean), time()), { write: true });
}

export function recordTaskLatency(file, taskID, attemptID, binding, messageID, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return withSystemDatabase(file, db => {
    const key = `latency:${id(messageID)}`;
    if (db.prepare('SELECT sequence FROM task_events WHERE event_key=?').get(key)) return false;
    const attempt = db.prepare('SELECT binding FROM task_attempts WHERE attempt_id=? AND task_id=?').get(id(attemptID), id(taskID));
    if (!attempt || attempt.binding !== binding) return false;
    const old = db.prepare('SELECT * FROM model_evaluations WHERE binding=?').get(binding);
    const scores = updateEvaluationScores(old || {}, { latency: latencyScoreFromMs(elapsedMs) });
    db.prepare(`INSERT INTO model_evaluations(binding,coding,reasoning,tool_use,reliability,latency,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(binding) DO UPDATE SET latency=excluded.latency,updated_at=excluded.updated_at`)
      .run(binding, scores.coding, scores.reasoning, scores.tool_use, scores.reliability, scores.latency, time());
    event(db, taskID, 'request_latency_observed', { elapsed_ms: elapsedMs, source: 'completed_tool_free_assistant_message' }, key, attemptID);
    return true;
  }, { write: true });
}

export function getTask(file, taskOrChildID, owner = null) {
  return withSystemDatabase(file, db => {
    const row = db.prepare('SELECT * FROM task_runs WHERE (task_id=? OR child_session_id=?) AND (? IS NULL OR owner_session_id=?)').get(id(taskOrChildID), taskOrChildID, owner, owner);
    return row ? { ...decode(row), attempts: db.prepare('SELECT * FROM task_attempts WHERE task_id=? ORDER BY ordinal').all(row.task_id), review: db.prepare('SELECT * FROM task_reviews WHERE target_task_id=?').get(row.task_id) || null } : null;
  });
}

export function reviewCandidates(file, owner, directory) {
  return withSystemDatabase(file, db => db.prepare(`SELECT t.task_id,t.child_session_id FROM task_runs t LEFT JOIN task_reviews r ON r.target_task_id=t.task_id
    WHERE t.owner_session_id=? AND t.directory=? AND t.role='implementer' AND t.status IN ('report_ready','report_unverified') AND r.target_task_id IS NULL`).all(owner, directory));
}

export function recordTaskReview(file, targetID, reviewerID, payload, revision) {
  const parsed = parseReviewerEvaluation(payload);
  return withSystemDatabase(file, db => {
    const existing = db.prepare('SELECT * FROM task_reviews WHERE target_task_id=?').get(id(targetID));
    if (existing) return { ...existing, duplicate: true };
    const target = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(targetID);
    const reviewer = db.prepare('SELECT * FROM task_runs WHERE task_id=?').get(id(reviewerID));
    if (!target || !reviewer || target.role !== 'implementer' || reviewer.role !== 'reviewer' || target.owner_session_id !== reviewer.owner_session_id || target.directory !== reviewer.directory || !['report_ready','report_unverified'].includes(target.status)) throw new Error('Invalid independent review target');
    const attempts = db.prepare('SELECT * FROM task_attempts WHERE task_id=? ORDER BY ordinal').all(targetID);
    const bindings = new Set(attempts.map(a => a.binding));
    const current = revision && target.revision === revision;
    const reason = !current ? 'revision_unverified_or_changed' : bindings.size !== 1 ? 'multiple_model_contributors' : 'attributed';
    const applied = reason === 'attributed';
    if (applied) {
      const binding = attempts.at(-1).binding;
      const prior = db.prepare('SELECT * FROM model_evaluations WHERE binding=?').get(binding);
      const scores = updateEvaluationScores(prior || {}, parsed.scores);
      db.prepare(`INSERT INTO model_evaluations(binding,coding,reasoning,tool_use,reliability,latency,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(binding) DO UPDATE SET coding=excluded.coding,reasoning=excluded.reasoning,tool_use=excluded.tool_use,updated_at=excluded.updated_at`)
        .run(binding, scores.coding, scores.reasoning, scores.tool_use, scores.reliability, scores.latency, time());
    }
    db.prepare('INSERT INTO task_reviews VALUES(?,?,?,?,?,?,?,?)').run(targetID, reviewerID, parsed.verdict, JSON.stringify(parsed.scores), applied ? 'applied' : 'skipped', reason, revision, time());
    // Review PASS is not automatically semantic acceptance when evidence is
    // missing, stale, or criteria were not explicitly assessed.
    const verified = current && target.status === 'report_ready' && JSON.parse(target.criteria_json).length > 0 && parsed.verdict === 'pass' && parsed.evidence?.acceptance_criteria_met === true;
    db.prepare('UPDATE task_runs SET status=?,updated_at=? WHERE task_id=?').run(verified ? 'review_pass' : current && parsed.verdict !== 'pass' ? 'needs_changes' : 'review_unverified', time(), targetID);
    event(db, targetID, 'review_recorded', { verdict: parsed.verdict, evaluation_status: applied ? 'applied' : 'skipped', reason });
    return { verdict: parsed.verdict, evaluation_status: applied ? 'applied' : 'skipped', reason };
  }, { write: true });
}

export function executionStatus(file, { root = null, task = null, after = 0, limit = 50, action = 'summary' } = {}) {
  limit = Number(limit); after = Number(after);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(after) || after < 0) throw new Error('Invalid status cursor/limit');
  if (root) id(root); if (task) id(task);
  return withSystemDatabase(file, db => {
    if (action === 'log') return db.prepare('SELECT * FROM runtime_events WHERE sequence>? AND (? IS NULL OR root_session_id=?) ORDER BY sequence LIMIT ?').all(after,root,root,limit).map(row => ({ ...row, data: JSON.parse(row.data_json), data_json: undefined }));
    if (action === 'recent') return db.prepare(`SELECT e.* FROM task_events e JOIN task_runs t ON t.task_id=e.task_id
      WHERE e.sequence>? AND (? IS NULL OR t.root_session_id=?) AND (? IS NULL OR e.task_id=?) ORDER BY e.sequence LIMIT ?`).all(after,root,root,task,task,limit).map(row => ({ ...row, data: JSON.parse(row.data_json), data_json: undefined }));
    const rows = db.prepare(`SELECT * FROM task_runs WHERE (? IS NULL OR root_session_id=?) AND (? IS NULL OR task_id=?) ORDER BY created_at DESC,task_id LIMIT ?`).all(root,root,task,task,limit);
    return rows.map(row => {
      const attempts = db.prepare('SELECT * FROM task_attempts WHERE task_id=? ORDER BY ordinal').all(row.task_id);
      const review = db.prepare('SELECT * FROM task_reviews WHERE target_task_id=?').get(row.task_id) || null;
      const last = db.prepare('SELECT sequence,kind,created_at,data_json FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(row.task_id);
      const last_event = last ? { sequence: last.sequence, kind: last.kind, created_at: last.created_at, data: JSON.parse(last.data_json) } : null;
      const lastReport = db.prepare("SELECT event_key,data_json,created_at FROM task_events WHERE task_id=? AND kind='role_report' ORDER BY sequence DESC LIMIT 1").get(row.task_id);
      const lastDecision = lastReport ? db.prepare('SELECT data_json FROM task_events WHERE event_key=?').get(`${lastReport.event_key}:decision`) : null;
      const supervision = lastReport ? { report: JSON.parse(lastReport.data_json), decision: lastDecision ? JSON.parse(lastDecision.data_json) : null,
        state: lastDecision ? 'decision_recorded' : 'unresolved', observed_at: lastReport.created_at } : null;
      if (action === 'task') return { ...decode(row), attempts, review, last_event, supervision };
      return { task_id: row.task_id, role: row.role, description: row.description, directory: row.directory, orchestra: row.orchestra, status: row.status,
        updated_at: row.updated_at, attempt_count: attempts.length, last_attempt: attempts.at(-1) || null, review, last_event, supervision, revision_freshness: 'not_rechecked' };
    });
  });
}
