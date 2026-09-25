export const MODEL_SCORE_KEYS = ['coding', 'reasoning', 'tool_use', 'reliability', 'latency'];
export const SELECTION_POLICIES = ['quality', 'balanced', 'cost', 'local', 'free'];
export function isFreeModelFacts(facts) {
  return facts?.input_cost === 0 && facts?.output_cost === 0;
}
export function matchesPolicyBoundary(binding, facts, policy) {
  return (policy !== 'local' || isLocalModelBinding(binding))
    && (policy !== 'free' || isFreeModelFacts(facts));
}
// Ollama is the self-hosted provider in the current NLA runtime. A local
// policy is a hard routing boundary, never a preference or cloud fallback.
const LOCAL_PROVIDERS = new Set(['ollama']);
export function isLocalModelBinding(binding) {
  return typeof binding === 'string' && LOCAL_PROVIDERS.has(binding.split('/')[0]);
}

export class ModelSelectionError extends Error {
  constructor(message) { super(message); this.name = 'ModelSelectionError'; }
}

// Role requirements, not model scores. Zero means the dimension is ignored.
export const DEFAULT_ROLE_WEIGHTS = Object.freeze({
  router: Object.freeze({ coding: 4, reasoning: 8, tool_use: 7, reliability: 9, latency: 10 }),
  supervisor: Object.freeze({ coding: 5, reasoning: 10, tool_use: 7, reliability: 10, latency: 5 }),
  scout: Object.freeze({ coding: 3, reasoning: 8, tool_use: 8, reliability: 8, latency: 7 }),
  explorer: Object.freeze({ coding: 7, reasoning: 9, tool_use: 10, reliability: 9, latency: 7 }),
  architect: Object.freeze({ coding: 7, reasoning: 10, tool_use: 7, reliability: 9, latency: 4 }),
  implementer: Object.freeze({ coding: 10, reasoning: 7, tool_use: 9, reliability: 9, latency: 7 }),
  reviewer: Object.freeze({ coding: 9, reasoning: 10, tool_use: 8, reliability: 9, latency: 6 }),
  compactor: Object.freeze({ coding: 2, reasoning: 7, tool_use: 8, reliability: 10, latency: 10 }),
});

function validScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : 0;
}

export function normalizedScores(scores = {}) {
  return Object.fromEntries(MODEL_SCORE_KEYS.map((key) => [key, validScore(scores?.[key])]));
}

export function selectionMode(pool = {}) {
  if (pool.selection_mode === 'auto' || (pool.selection_mode === 'select' && pool.models === 'auto')) return 'auto';
  return pool.selection_mode === 'select' ? 'select' : 'fallback';
}

export function selectionPolicy(pool = {}, taskProfile = {}) {
  const value = ['local', 'free'].includes(pool.selection_policy) ? pool.selection_policy : taskProfile.policy || pool.selection_policy || 'quality';
  if (!SELECTION_POLICIES.includes(value)) throw new ModelSelectionError('selection_policy must be quality, balanced, cost, local, or free');
  return value;
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new ModelSelectionError(`${label} must be a number from ${minimum} to ${maximum}`);
  return parsed;
}

export function selectionPreferences(pool = {}, taskProfile = {}) {
  return {
    policy: selectionPolicy(pool, taskProfile),
    minimum_score: boundedNumber(taskProfile.minimum_score ?? pool.minimum_score, 7.5, 0, 10, 'minimum_score'),
  };
}

