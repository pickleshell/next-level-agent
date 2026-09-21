const OMITTED_KEYS = new Set(['args', 'authorization', 'body', 'cmd', 'command', 'env', 'environment', 'headers', 'input', 'output', 'prompt', 'request', 'response', 'stderr', 'stdout']);
const SECRET_ASSIGNMENT = /\b(api[ _-]?key|authorization|bearer|cookie|password|secret|token)\b\s*(?:[:=]|\s+)\s*[^\s,;]+/gi;
const MAX_STRING = 300;

function safeString(value) {
  const redacted = String(value).replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
}

// Telemetry is trace metadata, never a transcript. Keep the sanitizer at the
// write boundary so a new event cannot accidentally serialize tool payloads.
export function sanitizeTelemetry(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value);
  if (depth >= 4) return '[OMITTED: depth limit]';
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeTelemetry(item, depth + 1));
  if (!value || typeof value !== 'object') return safeString(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = OMITTED_KEYS.has(key.toLowerCase()) ? '[OMITTED]' : sanitizeTelemetry(item, depth + 1);
  }
  return result;
}
