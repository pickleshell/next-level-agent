import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateModelPools } from '../../.opencode/plugins/nla-model-pools.mjs';
import { materializeAutoPool, parseContextWindow, parseSelectionWeights, rankModelCandidates, routableModelPool, selectionMode, selectionPreferences } from '../../.opencode/plugins/nla-model-selection.mjs';
import {
  averageScore,
  emptyEvaluationStore,
  initializeEvaluationStore,
  latencyScoreFromMs,
  loadEvaluationStore,
  parseReviewerEvaluation,
  recordEvaluation,
  recordReviewerEvaluation,
  runtimeEvaluationScores,
  writeEvaluationStoreAtomic,
} from '../../.opencode/plugins/nla-model-evaluations.mjs';

const health = (states = {}) => ({
  state(binding) { return states[binding] || { binding, state: 'available', eligible: true }; },
});

const productionSeed = JSON.parse(fs.readFileSync('config/model-evaluations.json', 'utf8'));
for (const mode of ['auto', 'select', 'fallback']) {
  const fixture = { selection_mode: mode, models: ['paused/model', 'paused/off'], model_facts: {
    'paused/model': { status: 'enabled', provider_status: 'disabled' },
    'paused/off': { status: 'disabled', provider_status: 'disabled' },
  } };
  const expected = mode === 'auto' ? [] : ['paused/model'];
  assert.deepEqual(routableModelPool(fixture).models, expected, `${mode}: provider off gates only auto`);
  assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: fixture }).models, expected);
  assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: fixture, healthManager: health({ 'paused/model': { state: 'cooling', eligible: false } }) }).models, [], 'health still applies');
}
assert.deepEqual(materializeAutoPool({ selection_mode: 'auto', models: ['paused/model'] }, [{ binding: 'paused/model', status: 'enabled', provider_status: 'disabled', facts: {} }], new Set(['paused/model'])).models, [], 'auto preferences do not bypass provider off');
assert.equal(Object.keys(productionSeed.models).length, 27, 'production seed covers the complete example Implementer pool');
assert.ok(Object.keys(productionSeed.models).every((binding) => binding.startsWith('opencode-go/')), 'production seed contains only OpenCode Go bindings');
assert.ok(Object.values(productionSeed.models).every(({ scores }) => scores.reliability === 0 && scores.latency === 0), 'environment-specific scores start unevaluated');

const pool = {
  selection_mode: 'select',
  models: ['fixture/slow', 'fixture/best', 'fixture/cheap', 'fixture/down'],
  model_facts: {
    'fixture/slow': { id: 'fixture/slow', context_window: 32768, input_cost: 5, output_cost: 5, availability: 'always' },
    'fixture/best': { id: 'fixture/best', context_window: 131072, input_cost: 3, output_cost: 3, availability: 'always' },
    'fixture/cheap': { id: 'fixture/cheap', context_window: 131072, input_cost: 0, output_cost: 0, availability: 'always' },
    'fixture/down': { id: 'fixture/down', context_window: 131072, input_cost: 0, output_cost: 0, availability: 'always' },
  },
};

