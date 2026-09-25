// OpenCode owns individual HTTP requests (including authenticated/custom fetch).
// Never time session.prompt: it includes the entire model/tool agent loop.
export function configureRequestTimeouts(config, bindings = []) {
  const providers = new Set(Object.keys(config.provider || {}));
  for (const binding of bindings) {
    if (typeof binding === 'string' && binding.includes('/')) providers.add(binding.split('/')[0]);
  }
  config.provider ||= {};
  for (const id of providers) {
    const provider = config.provider[id] ||= {};
    const options = provider.options ||= {};
    // Defaults only: keep explicit operator transport settings, including false.
    if (options.headerTimeout === undefined) options.headerTimeout = 300000;
    if (options.chunkTimeout === undefined) options.chunkTimeout = 300000;
    // Streaming activity must not consume an absolute request deadline by default.
    if (options.timeout === undefined) options.timeout = false;
  }
}
