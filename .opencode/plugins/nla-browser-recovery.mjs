import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, safeSessionID } from './nla-memory.mjs';

const RIGHTS = ['navigation', 'interaction', 'authentication', 'uploads', 'downloads', 'external_mutation'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fail = () => { throw Object.assign(new Error('Browser recovery state is missing, malformed, weakened, or unverifiable'), { code: 'NLA_BROWSER_RECOVERY_BLOCKED' }); };
const fileFor = (root, owner) => path.join(root, 'browser-recovery', `${safeSessionID(owner)}.json`);
const keyFor = root => path.join(root, 'browser-recovery', 'authentication.key');
const indexFor = root => path.join(root, 'browser-recovery', 'index.json');
const tag = (key, record) => {
  const copy = { ...record }; delete copy.authentication_tag;
  return crypto.createHmac('sha256', key).update(JSON.stringify(copy)).digest('hex');
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const browserRequirementHash = task => hash({ goal: task.goal, origins: [...task.origins].sort(), permissions: Object.fromEntries(RIGHTS.map(right => [right, task.permissions[right] === true])), upload_files: [...(task.upload_files || [])].sort(), criteria: task.success_criteria.filter(criterion => criterion.mandatory !== false) });
function key(root, create) {
  const file = keyFor(root);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (!create) fail();
  const value = crypto.randomBytes(32); atomicWrite(file, value); return value;
}
export function loadBrowserRecovery(root, owner) {
  const file = fileFor(root, owner);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(); }
}
function loadIndex(root) { try { return fs.existsSync(indexFor(root)) ? JSON.parse(fs.readFileSync(indexFor(root), 'utf8')) : null; } catch { fail(); } }
function required(root, owner) {
  const index = loadIndex(root); if (!index) return false;
  if (index.version !== 1 || !index.sessions || tag(key(root, false), index) !== index.authentication_tag) fail();
  return index.sessions[safeSessionID(owner)] === true;
}
function markRequired(root, owner) {
  const current = loadIndex(root) || { version: 1, sessions: {} };
  current.sessions[safeSessionID(owner)] = true;
  current.authentication_tag = tag(key(root, true), current);
  atomicWrite(indexFor(root), JSON.stringify(current, null, 2) + '\n');
}
export function createBrowserRecovery(root, owner, task, session, result, checks, originalTask = task) {
  const previous = loadBrowserRecovery(root, owner);
  if (previous && previous.requirement_hash !== browserRequirementHash(originalTask)) fail();
  const criteria = originalTask.success_criteria.filter(c => c.mandatory !== false).map(c => {
    const observed = checks.find(check => check.id === c.id);
    const prior = previous?.criteria?.find(entry => entry.id === c.id);
    if (!observed && prior?.status === 'completed') return prior;
    if (!observed || !['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(observed.status)) fail();
    return { id: c.id, definition_hash: hash(c), status: observed.status === 'PASS' ? 'completed' : 'pending' };
  });
  const pending = criteria.filter(c => c.status === 'pending').map(c => c.id);
  const evidence = criteria.filter(c => c.status === 'completed').map(c => previous?.evidence?.find(entry => entry.criterion_id === c.id) || ({ criterion_id: c.id, run_id: session.run_id, child_id: session.child, browser_session_id: session.id, owner_session_id: owner, evidence: result.metadata.evidence, evidence_hash: crypto.createHash('sha256').update(fs.readFileSync(result.metadata.evidence)).digest('hex'), head: session.revision.head || null, result: result.metadata.browser_result }));
  const record = {
    version: 1, owner_session_id: safeSessionID(owner), requirement_hash: browserRequirementHash(originalTask),
    policy: { origins: [...originalTask.origins].sort(), permissions: Object.fromEntries(RIGHTS.map(right => [right, originalTask.permissions[right] === true])), prohibitions: RIGHTS.filter(right => originalTask.permissions[right] !== true), upload_files: [...(originalTask.upload_files || [])].sort() },
    criteria, evidence, next_pending: pending.length ? { criterion_id: pending[0], pending_criteria: pending } : null,
  };
  record.authentication_tag = tag(key(root, true), record);
  atomicWrite(fileFor(root, owner), JSON.stringify(record, null, 2) + '\n');
  markRequired(root, owner);
  return record;
}
export function beginBrowserRecovery(root, owner, task) {
  const existing = validateBrowserRecovery(root, owner);
  if (existing) return existing;
  const criteria = task.success_criteria.filter(c => c.mandatory !== false).map(c => ({ id: c.id, definition_hash: hash(c), status: 'pending' }));
  const record = { version: 1, owner_session_id: safeSessionID(owner), requirement_hash: browserRequirementHash(task), policy: { origins: [...task.origins].sort(), permissions: Object.fromEntries(RIGHTS.map(right => [right, task.permissions[right] === true])), prohibitions: RIGHTS.filter(right => task.permissions[right] !== true), upload_files: [...(task.upload_files || [])].sort() }, criteria, evidence: [], next_pending: { criterion_id: criteria[0].id, pending_criteria: criteria.map(c => c.id) } };
  record.authentication_tag = tag(key(root, true), record);
  atomicWrite(fileFor(root, owner), JSON.stringify(record, null, 2) + '\n'); markRequired(root, owner);
  return { ...record, pending_criteria: record.next_pending.pending_criteria };
}
export function recoveryEvidence(root, owner) {
  const recovery = validateBrowserRecovery(root, owner); if (!recovery) return [];
  return recovery.evidence.map(entry => ({ head: entry.head, type: 'browser', evidence: entry.evidence, result: entry.result, provenance: { source: 'browser-capability', trusted: true, run_id: entry.run_id, session_id: entry.browser_session_id, child_id: entry.child_id, owner_session_id: owner } }));
}
export function validateBrowserRecovery(root, owner) {
  const record = loadBrowserRecovery(root, owner); if (!record) { if (required(root, owner)) fail(); return null; }
  try {
    if (!required(root, owner) || record.version !== 1 || record.owner_session_id !== safeSessionID(owner) || !record.policy || !Array.isArray(record.policy.origins) || !record.policy.origins.length || !record.policy.permissions || !Array.isArray(record.policy.prohibitions) || !Array.isArray(record.policy.upload_files) || !Array.isArray(record.criteria) || !record.criteria.length) fail();
    if (RIGHTS.some(right => typeof record.policy.permissions[right] !== 'boolean' || record.policy.prohibitions.includes(right) === record.policy.permissions[right])) fail();
    if (tag(key(root, false), record) !== record.authentication_tag) fail();
    const pending = record.criteria.filter(c => c.status === 'pending').map(c => c.id);
    if (record.criteria.some(c => typeof c.id !== 'string' || !/^[a-f0-9]{64}$/.test(c.definition_hash) || !['completed', 'pending'].includes(c.status))) fail();
    if ((pending.length === 0) !== (record.next_pending === null)) fail();
    if (pending.length && (record.next_pending.criterion_id !== pending[0] || JSON.stringify(record.next_pending.pending_criteria) !== JSON.stringify(pending))) fail();
    for (const entry of record.evidence) if (!record.criteria.some(c => c.id === entry.criterion_id && c.status === 'completed') || entry.owner_session_id !== owner || !fs.existsSync(entry.evidence) || crypto.createHash('sha256').update(fs.readFileSync(entry.evidence)).digest('hex') !== entry.evidence_hash) fail();
    return { ...record, pending_criteria: pending };
  } catch (error) { if (error.code === 'NLA_BROWSER_RECOVERY_BLOCKED') throw error; fail(); }
}
