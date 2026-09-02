const DEFAULT_MEM0_URL = 'http://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 30000;

function boundedText(value, name, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return text;
}

export function mem0Config(env = process.env) {
  const baseURL = new URL(env.NLA_MEM0_URL || DEFAULT_MEM0_URL);
  if (!['http:', 'https:'].includes(baseURL.protocol)) throw new Error('NLA_MEM0_URL must use HTTP or HTTPS');
  if (baseURL.username || baseURL.password) throw new Error('NLA_MEM0_URL must not contain credentials');
  const timeoutMs = Number(env.NLA_MEM0_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new Error('NLA_MEM0_TIMEOUT_MS must be an integer from 1 to 300000');
  }
  const userID = env.NLA_MEM0_USER_ID ? boundedText(env.NLA_MEM0_USER_ID, 'NLA_MEM0_USER_ID', 200) : null;
  return { baseURL, timeoutMs, userID };
}

function endpoint(baseURL, pathname) {
  const url = new URL(baseURL);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
  return url;
}

export class Mem0HttpClient {
  constructor({ baseURL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
    this.baseURL = new URL(baseURL);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint(this.baseURL, pathname), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { throw new Error(`Mem0 returned non-JSON HTTP ${response.status}`); }
      if (!response.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload);
        throw new Error(`Mem0 HTTP ${response.status}: ${detail.slice(0, 500)}`);
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Mem0 request timed out after ${this.timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  add({ text, userID, infer = true }) {
    return this.request('/memories', {
      text: boundedText(text, 'memory text', 32000),
      user_id: boundedText(userID, 'Mem0 user ID', 200),
      infer: Boolean(infer),
    });
  }

  search({ query, userID, limit = 5 }) {
    const boundedLimit = Number(limit);
    if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 20) {
      throw new Error('memory search limit must be an integer from 1 to 20');
    }
    return this.request('/search', {
      query: boundedText(query, 'memory query', 8000),
      user_id: boundedText(userID, 'Mem0 user ID', 200),
      limit: boundedLimit,
    });
  }
}

export function resolveMem0UserID(argument, configured) {
  return boundedText(argument || configured, 'Mem0 user ID', 200);
}
