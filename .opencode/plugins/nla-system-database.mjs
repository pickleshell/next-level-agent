import fs from 'node:fs';
import path from 'node:path';

import {
  EVALUATION_SCORE_KEYS, emptyEvaluationStore,
  parseReviewerEvaluation, updateEvaluationScores, validateEvaluationStore,
} from './nla-model-evaluations.mjs';
import { normalizeAutoPool, parseModelBinding, validateModelPools } from './nla-model-pools.mjs';

// OpenCode CLI loads local plugins in Bun, while some Desktop builds use
// Node/Electron. Both runtimes have a built-in SQLite implementation, but
// expose it under different module names.
const SQLiteDatabase = globalThis.Bun
  ? (await import('bun:sqlite')).Database
  : (await import('node:sqlite')).DatabaseSync;

export const SYSTEM_DATABASE_VERSION = 4;

export class SystemDatabaseError extends Error {
  constructor(message) { super(message); this.name = 'SystemDatabaseError'; }
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)["']?\s*[:=]\s*["']?\S+/i;
const SYSTEM_DATABASE_NAME = 'system';
const USER_COLUMN_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB']);
const SESSION_ID = /^[A-Za-z0-9_-]{8,160}$/;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)/i;
const SELECT_POLICIES = new Set(['quality', 'balanced', 'cost', 'local']);
const ORCHESTRA_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  try { return parseModelBinding(binding).binding; }
  catch { throw new SystemDatabaseError('Model binding must be an exact provider/model identifier'); }
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
    CREATE TABLE IF NOT EXISTS orchestras (
      name TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestra_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_name TEXT NOT NULL REFERENCES orchestras(name),
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
    CREATE TABLE IF NOT EXISTS provider_registry (
      provider_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
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
    CREATE TABLE IF NOT EXISTS model_usage_events (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      root_session_id TEXT NOT NULL,
      role TEXT,
      binding TEXT NOT NULL,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      cost REAL NOT NULL CHECK (cost >= 0),
      finish_reason TEXT,
      observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_usage_events_root_observed_idx
      ON model_usage_events (root_session_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS model_usage_events_binding_observed_idx
      ON model_usage_events (binding, observed_at DESC);
  `);
  db.prepare(`INSERT OR IGNORE INTO provider_registry (provider_id, status, updated_at)
    SELECT DISTINCT substr(binding, 1, instr(binding, '/') - 1), 'enabled', ?
    FROM model_registry WHERE instr(binding, '/') > 1`).run(now());
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
  db.prepare('UPDATE system_settings SET value_json = ?, updated_at = ? WHERE setting_key = ?')
    .run(jsonText(SYSTEM_DATABASE_VERSION), now(), 'system.database.version');
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
  } else if (/^routing\.selection_policy\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_]*)?$/.test(key)) {
    if (!SELECT_POLICIES.has(value)) throw new SystemDatabaseError(`${key} must be quality, balanced, cost, or local`);
  } else if (/^routing\.selection_preferences\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_]*)?$/.test(key)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'minimum_score,selection_policy'
      || !SELECT_POLICIES.has(value.selection_policy)
      || typeof value.minimum_score !== 'number' || !Number.isFinite(value.minimum_score) || value.minimum_score < 0 || value.minimum_score > 10) {
      throw new SystemDatabaseError(`${key} requires selection_policy and minimum_score (0–10)`);
    }
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

export function configuredSelectionPolicy(file, role, orchestra = 'go') {
  if (!IDENTIFIER.test(role)) throw new SystemDatabaseError('Invalid role name');
  validOrchestraName(orchestra);
  const value = getSystemSetting(file, orchestra === 'go' ? `routing.selection_policy.${role}` : `routing.selection_policy.${orchestra}.${role}`)?.value;
  if (value !== null && value !== undefined && !SELECT_POLICIES.has(value)) throw new SystemDatabaseError(`Invalid stored selection policy for ${role}`);
  return value ?? null;
}

export function configuredSelectionPreferences(file, role, orchestra = 'go') {
  if (!IDENTIFIER.test(role)) throw new SystemDatabaseError('Invalid role name');
  validOrchestraName(orchestra);
  const scope = orchestra === 'go' ? role : `${orchestra}.${role}`;
  const saved = getSystemSetting(file, `routing.selection_preferences.${scope}`);
  const legacy = getSystemSetting(file, `routing.selection_policy.${scope}`);
  if (!saved) return legacy ? { selection_policy: legacy.value } : null;
  // Older persisted records may still contain cost_weight; it is no longer a
  // routing input and must not leak back into the effective pool snapshot.
  return { selection_policy: legacy?.value ?? saved.value.selection_policy, minimum_score: saved.value.minimum_score };
}

export function saveSelectionPreferences(file, role, orchestra, preferences) {
  if (!IDENTIFIER.test(role)) throw new SystemDatabaseError('Invalid role name');
  validOrchestraName(orchestra);
  const scope = orchestra === 'go' ? role : `${orchestra}.${role}`;
  const key = `routing.selection_preferences.${scope}`;
  validateSetting(key, preferences);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      db.prepare(`INSERT INTO system_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, jsonText(preferences), now());
      // A previously saved policy-only override must not hide this complete set.
      db.prepare('DELETE FROM system_settings WHERE setting_key = ?').run(`routing.selection_policy.${scope}`);
      return { key, value: preferences };
    });
  } finally { closeDatabase(db); }
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
    orchestras: 'Named durable role, model-pool, and policy configurations. go is seeded from the original pool file.',
    orchestra_state: 'Durable active orchestra name; new tasks use its current snapshot.',
    system_settings: 'Typed settings: operator_databases.enabled and routing.selection_policy.<role> for go, or routing.selection_policy.<orchestra>.<role>. system.database.* is read-only; operator.* is metadata.',
    model_evaluations: 'Empirical selector scores for each exact model binding.',
    model_registry: 'Operator facts and durable enabled/disabled status for each exact model binding.',
    provider_registry: 'Independent durable enabled/disabled status for each provider; disabled providers exclude their models from new NLA tasks without changing model facts or evaluations.',
    model_notes: 'Optional operator annotations for registered models.',
    model_health: 'Persisted temporary cooldown and quarantine state.',
    model_usage_events: 'Privacy-preserving per-completed-request token, cache, cost, model, role, and finish metadata; never prompt or response text.',
    session_ledgers: 'Authoritative NLA workflow checkpoints used for restore and compaction.',
    restore_blocks: 'Fail-closed markers that deny unsafe continuation after restore failure.',
    database_catalog: 'Named operator databases outside NLA architectural tables.',
    schema_migrations: 'Applied system database migrations.',
    data_migrations: 'One-time imports of legacy and seed data.',
  };
}

