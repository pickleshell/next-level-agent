const STATIC_DESCRIPTIONS = Object.freeze({
  nla_models: 'Current configuration',
  nla_models_reload: 'Reload configuration',
  nla_work_state: 'Reconcile repository',
});

function clean(value, fallback, maximum = 96) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function jsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function nlaToolLabel(name) {
  const suffix = String(name || '').replace(/^nla_/, '');
  return suffix.split('_').filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ') || 'NLA';
}

export function nlaToolDescription(name, args = {}) {
  if (STATIC_DESCRIPTIONS[name]) return STATIC_DESCRIPTIONS[name];
  if (name === 'nla_task') return clean(args.description, clean(args.role, 'Delegated task'));
  if (name === 'nla_state') return clean(jsonObject(args.snapshot).intent, 'Update workflow state');
  if (name === 'nla_notebook') return clean(args.page, args.action === 'update' ? 'Update page' : 'Restore memory');
  if (name === 'nla_model_policy') {
    const role = clean(args.role, 'Model pool', 48);
    const policy = clean(args.policy, 'Update policy', 32);
    return `${role} → ${policy}`;
  }
  if (name === 'nla_model_health_reset') return clean(args.binding, 'Reset model health');
  if (name === 'nla_compact') return clean(args.reason, clean(jsonObject(args.snapshot).intent, 'Context checkpoint'));
  if (name.startsWith('nla_browser_')) {
    const request = jsonObject(args.request);
    return clean(request.description, clean(request.operation, clean(request.id, clean(request.check, 'Browser operation'))));
  }
  return 'Run';
}

export function nlaToolTitle(name, args = {}) {
  return `${nlaToolLabel(name)}: ${nlaToolDescription(name, args)}`;
}

export function withNlaToolDisplay(name, definition) {
  const execute = definition.execute;
  return {
    ...definition,
    execute: async (args, context) => {
      const title = nlaToolTitle(name, args);
      context?.metadata?.({ title, metadata: { nla_tool: name } });
      const result = await execute(args, context);
      return typeof result === 'string' ? { title, output: result } : { ...result, title };
    },
  };
}
