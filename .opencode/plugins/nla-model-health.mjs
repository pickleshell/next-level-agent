const DEFAULT_COOLDOWN_MS = 30_000;

export function classifyProviderError(error) {
  const data = error?.data || error?.cause?.data || error || {};
  const text = String(error?.message || error || '').replace(/(?:authorization|api[-_ ]?key|token|password)[^\n]{0,120}/ig, '$1=<redacted>');
  const lower = text.toLowerCase();
  const status = Number(data.statusCode ?? data.status ?? error?.statusCode ?? error?.status ?? lower.match(/\b(404|410|429|500|502|503|504)\b/)?.[1]);
  const retryAfter = Number(data.retryAfter ?? data.retry_after);
  if (status === 410 || /model\s+(?:not\s+found|unavailable|retired)|unknown model|model missing|does not exist|end of life/.test(lower) || status === 404 && /model|missing|unknown/.test(lower)) return { category: 'defective', reason: 'model_binding_unavailable', retryAfterMs: 0 };
  if (status === 404) return { category: 'configuration', reason: 'provider_endpoint_not_found', retryAfterMs: 0 };
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication/.test(lower)) return { category: 'configuration', reason: 'provider_authorization_failed', retryAfterMs: 0 };
  if (status === 429 || /rate limit|too many requests|overloaded|temporar(?:y|ily)|upstream|connection reset|network|timed out|timeout|service unavailable|unexpected server error/.test(lower) || [500, 502, 503, 504].includes(status)) {
    return { category: 'transient', reason: status ? `provider_http_${status}` : 'provider_transient_failure', retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : null };
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
    return { binding, ...entry, eligible: entry.state === 'available' || entry.state === 'probe-in-flight', remainingMs: entry.until ? Math.max(0, entry.until - now) : 0 };
  }
  candidates(models, limit, endpoint = '') {
    const all = models.map((binding) => ({ binding, health: this.state(binding, endpoint) }));
    const eligible = all.filter((item) => item.health.eligible);
    return { models: eligible.slice(0, limit).map((item) => item.binding), all, earliestRetryAt: all.filter((item) => item.health.state === 'cooling').map((item) => item.health.until).sort((a, b) => a - b)[0] || null, allQuarantined: all.length > 0 && all.every((item) => item.health.state === 'quarantined') };
  }
  claim(binding, endpoint = '') { const key = this.key(binding, endpoint); const current = this.state(binding, endpoint); if (!current.eligible) return false; this.entries.set(key, { state: 'probe-in-flight', claimedAt: this.now() }); return true; }
  success(binding, endpoint = '') { this.entries.delete(this.key(binding, endpoint)); }
  failure(binding, error, endpoint = '', cooldown = this.cooldownMs) {
    const result = classifyProviderError(error); if (!['transient', 'defective', 'configuration'].includes(result.category)) { this.entries.delete(this.key(binding, endpoint)); return result; }
    const until = result.category === 'transient' ? this.now() + Math.max(cooldown, result.retryAfterMs || 0) : null;
    this.entries.set(this.key(binding, endpoint), { state: result.category === 'transient' ? 'cooling' : 'quarantined', category: result.category, reason: result.reason, since: this.now(), until });
    return result;
  }
  reset(binding, endpoint = '') { this.entries.delete(this.key(binding, endpoint)); }
  snapshot() { return [...this.entries.entries()].map(([key, entry]) => ({ key, ...entry, remainingMs: entry.until ? Math.max(0, entry.until - this.now()) : 0 })); }
}

export const DEFAULT_MODEL_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
