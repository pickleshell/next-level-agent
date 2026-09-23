import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class ModelPoolResolutionError extends Error {
  constructor(message, source) { super(message); this.name = 'ModelPoolResolutionError'; this.source = source; }
}

export class ModelPoolValidationError extends Error {
  constructor(message, source) { super(message); this.name = 'ModelPoolValidationError'; this.source = source; }
}

const ROLE_ID = /^[a-z][a-z0-9_-]*$/;
const BINDING_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_SCORE_KEYS = ['coding', 'reasoning', 'tool_use', 'reliability', 'latency'];

function validateAvailability(value, label) {
  if (value === undefined || value === null || value === true || value === false || ['always', 'available', 'never', 'unavailable'].includes(value)) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelPoolValidationError(`${label}.availability is invalid`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new ModelPoolValidationError(`${label}.availability.enabled must be boolean`);
  if (value.schedule !== undefined && value.schedule !== 'always' && value.schedule !== 'windows') throw new ModelPoolValidationError(`${label}.availability.schedule must be always or windows`);
  if (value.windows === undefined) {
    if (value.schedule && value.schedule !== 'always') throw new ModelPoolValidationError(`${label}.availability.windows is required for a scheduled availability`);
    return;
  }
  if (!Array.isArray(value.windows) || value.windows.length === 0) throw new ModelPoolValidationError(`${label}.availability.windows must be a non-empty array`);
  for (const [index, window] of value.windows.entries()) {
    if (!window || typeof window !== 'object' || Array.isArray(window) || (!window.start && !window.end)) throw new ModelPoolValidationError(`${label}.availability.windows[${index}] must contain start or end`);
    const start = window.start ? Date.parse(window.start) : -Infinity;
    const end = window.end ? Date.parse(window.end) : Infinity;
    if (!Number.isFinite(start) && start !== -Infinity || !Number.isFinite(end) && end !== Infinity || start > end) throw new ModelPoolValidationError(`${label}.availability.windows[${index}] contains invalid dates`);
  }
}

// OpenCode child dispatch requires a provider/model pair. This validates only
// configuration syntax; provider availability is intentionally an operator/
// runtime concern and must be supplied to preflight explicitly.
export function parseModelBinding(binding, label = 'model binding') {
  if (typeof binding !== 'string' || binding !== binding.trim() || binding.length > 256) {
    throw new ModelPoolValidationError(`${label} must be a trimmed provider/model identifier`);
  }
  const parts = binding.split('/');
  if (parts.length < 2 || parts.some((part) => !BINDING_PART.test(part)) || parts[0] === parts[1]) {
    throw new ModelPoolValidationError(`${label} must be provider/model and must not repeat its provider prefix; received ${JSON.stringify(binding)}`);
  }
  return { providerID: parts[0], modelID: parts.slice(1).join('/'), binding };
}

export function validateModelPools(parsed, source = 'model pool file') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.roles || typeof parsed.roles !== 'object' || Array.isArray(parsed.roles)) {
    throw new ModelPoolValidationError(`Model pool file has no valid roles object: ${source}`, source);
  }
  for (const [role, pool] of Object.entries(parsed.roles)) {
    if (!ROLE_ID.test(role)) throw new ModelPoolValidationError(`Invalid model-pool role name ${JSON.stringify(role)} in ${source}`, source);
    if (!pool || typeof pool !== 'object' || Array.isArray(pool)) throw new ModelPoolValidationError(`Role ${role} must be an object in ${source}`, source);
    if (pool.enabled !== undefined && typeof pool.enabled !== 'boolean') throw new ModelPoolValidationError(`Role ${role}.enabled must be boolean in ${source}`, source);
    if (pool.selection_mode !== undefined && !['fallback', 'select'].includes(pool.selection_mode)) throw new ModelPoolValidationError(`Role ${role}.selection_mode must be fallback or select in ${source}`, source);
    if (pool.selection_policy !== undefined && !['quality', 'balanced', 'cost'].includes(pool.selection_policy)) throw new ModelPoolValidationError(`Role ${role}.selection_policy must be quality, balanced, or cost in ${source}`, source);
    if (pool.minimum_score !== undefined && (typeof pool.minimum_score !== 'number' || !Number.isFinite(pool.minimum_score) || pool.minimum_score < 0 || pool.minimum_score > 10)) throw new ModelPoolValidationError(`Role ${role}.minimum_score must be a number from 0 to 10 in ${source}`, source);
    if (pool.cost_weight !== undefined && (typeof pool.cost_weight !== 'number' || !Number.isFinite(pool.cost_weight) || pool.cost_weight < 0 || pool.cost_weight > 1)) throw new ModelPoolValidationError(`Role ${role}.cost_weight must be a number from 0 to 1 in ${source}`, source);
    if (pool.selection_weights !== undefined) {
      if (!pool.selection_weights || typeof pool.selection_weights !== 'object' || Array.isArray(pool.selection_weights) || !Object.keys(pool.selection_weights).length) throw new ModelPoolValidationError(`Role ${role}.selection_weights must be a non-empty object in ${source}`, source);
      for (const [key, value] of Object.entries(pool.selection_weights)) {
        if (!MODEL_SCORE_KEYS.includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) throw new ModelPoolValidationError(`Role ${role}.selection_weights.${key} must be a number from 0 to 10 in ${source}`, source);
      }
    }
    if (!Array.isArray(pool.models) || pool.models.length === 0) throw new ModelPoolValidationError(`Role ${role} requires a non-empty models array in ${source}`, source);
    const seen = new Set();
    pool.models.forEach((binding, index) => {
      const parsedBinding = parseModelBinding(binding, `Role ${role}.models[${index}]`);
      if (seen.has(parsedBinding.binding)) throw new ModelPoolValidationError(`Role ${role} repeats model binding ${JSON.stringify(parsedBinding.binding)} in ${source}`, source);
      seen.add(parsedBinding.binding);
    });
    if (pool.model_facts !== undefined || pool.model_metadata !== undefined) {
      const facts = pool.model_facts || pool.model_metadata;
      if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new ModelPoolValidationError(`Role ${role}.model_facts must be an object in ${source}`, source);
      for (const [binding, record] of Object.entries(facts)) {
        if (!seen.has(binding)) throw new ModelPoolValidationError(`Role ${role}.model_facts contains unlisted binding ${JSON.stringify(binding)} in ${source}`, source);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ModelPoolValidationError(`Role ${role}.model_facts.${binding} must be an object in ${source}`, source);
        if (record.id !== undefined && record.id !== binding) throw new ModelPoolValidationError(`Role ${role}.model_facts.${binding}.id must match its binding in ${source}`, source);
        if (record.status !== undefined && !['enabled', 'disabled'].includes(record.status)) throw new ModelPoolValidationError(`Role ${role}.model_facts.${binding}.status must be enabled or disabled in ${source}`, source);
        if (record.context_window !== undefined && (!Number.isInteger(record.context_window) || record.context_window <= 0)) throw new ModelPoolValidationError(`Role ${role}.model_facts.${binding}.context_window must be a positive integer in ${source}`, source);
        for (const key of ['input_cost', 'output_cost']) if (record[key] !== undefined && (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] < 0)) throw new ModelPoolValidationError(`Role ${role}.model_facts.${binding}.${key} must be a non-negative number in ${source}`, source);
        try { validateAvailability(record.availability, `Role ${role}.model_facts.${binding}`); }
        catch (error) { throw new ModelPoolValidationError(`${error.message} in ${source}`, source); }
      }
    }
  }
  return parsed;
}