function validOrchestraName(name) {
  if (!ORCHESTRA_NAME.test(name || '')) throw new SystemDatabaseError('Orchestra name must be a lowercase identifier (up to 64 characters)');
  return name;
}

function validOrchestraConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new SystemDatabaseError('Orchestra config must be an object');
  if (config.version !== undefined && config.version !== 1) throw new SystemDatabaseError('Unsupported orchestra config version');
  if (config.guidance !== undefined && (typeof config.guidance !== 'string' || config.guidance.length > 1000)) throw new SystemDatabaseError('Orchestra guidance must be a string up to 1000 characters');
  const normalized = { version: config.version ?? 1, roles: config.roles && Object.fromEntries(Object.entries(config.roles).map(([role, pool]) => [role, normalizeAutoPool(pool)])), ...(config.guidance ? { guidance: config.guidance } : {}) };
  validateModelPools(normalized, 'orchestra');
  for (const role of ['nla', 'router', 'supervisor', 'scout', 'explorer', 'architect', 'implementer', 'reviewer', 'compactor']) {
    if (!normalized.roles[role]) throw new SystemDatabaseError(`Orchestra is missing required role: ${role}`);
  }
  if (!Array.isArray(normalized.roles.nla.models) || normalized.roles.nla.models.length !== 1) throw new SystemDatabaseError('Orchestra nla role requires exactly one coordinator model');
  if (JSON.stringify(normalized).length > 262144) throw new SystemDatabaseError('Orchestra config is too large');
  assertNoSecrets(normalized, 'Orchestra config');
  return normalized;
}

