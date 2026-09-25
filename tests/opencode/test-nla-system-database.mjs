import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ModelHealthManager } from '../../.opencode/plugins/nla-model-health.mjs';
import { materializeAutoPool, rankModelCandidates, routableModelPool } from '../../.opencode/plugins/nla-model-selection.mjs';
import { createModelInventorySync } from '../../.opencode/plugins/nla-model-inventory.mjs';

import {
  configuredSelectionPolicy, createUserDatabase, createUserTable, getSystemSetting, importModelRegistry, initializeSystemDatabase,
  listModelRegistry, listProviderRegistry, listSystemModelUsage, listSystemSettings, listUserTables, loadSystemEvaluations, recordSystemEvaluation,
  hasSystemRestoreBlock, loadSystemLedger, saveSystemHealth, loadSystemHealth, saveSystemLedger, saveSystemRestoreBlock,
  poolWithSystemFacts, recordSystemModelUsage, setModelStatus, setProviderStatus, setSystemSetting, summarizeSystemModelUsage, synchronizeConfiguredModelRegistry, synchronizeRuntimeModelFacts, systemDatabasePath, systemDatabaseStatus, systemSchema, SYSTEM_DATABASE_VERSION,
} from '../../.opencode/plugins/nla-system-database.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-system-database-'));
const seed = path.join(root, 'seed.json');
const legacy = path.join(root, 'model-evaluations.json');
fs.writeFileSync(seed, JSON.stringify({ version: 1, models: { 'fixture/seed': { scores: { coding: 8, reasoning: 7, tool_use: 9, reliability: 0, latency: 0 } } } }));
fs.writeFileSync(legacy, JSON.stringify({ version: 1, models: { 'fixture/legacy': { scores: { coding: 7, reasoning: 8, tool_use: 7, reliability: 6, latency: 5 } } } }));

