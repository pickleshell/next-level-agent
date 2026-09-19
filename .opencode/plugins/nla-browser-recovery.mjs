import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeSessionID } from './nla-memory.mjs';

const RIGHTS = ['navigation', 'interaction', 'authentication', 'uploads', 'downloads', 'external_mutation'];
const STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (reason = 'missing, malformed, weakened, or unverifiable state') => { throw Object.assign(new Error(`Browser recovery blocked: ${reason}`), { code: 'NLA_BROWSER_RECOVERY_BLOCKED' }); };
const validID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const options = value => typeof value === 'string' ? { taskId: value, required: true } : typeof value === 'boolean' ? { required: value } : value || {};

// Input must already have passed validateBrowserTask. Transport/session reuse is
// intentionally excluded; every criterion (including optional ones) is retained.
export function canonicalBrowserContract(task) {
  if (!task || typeof task.goal !== 'string' || !task.goal || !Array.isArray(task.origins) || !task.origins.length || task.origins.some(x => typeof x !== 'string') || !task.permissions || !Array.isArray(task.success_criteria) || !task.success_criteria.length) fail('invalid task contract');
  if (Object.values(task.permissions).some(x => typeof x !== 'boolean') || (task.upload_files !== undefined && (!Array.isArray(task.upload_files) || task.upload_files.some(x => typeof x !== 'string')))) fail('invalid task policy');
  const criteria = task.success_criteria.map(c => {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.check !== 'string' || (c.mandatory !== undefined && typeof c.mandatory !== 'boolean')) fail('invalid criterion');
    return { ...c, mandatory: c.mandatory !== false, wait_ms: c.wait_ms ?? 1000 };
  });
  if (new Set(criteria.map(c => c.id)).size !== criteria.length) fail('duplicate criterion');
  return canonical({ goal: task.goal, origins: [...new Set(task.origins)].sort(), permissions: Object.fromEntries(RIGHTS.map(right => [right, task.permissions[right] === true])), upload_files: [...new Set(task.upload_files || [])].sort(), success_criteria: criteria });
}
export const browserRequirementHash = task => hash(json(canonicalBrowserContract(task)));
const policyFor = contract => ({ origins: contract.origins, permissions: contract.permissions, prohibitions: RIGHTS.filter(right => !contract.permissions[right]), upload_files: contract.upload_files });
const pendingFor = record => record.criteria.filter(c => c.status === 'pending').map(c => c.id);
function refresh(record) {
  const pending = pendingFor(record);
  record.next_pending = pending.length ? { criterion_id: pending[0], pending_criteria: pending } : null;
  return record;
}
function expose(record) {
  const copy = structuredClone(record);
  delete copy.execution_claim;
  return { ...copy, pending_criteria: pendingFor(record), execution_state: record.execution_claim ? 'UNKNOWN' : 'IDLE' };
}
const signature = (key, value) => {
  const copy = { ...value }; delete copy.authentication_tag;
  return crypto.createHmac('sha256', key).update(json(copy)).digest('hex');
};

function read(file, privateFile = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (privateFile && (stat.mode & 0o077))) fail('unsafe storage file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function durableWrite(file, content) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

// One signed document commits records and membership atomically. The independent
// witness detects deletion of the store directory. Readers and writers share a
// cross-process lock; abandoned locks fail closed and are never stolen by time.
function transaction(root, mutate, required, action) {
  let locked = false;
  let lock;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    root = fs.realpathSync(root);
    lock = path.join(root, '.browser-recovery.lock');
    const deadline = Date.now() + 3000;
    while (!locked) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) fail('storage lock busy or abandoned');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const directory = path.join(root, 'browser-recovery');
    const witness = path.join(root, '.browser-recovery.required');
    const indexFile = path.join(directory, 'index.json');
    const keyFile = path.join(directory, 'authentication.key');
    let store = null;
    let key;
    const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    if (exists(directory) || exists(witness)) {
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || read(witness, true).toString() !== 'browser-recovery-v2\n') fail('storage witness missing or invalid');
      key = read(keyFile, true);
      if (key.length !== 32) fail('authentication key invalid');
      store = JSON.parse(read(indexFile, true));
      const tag = signature(key, store);
      if (typeof store.authentication_tag !== 'string' || store.authentication_tag.length !== tag.length || !crypto.timingSafeEqual(Buffer.from(store.authentication_tag), Buffer.from(tag))) fail('authentication failed');
      validateStore(store);
    } else if (required) fail('known Browser workflow has no recovery storage');
    const result = action(store);
    if (mutate) {
      store = result.store;
      validateStore(store);
      if (!key) {
        durableWrite(witness, 'browser-recovery-v2\n');
        fs.mkdirSync(directory, { mode: 0o700 });
        key = crypto.randomBytes(32);
        durableWrite(keyFile, key);
      }
      store.authentication_tag = signature(key, store);
      durableWrite(indexFile, JSON.stringify(store, null, 2) + '\n');
      return result.value;
    }
    return result;
  } catch (error) {
    if (error.code === 'NLA_BROWSER_RECOVERY_BLOCKED') throw error;
    fail('storage or evidence could not be verified');
  } finally { if (locked) fs.rmdirSync(lock); }
}