export function initializeOrchestras(file, goConfig) {
  const config = validOrchestraConfig(goConfig);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      db.prepare('INSERT OR IGNORE INTO orchestras (name, config_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('go', jsonText(config), 'original-pool-config', now(), now());
      db.prepare('INSERT OR IGNORE INTO orchestra_state (id, active_name, updated_at) VALUES (1, ?, ?)').run('go', now());
      return db.prepare('SELECT active_name FROM orchestra_state WHERE id = 1').get().active_name;
    });
  } finally { closeDatabase(db); }
}

export function listOrchestras(file) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const active = db.prepare('SELECT active_name FROM orchestra_state WHERE id = 1').get()?.active_name;
    return db.prepare('SELECT name, source, created_at, updated_at FROM orchestras ORDER BY name').all()
      .map((row) => ({ ...row, active: row.name === active }));
  } finally { closeDatabase(db); }
}

export function getOrchestra(file, name = null) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const selected = name === null ? db.prepare('SELECT active_name FROM orchestra_state WHERE id = 1').get()?.active_name : validOrchestraName(name);
    if (!selected) return null;
    const row = db.prepare('SELECT name, config_json, source, created_at, updated_at FROM orchestras WHERE name = ?').get(selected);
    return row ? { name: row.name, config: validOrchestraConfig(JSON.parse(row.config_json)), source: row.source, created_at: row.created_at, updated_at: row.updated_at } : null;
  } finally { closeDatabase(db); }
}

export function saveOrchestra(file, name, config) {
  validOrchestraName(name);
  const valid = validOrchestraConfig(config);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      if (db.prepare('SELECT 1 FROM orchestras WHERE name = ?').get(name)) throw new SystemDatabaseError(`Orchestra already exists: ${name}`);
      db.prepare('INSERT INTO orchestras (name, config_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, jsonText(valid), 'operator', now(), now());
      return { name, roles: Object.keys(valid.roles).length };
    });
  } finally { closeDatabase(db); }
}

export function reloadGoOrchestra(file, config) {
  const valid = validOrchestraConfig(config);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      db.prepare('UPDATE orchestras SET config_json = ?, updated_at = ? WHERE name = ?').run(jsonText(valid), now(), 'go');
      return { name: 'go', roles: Object.keys(valid.roles).length };
    });
  } finally { closeDatabase(db); }
}

export function updateOrchestra(file, name, config) {
  validOrchestraName(name);
  if (name === 'go') throw new SystemDatabaseError('The go orchestra is updated only by reloading its original pool file');
  const valid = validOrchestraConfig(config);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      if (!db.prepare('SELECT 1 FROM orchestras WHERE name = ?').get(name)) throw new SystemDatabaseError(`Unknown orchestra: ${name}`);
      db.prepare('UPDATE orchestras SET config_json = ?, updated_at = ? WHERE name = ?')
        .run(jsonText(valid), now(), name);
      return { name, roles: Object.keys(valid.roles).length };
    });
  } finally { closeDatabase(db); }
}

