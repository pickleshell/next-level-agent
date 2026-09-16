const DEFAULT_COOLDOWN_MS = 30_000;

export function modelCooldownMs(pool = {}, env = process.env) {
  const value = Number(pool.cooldown_ms ?? env.NLA_MODEL_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COOLDOWN_MS;
}

export function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function unavailablePoolError(selection, label, attempted = 0) {
  const error = new Error(`${label}: unavailable; ${attempted} model attempts; ${selection.allQuarantined ? 'all models quarantined; exact binding reset required' : 'cooling or in-flight'}; earliest retry ${selection.earliestRetryAt ?? 'unknown'}`);
  error.code = 'NLA_MODEL_POOL_UNAVAILABLE';
  error.attempted = attempted;
  error.earliestRetryAt = selection.earliestRetryAt;
  error.requiresReset = selection.allQuarantined;
  error.health = selection.all;
  return error;
}

export function classifyProviderError(error, now = Date.now()) {
  const data = error?.data || error?.cause?.data || error || {};
  const text = String(data.message || error?.message || error || '');
  const lower = text.toLowerCase();
  const status = Number(data.statusCode ?? data.status ?? error?.statusCode ?? error?.status ?? lower.match(/\b(401|403|404|410|429|500|502|503|504)\b/)?.[1]);
  const headers = data.responseHeaders || data.headers || error?.headers;
  const retryAfter = retryAfterMs(data.retryAfter ?? data.retry_after ?? error?.retryAfter ?? headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'], now);
  if (error?.name === 'AbortError' || /abort|cancel|permission denied|invalid task|invalid tool|application error/.test(lower)) return { category: 'non_provider', reason: 'caller_or_application_error', retryAfterMs: 0 };
  if (status === 410 || /model\s+(?:not\s+found|unavailable|retired)|unknown model|model missing|model_not_found|model[^\n]{0,80}does not exist|end of life/.test(lower)) return { category: 'defective', reason: 'model_binding_unavailable', retryAfterMs: 0 };
  if (status === 404) return { category: 'configuration', reason: 'provider_endpoint_not_found', retryAfterMs: 0 };
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication/.test(lower)) return { category: 'configuration', reason: 'provider_authorization_failed', retryAfterMs: 0 };
  if (status === 429 || /rate limit|too many requests|overloaded|temporar(?:y|ily)|upstream|connection reset|network|timed out|timeout|service unavailable|unexpected server error/.test(lower) || [500, 502, 503, 504].includes(status)) {
    return { category: 'transient', reason: status ? `provider_http_${status}` : 'provider_transient_failure', retryAfterMs: retryAfter };
  }
  if (/abort|cancel|permission denied|invalid task|invalid tool|application error/.test(lower)) return { category: 'non_provider', reason: 'caller_or_application_error', retryAfterMs: 0 };
  return { category: 'unknown', reason: 'unknown_provider_failure', retryAfterMs: 0 };
}

export class ModelHealthManager {
  constructor({ now = () => Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) { this.now = now; this.cooldownMs = cooldownMs; this.entries = new Map(); }
  key(binding, endpoint = '') { return `${endpoint || 'default'}::${binding}`; }
  state(binding, endpoint = '') {
    const key = this.key(binding, endpoint); const entry = this.entries.get(key); const now = this.now();
    if (!entry) return { binding, state: 'available', eligible: true };
    if (entry.state === 'cooling' && entry.until <= now) return { binding, state: 'available', eligible: true, recovered: true };
    return { binding, ...entry, eligible: entry.state === 'available', remainingMs: entry.until ? Math.max(0, entry.until - now) : 0 };
  }
  candidates(models, limit, endpoint = '') {
    const all = models.map((binding) => ({ binding, health: this.state(binding, endpoint) }));
    const eligible = all.filter((item) => item.health.eligible);
    return { models: eligible.slice(0, limit).map((item) => item.binding), all, earliestRetryAt: all.filter((item) => item.health.state === 'cooling').map((item) => item.health.until).sort((a, b) => a - b)[0] || null, allQuarantined: all.length > 0 && all.every((item) => item.health.state === 'quarantined') };
  }
  claim(binding, endpoint = '') { const key = this.key(binding, endpoint); const current = this.state(binding, endpoint); if (!current.eligible) return false; this.entries.set(key, { state: 'probe-in-flight', claimedAt: this.now(), previous: this.entries.get(key) }); return true; }
  release(binding, endpoint = '') { const key = this.key(binding, endpoint); const entry = this.entries.get(key); if (entry?.state !== 'probe-in-flight') return; if (entry.previous) this.entries.set(key, entry.previous); else this.entries.delete(key); }
  success(binding, endpoint = '') { this.entries.delete(this.key(binding, endpoint)); }
  failure(binding, error, endpoint = '', cooldown = this.cooldownMs) {
    const result = classifyProviderError(error, this.now()); if (!['transient', 'defective', 'configuration'].includes(result.category)) { this.release(binding, endpoint); return result; }
    const until = result.category === 'transient' ? this.now() + Math.max(cooldown, result.retryAfterMs || 0) : null;
    this.entries.set(this.key(binding, endpoint), { state: result.category === 'transient' ? 'cooling' : 'quarantined', category: result.category, reason: result.reason, since: this.now(), until });
    return result;
  }
  reset(binding, endpoint = '') { if (this.entries.get(this.key(binding, endpoint))?.state === 'probe-in-flight') throw new Error('Cannot reset an in-flight binding'); this.entries.delete(this.key(binding, endpoint)); }
  snapshot() { return [...this.entries.entries()].map(([key, entry]) => { const { previous, ...safe } = entry; return { key, ...safe, remainingMs: entry.until ? Math.max(0, entry.until - this.now()) : 0 }; }); }
}

export const DEFAULT_MODEL_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