try {
  const upgradeRoot = path.join(root, 'provider-upgrade');
  const upgradeFile = initializeSystemDatabase({ stateRoot: upgradeRoot, seedPath: seed });
  synchronizeConfiguredModelRegistry(upgradeFile, { explorer: { models: ['fixture/seed'] } });
  const old = new DatabaseSync(upgradeFile);
  old.exec('DROP TABLE provider_registry; DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (3, \'legacy\')');
  old.close();
  assert.equal(listProviderRegistry(upgradeFile, 'fixture')[0].status, 'enabled', 'schema v3 upgrades and backfills providers');
  assert.equal(systemDatabaseStatus(upgradeFile).version, SYSTEM_DATABASE_VERSION);
  assert.equal(getSystemSetting(upgradeFile, 'system.database.version').value, SYSTEM_DATABASE_VERSION, 'schema version setting follows migration');
  assert.equal(loadSystemEvaluations(upgradeFile).models['fixture/seed'].scores.coding, 8, 'provider migration preserves evaluations');
  const inventoryFile = initializeSystemDatabase({ stateRoot: path.join(root, 'inventory'), seedPath: seed });
  const inventoryRoles = {
    explorer: { selection_mode: 'select', models: ['fixture/seed', 'fixture/invalid'], model_facts: { 'fixture/seed': { input_cost: 0 } } },
    compactor: { runtime: 'utility', models: ['fixture/utility'] },
  };
  synchronizeConfiguredModelRegistry(inventoryFile, inventoryRoles);
  const providers = [{ id: 'fixture', models: {
    seed: { limit: { context: 131072 }, cost: { input: 2, output: 3 }, apiKey: 'never-persist-this' },
    invalid: { limit: { context: -1 }, cost: { input: '2', output: Infinity } },
    utility: { limit: { context: 131072 } },
    unassigned: { limit: { context: 131072 } },
  } }];
  const scoresBefore = loadSystemEvaluations(inventoryFile);
  let calls = 0;
  const events = [];
  const sync = createModelInventorySync({ database: inventoryFile, directory: root, roles: () => inventoryRoles, report: (event) => events.push(event), client: { config: { providers: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { data: { providers } };
  } } } });
  await Promise.all([sync(), sync(), sync()]);
  assert.equal(calls, 1, 'concurrent discovery is coalesced');
  const discovered = poolWithSystemFacts(inventoryFile, inventoryRoles.explorer);
  assert.deepEqual(discovered.model_facts['fixture/seed'], { input_cost: 0, context_window: 131072, output_cost: 3 });
  assert.deepEqual(discovered.model_facts['fixture/invalid'], {}, 'invalid runtime metadata is ignored');
  assert.deepEqual(poolWithSystemFacts(inventoryFile, inventoryRoles.compactor).model_facts['fixture/utility'], {}, 'utility endpoint metadata is not inferred from OpenCode');
  assert.deepEqual(loadSystemEvaluations(inventoryFile), scoresBefore, 'discovery does not alter evaluations');
  assert.equal(listModelRegistry(inventoryFile).length, 3, 'unassigned catalogue entries are not registered');
  assert.deepEqual(rankModelCandidates({ role: 'explorer', pool: discovered, evaluations: scoresBefore, taskProfile: { context_window: 20000 } }).models, ['fixture/seed']);
  initializeSystemDatabase({ stateRoot: path.join(root, 'inventory'), seedPath: seed });
  assert.equal(poolWithSystemFacts(inventoryFile, inventoryRoles.explorer).model_facts['fixture/seed'].context_window, 131072, 'facts survive restart');
  importModelRegistry(inventoryFile, JSON.stringify({ models: { 'fixture/seed': { facts: { context_window: 32768, input_cost: 0 } } } }));
  await sync({ force: true });
  assert.equal(calls, 2);
  assert.deepEqual(poolWithSystemFacts(inventoryFile, inventoryRoles.explorer).model_facts['fixture/seed'], { context_window: 32768, input_cost: 0, output_cost: 3 });
  assert.equal(listModelRegistry(inventoryFile).find((row) => row.binding === 'fixture/seed').source, 'operator-import');
  assert.deepEqual(synchronizeRuntimeModelFacts(inventoryFile, inventoryRoles, providers), { models_updated: 0, fields_added: 0 });
  let finishLate;
  const timeoutSync = createModelInventorySync({ database: inventoryFile, roles: () => inventoryRoles, timeoutMs: 5, report: (event) => events.push(event), client: { config: { providers: () => new Promise((resolve) => { finishLate = resolve; }) } } });
  await timeoutSync();
  finishLate({ data: { providers: [{ id: 'fixture', models: { invalid: { limit: { context: 8192 } } } }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(poolWithSystemFacts(inventoryFile, inventoryRoles.explorer).model_facts['fixture/invalid'], {}, 'timed-out inventory cannot write late');
  assert.equal(events.at(-1).event, 'model_inventory_unavailable');
  assert.ok(!JSON.stringify(events).includes('never-persist-this'));
  let fail = true;
  const retrySync = createModelInventorySync({ database: inventoryFile, roles: () => inventoryRoles, client: { config: { providers: async () => {
    if (fail) throw new Error('provider secret');
    return { data: { providers: [{ id: 'fixture', models: { invalid: { limit: { context: 8192 } } } }] } };
  } } } });
  await retrySync();
  fail = false;
  await retrySync({ force: true });
  assert.equal(poolWithSystemFacts(inventoryFile, inventoryRoles.explorer).model_facts['fixture/invalid'].context_window, 8192, 'explicit reload retries failed discovery');

  // Reproduce first startup ordering: score seed registers bindings before
  // model-pool synchronization provides facts. The selector must see facts
  // after synchronization, and later operator facts must remain authoritative.
  const orderedRoot = path.join(root, 'ordered-startup');
  fs.mkdirSync(orderedRoot);
  const orderedSeed = path.join(orderedRoot, 'seed.json');
  fs.writeFileSync(orderedSeed, JSON.stringify({ version: 1, models: {
    'fixture/seed-qualified': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 8 } },
    'fixture/seed-small-context': { scores: { coding: 9, reasoning: 9, tool_use: 9, reliability: 9, latency: 9 } },
  } }));
  const orderedFile = initializeSystemDatabase({ stateRoot: orderedRoot, seedPath: orderedSeed });
  const orderedRoles = { explorer: { selection_mode: 'select', selection_policy: 'quality', models: ['fixture/seed-qualified', 'fixture/seed-small-context'], model_facts: {
    'fixture/seed-qualified': { context_window: 131072, input_cost: 0.2, output_cost: 1.2 },
    'fixture/seed-small-context': { context_window: 32768, input_cost: 0.1, output_cost: 0.5 },
  } } };
  synchronizeConfiguredModelRegistry(orderedFile, orderedRoles);
  const orderedPool = poolWithSystemFacts(orderedFile, orderedRoles.explorer);
  assert.equal(orderedPool.model_facts['fixture/seed-qualified'].input_cost, 0.2, 'pool sync fills seeded registry records with configured facts');
  const orderedSelection = rankModelCandidates({ role: 'explorer', pool: orderedPool, evaluations: loadSystemEvaluations(orderedFile), taskProfile: { context_window: 100000 } });
  assert.deepEqual(orderedSelection.models, ['fixture/seed-qualified'], 'seed → pool sync → selector retains the context-qualified seeded model');
  importModelRegistry(orderedFile, JSON.stringify({ models: { 'fixture/seed-qualified': { facts: { context_window: 196608, input_cost: 0.05, output_cost: 0.1 } } } }));
  synchronizeConfiguredModelRegistry(orderedFile, orderedRoles);
  assert.equal(poolWithSystemFacts(orderedFile, orderedRoles.explorer).model_facts['fixture/seed-qualified'].context_window, 196608, 'pool sync does not overwrite later operator imports');

  const malformedRoot = path.join(root, 'malformed');
  fs.mkdirSync(malformedRoot);
  const malformedLegacy = path.join(malformedRoot, 'legacy.json');
  fs.writeFileSync(malformedLegacy, '{broken');
  assert.throws(() => initializeSystemDatabase({ stateRoot: malformedRoot, seedPath: seed, legacyEvaluationPath: malformedLegacy }), /JSON|Unexpected/);
  assert.equal(fs.readFileSync(malformedLegacy, 'utf8'), '{broken', 'failed migration leaves the legacy file untouched');
  fs.writeFileSync(malformedLegacy, JSON.stringify({ version: 1, models: { 'fixture/recovered': { scores: { coding: 9, reasoning: 8, tool_use: 7, reliability: 6, latency: 5 } } } }));
  const recovered = initializeSystemDatabase({ stateRoot: malformedRoot, seedPath: seed, legacyEvaluationPath: malformedLegacy });
  assert.equal(loadSystemEvaluations(recovered).models['fixture/recovered'].scores.coding, 9, 'retry imports repaired observations after a failed migration');
  const emptyRoot = path.join(root, 'empty');
  fs.mkdirSync(emptyRoot);
  const emptyLegacy = path.join(emptyRoot, 'legacy.json');
  fs.writeFileSync(emptyLegacy, JSON.stringify({ version: 1, models: {} }));
  const emptyFile = initializeSystemDatabase({ stateRoot: emptyRoot, seedPath: seed, legacyEvaluationPath: emptyLegacy });
  assert.deepEqual(loadSystemEvaluations(emptyFile).models, {}, 'intentional empty legacy state is not replaced with seed');
  initializeSystemDatabase({ stateRoot: emptyRoot, seedPath: seed, legacyEvaluationPath: emptyLegacy });
  assert.deepEqual(loadSystemEvaluations(emptyFile).models, {}, 'empty migration marker prevents reseeding on restart');

  const file = initializeSystemDatabase({ stateRoot: root, seedPath: seed, legacyEvaluationPath: legacy });
  assert.equal(file, systemDatabasePath(root));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'system database is private');
  assert.equal(listSystemSettings(file).find((entry) => entry.key === 'operator_databases.enabled').value, true, 'typed operational defaults are visible as system settings');
  assert.equal(systemSchema().session_ledgers.includes('workflow checkpoints'), true, 'the logical system-data map documents critical ledger storage');
  assert.equal(systemSchema().model_usage_events.includes('never prompt or response text'), true, 'the logical system-data map documents privacy-safe usage storage');
  assert.deepEqual(Object.keys(loadSystemEvaluations(file).models), ['fixture/legacy'], 'legacy observations migrate before the seed');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, models: {} }));
  initializeSystemDatabase({ stateRoot: root, seedPath: seed, legacyEvaluationPath: legacy });
  assert.equal(loadSystemEvaluations(file).models['fixture/legacy'].scores.coding, 7, 'initial migration is one-time and preserves observations');

  assert.equal(setSystemSetting(file, 'routing.selection_policy.implementer', '"balanced"').value, 'balanced');
  assert.equal(configuredSelectionPolicy(file, 'implementer'), 'balanced');
  assert.equal(getSystemSetting(file, 'routing.selection_policy.implementer').value, 'balanced');
  assert.equal(setSystemSetting(file, 'routing.selection_policy.implementer', '"local"').value, 'local', 'local policy persists in SQLite');
  assert.equal(configuredSelectionPolicy(file, 'implementer'), 'local');
  setSystemSetting(file, 'routing.selection_policy.implementer', '"balanced"');
  assert.throws(() => setSystemSetting(file, 'system.database.version', '5'), /read-only/);
  assert.throws(() => setSystemSetting(file, 'routing.health_persistence', 'false'), /unsupported/);
  assert.equal(setSystemSetting(file, 'routing.selection_policy.explorer', '"free"').value, 'free');
  assert.equal(configuredSelectionPolicy(file, 'explorer'), 'free');
  assert.throws(() => setSystemSetting(file, 'routing.selection_policy.implementer', '"random"'), /quality, balanced, cost, local, or free/);
  assert.throws(() => setSystemSetting(file, 'api_key', '"secret"'), /Setting key|secret/i);
  assert.throws(() => setSystemSetting(file, 'operator.notes', '{"nested":{"api_key":"secret"}}'), /secret field/);

  const imported = importModelRegistry(file, JSON.stringify({ models: {
    'fixture/imported': {
      facts: { context_window: 131072, input_cost: 0.1, output_cost: 0.2, availability: 'always' },
      scores: { coding: 8, reasoning: 9, tool_use: 8, reliability: 0, latency: 0 },
      notes: { operator: 'initial registry import' },
    },
  } }));
  assert.deepEqual(imported.inserted, ['fixture/imported']);
  const record = listModelRegistry(file, 'fixture/imported')[0];
  assert.equal(record.facts.context_window, 131072);
  assert.equal(record.scores.reasoning, 9);
  assert.equal(record.notes.operator, 'initial registry import');
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].status, 'enabled', 'unmarked models default to enabled');
  assert.deepEqual(setModelStatus(file, 'fixture/imported', 'disabled'), { binding: 'fixture/imported', status: 'disabled' });
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].status, 'disabled');
  assert.equal(poolWithSystemFacts(file, { models: ['fixture/imported'] }).model_facts['fixture/imported'].status, 'disabled');
  importModelRegistry(file, JSON.stringify({ models: { 'fixture/imported': { facts: { context_window: 65536 } } } }));
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].status, 'disabled', 'ordinary facts import does not re-enable a disabled model');
  synchronizeConfiguredModelRegistry(file, { implementer: { models: ['fixture/imported'], model_facts: { 'fixture/imported': { context_window: 32768 } } } });
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].status, 'disabled', 'pool reload does not re-enable a disabled model');
  assert.deepEqual(setModelStatus(file, 'fixture/imported', 'enabled'), { binding: 'fixture/imported', status: 'enabled' });
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].scores.reasoning, 9, 'status changes retain evaluations');
  const scoresBeforeProviderPause = loadSystemEvaluations(file);
  assert.equal(listProviderRegistry(file, 'fixture')[0].status, 'enabled', 'registered model providers default to enabled');
  assert.deepEqual(setProviderStatus(file, 'fixture', 'disabled'), { provider: 'fixture', status: 'disabled' });
  const pausedModel = listModelRegistry(file, 'fixture/imported')[0];
  assert.equal(pausedModel.status, 'enabled', 'provider pause does not mutate model status');
  assert.equal(pausedModel.provider_status, 'disabled');
  assert.deepEqual(routableModelPool(poolWithSystemFacts(file, { models: ['fixture/imported'] })).models, [], 'fixed pools exclude a disabled provider');
  assert.deepEqual(materializeAutoPool({ selection_mode: 'auto', models: [] }, listModelRegistry(file), new Set(['fixture/imported'])).models, [], 'auto excludes a disabled provider');
  importModelRegistry(file, JSON.stringify({ models: { 'fixture/imported': { facts: { context_window: 65536 } } } }));
  assert.equal(listProviderRegistry(file, 'fixture')[0].status, 'disabled', 'model import does not re-enable a provider');
  initializeSystemDatabase({ stateRoot: path.dirname(file), seedPath: seed });
  assert.equal(listProviderRegistry(file, 'fixture')[0].status, 'disabled', 'provider pause survives restart');
  assert.deepEqual(loadSystemEvaluations(file), scoresBeforeProviderPause, 'provider pause preserves every model evaluation');
  assert.deepEqual(setProviderStatus(file, 'fixture', 'enabled'), { provider: 'fixture', status: 'enabled' });
  assert.deepEqual(routableModelPool(poolWithSystemFacts(file, { models: ['fixture/imported'] })).models, ['fixture/imported'], 'provider resume restores individually enabled model');
  setModelStatus(file, 'fixture/imported', 'disabled');
  setProviderStatus(file, 'fixture', 'disabled');
  setProviderStatus(file, 'fixture', 'enabled');
  assert.equal(listModelRegistry(file, 'fixture/imported')[0].status, 'disabled', 'provider resume does not enable an individually disabled model');
  assert.deepEqual(routableModelPool(poolWithSystemFacts(file, { models: ['fixture/imported'] })).models, []);
  setModelStatus(file, 'fixture/imported', 'enabled');
  assert.throws(() => setProviderStatus(file, 'bad/provider', 'disabled'), /provider ID/);
  assert.throws(() => setProviderStatus(file, 'typo-provider', 'disabled'), /not registered/);
  assert.throws(() => setModelStatus(file, 'fixture/missing', 'disabled'), /not registered/);
  assert.throws(() => setModelStatus(file, 'fixture/imported', 'paused'), /enabled or disabled/);
  const nestedBinding = 'command-code/xiaomi/mimo-v2.6-pro';
  importModelRegistry(file, JSON.stringify({ models: {
    [nestedBinding]: {
      facts: { context_window: 262144, input_cost: 0.1, output_cost: 0.2 },
      scores: { coding: 9, reasoning: 9, tool_use: 8, reliability: 0, latency: 0 },
    },
  } }));
  assert.equal(listModelRegistry(file, nestedBinding)[0].scores.coding, 9, 'registry accepts exact provider/model paths used by GOAT');
  assert.equal(loadSystemEvaluations(file).models[nestedBinding].scores.tool_use, 8);
  assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: poolWithSystemFacts(file, {
    selection_mode: 'select', selection_policy: 'quality', models: [nestedBinding],
  }), evaluations: loadSystemEvaluations(file) }).models, [nestedBinding], 'nested binding remains selectable');
  recordSystemEvaluation(file, nestedBinding, { coding: 7, reliability: 8 });
  assert.equal(listModelRegistry(file, nestedBinding)[0].scores.coding, 8, 'nested GOAT binding accepts runtime score updates');
  recordSystemEvaluation(file, 'fixture/imported', { coding: 6, reliability: 10 });
  assert.equal(loadSystemEvaluations(file).models['fixture/imported'].scores.coding, 7, 'runtime evaluation keeps half-average semantics');
  importModelRegistry(file, JSON.stringify({ models: { 'fixture/imported': { scores: { coding: 1, reasoning: 1, tool_use: 1, reliability: 1, latency: 1 } } } }));
  assert.equal(loadSystemEvaluations(file).models['fixture/imported'].scores.coding, 7, 'ordinary imports preserve empirical scores');
  importModelRegistry(file, JSON.stringify({ models: { 'fixture/imported': { scores: { coding: 1, reasoning: 1, tool_use: 1, reliability: 1, latency: 1 } } } }), { overwriteScores: true });
  assert.equal(loadSystemEvaluations(file).models['fixture/imported'].scores.coding, 1, 'explicit overwrite replaces empirical scores');
  assert.throws(() => importModelRegistry(file, JSON.stringify({ models: { 'bad//model': {} } })), /provider\/model/);
  assert.throws(() => importModelRegistry(file, JSON.stringify({ models: { 'bad/bad/model': {} } })), /provider\/model/);
  saveSystemHealth(file, 'fixture/imported', '', { state: 'cooling', category: 'transient', reason: 'provider_http_429', since: Date.now(), until: Date.now() + 60000 });
  assert.equal(loadSystemHealth(file).length, 1, 'cooldown health persists across a process restart');
  const hydratedHealth = new ModelHealthManager();
  hydratedHealth.hydrate(loadSystemHealth(file));
  assert.equal(hydratedHealth.state('fixture/imported').eligible, false, 'persisted cooldown hydrates the in-memory health filter');
  saveSystemHealth(file, 'fixture/imported', '', { state: 'available' });
  assert.equal(loadSystemHealth(file).length, 0, 'successful/reset health removes persistent cooldown');
  const ledger = { version: 1, session_id: 'session_12345678', directory: root, updated_at: new Date().toISOString(), tier: 2, verification_evidence: [] };
  saveSystemLedger(file, ledger);
  assert.deepEqual(loadSystemLedger(file, root, ledger.session_id), ledger, 'workflow ledger is restored from SQLite');
  const legacySessionID = 'session_legacy123';
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', `${legacySessionID}.json`), JSON.stringify({ ...ledger, session_id: legacySessionID }));
  assert.equal(loadSystemLedger(file, root, legacySessionID).session_id, legacySessionID, 'legacy workflow ledger is migrated lazily on first restore');
  saveSystemRestoreBlock(file, ledger.session_id, { reason: 'verification failed', code: 'NLA_CONTEXT_RESTORE_BLOCKED' });
  assert.equal(hasSystemRestoreBlock(file, root, ledger.session_id), true, 'restore block remains fail-closed in SQLite');
  const legacyBlockID = 'session_block1234';
  fs.mkdirSync(path.join(root, 'restore-blocked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'restore-blocked', `${legacyBlockID}.json`), JSON.stringify({ reason: 'legacy failure', code: 'NLA_CONTEXT_RESTORE_BLOCKED' }));
  assert.equal(hasSystemRestoreBlock(file, root, legacyBlockID), true, 'legacy restore block is migrated lazily and remains fail-closed');
  const usage = {
    message_id: 'message_usage_1234', session_id: 'session_usage_1234', parent_session_id: null,
    root_session_id: 'session_usage_1234', role: 'implementer', binding: 'fixture/imported',
    input_tokens: 100, output_tokens: 20, reasoning_tokens: 30, cache_read_tokens: 40,
    cache_write_tokens: 5, total_tokens: 195, cost: 0.0125, finish_reason: 'stop',
  };
  assert.equal(recordSystemModelUsage(file, usage).recorded, true, 'completed model usage is persisted');
  assert.equal(recordSystemModelUsage(file, usage).recorded, false, 'duplicate OpenCode message updates do not duplicate usage');
  assert.equal(recordSystemModelUsage(file, { ...usage, output_tokens: 25, total_tokens: 200 }).recorded, true, 'a more complete final message accounting updates the one usage row');
  assert.equal(listSystemModelUsage(file, { rootSessionID: usage.root_session_id })[0].total_tokens, 200, 'usage can be read per workflow tree');
  assert.deepEqual({ ...summarizeSystemModelUsage(file, { rootSessionID: usage.root_session_id })[0] }, {
    role: 'implementer', binding: 'fixture/imported', requests: 1, input_tokens: 100,
    output_tokens: 25, reasoning_tokens: 30, cache_read_tokens: 40, cache_write_tokens: 5,
    total_tokens: 200, cost: 0.0125,
  }, 'usage summary groups privacy-safe token and cost totals by role/model');
  assert.throws(() => recordSystemModelUsage(file, { ...usage, message_id: 'message_usage_5678', cost: -1 }), /cost/);
  synchronizeConfiguredModelRegistry(file, { implementer: { models: ['fixture/pool'], model_facts: { 'fixture/pool': { context_window: 65536, input_cost: 0.5 } } } });
  assert.deepEqual(listModelRegistry(file, 'fixture/pool')[0].facts, { context_window: 65536, input_cost: 0.5 }, 'active pool facts populate the registry');
  importModelRegistry(file, JSON.stringify({ models: { 'fixture/pool': { facts: { context_window: 131072, input_cost: 0.2, availability: 'always' } } } }));
  synchronizeConfiguredModelRegistry(file, { implementer: { models: ['fixture/pool'], model_facts: { 'fixture/pool': { context_window: 32768, input_cost: 1 } } } });
  assert.equal(poolWithSystemFacts(file, { models: ['fixture/pool'] }).model_facts['fixture/pool'].context_window, 131072, 'imported facts survive pool reload and feed selection');
  synchronizeConfiguredModelRegistry(file, { implementer: { models: ['fixture/cheap', 'fixture/pool'], model_facts: { 'fixture/cheap': { input_cost: 0.1, output_cost: 0.1 } } } });
  const selectingPool = poolWithSystemFacts(file, { selection_mode: 'select', selection_policy: configuredSelectionPolicy(file, 'implementer'), models: ['fixture/cheap', 'fixture/pool'] });
  const ranked = rankModelCandidates({ role: 'implementer', pool: selectingPool, evaluations: {
    version: 1, models: {
      'fixture/cheap': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 8 } },
      'fixture/pool': { scores: { coding: 9, reasoning: 9, tool_use: 9, reliability: 9, latency: 9 } },
    },
  }, taskProfile: { context_window: 100000 } });
  assert.deepEqual(ranked.models, ['fixture/pool'], 'selector uses imported context facts after reload');
  assert.equal(ranked.policy, 'balanced', 'selector uses policy restored from SQLite');

  const database = createUserDatabase(file, root, 'research', 'Non-NLA research notes');
  assert.equal(database.name, 'research');
  assert.throws(() => createUserDatabase(file, root, 'research', 'again'), /already exists/);
  const table = createUserTable(file, root, 'research', 'findings', JSON.stringify([
    { name: 'id', type: 'INTEGER', primary_key: true },
    { name: 'summary', type: 'TEXT', not_null: true },
    { name: 'confidence', type: 'REAL' },
  ]));
  assert.equal(table.table, 'findings');
  assert.deepEqual(listUserTables(file, root, 'research').find((entry) => entry.name === 'findings').columns.map((column) => column.name), ['id', 'summary', 'confidence']);
  assert.throws(() => createUserTable(file, root, 'research', 'unsafe', JSON.stringify([{ name: 'x', type: 'TEXT; DROP TABLE findings' }])), /Column type/);
  setSystemSetting(file, 'operator_databases.enabled', 'false');
  assert.throws(() => createUserDatabase(file, root, 'disabled', 'disabled fixture'), /disabled/);
  assert.throws(() => createUserTable(file, root, 'research', 'blocked', '[{"name":"x","type":"TEXT"}]'), /disabled/);
  const status = systemDatabaseStatus(file);
  assert.equal(status.version, SYSTEM_DATABASE_VERSION);
  assert.equal(status.model_usage_events, 1);
  assert.equal(status.databases[0].name, 'research');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('NLA system database migrations, model registry, settings, and safe user databases passed');