validateModelPools({ roles: { explorer: { enabled: true, models: ['fixture/a'] } } });
assert.equal(selectionMode({}), 'fallback', 'missing selection mode preserves fallback');
assert.equal(selectionMode({ selection_mode: 'auto', models: [] }), 'auto');
validateModelPools({ roles: { implementer: { enabled: true, selection_mode: 'auto', models: [] } } });
validateModelPools({ roles: { implementer: { enabled: true, selection_mode: 'auto', models: ['fixture/a'] } } });
assert.throws(() => validateModelPools({ roles: { implementer: { enabled: true, selection_mode: 'select', models: [] } } }), /non-empty/);
assert.throws(() => validateModelPools({ roles: { implementer: { enabled: true, selection_mode: 'auto', models: ['fixture/a', 'fixture/a'] } } }), /repeats/);
assert.throws(() => validateModelPools({ roles: { nla: { enabled: true, selection_mode: 'auto', models: [] } } }), /agent pool/);
const autoSource = { selection_mode: 'auto', selection_policy: 'quality', models: ['fixture/preferred'], model_facts: { 'fixture/preferred': { context_window: 131072 } } };
const autoRegistry = [
  { binding: 'fixture/preferred', status: 'enabled', facts: { context_window: 131072, input_cost: 1 } },
  { binding: 'fixture/other', status: 'enabled', facts: { context_window: 131072, input_cost: 1 } },
  { binding: 'fixture/disabled', status: 'disabled', facts: {} },
];
const autoInventory = new Set(autoRegistry.map((record) => record.binding));
const autoPool = materializeAutoPool(autoSource, autoRegistry, autoInventory);
assert.deepEqual(autoPool.models, ['fixture/preferred', 'fixture/other'], 'auto includes unlisted enabled inventory models but not disabled ones');
assert.deepEqual(autoSource.models, ['fixture/preferred'], 'materialization does not mutate saved preferences');
const autoEvaluations = { models: {
  'fixture/preferred': { scores: { coding: 8, reasoning: 8, tool_use: 8 } },
  'fixture/other': { scores: { coding: 8, reasoning: 8, tool_use: 8 } },
} };
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: autoPool, evaluations: autoEvaluations }).models, ['fixture/preferred', 'fixture/other'], 'equivalent candidates favor listed preference');
autoEvaluations.models['fixture/other'].scores.coding = 10;
assert.equal(rankModelCandidates({ role: 'implementer', pool: autoPool, evaluations: autoEvaluations }).models[0], 'fixture/other', 'higher suitability outside preferences wins');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: autoPool, evaluations: autoEvaluations, attempted: ['fixture/other'] }).models, ['fixture/preferred'], 'auto failover reselects remaining candidate');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: autoPool, evaluations: autoEvaluations, healthManager: health({ 'fixture/other': { state: 'cooling', eligible: false } }) }).models, ['fixture/preferred'], 'auto respects health');
assert.deepEqual(materializeAutoPool({ selection_mode: 'auto', models: [] }, autoRegistry, autoInventory).models.sort(), ['fixture/other', 'fixture/preferred'], 'empty auto preferences use all enabled inventory');
assert.deepEqual(parseSelectionWeights('{"coding":10,"latency":3}'), { coding: 10, latency: 3 });
assert.throws(() => parseSelectionWeights('{"unknown":5}'), /selection_weights/);
assert.throws(() => parseSelectionWeights('{"coding":11}'), /selection_weights/);
assert.equal(parseContextWindow('131072'), 131072);
assert.throws(() => parseContextWindow('0'), /context_window/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'parallel', models: ['fixture/a'] } } }), /selection_mode/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'select', selection_policy: 'random', models: ['fixture/a'] } } }), /selection_policy/);
validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'auto', selection_policy: 'local', models: [] } } });
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'fallback', selection_policy: 'local', models: ['ollama/qwen'] } } }), /requires select or auto/);
assert.equal(selectionPreferences({ selection_policy: 'balanced', cost_weight: 1 }).cost_weight, undefined, 'legacy cost weight does not affect routing');
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_weights: { coding: 11 }, models: ['fixture/a'] } } }), /selection_weights/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, model_facts: { 'fixture/b': {} }, models: ['fixture/a'] } } }), /unlisted binding/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, models: ['fixture/a'], model_facts: { 'fixture/a': { status: 'paused' } } } } }), /status must be enabled or disabled/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, models: ['fixture/a'], model_facts: { 'fixture/a': { availability: { schedule: 'windows', windows: [{ start: 'not-a-date', end: '2030-01-01T00:00:00Z' }] } } } } } }), /invalid dates/);

