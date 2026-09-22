import fs from 'node:fs';
import path from 'node:path';

import {
  EVALUATION_SCORE_KEYS, emptyEvaluationStore,
  parseReviewerEvaluation, updateEvaluationScores, validateEvaluationStore,
} from './nla-model-evaluations.mjs';
import { validateModelPools } from './nla-model-pools.mjs';

// OpenCode CLI loads local plugins in Bun, while some Desktop builds use
// Node/Electron. Both runtimes have a built-in SQLite implementation, but
// expose it under different module names.
const SQLiteDatabase = globalThis.Bun
  ? (await import('bun:sqlite')).Database
  : (await import('node:sqlite')).DatabaseSync;

export const SYSTEM_DATABASE_VERSION = 1;

export class SystemDatabaseError extends Error {
  constructor(message) { super(message); this.name = 'SystemDatabaseError'; }
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)["']?\s*[:=]\s*["']?\S+/i;
const SYSTEM_DATABASE_NAME = 'system';
const USER_COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB']);
const SESSION_ID = /^[A-Za-z0-9_-]{8,160}$/;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)/i;
const SELECT_POLICIES = new Set(['quality', 'balanced', 'cost']);

export function systemDatabasePath(stateRoot) {
  return path.join(path.resolve(stateRoot), 'system.sqlite');
}

function now() { return new Date().toISOString(); }

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function ensurePrivateFile(file) {
  try { fs.chmodSync(file, 0o600); } catch {}
}

function openDatabase(file) {
  ensurePrivateDirectory(path.dirname(file));
  const native = new SQLiteDatabase(file);
  ensurePrivateFile(file);
  native.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;');
  if (!globalThis.Bun) return native;
  // Normalize Bun's query() API to the small DatabaseSync subset used below.
  return {
    exec: (sql) => native.exec(sql),
    prepare: (sql) => {
      const statement = native.query(sql);
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => statement.run(...params),
      };
    },
    close: () => native.close(),
  };
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function closeDatabase(db) {
  try { db.close(); } catch {}
}

function validBinding(binding) {
  if (typeof binding !== 'string' || !binding.trim() || binding !== binding.trim() || binding.length > 256 || binding.indexOf('/') <= 0 || binding.indexOf('/') === binding.length - 1 || binding.indexOf('/') !== binding.lastIndexOf('/')) {
    throw new SystemDatabaseError('Model binding must be an exact provider/model identifier');
  }
  return binding;
}

function validSessionID(sessionID) {
  if (!SESSION_ID.test(sessionID || '')) throw new SystemDatabaseError('Invalid NLA session identifier');
  return sessionID;
}

function json(value, label, maxLength = 16384) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new SystemDatabaseError(`${label} must be non-empty JSON up to ${maxLength} characters`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new SystemDatabaseError(`${label} must be valid JSON`); }
  assertNoSecrets(parsed, label);
  return parsed;
}

function assertNoSecrets(value, label, depth = 0) {
  if (depth > 24) throw new SystemDatabaseError(`${label} is nested too deeply`);
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) throw new SystemDatabaseError(`${label} appears to contain a secret`);
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, label, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new SystemDatabaseError(`${label} contains a secret field`);
      assertNoSecrets(item, label, depth + 1);
    }
  }
}