export function activateOrchestra(file, name) {
  validOrchestraName(name);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      if (!db.prepare('SELECT 1 FROM orchestras WHERE name = ?').get(name)) throw new SystemDatabaseError(`Unknown orchestra: ${name}`);
      db.prepare('UPDATE orchestra_state SET active_name = ?, updated_at = ? WHERE id = 1').run(name, now());
      return { active: name };
    });
  } finally { closeDatabase(db); }
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
      registered_providers: Number(db.prepare('SELECT COUNT(*) AS count FROM provider_registry').get().count),
      orchestras: Number(db.prepare('SELECT COUNT(*) AS count FROM orchestras').get().count),
      active_orchestra: db.prepare('SELECT active_name FROM orchestra_state WHERE id = 1').get()?.active_name || null,
      model_notes: Number(db.prepare('SELECT COUNT(*) AS count FROM model_notes').get().count),
      health_records: Number(db.prepare('SELECT COUNT(*) AS count FROM model_health').get().count),
      model_usage_events: Number(db.prepare('SELECT COUNT(*) AS count FROM model_usage_events').get().count),
      session_ledgers: Number(db.prepare('SELECT COUNT(*) AS count FROM session_ledgers').get().count),
      restore_blocks: Number(db.prepare('SELECT COUNT(*) AS count FROM restore_blocks').get().count),
      databases: db.prepare('SELECT name, purpose, created_at, updated_at FROM database_catalog ORDER BY name').all(),
    };
  } finally { closeDatabase(db); }
}

function usageInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SystemDatabaseError(`${field} must be a non-negative integer`);
  return value;
}

function usageText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || SECRET_PATTERN.test(value)) throw new SystemDatabaseError(`Invalid model usage ${field}`);
  return value;
}

function validateUsageEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new SystemDatabaseError('Model usage event must be an object');
  const message_id = validSessionID(event.message_id);
  const session_id = validSessionID(event.session_id);
  const root_session_id = validSessionID(event.root_session_id);
  const parent_session_id = event.parent_session_id === null || event.parent_session_id === undefined ? null : validSessionID(event.parent_session_id);
  const role = event.role === null || event.role === undefined ? null : usageText(event.role, 'role', 64);
  const binding = validBinding(event.binding);
  const finish_reason = event.finish_reason === null || event.finish_reason === undefined ? null : usageText(event.finish_reason, 'finish reason', 128);
  const cost = Number(event.cost ?? 0);
  if (!Number.isFinite(cost) || cost < 0) throw new SystemDatabaseError('Model usage cost must be a non-negative number');
  return {
    message_id, session_id, parent_session_id, root_session_id, role, binding, finish_reason,
    input_tokens: usageInteger(Number(event.input_tokens ?? 0), 'input_tokens'),
    output_tokens: usageInteger(Number(event.output_tokens ?? 0), 'output_tokens'),
    reasoning_tokens: usageInteger(Number(event.reasoning_tokens ?? 0), 'reasoning_tokens'),
    cache_read_tokens: usageInteger(Number(event.cache_read_tokens ?? 0), 'cache_read_tokens'),
    cache_write_tokens: usageInteger(Number(event.cache_write_tokens ?? 0), 'cache_write_tokens'),
    total_tokens: usageInteger(Number(event.total_tokens ?? 0), 'total_tokens'),
    cost,
  };
}

function usageIsMoreComplete(existing, next) {
  return ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens', 'cost']
    .some((key) => Number(next[key]) > Number(existing[key]));
}

// OpenCode can emit more than one update for an assistant message. Keep one
// row per message and accept only a strictly more complete final accounting.
export function recordSystemModelUsage(file, event) {
  const usage = validateUsageEvent(event);
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      const existing = db.prepare(`SELECT input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, cost FROM model_usage_events WHERE message_id = ?`).get(usage.message_id);
      if (existing && !usageIsMoreComplete(existing, usage)) return { recorded: false, message_id: usage.message_id };
      const statement = db.prepare(`INSERT INTO model_usage_events
        (message_id, session_id, parent_session_id, root_session_id, role, binding, input_tokens, output_tokens,
         reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, finish_reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET session_id = excluded.session_id, parent_session_id = excluded.parent_session_id,
          root_session_id = excluded.root_session_id, role = excluded.role, binding = excluded.binding,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens, cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens, total_tokens = excluded.total_tokens, cost = excluded.cost,
          finish_reason = excluded.finish_reason, observed_at = excluded.observed_at`);
      statement.run(usage.message_id, usage.session_id, usage.parent_session_id, usage.root_session_id, usage.role,
        usage.binding, usage.input_tokens, usage.output_tokens, usage.reasoning_tokens, usage.cache_read_tokens,
        usage.cache_write_tokens, usage.total_tokens, usage.cost, usage.finish_reason, now());
      return { recorded: true, message_id: usage.message_id };
    });
  } finally { closeDatabase(db); }
}