const evaluations = {
  version: 1,
  models: {
    'fixture/slow': { scores: { coding: 7, reasoning: 7, tool_use: 7, reliability: 9, latency: 2 } },
    'fixture/best': { scores: { coding: 9, reasoning: 9, tool_use: 9, reliability: 8, latency: 8 } },
    'fixture/cheap': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 8 } },
    'fixture/down': { scores: { coding: 10, reasoning: 10, tool_use: 10, reliability: 10, latency: 10 } },
  },
};
const ranked = rankModelCandidates({ role: 'implementer', pool, evaluations, healthManager: health({ 'fixture/down': { state: 'quarantined', eligible: false } }) });
assert.deepEqual(ranked.models, ['fixture/best', 'fixture/cheap', 'fixture/slow'], 'select ranks suitability and filters quarantined models');
const disabledPool = { ...pool, model_facts: { ...pool.model_facts, 'fixture/best': { ...pool.model_facts['fixture/best'], status: 'disabled' } } };
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: disabledPool, evaluations, healthManager: health() }).models.includes('fixture/best'), false, 'select excludes operator-disabled model');
assert.deepEqual(routableModelPool(disabledPool).models, ['fixture/slow', 'fixture/cheap', 'fixture/down'], 'fallback retains order while removing disabled models');
assert.ok(Math.abs(ranked.candidates[0].score - 8.619047619) < 0.000001, 'weighted suitability is explainable');
assert.equal(selectionPreferences(pool).policy, 'quality');
const balanced = rankModelCandidates({ role: 'implementer', pool: { ...pool, selection_policy: 'balanced' }, evaluations, healthManager: health({ 'fixture/down': { state: 'quarantined', eligible: false } }) });
assert.equal(balanced.models[0], 'fixture/cheap', 'balanced favors lower cost among similarly suitable models');
assert.ok(balanced.models.includes('fixture/slow'), 'balanced retains lower-ranked candidates for failover');
const qualityGap = structuredClone(evaluations);
qualityGap.models['fixture/cheap'].scores = { coding: 6, reasoning: 6, tool_use: 6, reliability: 6, latency: 6 };
assert.equal(rankModelCandidates({ role: 'implementer', pool: { ...pool, selection_policy: 'balanced' }, evaluations: qualityGap, healthManager: health({ 'fixture/down': { state: 'quarantined', eligible: false } }) }).models[0], 'fixture/best', 'balanced does not trade away a clear suitability advantage for price');
const costFirst = rankModelCandidates({ role: 'implementer', pool: { ...pool, selection_policy: 'cost', minimum_score: 7.5 }, evaluations, healthManager: health({ 'fixture/down': { state: 'quarantined', eligible: false } }) });
assert.deepEqual(costFirst.models, ['fixture/cheap', 'fixture/best'], 'cost policy enforces quality floor before sorting by price');
const freeFacts = {
  'fixture/free': { input_cost: 0, output_cost: 0 },
  'ollama/free': { input_cost: 0, output_cost: 0 },
  'fixture/paid': { input_cost: 0, output_cost: 1 },
  'fixture/partial': { input_cost: 0 },
  'fixture/unknown': {},
  'fixture/null': { input_cost: null, output_cost: null },
  'fixture/string': { input_cost: '0', output_cost: '0' },
};
const freePool = { selection_mode: 'select', selection_policy: 'free', models: Object.keys(freeFacts), model_facts: freeFacts };
validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'auto', selection_policy: 'free', models: [] } } });
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'fallback', selection_policy: 'free', models: ['fixture/free'] } } }), /requires select or auto/);
assert.deepEqual(rankModelCandidates({ role: 'explorer', pool: freePool, taskProfile: { policy: 'quality' } }).models, ['fixture/free', 'ollama/free']);
assert.deepEqual(rankModelCandidates({ pool: freePool, attempted: ['fixture/free', 'ollama/free'] }).models, [], 'free never falls back to paid or unknown prices');
assert.deepEqual(rankModelCandidates({ pool: freePool, taskProfile: { policy: 'local' } }).models, ['ollama/free'], 'local and free restrictions intersect');
const freeAuto = materializeAutoPool({ selection_mode: 'auto', selection_policy: 'free', models: ['fixture/paid'] }, Object.entries(freeFacts).map(([binding, facts]) => ({ binding, facts, status: 'enabled' })), new Set(Object.keys(freeFacts)));
assert.deepEqual(freeAuto.models, ['fixture/free', 'ollama/free']);
const localPool = { selection_mode: 'select', selection_policy: 'local', models: ['fixture/strong', 'ollama/qwen', 'ollama/backup'], model_facts: {
  'fixture/strong': { context_window: 131072, input_cost: 0 },
  'ollama/qwen': { context_window: 131072, input_cost: 0 },
  'ollama/backup': { context_window: 131072, input_cost: 0 },
} };
const localEvaluations = { models: {
  'fixture/strong': { scores: { coding: 10, reasoning: 10, tool_use: 10 } },
  'ollama/qwen': { scores: { coding: 8, reasoning: 8, tool_use: 8 } },
  'ollama/backup': { scores: { coding: 7, reasoning: 7, tool_use: 7 } },
} };
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: localPool, evaluations: localEvaluations, taskProfile: { policy: 'quality' } }).models, ['ollama/qwen', 'ollama/backup'], 'saved local boundary cannot be overridden by a task policy');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: localPool, evaluations: localEvaluations, attempted: ['ollama/qwen'] }).models, ['ollama/backup'], 'local failover stays local');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: localPool, evaluations: localEvaluations, healthManager: health({ 'ollama/qwen': { state: 'cooling', eligible: false }, 'ollama/backup': { state: 'cooling', eligible: false } }) }).models, [], 'unavailable local models never fall back to cloud');
const autoLocalPool = materializeAutoPool({ selection_mode: 'auto', selection_policy: 'local', models: ['fixture/strong'] }, [
  { binding: 'fixture/strong', status: 'enabled', facts: {} },
  { binding: 'ollama/qwen', status: 'enabled', facts: {} },
], new Set(['fixture/strong', 'ollama/qwen']));
assert.deepEqual(autoLocalPool.models, ['ollama/qwen'], 'local auto pool materializes no cloud bindings');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: autoLocalPool, evaluations: localEvaluations }).models, ['ollama/qwen'], 'auto local ignores remote preferred bindings');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: { ...pool, selection_policy: 'cost', minimum_score: 9.5 }, evaluations, healthManager: health() }).models, ['fixture/down'], 'cost policy keeps only candidates meeting the quality floor');

