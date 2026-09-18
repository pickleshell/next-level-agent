const TOOL_FREE_ROLES = new Set(['router', 'supervisor', 'architect', 'compactor']);

// This is a capability ceiling, not a routing table. Router chooses the role;
// Compactor may only narrow the tools that role is ever allowed to receive.
export const ROLE_TOOL_CEILINGS = Object.freeze({
  scout: Object.freeze(['webfetch', 'read', 'grep']),
  explorer: Object.freeze(['read', 'grep', 'glob']),
  implementer: Object.freeze(['read', 'grep', 'edit', 'write', 'bash']),
  reviewer: Object.freeze(['read', 'grep', 'glob', 'bash']),
  browser: Object.freeze(['nla_browser_session', 'nla_browser_observe', 'nla_browser_action', 'nla_browser_check']),
});

const TOOL_SIGNALS = Object.freeze({
  read: /\b(read|inspect|review|file|source|code|content|open)\b/i,
  grep: /\b(search|find|locate|grep|reference|usage|occurrence)\b/i,
  glob: /\b(glob|tree|discover|repository|files?|paths?|structure)\b/i,
  webfetch: /\b(web|url|http|docs?|documentation|research|source|dependency|version)\b/i,
  edit: /\b(edit|modify|change|patch|implement|fix|refactor|update)\b/i,
  write: /\b(create|add|generate|write|new file|implement)\b/i,
  bash: /\b(test|verify|build|run|command|shell|git|npm|node|python|compile|lint)\b/i,
});

const REQUIRED_BY_ROLE = Object.freeze({
  scout: ['webfetch', 'read'],
  explorer: ['read', 'grep'],
  implementer: ['read', 'edit'],
  reviewer: ['read', 'grep'],
  browser: ['nla_browser_session', 'nla_browser_observe', 'nla_browser_action', 'nla_browser_check'],
});

export function roleIsToolFree(role) {
  return TOOL_FREE_ROLES.has(role);
}

export function roleCapabilityCeiling(role, catalog) {
  if (role === 'implementer' && Array.isArray(catalog) && catalog.some(tool => tool.id === 'apply_patch')) {
    return ['read', 'grep', 'apply_patch', 'bash'];
  }
  return ROLE_TOOL_CEILINGS[role];
}

export function requiredRoleTools(role, profile = ROLE_TOOL_CEILINGS[role]) {
  if (role === 'implementer' && profile?.includes('apply_patch')) return ['read', 'apply_patch'];
  return REQUIRED_BY_ROLE[role] ? [...REQUIRED_BY_ROLE[role]] : [];
}

function uniqueKnownTools(value, ceiling, role, required) {
  if (!Array.isArray(value)) throw new Error('Compactor output must contain a tools array');
  const selected = [...new Set(value)];
  if (selected.some((name) => typeof name !== 'string' || !ceiling.includes(name))) {
    throw new Error('Compactor selected a tool outside the role capability ceiling');
  }
  if (selected.length < 2 || selected.length > 5) throw new Error('Compactor shortlist must contain 2-5 tools');
  if (required.some((name) => !selected.includes(name))) {
    throw new Error('Compactor omitted a required deterministic tool');
  }
  return ceiling.filter((name) => selected.includes(name));
}

export function parseCompactorToolOutput(output, role, required, roleProfile = ROLE_TOOL_CEILINGS[role]) {
  required ??= requiredRoleTools(role, roleProfile);
  const ceiling = roleProfile;
  if (!ceiling) throw new Error(`Role ${role} has no tool capability ceiling`);
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error('Compactor returned invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some((key) => key !== 'tools')) {
    throw new Error('Compactor output must be exactly {"tools":[...]}');
  }
  return uniqueKnownTools(parsed.tools, ceiling, role, required);
}

export function deterministicToolShortlist(role, prompt, roleProfile = ROLE_TOOL_CEILINGS[role]) {
  if (TOOL_FREE_ROLES.has(role)) return [];
  const ceiling = roleProfile;
  if (!ceiling) throw new Error(`No safe tool policy is defined for role: ${role}`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Cannot optimize an empty bounded task');
  if (/\b(no tools?|tool[- ]free|without (?:using )?tools?)\b/i.test(prompt)) return [];

  const selected = new Set(requiredRoleTools(role, ceiling));
  for (const name of ROLE_TOOL_CEILINGS[role]) {
    if (!TOOL_SIGNALS[name]?.test(prompt)) continue;
    if (role === 'implementer' && ['edit', 'write'].includes(name) && ceiling.includes('apply_patch')) {
      selected.add('apply_patch');
      continue;
    }
    if (!ceiling.includes(name)) throw new Error(`Role ${role} profile lacks a tool required by the bounded step: ${name}`);
    selected.add(name);
  }
  const shortlist = ceiling.filter((name) => selected.has(name)).slice(0, 5);
  if (shortlist.length < 2) throw new Error(`No safe sufficient tool subset can be determined for role: ${role}`);
  return shortlist;
}

export function toolPermissionMap(shortlist) {
  const permissions = { '*': false };
  for (const name of shortlist) permissions[name] = true;
  return permissions;
}

function compactorPrompt(role, prompt, ceiling, fallback) {
  return [
    'Select the smallest sufficient tool subset for this already-bounded child-agent step.',
    'Return JSON only, exactly {"tools":["name"]}. Select 2-5 tools.',
    `Role: ${role}`,
    `Allowed capability ceiling: ${JSON.stringify(ceiling)}`,
    `Conservative deterministic candidate: ${JSON.stringify(fallback)}`,
    'Never add a tool outside the ceiling. Do not rewrite or reinterpret the task.',
    '<BOUNDED_TASK>', prompt, '</BOUNDED_TASK>',
  ].join('\n');
}

export function compactorOptimizationEnabled(model, policy) {
  if (policy === undefined) return true;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid prompt_optimization policy');
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') throw new Error('Invalid prompt_optimization enabled');
  const excluded = policy.exclude_models ?? [];
  if (!Array.isArray(excluded) || excluded.some(pattern => typeof pattern !== 'string' || !pattern.includes('/') || pattern.includes('*') && !/^[^*]+\*$/.test(pattern))) {
    throw new Error('Invalid prompt_optimization exclude_models');
  }
  return policy.enabled !== false && !excluded.some(pattern =>
    pattern.endsWith('*') ? typeof model === 'string' && model.startsWith(pattern.slice(0, -1)) : model === pattern);
}

export async function optimizeInvocation({ role, prompt, roleProfile = ROLE_TOOL_CEILINGS[role], runCompactor, model, policy }) {
  const fallback = deterministicToolShortlist(role, prompt, roleProfile);
  if (!compactorOptimizationEnabled(model, policy)) {
    return { prompt, tools: fallback, source: fallback.length ? 'deterministic-policy' : 'tool-free', reason: 'Compactor prompt optimization disabled by model policy' };
  }
  if (fallback.length === 0 || typeof runCompactor !== 'function') {
    return { prompt, tools: fallback, source: fallback.length ? 'deterministic' : 'tool-free' };
  }
  try {
    const result = await runCompactor(compactorPrompt(role, prompt, roleProfile, fallback));
    const output = typeof result === 'string' ? result : result?.output;
    return {
      prompt, tools: parseCompactorToolOutput(output, role, fallback, roleProfile), source: 'utility-compactor',
      compactorMetadata: typeof result === 'object' ? result.metadata : undefined,
    };
  } catch (error) {
    return { prompt, tools: fallback, source: 'deterministic-fallback', reason: String(error?.message || error) };
  }
}