function jsonText(value) { return JSON.stringify(value); }

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const version = Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0);
  if (version > SYSTEM_DATABASE_VERSION) throw new SystemDatabaseError(`System database schema ${version} is newer than this NLA version`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_migrations (
      name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_evaluations (
      binding TEXT PRIMARY KEY,
      coding REAL NOT NULL CHECK (coding >= 0 AND coding <= 10),
      reasoning REAL NOT NULL CHECK (reasoning >= 0 AND reasoning <= 10),
      tool_use REAL NOT NULL CHECK (tool_use >= 0 AND tool_use <= 10),
      reliability REAL NOT NULL CHECK (reliability >= 0 AND reliability <= 10),
      latency REAL NOT NULL CHECK (latency >= 0 AND latency <= 10),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_registry (
      binding TEXT PRIMARY KEY,
      facts_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_notes (
      binding TEXT NOT NULL,
      note_key TEXT NOT NULL,
      note_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding, note_key),
      FOREIGN KEY (binding) REFERENCES model_registry(binding) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS model_health (
      binding TEXT NOT NULL,
      endpoint TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK (state IN ('cooling', 'quarantined')),
      category TEXT,
      reason TEXT,
      since_ms INTEGER NOT NULL,
      until_ms INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding, endpoint)
    );
    CREATE TABLE IF NOT EXISTS session_ledgers (
      session_id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      ledger_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS restore_blocks (
      session_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS database_catalog (
      name TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(SYSTEM_DATABASE_VERSION);
  if (!applied) db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SYSTEM_DATABASE_VERSION, now());
}

function evaluationCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM model_evaluations').get().count);
}

function persistEvaluationStore(db, store) {
  const validated = validateEvaluationStore(store);
  const insert = db.prepare(`INSERT INTO model_evaluations
    (binding, coding, reasoning, tool_use, reliability, latency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(binding) DO UPDATE SET coding = excluded.coding, reasoning = excluded.reasoning,
      tool_use = excluded.tool_use, reliability = excluded.reliability, latency = excluded.latency,
      updated_at = excluded.updated_at`);
  for (const [binding, record] of Object.entries(validated.models)) {
    const scores = record.scores;
    insert.run(binding, scores.coding, scores.reasoning, scores.tool_use, scores.reliability, scores.latency, now());
  }
  return validated;
}

function registerBindings(db, store, source) {
  const insert = db.prepare(`INSERT INTO model_registry (binding, facts_json, source, updated_at)
    VALUES (?, '{}', ?, ?)
    ON CONFLICT(binding) DO NOTHING`);
  for (const binding of Object.keys(store.models)) insert.run(binding, source, now());
}

function ensureDefaultSettings(db) {
  const defaultSetting = db.prepare(`INSERT INTO system_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO NOTHING`);
  for (const [key, value] of Object.entries({
    'system.database.version': SYSTEM_DATABASE_VERSION,
    'system.database.driver': 'builtin-sqlite',
    'operator_databases.enabled': true,
  })) defaultSetting.run(key, jsonText(value), now());
}

export function initializeSystemDatabase({ stateRoot, seedPath, legacyEvaluationPath } = {}) {
  if (!stateRoot) throw new SystemDatabaseError('System database requires a state root');
  const file = systemDatabasePath(stateRoot);
  const db = openDatabase(file);
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new SystemDatabaseError('System database integrity check failed');
    transaction(db, () => {
      migrate(db);
      ensureDefaultSettings(db);
      if (db.prepare("SELECT name FROM data_migrations WHERE name = 'model_evaluations'").get()) return;
      let source = 'existing-sqlite';
      if (evaluationCount(db) === 0) {
        const inputPath = legacyEvaluationPath && fs.existsSync(legacyEvaluationPath) ? legacyEvaluationPath : seedPath;
        source = inputPath === legacyEvaluationPath ? 'legacy-json-migration' : 'seed';
        const initial = inputPath && fs.existsSync(inputPath)
          ? validateEvaluationStore(JSON.parse(fs.readFileSync(inputPath, 'utf8')))
          : emptyEvaluationStore();
        persistEvaluationStore(db, initial);
        registerBindings(db, initial, source);
      }
      db.prepare('INSERT INTO data_migrations (name, source, applied_at) VALUES (?, ?, ?)').run('model_evaluations', source, now());
    });
    ensurePrivateFile(file);
    return file;
  } finally { closeDatabase(db); }
}

export function loadSystemEvaluations(file) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const models = {};
    for (const row of db.prepare('SELECT binding, coding, reasoning, tool_use, reliability, latency FROM model_evaluations ORDER BY binding').all()) {
      models[row.binding] = { scores: Object.fromEntries(EVALUATION_SCORE_KEYS.map((key) => [key, row[key]])) };
    }
    return { version: 1, models };
  } finally { closeDatabase(db); }
}

