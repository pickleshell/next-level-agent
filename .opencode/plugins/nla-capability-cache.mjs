import { createHash } from 'node:crypto';

export const CAPABILITY_CACHE_FORMAT = 1;
export const NLA_CAPABILITY_VERSION = '6.3.0';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function capabilityHash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function parseCapabilityCache(text) {
  if (typeof text !== 'string' || !text.trim()) return { format: CAPABILITY_CACHE_FORMAT, entries: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed?.format !== CAPABILITY_CACHE_FORMAT || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return { format: CAPABILITY_CACHE_FORMAT, entries: {} };
    }
    return { format: CAPABILITY_CACHE_FORMAT, entries: { ...parsed.entries } };
  } catch {
    return { format: CAPABILITY_CACHE_FORMAT, entries: {} };
  }
}

export function serializeCapabilityCache(cache) {
  return JSON.stringify({ format: CAPABILITY_CACHE_FORMAT, entries: cache.entries }, null, 2) + '\n';
}

function catalogMap(catalog) {
  if (!Array.isArray(catalog)) throw new Error('OpenCode returned an invalid tool catalog');
  const mapped = new Map();
  for (const item of catalog) {
    if (!item || typeof item.id !== 'string' || !item.id || mapped.has(item.id)) continue;
    mapped.set(item.id, item);
  }
  return mapped;
}

export function resolveRoleCapabilityProfile({
  role, ceiling, required, catalog, cache, configSignature, nlaVersion = NLA_CAPABILITY_VERSION,
}) {
  if (!Array.isArray(ceiling) || ceiling.length === 0) throw new Error(`No safe tool policy is defined for role: ${role}`);
  const byID = catalogMap(catalog);
  const available = ceiling.filter((id) => byID.has(id));
  if (required.some((id) => !available.includes(id))) {
    throw new Error(`OpenCode catalog is missing a required ${role} capability`);
  }
  if (available.length < 2 || available.length > 5) throw new Error(`Role ${role} capability profile must contain 2-5 tools`);

  const schemaHashes = Object.fromEntries(ceiling.map((id) => [id, byID.has(id) ? capabilityHash(byID.get(id)) : null]));
  const opencodeSignature = capabilityHash({ expected: ceiling, schema_hashes: schemaHashes });
  const key = capabilityHash({ format: CAPABILITY_CACHE_FORMAT, nlaVersion, role, opencodeSignature, configSignature });
  const entry = cache.entries[role];
  const cachedTools = entry?.key === key && Array.isArray(entry.tools) ? entry.tools : null;
  if (cachedTools
    && cachedTools.length === available.length
    && cachedTools.length >= 2
    && cachedTools.length <= 5
    && cachedTools.every((id, index) => id === available[index])) {
    return { tools: cachedTools, source: 'cache-hit', key, cache, opencodeSignature, schemaHashes };
  }

  const next = {
    format: CAPABILITY_CACHE_FORMAT,
    entries: {
      ...cache.entries,
      [role]: {
        key, tools: available, schema_hashes: schemaHashes, nla_version: nlaVersion,
        opencode_signature: opencodeSignature, config_signature: configSignature,
      },
    },
  };
  return { tools: available, source: 'cache-miss', key, cache: next, opencodeSignature, schemaHashes };
}