// A supplied runtime inventory is authoritative for this check. The validator
// never queries a provider or infers that a similarly named binding exists.
export function preflightModelPools(parsed, availableBindings, source = 'model pool file') {
  validateModelPools(parsed, source);
  if (availableBindings === undefined) return { roles: Object.keys(parsed.roles).length, checkedAvailability: false };
  if (!Array.isArray(availableBindings)) throw new ModelPoolValidationError('Available model inventory must be an array of provider/model identifiers', source);
  const available = new Set(availableBindings.map((binding, index) => parseModelBinding(binding, `Available model inventory[${index}]`).binding));
  const unavailable = [];
  for (const [role, pool] of Object.entries(parsed.roles)) {
    if (!pool.enabled) continue;
    for (const binding of pool.models) if (pool.model_facts?.[binding]?.status !== 'disabled' && !available.has(binding)) unavailable.push(`${role}:${binding}`);
  }
  if (unavailable.length) throw new ModelPoolValidationError(`Enabled model-pool bindings absent from supplied runtime inventory: ${unavailable.join(', ')}`, source);
  return { roles: Object.keys(parsed.roles).length, checkedAvailability: true };
}

export function normalizeModelPoolPath(value, homeDir = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === '~') return path.resolve(homeDir);
  if (trimmed.startsWith('~/')) return path.resolve(homeDir, trimmed.slice(2));
  return path.resolve(trimmed);
}