function validateStore(store) {
  if (store.version !== 2 || !Array.isArray(store.records) || !store.records.length) fail('invalid store');
  const identities = new Set();
  const runs = new Set();
  for (const record of store.records) {
    safeSessionID(record.owner_session_id);
    const identity = `${record.owner_session_id}:${record.task_id}`;
    if (record.version !== 2 || !validID(record.task_id) || identities.has(identity)) fail('invalid task identity');
    identities.add(identity);
    if (record.execution_claim !== undefined && (typeof record.execution_claim !== 'string' || !/^[a-f0-9]{64}$/.test(record.execution_claim))) fail('invalid execution claim');
    const contract = canonicalBrowserContract(record.contract);
    if (json(contract) !== json(record.contract) || record.requirement_hash !== browserRequirementHash(contract) || json(record.policy) !== json(policyFor(contract)) || !Array.isArray(record.criteria) || record.criteria.length !== contract.success_criteria.length || !Array.isArray(record.attempts) || !Array.isArray(record.evidence)) fail('invalid recovery contract');
    for (const [i, c] of record.criteria.entries()) {
      const definition = contract.success_criteria[i];
      if (c.id !== definition.id || c.definition_hash !== hash(json(definition)) || c.mandatory !== definition.mandatory || !['pending', 'completed'].includes(c.status)) fail('invalid recovered criterion');
      if (c.status === 'completed' && !record.attempts.some(a => a.run_id === c.completed_run_id && a.checks.some(check => check.id === c.id && check.status === 'PASS'))) fail('completed criterion has no provenance');
    }
    const pending = pendingFor(record);
    if (json(record.next_pending) !== json(pending.length ? { criterion_id: pending[0], pending_criteria: pending } : null)) fail('invalid continuation');
    const finalized = [];
    for (const attempt of record.attempts) {
      if (!validID(attempt.run_id) || runs.has(attempt.run_id) || !validID(attempt.browser_session_id) || (attempt.child_id !== null && !validID(attempt.child_id)) || attempt.owner_session_id !== record.owner_session_id || attempt.task_id !== record.task_id || !Array.isArray(attempt.checks) || !Array.isArray(attempt.pending_criteria) || attempt.pending_criteria.some(id => !record.criteria.some(c => c.id === id))) fail('invalid run provenance');
      runs.add(attempt.run_id);
      if (attempt.result === 'RUNNING') {
        if (attempt.evidence !== null || attempt.checks.length) fail('invalid in-flight attempt');
      } else {
        if (!STATUSES.includes(attempt.result) || typeof attempt.evidence !== 'string' || !path.isAbsolute(attempt.evidence)) fail('invalid run evidence');
        const bytes = read(attempt.evidence);
        if (hash(bytes) !== attempt.evidence_hash) fail('evidence changed');
        const manifest = JSON.parse(bytes);
        if (manifest.run_id !== attempt.run_id || manifest.session_id !== attempt.browser_session_id || (manifest.task_id || null) !== attempt.child_id || manifest.result !== attempt.result || (manifest.revision?.head || null) !== attempt.head || json(checkSummary(manifest.checks)) !== json(attempt.checks) || (manifest.reason || null) !== attempt.reason) fail('evidence provenance mismatch');
        if (!attempt.child_id && (attempt.result === 'PASS' || attempt.checks.some(c => c.status === 'PASS'))) fail('PASS requires child provenance');
        if (attempt.checks.some(c => !attempt.pending_criteria.includes(c.id))) fail('replayed completed criterion');
        finalized.push(attempt);
      }
    }
    if (json(finalized) !== json(record.evidence)) fail('run evidence omitted');
  }
}
function checkSummary(checks) {
  if (!Array.isArray(checks) || checks.some(c => !c || typeof c.id !== 'string' || !STATUSES.includes(c.status)) || new Set(checks.map(c => c.id)).size !== checks.length) fail('invalid run checks');
  return checks.map(c => ({ id: c.id, status: c.status }));
}
function select(store, owner, taskID, required = true) {
  safeSessionID(owner);
  if (taskID !== undefined && !validID(taskID)) fail('invalid logical task ID');
  const candidates = (store?.records || []).filter(r => r.owner_session_id === owner && (taskID === undefined || r.task_id === taskID));
  if (candidates.length > 1 || (required && !candidates.length)) fail('logical task ID missing or ambiguous');
  return candidates[0] || null;
}
function newRecord(owner, task) {
  safeSessionID(owner);
  const contract = canonicalBrowserContract(task);
  return refresh({ version: 2, owner_session_id: owner, task_id: crypto.randomUUID(), requirement_hash: browserRequirementHash(contract), contract, policy: policyFor(contract), criteria: contract.success_criteria.map(c => ({ id: c.id, mandatory: c.mandatory, definition_hash: hash(json(c)), status: 'pending' })), attempts: [], evidence: [] });
}