const unknown = rankModelCandidates({
  role: 'implementer',
  pool: { ...pool, models: ['fixture/unknown', 'fixture/scored'], model_facts: { 'fixture/unknown': { input_cost: 0 }, 'fixture/scored': { input_cost: 1 } } },
  evaluations: { version: 1, models: { 'fixture/scored': { scores: { coding: 8, reasoning: 0, tool_use: 0, reliability: 0, latency: 0 } } } },
  healthManager: health(),
});
assert.equal(unknown.candidates.find((candidate) => candidate.binding === 'fixture/unknown').score, null, 'zero scores mean unevaluated');
assert.equal(unknown.models[0], 'fixture/scored', 'unknown dimensions do not enter the denominator');

const tie = rankModelCandidates({
  role: 'implementer',
  pool: { ...pool, models: ['fixture/costly', 'fixture/cheap-tie'], model_facts: { 'fixture/costly': { input_cost: 5 }, 'fixture/cheap-tie': { input_cost: 1 } } },
  evaluations: { version: 1, models: {
    'fixture/costly': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 7 } },
    'fixture/cheap-tie': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 7 } },
  } },
  healthManager: health(),
});
assert.deepEqual(tie.models, ['fixture/cheap-tie', 'fixture/costly'], 'tie-break prefers lower static cost');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool, evaluations, healthManager: health({ 'fixture/down': { state: 'quarantined', eligible: false } }), attempted: ['fixture/best'] }).models, ['fixture/cheap', 'fixture/slow'], 'attempted candidates are excluded');
assert.deepEqual(rankModelCandidates({ role: 'implementer', pool: { ...pool, models: ['fixture/down'] }, evaluations, healthManager: health({ 'fixture/down': { state: 'cooling', eligible: false, until: Date.now() + 1000 } }) }).models, [], 'all unavailable candidates produce no attempts');