export function recordSystemEvaluation(file, binding, currentScores) {
  validBinding(binding);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      const row = db.prepare('SELECT coding, reasoning, tool_use, reliability, latency FROM model_evaluations WHERE binding = ?').get(binding);
      const scores = updateEvaluationScores(row || {}, currentScores);
      db.prepare(`INSERT INTO model_evaluations (binding, coding, reasoning, tool_use, reliability, latency, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding) DO UPDATE SET coding = excluded.coding, reasoning = excluded.reasoning,
          tool_use = excluded.tool_use, reliability = excluded.reliability, latency = excluded.latency, updated_at = excluded.updated_at`)
        .run(binding, scores.coding, scores.reasoning, scores.tool_use, scores.reliability, scores.latency, now());
      db.prepare(`INSERT INTO model_registry (binding, facts_json, source, updated_at) VALUES (?, '{}', 'runtime', ?)
        ON CONFLICT(binding) DO NOTHING`).run(binding, now());
      return loadSystemEvaluationsFromOpenDatabase(db);
    });
  } finally { closeDatabase(db); }
}

function loadSystemEvaluationsFromOpenDatabase(db) {
  const models = {};
  for (const row of db.prepare('SELECT binding, coding, reasoning, tool_use, reliability, latency FROM model_evaluations ORDER BY binding').all()) {
    models[row.binding] = { scores: Object.fromEntries(EVALUATION_SCORE_KEYS.map((key) => [key, row[key]])) };
  }
  return { version: 1, models };
}

export function recordSystemReviewerEvaluation(file, binding, payload) {
  return recordSystemEvaluation(file, binding, parseReviewerEvaluation(payload).scores);
}

function settingKey(key) {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(key)) throw new SystemDatabaseError('Setting key must use lowercase letters, digits, dot, dash, or underscore');
  if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)/i.test(key)) throw new SystemDatabaseError('System settings cannot store secrets');
  return key;
}

function getSettingFromOpenDatabase(db, key) {
  const row = db.prepare('SELECT value_json FROM system_settings WHERE setting_key = ?').get(key);
  return row ? JSON.parse(row.value_json) : null;
}

function validateSetting(key, value) {
  settingKey(key);
  if (key === 'operator_databases.enabled') {
    if (typeof value !== 'boolean') throw new SystemDatabaseError(`${key} must be true or false`);
  } else if (/^routing\.selection_policy\.[a-z][a-z0-9_]*$/.test(key)) {
    if (!SELECT_POLICIES.has(value)) throw new SystemDatabaseError(`${key} must be quality, balanced, or cost`);
  } else if (key.startsWith('operator.')) {
    // Private operator metadata has no effect on NLA routing or security.
  } else {
    throw new SystemDatabaseError(`Setting ${key} is read-only or unsupported`);
  }
}

export function getSystemSetting(file, key) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const row = db.prepare('SELECT value_json, updated_at FROM system_settings WHERE setting_key = ?').get(settingKey(key));
    return row ? { key, value: JSON.parse(row.value_json), updated_at: row.updated_at } : null;
  } finally { closeDatabase(db); }
}

export function configuredSelectionPolicy(file, role) {
  if (!IDENTIFIER.test(role)) throw new SystemDatabaseError('Invalid role name');
  const value = getSystemSetting(file, `routing.selection_policy.${role}`)?.value;
  if (value !== null && value !== undefined && !SELECT_POLICIES.has(value)) throw new SystemDatabaseError(`Invalid stored selection policy for ${role}`);
  return value ?? null;
}

export function listSystemSettings(file) {
  const db = openDatabase(file);
  try {
    migrate(db);
    return db.prepare('SELECT setting_key, value_json, updated_at FROM system_settings ORDER BY setting_key').all()
      .map((row) => ({ key: row.setting_key, value: JSON.parse(row.value_json), updated_at: row.updated_at }));
  } finally { closeDatabase(db); }
}

