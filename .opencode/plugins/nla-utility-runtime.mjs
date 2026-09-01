const DEFAULT_HEADERS = { 'content-type': 'application/json' };

function utilityConfig(pool) {
  if (!pool || pool.runtime !== 'utility') return null;
  const provider = pool.provider && typeof pool.provider === 'object' ? pool.provider : {};
  const models = Array.isArray(pool.models) ? pool.models.filter((model) => typeof model === 'string' && model.trim()) : [];
  const timeoutMs = Number(pool.request_timeout_ms);
  if (!['ollama', 'openai-compatible'].includes(pool.backend)) throw new Error(`Unsupported utility-model backend: ${pool.backend || 'missing'}`);
  if (!['native', 'openai-compatible'].includes(provider.api)) {
    throw new Error(`Unsupported utility provider API: ${provider.api || 'missing'}`);
  }
  if (pool.backend === 'openai-compatible' && provider.api !== 'openai-compatible') throw new Error('OpenAI-compatible backend requires openai-compatible provider API');
  if (!provider.base_url || typeof provider.base_url !== 'string') throw new Error('Utility provider requires base_url');
  const baseURL = new URL(provider.base_url);
  if (!['http:', 'https:'].includes(baseURL.protocol)) throw new Error('Utility base_url must use HTTP or HTTPS');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Utility-model request_timeout_ms must be positive');
  if (models.length === 0) throw new Error('Utility-model role requires at least one model');
  const outputFormat = pool.output_format === 'json' ? 'json' : 'text';
  const reasoningEffort = pool.reasoning_effort;
  if (reasoningEffort !== undefined && !['none', 'low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('Invalid utility reasoning_effort');
  const maxOutputTokens = pool.max_output_tokens === undefined ? undefined : Number(pool.max_output_tokens);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > 4096)) {
    throw new Error('Utility max_output_tokens must be an integer from 1 to 4096');
  }
  return { api: provider.api, backend: pool.backend, baseURL, models, timeoutMs, outputFormat, reasoningEffort, maxOutputTokens };
}

export function configuredUtilityPool(pool) {
  try {
    return Boolean(pool && pool.enabled && utilityConfig(pool));
  } catch {
    return false;
  }
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function parseUtilityResponse(payload, api) {
  if (!payload || typeof payload !== 'object') throw new Error('Utility model returned an invalid response');
  const content = api === 'native'
    ? contentText(payload.message && payload.message.content)
    : contentText(payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content);
  if (!content) {
    const hasReasoning = api === 'native'
      ? Boolean(payload.message && payload.message.thinking)
      : Boolean(payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.reasoning);
    throw new Error(hasReasoning ? 'Utility model returned reasoning but no answer content' : 'Utility model returned no answer content');
  }
  return content;
}

function endpoint(baseURL, suffix) {
  const base = new URL(baseURL);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(suffix.replace(/^\//, ''), base);
}

function requestFor(config, model, prompt) {
  if (config.api === 'native') {
    const body = { model, stream: false, think: false, messages: [{ role: 'user', content: prompt }] };
    if (config.outputFormat === 'json') body.format = 'json';
    return {
      url: endpoint(config.baseURL, 'api/chat'),
      body,
    };
  }
  const request = {
    url: endpoint(config.baseURL, 'v1/chat/completions'),
    body: { model, stream: false, messages: [{ role: 'user', content: prompt }] },
  };
  if (config.outputFormat === 'json') request.body.response_format = { type: 'json_object' };
  if (config.reasoningEffort !== undefined) request.body.reasoning_effort = config.reasoningEffort;
  if (config.maxOutputTokens !== undefined) request.body.max_tokens = config.maxOutputTokens;
  return request;
}

export async function runUtilityModel({ role, pool, prompt, fetchImpl = globalThis.fetch }) {
  const config = utilityConfig(pool);
  if (!config) throw new Error(`Role ${role} is not configured for the utility runtime`);
  if (typeof fetchImpl !== 'function') throw new Error('Utility-model runtime requires fetch');
  const attempts = config.models.slice(0, Math.min(config.models.length, Number(pool.max_failovers || 0) + 1));
  let lastError;
  for (const model of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const request = requestFor(config, model, prompt);
      const response = await fetchImpl(request.url, {
        method: 'POST', headers: DEFAULT_HEADERS, body: JSON.stringify(request.body), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Utility provider HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
      let payload;
      try { payload = await response.json(); } catch { throw new Error('Utility provider returned invalid JSON'); }
      return {
        output: parseUtilityResponse(payload, config.api),
        metadata: { role, runtime: 'utility', backend: config.backend, model, usage: payload.usage || null, cost: payload.cost ?? null },
      };
    } catch (error) {
      lastError = error && error.name === 'AbortError'
        ? new Error(`Utility-model request timed out after ${config.timeoutMs}ms`)
        : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Utility-model task failed for ${role} after ${attempts.length} model attempt(s): ${lastError && lastError.message || lastError}`);
}