export function parseSelectionWeights(value) {
  if (value === undefined || value === null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new ModelSelectionError('selection_weights must be valid JSON'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new ModelSelectionError('selection_weights must be a non-empty object');
  const result = {};
  for (const [key, weight] of Object.entries(parsed)) {
    if (!MODEL_SCORE_KEYS.includes(key) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 10) throw new ModelSelectionError(`selection_weights.${key} must be a number from 0 to 10`);
    result[key] = weight;
  }
  return result;
}

export function parseContextWindow(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ModelSelectionError('context_window must be a positive integer');
  return parsed;
}

function staticAvailability(facts, now = new Date()) {
  const availability = facts?.availability;
  if (availability === undefined || availability === null || availability === 'always' || availability === 'available' || availability === true) return true;
  if (availability === false || availability === 'never' || availability === 'unavailable') return false;
  if (typeof availability !== 'object' || Array.isArray(availability)) return false;
  if (availability.enabled === false) return false;
  if (availability.schedule === 'always' || availability.schedule === undefined) return true;
  if (!Array.isArray(availability.windows)) return false;
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return availability.windows.some((window) => {
    if (!window || typeof window !== 'object') return false;
    const start = window.start ? Date.parse(window.start) : -Infinity;
    const end = window.end ? Date.parse(window.end) : Infinity;
    return (Number.isFinite(start) || Number.isFinite(end)) && time >= start && time <= end;
  });
}

function modelFacts(pool, binding) {
  return pool?.model_facts?.[binding] || pool?.model_metadata?.[binding] || {};
}

export function routableModelPool(pool) {
  if (!pool || !Array.isArray(pool.models)) return pool;
  return { ...pool, models: pool.models.filter((binding) => {
    const status = modelFacts(pool, binding).status;
    return (status === undefined || status === 'enabled') && (selectionMode(pool) !== 'auto' || modelFacts(pool, binding).provider_status !== 'disabled');
  }) };
}

// Materialize auto once per task. Explicit models are soft preferences, not a
// whitelist. The child keeps a concrete snapshot for failover and auditability.
export function materializeAutoPool(pool, registry, inventory) {
  if (selectionMode(pool) !== 'auto') return pool;
  if (!(inventory instanceof Set)) throw new ModelSelectionError('Auto pool requires a fresh OpenCode provider inventory');
  const eligible = registry.filter((record) => record.status === 'enabled' && record.provider_status !== 'disabled'
    && inventory.has(record.binding) && matchesPolicyBoundary(record.binding, record.facts, pool.selection_policy));
  const available = new Set(eligible.map((record) => record.binding));
  const preferred = Array.isArray(pool.models) ? pool.models.filter((binding) => available.has(binding)) : [];
  const preferredSet = new Set(preferred);
  const models = [...preferred, ...eligible.map((record) => record.binding).filter((binding) => !preferredSet.has(binding)).sort()];
  const model_facts = Object.fromEntries(eligible.map((record) => [record.binding, record.facts]));
  return { ...pool, selection_mode: 'auto', models, model_facts, auto_preferences: preferred };
}

function healthFor(healthManager, binding, endpoint, now) {
  if (healthManager?.state) return healthManager.state(binding, endpoint);
  const entry = healthManager?.get?.(binding);
  if (!entry || !entry.until || entry.until <= now.getTime()) return { binding, state: 'available', eligible: true };
  return { binding, ...entry, eligible: false };
}

function evaluatedScores(evaluations, binding) {
  const record = evaluations?.models?.[binding] || evaluations?.[binding] || {};
  return normalizedScores(record.scores);
}

function weightedScore(scores, weights) {
  let numerator = 0;
  let denominator = 0;
  for (const key of MODEL_SCORE_KEYS) {
    const score = scores[key];
    const weight = validScore(weights?.[key]);
    if (score > 0 && weight > 0) {
      numerator += score * weight;
      denominator += weight;
    }
  }
  return denominator ? numerator / denominator : null;
}

function staticCost(facts) {
  const input = Number(facts?.input_cost);
  const output = Number(facts?.output_cost);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return Math.max(0, Number.isFinite(input) ? input : 0) + Math.max(0, Number.isFinite(output) ? output : 0);
}

function compareQuality(left, right) {
  const leftScore = left.score === null ? -1 : left.score + (left.preference_rank ? 0.25 : 0);
  const rightScore = right.score === null ? -1 : right.score + (right.preference_rank ? 0.25 : 0);
  if (leftScore !== rightScore) return rightScore - leftScore;
  const reliability = (right.scores.reliability || 0) - (left.scores.reliability || 0);
  if (reliability) return reliability;
  const preference = (right.provider_preference || 0) - (left.provider_preference || 0);
  if (preference) return preference;
  if (left.cost !== null && right.cost !== null && left.cost !== right.cost) return left.cost - right.cost;
  if (left.cost === null && right.cost !== null) return 1;
  if (left.cost !== null && right.cost === null) return -1;
  const latency = (right.scores.latency || 0) - (left.scores.latency || 0);
  if (latency) return latency;
  if (left.preference_rank !== right.preference_rank) return (left.preference_rank || Infinity) - (right.preference_rank || Infinity);
  return left.index - right.index;
}

function rankByPolicy(candidates, preferences) {
  if (['quality', 'local', 'free'].includes(preferences.policy)) return candidates.sort(compareQuality);
  if (preferences.policy === 'balanced') {
    // The assessor/coordinator chooses the policy. Balanced keeps models close
    // to the best task fit, then prefers the cheaper of those viable choices.
    const best = Math.max(...candidates.map((candidate) => candidate.score === null ? -1 : candidate.score + (candidate.preference_rank ? 0.25 : 0)));
    const viable = candidates.filter((candidate) => best < 0 || (candidate.score !== null && candidate.score + (candidate.preference_rank ? 0.25 : 0) >= best - 1));
    const remaining = candidates.filter((candidate) => !viable.includes(candidate));
    viable.sort((left, right) => {
      if (left.cost === null && right.cost !== null) return 1;
      if (left.cost !== null && right.cost === null) return -1;
      if (left.cost !== null && right.cost !== null && left.cost !== right.cost) return left.cost - right.cost;
      return compareQuality(left, right);
    });
    return [...viable, ...remaining.sort(compareQuality)];
  }
  const qualified = candidates.filter((candidate) => candidate.score !== null && candidate.score >= preferences.minimum_score);
  return qualified.sort((left, right) => {
    if (left.cost === null && right.cost !== null) return 1;
    if (left.cost !== null && right.cost === null) return -1;
    if (left.cost !== null && right.cost !== null && left.cost !== right.cost) return left.cost - right.cost;
    return compareQuality(left, right);
  });
}

export function rankModelCandidates({ role, pool = {}, evaluations, healthManager, endpoint = '', attempted = [], now = new Date(), taskProfile = {} } = {}) {
  const models = Array.isArray(pool.models) ? pool.models : [];
  const preferences = selectionPreferences(pool, taskProfile);
  const attemptedSet = new Set(attempted);
  const baseWeights = DEFAULT_ROLE_WEIGHTS[role] || DEFAULT_ROLE_WEIGHTS.implementer;
  const weights = taskProfile.weights || pool.selection_weights || baseWeights;
  const all = models.map((binding, index) => {
    const facts = modelFacts(pool, binding);
    const health = healthFor(healthManager, binding, endpoint, now);
    const reasons = [];
    if (attemptedSet.has(binding)) reasons.push('attempted');
    if (!health.eligible) reasons.push(health.state || 'unavailable');
    if (facts.status !== undefined && facts.status !== 'enabled') reasons.push('disabled');
    if (selectionMode(pool) === 'auto' && facts.provider_status === 'disabled') reasons.push('provider_disabled');
    if ([preferences.policy, taskProfile.policy].includes('local') && !isLocalModelBinding(binding)) reasons.push('not_local');
    if ([preferences.policy, taskProfile.policy].includes('free') && !isFreeModelFacts(facts)) reasons.push('not_free');
    if (!staticAvailability(facts, now)) reasons.push('static_unavailable');
    if (taskProfile.context_window && (!Number.isFinite(Number(facts.context_window)) || facts.context_window < Number(taskProfile.context_window))) reasons.push('insufficient_context');
    const scores = evaluatedScores(evaluations, binding);
    const preferred = pool.preferred_providers || [];
    const providerIndex = preferred.indexOf(binding.slice(0, binding.indexOf('/')));
    const preferenceIndex = selectionMode(pool) === 'auto' ? (pool.auto_preferences || []).indexOf(binding) : -1;
    return { binding, index, facts, health, scores, preference_rank: preferenceIndex < 0 ? 0 : preferenceIndex + 1, provider_preference: providerIndex < 0 ? 0 : preferred.length - providerIndex, cost: staticCost(facts), score: weightedScore(scores, weights), eligible: reasons.length === 0, reasons };
  });
  const eligible = rankByPolicy(all.filter((candidate) => candidate.eligible), preferences);
  return {
    mode: selectionMode(pool),
    policy: preferences.policy,
    preferences,
    models: eligible.map((candidate) => candidate.binding),
    all,
    candidates: eligible,
    allQuarantined: all.length > 0 && all.every((candidate) => candidate.health.state === 'quarantined'),
    earliestRetryAt: all.map((candidate) => candidate.health.until).filter(Boolean).sort((a, b) => a - b)[0] || null,
  };
}
