import { LEDGER_KEYS, normalizeLedger } from './nla-memory.mjs';

const CRITICAL_LIST_KEYS = [
  'acceptance_criteria', 'approved_decisions', 'changed_files', 'verification', 'blockers',
];

const CRITICAL_EXACT_KEYS = [
  'goal', 'tier', 'workflow_stage', 'active_task', 'pending_gate', 'next_step',
];

export function configuredCompactorPool(pool) {
  return Boolean(
    pool
    && pool.enabled
    && Array.isArray(pool.models)
    && pool.models.some((model) => typeof model === 'string' && model.trim())
  );
}

export function compactorPrompt(ledger) {
  return `Return ONLY valid JSON for an intelligent, faithful NLA continuation checkpoint.
Preserve all top-level ledger fields: ${LEDGER_KEYS.join(', ')}.
Compress completed-task detail and non-critical wording where useful, but preserve critical facts and provenance. Keep every acceptance criterion, approved decision, changed file path, verification entry and its source, and blocker unchanged. Preserve the goal, pending gate, and exact next step.
Do not invent facts or approval. Do not add prose, markdown fences, secrets, transcript text, or irrelevant tool output.
Input ledger:\n${JSON.stringify(ledger)}`;
}

export function parseCompactorOutput(output, ledger, sessionID, directory) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Compactor returned no text');
  const text = output.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Compactor checkpoint must be a JSON object');
  }
  for (const key of LEDGER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error(`Compactor checkpoint omitted ${key}`);
    }
  }
  const checkpoint = normalizeLedger(parsed, sessionID, directory);
  for (const key of CRITICAL_EXACT_KEYS) {
    if (JSON.stringify(checkpoint[key]) !== JSON.stringify(ledger[key])) {
      throw new Error(`Compactor checkpoint altered ${key}`);
    }
  }
  for (const key of CRITICAL_LIST_KEYS) {
    if (Array.isArray(ledger[key]) && ledger[key].length > 0 && checkpoint[key].length === 0) {
      throw new Error(`Compactor checkpoint lost ${key}`);
    }
    const compactedEntries = new Set((checkpoint[key] || []).map((value) => JSON.stringify(value)));
    for (const value of ledger[key] || []) {
      if (!compactedEntries.has(JSON.stringify(value))) {
        throw new Error(`Compactor checkpoint altered or lost ${key} provenance`);
      }
    }
  }
  return checkpoint;
}

export async function intelligentCheckpoint({ ledger, sessionID, directory, pool, runCompactor }) {
  if (!configuredCompactorPool(pool)) {
    return { checkpoint: ledger, mode: 'deterministic', reason: 'compactor_not_configured' };
  }
  try {
    const result = await runCompactor(compactorPrompt(ledger));
    return {
      checkpoint: parseCompactorOutput(result && result.output, ledger, sessionID, directory),
      mode: 'intelligent',
      reason: null,
    };
  } catch (error) {
    return {
      checkpoint: ledger,
      mode: 'deterministic',
      reason: String(error && error.message || error).slice(0, 300),
    };
  }
}
