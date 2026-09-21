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
    if (!Array.isArray(pool.models) || pool.models.length === 0) throw new ModelPoolValidationError(`Role ${role} requires a non-empty models array in ${source}`, source);
    const seen = new Set();
    pool.models.forEach((binding, index) => {
      const parsedBinding = parseModelBinding(binding, `Role ${role}.models[${index}]`);
      if (seen.has(parsedBinding.binding)) throw new ModelPoolValidationError(`Role ${role} repeats model binding ${JSON.stringify(parsedBinding.binding)} in ${source}`, source);
      seen.add(parsedBinding.binding);
    });
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
    for (const binding of pool.models) if (!available.has(binding)) unavailable.push(`${role}:${binding}`);
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
  return { version: parsed.version ?? 1, roles: parsed.roles, source: configPath, resolution };
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
      primary: Array.isArray(pool?.models) ? (pool.models[0] || null) : null,
      fallbacks: Array.isArray(pool?.models) ? pool.models.slice(1) : [],
    };
  });
}

export function formatModelPools(resolved) {
  if (!resolved || typeof resolved !== 'object' || !resolved.roles || typeof resolved.roles !== 'object') return '';
  const lines = ['Role        Primary                         Fallbacks                         Status', ...modelPoolSummary(resolved).map((row) => `${row.role.padEnd(11)} ${(row.primary || '-').padEnd(32)} ${(row.fallbacks.join(' -> ') || '-').padEnd(32)} ${row.status}`), '', `source: ${resolved.source}`, `resolution: ${resolved.resolution}`];
  return lines.join('\n');
}
