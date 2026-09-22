import { synchronizeRuntimeModelFacts } from './nla-system-database.mjs';

// Never call during plugin/config initialization: provider resolution loads plugins.
export function createModelInventorySync({ client, directory, database, roles, report = () => {}, timeoutMs = 5000 }) {
  let pending;
  let completed = false;
  return async function sync({ force = false } = {}) {
    if (pending) await pending;
    if (completed && !force) return;
    if (typeof client?.config?.providers !== 'function') return;
    pending = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => client.config.providers({ query: { directory }, signal: controller.signal, throwOnError: true })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
        ]);
        if (!Array.isArray(response?.data?.providers)) throw new Error('invalid inventory');
        const result = synchronizeRuntimeModelFacts(database, roles(), response.data.providers);
        report({ event: 'model_inventory_synchronized', ...result });
      } catch {
        // Do not log provider payloads, credentials, or arbitrary API errors.
        report({ event: 'model_inventory_unavailable', reason: 'inventory_sync_failed', retry: 'nla_models_reload' });
      } finally {
        clearTimeout(timer);
        completed = true;
      }
    })();
    try { await pending; } finally { pending = undefined; }
  };
}