function usageFilters({ rootSessionID, role, binding } = {}) {
  const filters = [];
  const params = [];
  if (rootSessionID) { filters.push('root_session_id = ?'); params.push(validSessionID(rootSessionID)); }
  if (role) { filters.push('role = ?'); params.push(usageText(role, 'role', 64)); }
  if (binding) { filters.push('binding = ?'); params.push(validBinding(binding)); }
  return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
}

function usageLimit(limit) {
  const parsed = Number(limit ?? 20);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new SystemDatabaseError('Usage limit must be an integer from 1 to 100');
  return parsed;
}

export function listSystemModelUsage(file, { rootSessionID, role, binding, limit } = {}) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const filters = usageFilters({ rootSessionID, role, binding });
    return db.prepare(`SELECT message_id, session_id, parent_session_id, root_session_id, role, binding,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      cost, finish_reason, observed_at FROM model_usage_events ${filters.where}
      ORDER BY observed_at DESC LIMIT ?`).all(...filters.params, usageLimit(limit));
  } finally { closeDatabase(db); }
}

export function summarizeSystemModelUsage(file, { rootSessionID, role, binding } = {}) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const filters = usageFilters({ rootSessionID, role, binding });
    return db.prepare(`SELECT role, binding, COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(cost), 0) AS cost
      FROM model_usage_events ${filters.where} GROUP BY role, binding
      ORDER BY total_tokens DESC, binding ASC`).all(...filters.params);
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
    if (facts !== undefined && (!facts || typeof facts !== 'object' || Array.isArray(facts) || Object.keys(facts).some((key) => !['context_window', 'input_cost', 'output_cost', 'availability', 'status'].includes(key)))) throw new SystemDatabaseError(`Invalid facts for ${binding}`);
    if (facts?.status !== undefined && !['enabled', 'disabled'].includes(facts.status)) throw new SystemDatabaseError(`status must be enabled or disabled for ${binding}`);
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
        const previousFacts = oldFacts ? JSON.parse(oldFacts.facts_json) : {};
        const facts = model.facts === undefined ? previousFacts : {
          ...model.facts,
          ...(Object.hasOwn(previousFacts, 'status') && !Object.hasOwn(model.facts, 'status') ? { status: previousFacts.status } : {}),
        };
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

function validProviderID(provider) {
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) throw new SystemDatabaseError('Provider must be an exact provider ID');
  return provider;
}

export function listProviderRegistry(file, provider = null) {
  const db = openDatabase(file);
  try {
    migrate(db);
    return provider
      ? db.prepare('SELECT provider_id AS provider, status, updated_at FROM provider_registry WHERE provider_id = ?').all(validProviderID(provider))
      : db.prepare('SELECT provider_id AS provider, status, updated_at FROM provider_registry ORDER BY provider_id').all();
  } finally { closeDatabase(db); }
}

export function setProviderStatus(file, provider, status) {
  validProviderID(provider);
  if (!['enabled', 'disabled'].includes(status)) throw new SystemDatabaseError('Provider status must be enabled or disabled');
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      if (!db.prepare('SELECT 1 FROM provider_registry WHERE provider_id = ?').get(provider)) throw new SystemDatabaseError(`Provider is not registered: ${provider}`);
      db.prepare('UPDATE provider_registry SET status = ?, updated_at = ? WHERE provider_id = ?').run(status, now(), provider);
      return { provider, status };
    });
  } finally { closeDatabase(db); }
}