const taskSpecializedPool = { selection_mode: 'select', models: ['fixture/coding', 'fixture/reasoning'], model_facts: { 'fixture/coding': { context_window: 32768 }, 'fixture/reasoning': { context_window: 131072 } } };
const taskSpecializedEvaluations = { version: 1, models: {
  'fixture/coding': { scores: { coding: 10, reasoning: 2, tool_use: 0, reliability: 0, latency: 0 } },
  'fixture/reasoning': { scores: { coding: 2, reasoning: 10, tool_use: 0, reliability: 0, latency: 0 } },
} };
assert.equal(rankModelCandidates({ role: 'architect', pool: taskSpecializedPool, evaluations: taskSpecializedEvaluations, healthManager: health(), taskProfile: { weights: { coding: 10 } } }).models[0], 'fixture/coding');
assert.equal(rankModelCandidates({ role: 'architect', pool: taskSpecializedPool, evaluations: taskSpecializedEvaluations, healthManager: health(), taskProfile: { weights: { reasoning: 10 } } }).models[0], 'fixture/reasoning');
assert.deepEqual(rankModelCandidates({ role: 'architect', pool: { ...taskSpecializedPool, models: ['fixture/no-facts', 'fixture/has-facts'], model_facts: { 'fixture/has-facts': { context_window: 131072 } } }, evaluations: { version: 1, models: {} }, healthManager: health(), taskProfile: { context_window: 64000 } }).models, ['fixture/has-facts'], 'explicit context requirements fail closed without metadata');

assert.equal(averageScore(0, 8), 8);
assert.equal(averageScore(8, 6), 7);
assert.equal(averageScore(7, 5), 6);
assert.equal(latencyScoreFromMs(500), 10);
assert.deepEqual(runtimeEvaluationScores({ succeeded: true, elapsedMs: 2000 }), { reliability: 10, latency: 8 });
assert.deepEqual(runtimeEvaluationScores({ succeeded: false }), { reliability: 1 });

const review = parseReviewerEvaluation({ verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 }, evidence: { tests_passed: true, acceptance_criteria_met: true } });
assert.deepEqual(review.scores, { coding: 8, reasoning: 7, tool_use: 9 });
for (const malformed of [
  '{}',
  { verdict: 'pass', scores: { coding: 0, reasoning: 7, tool_use: 9 } },
  { verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 }, prompt: 'secret' },
  { verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 }, evidence: { defects_found: 1 } },
]) assert.throws(() => parseReviewerEvaluation(malformed), /Reviewer|evaluation/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-model-evaluation-'));
const file = path.join(root, 'model-evaluations.json');
try {
  const seedFile = path.join(root, 'seed.json');
  const seededFile = path.join(root, 'seeded.json');
  fs.writeFileSync(seedFile, JSON.stringify({ version: 1, models: { 'fixture/seeded': { scores: { coding: 8, reasoning: 7, tool_use: 9, reliability: 0, latency: 0 } } } }));
  assert.equal(initializeEvaluationStore(seededFile, seedFile).models['fixture/seeded'].scores.coding, 8, 'fresh state is initialized from the production seed');
  fs.writeFileSync(seedFile, JSON.stringify({ version: 1, models: {} }));
  assert.equal(initializeEvaluationStore(seededFile, seedFile).models['fixture/seeded'].scores.coding, 8, 'existing local evaluations are never replaced by a changed seed');
  assert.equal(fs.statSync(seededFile).mode & 0o777, 0o600, 'seeded evaluation state is private');
  writeEvaluationStoreAtomic(file, emptyEvaluationStore());
  recordReviewerEvaluation(file, 'fixture/model', JSON.stringify({ verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 } }));
  recordEvaluation(file, 'fixture/model', { coding: 6, reliability: 10 });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.models['fixture/model'].scores, { coding: 7, reasoning: 7, tool_use: 9, reliability: 10, latency: 0 }, 'scores are averaged and unknown scores remain zero');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'evaluation state is private');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp') || name.endsWith('.lock')), [], 'atomic write leaves no temp or lock file');

  fs.writeFileSync(file, '{malformed');
  assert.deepEqual(loadEvaluationStore(file), emptyEvaluationStore(), 'malformed state fails closed');
  assert.throws(() => recordEvaluation(file, 'fixture/model', { coding: 8 }), /JSON|Unexpected|version|evaluation/i, 'writer refuses to overwrite malformed state');
  assert.equal(fs.readFileSync(file, 'utf8'), '{malformed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('NLA model selection, evaluation API, validation, ranking, fail-safe persistence, and score averaging tests passed');