/** Absent taskID means NEW task, even for identical contracts. Present means RESUME. */
export function beginBrowserRecovery(root, owner, task, taskID) {
  const contract = canonicalBrowserContract(task);
  return transaction(root, true, taskID !== undefined, current => {
    const store = current || { version: 2, records: [] };
    let record;
    if (taskID !== undefined) {
      record = select(store, owner, taskID);
      if (record.requirement_hash !== browserRequirementHash(contract)) fail('continuation contract mismatch');
      if (record.execution_claim) fail('task execution UNKNOWN: unresolved claim blocks continuation');
    } else { record = newRecord(owner, contract); store.records.push(record); }
    return { store, value: expose(record) };
  });
}

/** Acquire before Browser.begin; filter pending work from the returned record,
 * captured atomically with acquisition, not an earlier begin/validate result.
 * This is an execution claim, not a timed lease. Only the returned opaque token
 * can release it. Never put that token in model context, recovery, or logs.
 * The authenticated store holds only its hash. A surviving claim means UNKNOWN
 * (active or interrupted); process death never makes replay safe. No expiry,
 * stealing, or automatic reconciliation exists. Token loss requires operator
 * resolution or a genuinely new workflow, not replay of the uncertain task.
 */
export function claimBrowserRecoveryTask(root, owner, taskID) {
  if (!validID(taskID)) fail('explicit logical task ID required for claim');
  return transaction(root, true, true, store => {
    const record = select(store, owner, taskID);
    if (record.execution_claim) fail('task execution UNKNOWN: unresolved claim blocks execution');
    if (!pendingFor(record).length || record.attempts.some(a => a.result === 'RUNNING')) fail('task is complete or has an unfinished attempt');
    const token = crypto.randomBytes(32).toString('hex');
    record.execution_claim = hash(token);
    return { store, value: { token, record: expose(record) } };
  });
}

function requireClaimToken(record, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !record.execution_claim || !crypto.timingSafeEqual(Buffer.from(record.execution_claim, 'hex'), Buffer.from(hash(token), 'hex'))) fail('execution claim token mismatch');
}

/** Call ONLY when allocation has not started. Terminal finalization removes its
 * claim atomically in createBrowserRecovery. Integration owns the pre-allocation
 * decision; storage errors or uncertain allocation must retain the claim. Token mismatch,
 * repeated release, and missing/corrupt storage fail closed without mutation.
 */
export function releaseBrowserRecoveryTask(root, owner, taskID, token) {
  if (!validID(taskID)) fail('explicit logical task ID required for release');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('execution claim token mismatch');
  return transaction(root, true, true, store => {
    const record = select(store, owner, taskID);
    requireClaimToken(record, token);
    delete record.execution_claim;
    return { store, value: true };
  });
}

/** Every terminal outcome is retained, including partial PASS checks. Only
 * trusted runtime callers may supply sessions/manifests. Omitted taskID remains
 * compatible only when the owner has at most one task (never guess among tasks).
 * A claimed task requires its token. Terminal evidence and claim removal commit
 * atomically; callers must not perform a second release after finalization. */