export function listModelRegistry(file, binding = null) {
  const db = openDatabase(file);
  try {
    migrate(db);
    const where = binding ? 'WHERE r.binding = ?' : '';
    const rows = db.prepare(`SELECT r.binding, r.facts_json, r.source, r.updated_at,
      p.status AS provider_status, e.coding, e.reasoning, e.tool_use, e.reliability, e.latency
      FROM model_registry r
      LEFT JOIN provider_registry p ON p.provider_id = substr(r.binding, 1, instr(r.binding, '/') - 1)
      LEFT JOIN model_evaluations e ON e.binding = r.binding ${where} ORDER BY r.binding`).all(...(binding ? [validBinding(binding)] : []));
    return rows.map((row) => {
      const facts = JSON.parse(row.facts_json);
      return {
        binding: row.binding, status: facts.status || 'enabled', provider_status: row.provider_status || 'enabled', facts, source: row.source, updated_at: row.updated_at,
        scores: row.coding === null ? null : Object.fromEntries(EVALUATION_SCORE_KEYS.map((key) => [key, row[key]])),
        notes: Object.fromEntries(db.prepare('SELECT note_key, note_text FROM model_notes WHERE binding = ? ORDER BY note_key').all(row.binding).map((note) => [note.note_key, note.note_text])),
      };
    });
  } finally { closeDatabase(db); }
}

export function setModelStatus(file, binding, status) {
  validBinding(binding);
  if (!['enabled', 'disabled'].includes(status)) throw new SystemDatabaseError('Model status must be enabled or disabled');
  const db = openDatabase(file);
  try {
    return transaction(db, () => {
      migrate(db);
      const row = db.prepare('SELECT facts_json FROM model_registry WHERE binding = ?').get(binding);
      if (!row) throw new SystemDatabaseError(`Model binding is not registered: ${binding}`);
      const facts = { ...JSON.parse(row.facts_json), status };
      db.prepare('UPDATE model_registry SET facts_json = ?, updated_at = ? WHERE binding = ?').run(jsonText(facts), now(), binding);
      return { binding, status };
    });
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
  const hasAuto = Object.values(roles).some((pool) => pool?.models === 'auto' || pool?.selection_mode === 'auto');
  const assigned = new Set(Object.values(roles).filter((pool) => pool?.runtime !== 'utility').flatMap((pool) => Array.isArray(pool.models) ? pool.models : []));
  const utilityOnly = new Set(Object.values(roles).filter((pool) => pool?.runtime === 'utility').flatMap((pool) => Array.isArray(pool.models) ? pool.models : []));
  for (const pool of Object.values(roles)) if (pool?.runtime !== 'utility' && Array.isArray(pool?.models)) for (const binding of pool.models) utilityOnly.delete(binding);
  for (const provider of providers) {
    if (!provider?.id || !provider.models || typeof provider.models !== 'object') continue;
    for (const [modelID, model] of Object.entries(provider.models)) {
      const binding = `${provider.id}/${modelID}`;
      try { validBinding(binding); } catch { continue; }
      if (!hasAuto && !assigned.has(binding)) continue;
      if (utilityOnly.has(binding)) continue;
      if (!model || (Array.isArray(model.modalities?.output) && !model.modalities.output.includes('text'))) continue;
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
      const insert = db.prepare("INSERT OR IGNORE INTO model_registry (binding, facts_json, source, updated_at) VALUES (?, ?, 'runtime-discovery', ?)");
      let models_updated = 0;
      let fields_added = 0;
      for (const [binding, discovered] of candidates) {
        insert.run(binding, jsonText(discovered), now());
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
    const query = db.prepare(`SELECT r.facts_json, p.status AS provider_status FROM model_registry r
      LEFT JOIN provider_registry p ON p.provider_id = substr(r.binding, 1, instr(r.binding, '/') - 1)
      WHERE r.binding = ?`);
    const providerQuery = db.prepare('SELECT status FROM provider_registry WHERE provider_id = ?');
    const facts = {};
    for (const binding of pool.models) {
      const row = query.get(binding);
      const stored = row ? JSON.parse(row.facts_json) : {};
      const provider = binding.slice(0, binding.indexOf('/'));
      const providerStatus = row?.provider_status || providerQuery.get(provider)?.status || 'enabled';
      if (row || providerStatus === 'disabled') facts[binding] = providerStatus === 'disabled' ? { ...stored, provider_status: 'disabled' } : stored;
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
