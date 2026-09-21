import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateModelPools } from '../../.opencode/plugins/nla-model-pools.mjs';
import { parseContextWindow, parseSelectionWeights, rankModelCandidates, selectionMode } from '../../.opencode/plugins/nla-model-selection.mjs';
import {
  averageScore,
  emptyEvaluationStore,
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
assert.deepEqual(parseSelectionWeights('{"coding":10,"latency":3}'), { coding: 10, latency: 3 });
assert.throws(() => parseSelectionWeights('{"unknown":5}'), /selection_weights/);
assert.throws(() => parseSelectionWeights('{"coding":11}'), /selection_weights/);
assert.equal(parseContextWindow('131072'), 131072);
assert.throws(() => parseContextWindow('0'), /context_window/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_mode: 'parallel', models: ['fixture/a'] } } }), /selection_mode/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, selection_weights: { coding: 11 }, models: ['fixture/a'] } } }), /selection_weights/);
assert.throws(() => validateModelPools({ roles: { explorer: { enabled: true, model_facts: { 'fixture/b': {} }, models: ['fixture/a'] } } }), /unlisted binding/);
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
assert.ok(Math.abs(ranked.candidates[0].score - 8.619047619) < 0.000001, 'weighted suitability is explainable');

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
