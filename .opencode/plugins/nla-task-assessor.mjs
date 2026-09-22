import { DEFAULT_ROLE_WEIGHTS, parseContextWindow, parseSelectionWeights, selectionPreferences } from './nla-model-selection.mjs';

const RISK_PATTERNS = Object.freeze({
  critical: /\b(production|prod|credential|secret|authentication|authorization|permission|security|payment|billing|delete|destructive|data loss|rollback)\b/i,
  high: /\b(migration|schema|database|persistence|public api|breaking change|deployment|release|concurrency|race condition|sandbox|privilege)\b/i,
  low: /\b(read[ -]?only|documentation|docs|comment|typo|explain|summari[sz]e|inspect)\b/i,
});

const COMPLEXITY_PATTERNS = Object.freeze({
  high: /\b(architecture|redesign|cross[- ]component|distributed|protocol|state machine|migration|refactor|multiple (files|services|repositories)|end[- ]to[- ]end)\b/i,
  tools: /\b(test|build|compile|debug|benchmark|profile|repository|code|implement|fix|review|search|inspect|file|command)\b/i,
  latency: /\b(urgent|quick|quickly|fast|immediate|interactive|low latency)\b/i,
});

const LEVEL = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

function clamp(value, minimum = 0, maximum = 10) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function deterministicAssessment({ role, description = '', prompt = '' } = {}) {
  const text = `${description}\n${prompt}`;
  const roleWeights = DEFAULT_ROLE_WEIGHTS[role] || DEFAULT_ROLE_WEIGHTS.implementer;
  const weights = { ...roleWeights };
  const reasons = [];

  let risk = 'medium';
  if (RISK_PATTERNS.critical.test(text)) risk = 'critical';
  else if (RISK_PATTERNS.high.test(text)) risk = 'high';
  else if (RISK_PATTERNS.low.test(text)) risk = 'low';

  const structuralSignals = [
    text.length > 6000,
    (text.match(/\n/g) || []).length > 40,
    (text.match(/\b(must|requirement|acceptance|constraint)\b/gi) || []).length >= 4,
    COMPLEXITY_PATTERNS.high.test(text),
  ].filter(Boolean).length;
  let complexity = structuralSignals >= 2 ? 'high' : structuralSignals === 1 ? 'medium' : 'low';
  if (['architect', 'reviewer'].includes(role) && complexity === 'low') complexity = 'medium';

  if (LEVEL[risk] >= LEVEL.high) {
    weights.reliability = 10;
    weights.reasoning = Math.max(weights.reasoning, 9);
    weights.latency = Math.min(weights.latency, 5);
    reasons.push('high-risk change');
  }
  if (complexity === 'high') {
    weights.reasoning = Math.max(weights.reasoning, 9);
    weights.tool_use = Math.max(weights.tool_use, 8);
    reasons.push('high task complexity');
  }
  if (COMPLEXITY_PATTERNS.tools.test(text)) {
    weights.tool_use = Math.max(weights.tool_use, 9);
    reasons.push('tool-dependent work');
  }
  if (COMPLEXITY_PATTERNS.latency.test(text) && LEVEL[risk] < LEVEL.high) {
    weights.latency = Math.max(weights.latency, 9);
    reasons.push('latency-sensitive request');
  }

  const estimatedTokens = Math.ceil(text.length / 4);
  const explicitLargeContext = /\b(128k|131072|large context|long context|entire (repository|codebase))\b/i.test(text);
  const contextWindow = explicitLargeContext || estimatedTokens > 48000 ? 131072
    : estimatedTokens > 16000 ? 65536
      : estimatedTokens > 6000 ? 32768
        : null;
  const policy = LEVEL[risk] >= LEVEL.high ? 'quality' : complexity === 'low' ? 'balanced' : undefined;
  const confidence = clamp(5 + structuralSignals + (reasons.length > 0 ? 1 : 0), 5, 9) / 10;

  return {
    risk,
    complexity,
    weights,
    context_window: contextWindow,
    policy,
    confidence,
    reasons: reasons.length ? reasons : ['role defaults and bounded task size'],
  };
}

function refineWeights(baseline, proposed, risk) {
  if (!proposed) return baseline;
  // A model refinement describes task importance, so omitted dimensions are
  // intentionally ignored. Runtime-owned safety floors are applied below.
  const result = Object.fromEntries(Object.keys(baseline).map((key) => [key, proposed[key] ?? 0]));
  if (LEVEL[risk] >= LEVEL.high) {
    result.reliability = 10;
    result.reasoning = Math.max(result.reasoning, 9);
    result.latency = Math.min(result.latency || baseline.latency, 5);
  }
  return result;
}

export function assessTask({ role, description, prompt, refinement = {} } = {}) {
  const baseline = deterministicAssessment({ role, description, prompt });
  try {
    const proposedWeights = parseSelectionWeights(refinement.selection_weights);
    const proposedContext = parseContextWindow(refinement.context_window);
    const supplied = (key) => refinement[key] !== undefined && refinement[key] !== null && refinement[key] !== '';
    const hasRefinement = Boolean(proposedWeights || proposedContext || supplied('selection_policy') || supplied('minimum_score') || supplied('cost_weight'));
    const preferences = hasRefinement ? selectionPreferences({}, {
      policy: refinement.selection_policy,
      minimum_score: refinement.minimum_score,
      cost_weight: refinement.cost_weight,
    }) : {};
    let policy = refinement.selection_policy || baseline.policy;
    if (LEVEL[baseline.risk] >= LEVEL.high) policy = 'quality';
    const contextWindow = Math.max(baseline.context_window || 0, proposedContext || 0) || null;

    return {
      risk: baseline.risk,
      complexity: baseline.complexity,
      weights: refineWeights(baseline.weights, proposedWeights, baseline.risk),
      context_window: contextWindow,
      policy,
      minimum_score: supplied('minimum_score') ? preferences.minimum_score : undefined,
      cost_weight: supplied('cost_weight') ? preferences.cost_weight : undefined,
      confidence: baseline.confidence,
      source: hasRefinement ? 'hybrid' : 'deterministic',
      reasons: baseline.reasons,
    };
  } catch {
    return {
      ...baseline,
      source: 'deterministic_fallback',
      reasons: [...baseline.reasons, 'invalid model refinement ignored'],
    };
  }
}