export function createBrowserRecovery(root, owner, task, session, result, checks, originalTask = task, taskID, claimToken) {
  return transaction(root, true, taskID !== undefined, current => {
    const store = current || { version: 2, records: [] };
    let record = select(store, owner, taskID, taskID !== undefined);
    if (!record) { record = newRecord(owner, originalTask); store.records.push(record); }
    if (record.execution_claim || claimToken !== undefined) requireClaimToken(record, claimToken);
    if (record.requirement_hash !== browserRequirementHash(originalTask)) fail('continuation contract mismatch');
    const executed = canonicalBrowserContract(task);
    const expected = { ...record.contract, success_criteria: executed.success_criteria };
    if (json(executed) !== json(expected) || executed.success_criteria.some(c => !record.contract.success_criteria.some(original => json(c) === json(original)))) fail('executed contract mismatch');
    const summary = checkSummary(checks);
    if (summary.length !== executed.success_criteria.length || summary.some(c => !executed.success_criteria.some(definition => definition.id === c.id))) fail('run checks do not match executed task');
    const previous = record.attempts.find(a => a.run_id === session.run_id);
    if (previous && previous.result !== 'RUNNING') fail('run already finalized');
    if (record.attempts.some(a => a.result === 'RUNNING' && a !== previous)) fail('another attempt is unfinished');
    if (summary.some(c => !pendingFor(record).includes(c.id))) fail('completed checks cannot be replayed');
    const evidence = path.resolve(result.metadata.evidence);
    const bytes = read(evidence);
    const manifest = JSON.parse(bytes);
    const attempt = { task_id: record.task_id, owner_session_id: owner, run_id: session.run_id, browser_session_id: session.id, child_id: session.child || manifest.task_id || null, head: session.revision?.head || null, result: result.metadata.browser_result, reason: manifest.reason || null, checks: summary, pending_criteria: previous?.pending_criteria || pendingFor(record), evidence, evidence_hash: hash(bytes) };
    if (previous && (previous.browser_session_id !== attempt.browser_session_id || previous.head !== attempt.head || (previous.child_id !== null && previous.child_id !== attempt.child_id))) fail('attempt identity changed');
    if (previous) record.attempts[record.attempts.indexOf(previous)] = attempt;
    else record.attempts.push(attempt);
    record.evidence.push(attempt);
    for (const c of record.criteria) if (summary.some(check => check.id === c.id && check.status === 'PASS')) { c.status = 'completed'; c.completed_run_id = attempt.run_id; }
    refresh(record);
    delete record.execution_claim;
    return { store, value: expose(record) };
  });
}

/** required/expectedKnown comes from independent ledger state. taskIds can also
 * bind expected membership. Total loss is never safe when work is known. */
export function listBrowserRecoveries(root, owner, value = {}) {
  const opts = options(value);
  const required = opts.required === true || opts.expectedKnown === true || !!opts.taskIds?.length;
  safeSessionID(owner);
  return transaction(root, false, required, store => {
    const records = (store?.records || []).filter(r => r.owner_session_id === owner);
    if ((required && !records.length) || (opts.taskIds && (!Array.isArray(opts.taskIds) || opts.taskIds.some(id => !records.some(r => r.task_id === id))))) fail('known logical task is missing');
    return records.map(expose);
  });
}
export function validateBrowserRecovery(root, owner, value) {
  const opts = options(value);
  const records = listBrowserRecoveries(root, owner, opts);
  if (opts.taskId !== undefined) return select({ records }, owner, opts.taskId);
  if (!records.length) return null;
  // Safe single-task read compatibility; multi-task callers must use tasks.
  return { ...(records.length === 1 ? records[0] : { version: 2, owner_session_id: owner }), tasks: records };
}
export const loadBrowserRecovery = validateBrowserRecovery;
export function recoveryEvidence(root, owner, value) {
  return listBrowserRecoveries(root, owner, value).flatMap(record => record.evidence.map(entry => ({ head: entry.head, type: 'browser', evidence: entry.evidence, result: entry.result, provenance: { source: 'browser-capability', trusted: true, task_id: record.task_id, run_id: entry.run_id, session_id: entry.browser_session_id, child_id: entry.child_id, owner_session_id: owner } })));
}