export function setSystemSetting(file, key, valueJSON) {
  const parsed = json(valueJSON, 'Setting value');
  validateSetting(key, parsed);
  const db = openDatabase(file);
  try {
    transaction(db, () => {
      migrate(db);
      db.prepare(`INSERT INTO system_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(settingKey(key), jsonText(parsed), now());
    });
    return getSystemSetting(file, key);
  } finally { closeDatabase(db); }
}

export function systemSchema() {
  return {
    system_settings: 'Typed settings: operator_databases.enabled and routing.selection_policy.<role>. system.database.* is read-only; operator.* is metadata.',
    model_evaluations: 'Empirical selector scores for each exact model binding.',
    model_registry: 'Operator facts for known model bindings.',
    model_notes: 'Optional operator annotations for registered models.',
    model_health: 'Persisted temporary cooldown and quarantine state.',
    session_ledgers: 'Authoritative NLA workflow checkpoints used for restore and compaction.',
    restore_blocks: 'Fail-closed markers that deny unsafe continuation after restore failure.',
    database_catalog: 'Named operator databases outside NLA architectural tables.',
    schema_migrations: 'Applied system database migrations.',
    data_migrations: 'One-time imports of legacy and seed data.',
  };
}

function legacyLedgerPath(stateRoot, sessionID) { return path.join(path.resolve(stateRoot), 'sessions', `${validSessionID(sessionID)}.json`); }
function legacyRestoreBlockPath(stateRoot, sessionID) { return path.join(path.resolve(stateRoot), 'restore-blocked', `${validSessionID(sessionID)}.json`); }

export function saveSystemLedger(file, ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new SystemDatabaseError('System ledger must be an object');
  const sessionID = validSessionID(ledger.session_id);
  if (typeof ledger.directory !== 'string' || !ledger.directory.trim()) throw new SystemDatabaseError('System ledger requires directory');
  const value = JSON.stringify(ledger);
  if (value.length > 128000) throw new SystemDatabaseError('System ledger is oversized');
  assertNoSecrets(ledger, 'System ledger');
  const db = openDatabase(file);
  try {
    transaction(db, () => {
      migrate(db);
      db.prepare(`INSERT INTO session_ledgers (session_id, directory, ledger_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET directory = excluded.directory, ledger_json = excluded.ledger_json, updated_at = excluded.updated_at`)
        .run(sessionID, ledger.directory, value, now());
    });
    return { session_id: sessionID, database: file };
  } finally { closeDatabase(db); }
}

export function loadSystemLedger(file, stateRoot, sessionID) {
  const id = validSessionID(sessionID);
  const db = openDatabase(file);
  try {
    migrate(db);
    const row = db.prepare('SELECT ledger_json FROM session_ledgers WHERE session_id = ?').get(id);
    if (row) return JSON.parse(row.ledger_json);
  } finally { closeDatabase(db); }
  const legacy = legacyLedgerPath(stateRoot, id);
  if (!fs.existsSync(legacy)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')); }
  catch { throw new SystemDatabaseError('Legacy session ledger is malformed'); }
  saveSystemLedger(file, parsed);
  return parsed;
}

export function saveSystemRestoreBlock(file, sessionID, { reason, code } = {}) {
  const id = validSessionID(sessionID);
  const safeReason = String(reason || 'Unknown NLA restore failure').slice(0, 300);
  const safeCode = typeof code === 'string' ? code.slice(0, 120) : null;
  const db = openDatabase(file);
  try {
    transaction(db, () => {
      migrate(db);
      db.prepare(`INSERT INTO restore_blocks (session_id, reason, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET reason = excluded.reason, code = excluded.code, updated_at = excluded.updated_at`)
        .run(id, safeReason, safeCode, now(), now());
    });
  } finally { closeDatabase(db); }
}

export function hasSystemRestoreBlock(file, stateRoot, sessionID) {
  const id = validSessionID(sessionID);
  const db = openDatabase(file);
  try {
    migrate(db);
    if (db.prepare('SELECT session_id FROM restore_blocks WHERE session_id = ?').get(id)) return true;
  } finally { closeDatabase(db); }
  const legacy = legacyRestoreBlockPath(stateRoot, id);
  if (!fs.existsSync(legacy)) return false;
  try { saveSystemRestoreBlock(file, id, JSON.parse(fs.readFileSync(legacy, 'utf8'))); }
  catch { saveSystemRestoreBlock(file, id, { reason: 'Legacy restore-block record is malformed', code: 'NLA_CONTEXT_RESTORE_BLOCKED' }); }
  return true;
}

export function systemDatabaseStatus(file) {
  const db = openDatabase(file);
  try {
    migrate(db);
    return {
      path: file,
      version: SYSTEM_DATABASE_VERSION,
      settings: Number(db.prepare('SELECT COUNT(*) AS count FROM system_settings').get().count),
      model_evaluations: evaluationCount(db),
      registered_models: Number(db.prepare('SELECT COUNT(*) AS count FROM model_registry').get().count),
      model_notes: Number(db.prepare('SELECT COUNT(*) AS count FROM model_notes').get().count),
      health_records: Number(db.prepare('SELECT COUNT(*) AS count FROM model_health').get().count),
      session_ledgers: Number(db.prepare('SELECT COUNT(*) AS count FROM session_ledgers').get().count),
      restore_blocks: Number(db.prepare('SELECT COUNT(*) AS count FROM restore_blocks').get().count),
      databases: db.prepare('SELECT name, purpose, created_at, updated_at FROM database_catalog ORDER BY name').all(),
    };
  } finally { closeDatabase(db); }
}

export function loadSystemHealth(file, nowMs = Date.now()) {
  const db = openDatabase(file);
  try {
    migrate(db);
    db.prepare("DELETE FROM model_health WHERE state = 'cooling' AND until_ms IS NOT NULL AND until_ms <= ?").run(nowMs);
    return db.prepare('SELECT binding, endpoint, state, category, reason, since_ms, until_ms FROM model_health ORDER BY binding, endpoint').all()
      .map((row) => ({ binding: row.binding, endpoint: row.endpoint, state: row.state, category: row.category, reason: row.reason, since: row.since_ms, until: row.until_ms }));
  } finally { closeDatabase(db); }
}

export function saveSystemHealth(file, binding, endpoint = '', health = null) {
  validBinding(binding);
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new SystemDatabaseError('Invalid model health endpoint');
  const db = openDatabase(file);
  try {
    transaction(db, () => {
      migrate(db);
      if (!health || health.state === 'available') {
        db.prepare('DELETE FROM model_health WHERE binding = ? AND endpoint = ?').run(binding, endpoint);
        return;
      }
      if (!['cooling', 'quarantined'].includes(health.state) || !Number.isFinite(health.since) || (health.until !== null && health.until !== undefined && !Number.isFinite(health.until))) throw new SystemDatabaseError('Invalid persisted model health state');
      db.prepare(`INSERT INTO model_health (binding, endpoint, state, category, reason, since_ms, until_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding, endpoint) DO UPDATE SET state = excluded.state, category = excluded.category,
          reason = excluded.reason, since_ms = excluded.since_ms, until_ms = excluded.until_ms, updated_at = excluded.updated_at`)
        .run(binding, endpoint, health.state, health.category || null, health.reason || null, health.since, health.until ?? null, now());
    });
  } finally { closeDatabase(db); }
}

function validateImport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) throw new SystemDatabaseError('Model import requires an object with a models map');
  const models = [];
  for (const [binding, record] of Object.entries(value.models)) {
    validBinding(binding);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new SystemDatabaseError(`Invalid model import record for ${binding}`);
    let scores;
    if (record.scores !== undefined) {
      const candidate = { version: 1, models: { [binding]: { scores: record.scores } } };
      scores = validateEvaluationStore(candidate).models[binding].scores;
    }
    const facts = record.facts === undefined ? undefined : record.facts;
    if (facts !== undefined && (!facts || typeof facts !== 'object' || Array.isArray(facts) || Object.keys(facts).some((key) => !['context_window', 'input_cost', 'output_cost', 'availability'].includes(key)))) throw new SystemDatabaseError(`Invalid facts for ${binding}`);
    if (facts?.context_window !== undefined && (!Number.isInteger(facts.context_window) || facts.context_window <= 0)) throw new SystemDatabaseError(`context_window must be a positive integer for ${binding}`);
    for (const key of ['input_cost', 'output_cost']) if (facts?.[key] !== undefined && (!Number.isFinite(facts[key]) || facts[key] < 0)) throw new SystemDatabaseError(`${key} must be a non-negative number for ${binding}`);
    if (facts?.availability !== undefined && typeof facts.availability !== 'string' && typeof facts.availability !== 'boolean' && (typeof facts.availability !== 'object' || facts.availability === null || Array.isArray(facts.availability))) throw new SystemDatabaseError(`availability must be a string, boolean, or object for ${binding}`);
    if (facts !== undefined) validateModelPools({ roles: { model_import: { enabled: true, models: [binding], model_facts: { [binding]: { id: binding, ...facts } } } } }, 'model registry import');
    const notes = record.notes === undefined ? {} : record.notes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) throw new SystemDatabaseError(`notes must be an object for ${binding}`);
    for (const [key, text] of Object.entries(notes)) {
      if (!IDENTIFIER.test(key) || typeof text !== 'string' || !text.trim() || text.length > 4000 || SECRET_PATTERN.test(text)) throw new SystemDatabaseError(`Invalid note ${key} for ${binding}`);
    }
    models.push({ binding, scores, facts, notes });
  }
  return models;
}

export function importModelRegistry(file, payloadJSON, { overwriteScores = false } = {}) {
  const models = validateImport(json(payloadJSON, 'Model import', 131072));
  const db = openDatabase(file);
  try {
    const result = transaction(db, () => {
      migrate(db);
      const inserted = [];
      const updated = [];
      for (const model of models) {
        const existing = db.prepare('SELECT binding FROM model_registry WHERE binding = ?').get(model.binding);
        const oldEvaluation = db.prepare('SELECT binding FROM model_evaluations WHERE binding = ?').get(model.binding);
        const oldFacts = db.prepare('SELECT facts_json FROM model_registry WHERE binding = ?').get(model.binding);
        const facts = model.facts === undefined ? (oldFacts ? JSON.parse(oldFacts.facts_json) : {}) : model.facts;
        db.prepare(`INSERT INTO model_registry (binding, facts_json, source, updated_at) VALUES (?, ?, 'operator-import', ?)
          ON CONFLICT(binding) DO UPDATE SET facts_json = excluded.facts_json, source = excluded.source, updated_at = excluded.updated_at`)
          .run(model.binding, jsonText(facts), now());
        if (model.scores && (!oldEvaluation || overwriteScores)) {
          db.prepare(`INSERT INTO model_evaluations (binding, coding, reasoning, tool_use, reliability, latency, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(binding) DO UPDATE SET coding = excluded.coding, reasoning = excluded.reasoning,
              tool_use = excluded.tool_use, reliability = excluded.reliability, latency = excluded.latency, updated_at = excluded.updated_at`)
            .run(model.binding, model.scores.coding, model.scores.reasoning, model.scores.tool_use, model.scores.reliability, model.scores.latency, now());
        }
        for (const [noteKey, noteText] of Object.entries(model.notes)) {
          db.prepare(`INSERT INTO model_notes (binding, note_key, note_text, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(binding, note_key) DO UPDATE SET note_text = excluded.note_text, updated_at = excluded.updated_at`)
            .run(model.binding, noteKey, noteText, now());
        }
        (existing ? updated : inserted).push(model.binding);
      }
      return { inserted, updated, score_overwrite: overwriteScores };
    });
    return result;
  } finally { closeDatabase(db); }
}

export function listModelRegistry(file, binding = null) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const where = binding ? 'WHERE r.binding = ?' : '';
    const rows = db.prepare(`SELECT r.binding, r.facts_json, r.source, r.updated_at, e.coding, e.reasoning, e.tool_use, e.reliability, e.latency
      FROM model_registry r LEFT JOIN model_evaluations e ON e.binding = r.binding ${where} ORDER BY r.binding`).all(...(binding ? [validBinding(binding)] : []));
    return rows.map((row) => ({
      binding: row.binding, facts: JSON.parse(row.facts_json), source: row.source, updated_at: row.updated_at,
      scores: row.coding === null ? null : Object.fromEntries(EVALUATION_SCORE_KEYS.map((key) => [key, row[key]])),
      notes: Object.fromEntries(db.prepare('SELECT note_key, note_text FROM model_notes WHERE binding = ? ORDER BY note_key').all(row.binding).map((note) => [note.note_key, note.note_text])),
    }));
  } finally { closeDatabase(db); }
}

// Pool configuration owns role membership and provides only first-run facts.
// Once registered, SQLite owns model facts, including operator imports.
export function synchronizeConfiguredModelRegistry(file, roles = {}) {
  const records = new Map();
  for (const pool of Object.values(roles)) {
    if (!pool || !Array.isArray(pool.models)) continue;
    for (const binding of pool.models) {
      validBinding(binding);
      const { id: _id, ...facts } = pool.model_facts?.[binding] || pool.model_metadata?.[binding] || {};
      const previous = records.get(binding) || {};
      records.set(binding, { ...previous, ...facts });
    }
  }
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      const statement = db.prepare(`INSERT INTO model_registry (binding, facts_json, source, updated_at) VALUES (?, ?, 'pool-config-seed', ?)
        ON CONFLICT(binding) DO UPDATE SET facts_json = excluded.facts_json, source = excluded.source, updated_at = excluded.updated_at
        WHERE model_registry.facts_json = '{}' AND model_registry.source <> 'operator-import'`);
      for (const [binding, facts] of records) statement.run(binding, jsonText(facts), now());
      return records.size;
    });
  } finally { closeDatabase(db); }
}

// Runtime metadata fills holes only: operator facts and configured prices win.
export function synchronizeRuntimeModelFacts(file, roles, providers) {
  const candidates = new Map();
  for (const pool of Object.values(roles)) {
    if (pool?.runtime === 'utility') continue;
    for (const binding of pool?.models || []) {
      const slash = binding.indexOf('/');
      const provider = providers.find((item) => item?.id === binding.slice(0, slash));
      const model = provider?.models?.[binding.slice(slash + 1)];
      if (!model) continue;
      const facts = {};
      if (Number.isSafeInteger(model.limit?.context) && model.limit.context > 0) facts.context_window = model.limit.context;
      for (const [field, key] of [['input_cost', 'input'], ['output_cost', 'output']]) {
        if (typeof model.cost?.[key] === 'number' && Number.isFinite(model.cost[key]) && model.cost[key] >= 0) facts[field] = model.cost[key];
      }
      candidates.set(binding, facts);
    }
  }
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      const query = db.prepare('SELECT facts_json FROM model_registry WHERE binding = ?');
      const update = db.prepare('UPDATE model_registry SET facts_json = ?, updated_at = ? WHERE binding = ?');
      let models_updated = 0;
      let fields_added = 0;
      for (const [binding, discovered] of candidates) {
        const row = query.get(binding);
        if (!row) continue;
        const facts = JSON.parse(row.facts_json);
        const missing = Object.entries(discovered).filter(([key]) => !Object.hasOwn(facts, key));
        if (!missing.length) continue;
        update.run(jsonText({ ...facts, ...Object.fromEntries(missing) }), now(), binding);
        models_updated++;
        fields_added += missing.length;
      }
      return { models_updated, fields_added };
    });
  } finally { closeDatabase(db); }
}

export function poolWithSystemFacts(file, pool) {
  if (!pool || !Array.isArray(pool.models)) return pool;
  const db = openDatabase(file);
  try {
    migrate(db);
    const query = db.prepare('SELECT facts_json FROM model_registry WHERE binding = ?');
    const facts = {};
    for (const binding of pool.models) {
      const row = query.get(binding);
      if (row) facts[binding] = JSON.parse(row.facts_json);
    }
    return { ...pool, model_facts: facts };
  } finally { closeDatabase(db); }
}

function userDatabaseFile(stateRoot, name) {
  if (!IDENTIFIER.test(name) || name === SYSTEM_DATABASE_NAME) throw new SystemDatabaseError('Database name must be a lowercase identifier other than system');
  return path.join(path.resolve(stateRoot), 'databases', `${name}.sqlite`);
}

export function createUserDatabase(systemFile, stateRoot, name, purpose) {
  const file = userDatabaseFile(stateRoot, name);
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500 || SECRET_PATTERN.test(purpose)) throw new SystemDatabaseError('Database purpose must be 1-500 non-secret characters');
  const system = openDatabase(systemFile);
  try {
    transaction(system, () => {
      migrate(system);
      if (getSettingFromOpenDatabase(system, 'operator_databases.enabled') !== true) throw new SystemDatabaseError('Operator databases are disabled');
      if (system.prepare('SELECT name FROM database_catalog WHERE name = ?').get(name)) throw new SystemDatabaseError(`Database already exists: ${name}`);
      const user = openDatabase(file);
      try {
        user.exec('CREATE TABLE IF NOT EXISTS database_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);');
        user.prepare('INSERT INTO database_metadata (key, value_json, updated_at) VALUES (?, ?, ?)').run('purpose', jsonText(purpose.trim()), now());
      } finally { closeDatabase(user); }
      system.prepare('INSERT INTO database_catalog (name, relative_path, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, path.join('databases', `${name}.sqlite`), purpose.trim(), now(), now());
    });
    return { name, path: file, purpose: purpose.trim() };
  } finally { closeDatabase(system); }
}

function quotedIdentifier(name, label) {
  if (!IDENTIFIER.test(name)) throw new SystemDatabaseError(`${label} must be a lowercase identifier`);
  return `"${name}"`;
}

export function createUserTable(systemFile, stateRoot, databaseName, tableName, columnsJSON) {
  const file = userDatabaseFile(stateRoot, databaseName);
  const columns = json(columnsJSON, 'Table columns');
  if (!Array.isArray(columns) || !columns.length || columns.length > 64) throw new SystemDatabaseError('Table columns must be an array of 1-64 columns');
  const definitions = columns.map((column) => {
    if (!column || typeof column !== 'object' || Array.isArray(column) || Object.keys(column).some((key) => !['name', 'type', 'primary_key', 'not_null'].includes(key))) throw new SystemDatabaseError('Each table column has unsupported fields');
    const type = String(column.type || '').toUpperCase();
    if (!USER_COLUMN_TYPES.has(type)) throw new SystemDatabaseError('Column type must be TEXT, INTEGER, REAL, or BLOB');
    return `${quotedIdentifier(column.name, 'Column name')} ${type}${column.primary_key === true ? ' PRIMARY KEY' : ''}${column.not_null === true ? ' NOT NULL' : ''}`;
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length) throw new SystemDatabaseError('Table column names must be unique');
  const system = openDatabase(systemFile);
  try {
    migrate(system);
    if (getSettingFromOpenDatabase(system, 'operator_databases.enabled') !== true) throw new SystemDatabaseError('Operator databases are disabled');
    if (!system.prepare('SELECT name FROM database_catalog WHERE name = ?').get(databaseName) || !fs.existsSync(file)) throw new SystemDatabaseError(`Unknown database: ${databaseName}`);
  } finally { closeDatabase(system); }
  const user = openDatabase(file);
  try {
    user.exec(`CREATE TABLE ${quotedIdentifier(tableName, 'Table name')} (${definitions.join(', ')})`);
    return { database: databaseName, table: tableName, columns: columns.map((column) => ({ ...column, type: String(column.type).toUpperCase() })) };
  } finally { closeDatabase(user); }
}

export function listUserTables(systemFile, stateRoot, databaseName) {
  const file = userDatabaseFile(stateRoot, databaseName);
  const system = openDatabase(systemFile);
  try {
    migrate(system);
    if (!system.prepare('SELECT name FROM database_catalog WHERE name = ?').get(databaseName) || !fs.existsSync(file)) throw new SystemDatabaseError(`Unknown database: ${databaseName}`);
  } finally { closeDatabase(system); }
  const user = openDatabase(file);
  try {
    return user.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({
      name,
      columns: user.prepare(`PRAGMA table_info(${quotedIdentifier(name, 'Table name')})`).all().map((column) => ({ name: column.name, type: column.type, primary_key: Boolean(column.pk), not_null: Boolean(column.notnull) })),
    }));
  } finally { closeDatabase(user); }
}
