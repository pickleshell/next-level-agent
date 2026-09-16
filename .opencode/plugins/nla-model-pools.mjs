import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class ModelPoolResolutionError extends Error {
  constructor(message, source) { super(message); this.name = 'ModelPoolResolutionError'; this.source = source; }
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
  if (!parsed || typeof parsed !== 'object' || !parsed.roles || typeof parsed.roles !== 'object' || Array.isArray(parsed.roles)) {
    throw new ModelPoolResolutionError(`Model pool file has no valid roles object: ${configPath}`, configPath);
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
  return Object.entries(resolved.roles).map(([role, pool]) => ({ role, enabled: pool?.enabled !== false, primary: Array.isArray(pool?.models) ? (pool.models[0] || null) : null, fallbacks: Array.isArray(pool?.models) ? pool.models.slice(1) : [] }));
}

export function formatModelPools(resolved) {
  const lines = ['Role        Primary                         Fallbacks                         Enabled', ...modelPoolSummary(resolved).map((row) => `${row.role.padEnd(11)} ${(row.primary || '-').padEnd(32)} ${(row.fallbacks.join(' -> ') || '-').padEnd(32)} ${row.enabled ? 'yes' : 'no'}`), '', `source: ${resolved.source}`, `resolution: ${resolved.resolution}`];
  return lines.join('\n');
}