function readPoolFile(configPath, resolution) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new ModelPoolResolutionError(`Could not load model pools from ${configPath}: ${error.message}`, configPath); }
  try { validateModelPools(parsed, configPath); }
  catch (error) {
    if (error instanceof ModelPoolValidationError) throw new ModelPoolResolutionError(error.message, configPath);
    throw error;
  }
  const sharedFacts = {};
  for (const pool of Object.values(parsed.roles)) Object.assign(sharedFacts, pool.model_facts || pool.model_metadata || {});
  const roles = Object.fromEntries(Object.entries(parsed.roles).map(([role, pool]) => [role, {
    ...pool,
    ...(Object.keys(sharedFacts).length ? { model_facts: Object.fromEntries((pool.models || []).filter((binding) => sharedFacts[binding]).map((binding) => [binding, sharedFacts[binding]])) } : {}),
  }]));
  return { version: parsed.version ?? 1, roles, source: configPath, resolution };
}

export function resolveModelPools({ explicitPath = null, env = process.env, homeDir = os.homedir(), defaultPath } = {}) {
  const fallback = path.resolve(defaultPath || path.join(MODULE_DIR, '../../config/model-pools.json'));
  const explicit = normalizeModelPoolPath(explicitPath, homeDir);
  if (explicit) return readPoolFile(explicit, 'explicit runtime/request override');
  const environment = normalizeModelPoolPath(env?.NLA_MODEL_POOLS_PATH, homeDir);
  if (environment) return readPoolFile(environment, 'NLA_MODEL_POOLS_PATH');
  return readPoolFile(fallback, 'repository/package default');
}

export function modelPoolSummary(resolved) {
  if (!resolved || typeof resolved !== 'object' || !resolved.roles || typeof resolved.roles !== 'object') return [];
  return Object.entries(resolved.roles).map(([role, pool]) => {
    const coordinator = role === 'nla';
    const enabled = Boolean(pool?.enabled);
    return {
      role,
      enabled: coordinator ? null : enabled,
      pooled: !coordinator && enabled,
      status: coordinator ? 'orchestrator' : (enabled ? 'enabled' : 'disabled'),
      selection_mode: pool?.selection_mode || 'fallback',
      selection_policy: pool?.selection_policy || 'quality',
      minimum_score: pool?.minimum_score ?? 7.5,
      cost_weight: pool?.cost_weight ?? 0.25,
      primary: Array.isArray(pool?.models) ? (pool.models[0] || null) : null,
      fallbacks: Array.isArray(pool?.models) ? pool.models.slice(1) : [],
    };
  });
}

export function formatModelPools(resolved) {
  if (!resolved || typeof resolved !== 'object' || !resolved.roles || typeof resolved.roles !== 'object') return '';
  const lines = ['Role        Mode      Policy     Primary                         Fallbacks                         Status', ...modelPoolSummary(resolved).map((row) => `${row.role.padEnd(11)} ${(row.selection_mode || 'fallback').padEnd(9)} ${(row.selection_policy || 'quality').padEnd(10)} ${(row.primary || '-').padEnd(32)} ${(row.fallbacks.join(' -> ') || '-').padEnd(32)} ${row.status}`), '', `source: ${resolved.source}`, `resolution: ${resolved.resolution}`];
  return lines.join('\n');
}
