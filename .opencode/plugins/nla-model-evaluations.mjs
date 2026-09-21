import fs from 'node:fs';
import path from 'node:path';

export const EVALUATION_VERSION = 1;
export const EVALUATION_SCORE_KEYS = ['coding', 'reasoning', 'tool_use', 'reliability', 'latency'];
const REVIEW_SCORE_KEYS = ['coding', 'reasoning', 'tool_use'];
const REVIEW_VERDICTS = new Set(['pass', 'fail', 'needs_changes']);

export class ModelEvaluationError extends Error {
  constructor(message) { super(message); this.name = 'ModelEvaluationError'; }
}

export function emptyEvaluationStore() { return { version: EVALUATION_VERSION, models: {} }; }

function score(value, allowZero = true) {
  const minimum = allowZero ? 0 : 1;
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 10 ? value : null;
}

function validBinding(binding) {
  if (typeof binding !== 'string' || !binding.trim() || binding.length > 256 || binding !== binding.trim()) throw new ModelEvaluationError('Evaluation model binding must be a trimmed non-empty string');
  return binding;
}

export function validateEvaluationStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== EVALUATION_VERSION || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) throw new ModelEvaluationError('Evaluation store must be a version 1 object with a models map');
  const models = {};
  for (const [binding, record] of Object.entries(value.models)) {
    validBinding(binding);
    if (!record || typeof record !== 'object' || Array.isArray(record) || !record.scores || typeof record.scores !== 'object' || Array.isArray(record.scores)) throw new ModelEvaluationError(`Invalid evaluation record for ${binding}`);
    const scores = {};
    for (const key of EVALUATION_SCORE_KEYS) {
      const value = score(record.scores[key]);
      if (value === null) throw new ModelEvaluationError(`Invalid ${key} score for ${binding}`);
      scores[key] = value;
    }
    models[binding] = { scores };
  }
  return { version: EVALUATION_VERSION, models };
}

export function loadEvaluationStore(filePath) {
  if (!fs.existsSync(filePath)) return emptyEvaluationStore();
  try { return validateEvaluationStore(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { return emptyEvaluationStore(); }
}

function waitForLock(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function acquireLock(lockPath, timeoutMs = 5000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > timeoutMs * 2) fs.unlinkSync(lockPath);
      } catch {}
      waitForLock(10);
    }
  }
  throw new ModelEvaluationError('Timed out waiting for model evaluation state lock');
}

function releaseLock(lockPath, fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}

function writeWithoutLock(filePath, value) {
  const store = validateEvaluationStore(value);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return store;
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

export function writeEvaluationStoreAtomic(filePath, value) {
  const store = validateEvaluationStore(value);
  const lockPath = `${filePath}.lock`;
  const fd = acquireLock(lockPath);
  try { return writeWithoutLock(filePath, store); }
  finally { releaseLock(lockPath, fd); }
}

function readValid(filePath) {
  if (!fs.existsSync(filePath)) return emptyEvaluationStore();
  return validateEvaluationStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function averageScore(oldValue, currentValue) {
  const current = score(currentValue, false);
  if (current === null) throw new ModelEvaluationError('Evaluation scores must be numbers from 1 to 10');
  const old = score(oldValue);
  return old === null || old === 0 ? current : (old + current) / 2;
}

export function updateEvaluationScores(existingScores = {}, currentScores = {}) {
  const next = Object.fromEntries(EVALUATION_SCORE_KEYS.map((key) => [key, score(existingScores[key]) ?? 0]));
  for (const key of EVALUATION_SCORE_KEYS) if (currentScores[key] !== undefined) next[key] = averageScore(next[key], currentScores[key]);
  return next;
}

export function parseReviewerEvaluation(payload) {
  let value = payload;
  if (typeof payload === 'string') {
    try { value = JSON.parse(payload); } catch { throw new ModelEvaluationError('Reviewer evaluation must be valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !REVIEW_VERDICTS.has(value.verdict)) throw new ModelEvaluationError('Reviewer evaluation requires verdict pass, fail, or needs_changes');
  if (Object.keys(value).some((key) => !['verdict', 'scores', 'evidence'].includes(key))) throw new ModelEvaluationError('Reviewer evaluation contains unsupported fields');
  if (!value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores) || Object.keys(value.scores).some((key) => !REVIEW_SCORE_KEYS.includes(key)) || REVIEW_SCORE_KEYS.some((key) => score(value.scores[key], false) === null)) throw new ModelEvaluationError('Reviewer evaluation must contain coding, reasoning, and tool_use scores from 1 to 10');
  if (value.evidence !== undefined && (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence) || Object.keys(value.evidence).some((key) => !['tests_passed', 'acceptance_criteria_met'].includes(key)) || Object.values(value.evidence).some((item) => typeof item !== 'boolean'))) throw new ModelEvaluationError('Reviewer evidence must contain only boolean tests_passed and acceptance_criteria_met');
  return { verdict: value.verdict, scores: Object.fromEntries(REVIEW_SCORE_KEYS.map((key) => [key, value.scores[key]])), ...(value.evidence ? { evidence: { ...value.evidence } } : {}) };
}

export function recordEvaluation(filePath, binding, currentScores) {
  validBinding(binding);
  const lockPath = `${filePath}.lock`;
  const fd = acquireLock(lockPath);
  try {
    // Do not replace a malformed existing state file with a new empty store.
    const current = readValid(filePath);
    const old = current.models[binding]?.scores || {};
    return writeWithoutLock(filePath, { ...current, models: { ...current.models, [binding]: { scores: updateEvaluationScores(old, currentScores) } } });
  } finally { releaseLock(lockPath, fd); }
}

export function recordReviewerEvaluation(filePath, binding, payload) {
  return recordEvaluation(filePath, binding, parseReviewerEvaluation(payload).scores);
}

export function latencyScoreFromMs(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value <= 1000) return 10;
  if (value <= 3000) return 8;
  if (value <= 10000) return 6;
  if (value <= 30000) return 4;
  return 2;
}

export function runtimeEvaluationScores({ succeeded, elapsedMs } = {}) {
  return {
    reliability: succeeded ? 10 : 1,
    ...(Number.isFinite(Number(elapsedMs)) ? { latency: latencyScoreFromMs(elapsedMs) || 1 } : {}),
  };
}
