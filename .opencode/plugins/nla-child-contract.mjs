import fs from 'node:fs';
import path from 'node:path';
import { REPORT_GUIDANCE } from './nla-supervision.mjs';

// Load the maintained skill once; Supervisor does not need a skill-tool call.
// Other roles must not inherit these diagnostic instructions.
const supervisorDiagnostics = fs.readFileSync(new URL('../../skills/nla-supervisor-diagnostics/SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

// Shared by directory-scoped plugin instances in the same OpenCode process.
// Entries exist only for the lifetime of a managed child task.
export const managedChildren = new Map();

export function taskDirectory(requested, inherited) {
  if (requested === undefined) return inherited;
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Invalid task directory: expected an absolute existing directory');
  try {
    const resolved = fs.realpathSync(requested);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new Error('Invalid task directory: cannot resolve an existing directory');
  }
}

export function childContract(child) {
  return `<NLA_CHILD_CONTRACT>
You are the delegated ${child.role}, not the NLA coordinator. Execute only the original task packet and preserve its safety constraints.
Working directory: ${child.directory}. Resolve relative file searches here; never substitute the coordinator's home directory.
Available tools for this attempt: ${child.tools.join(', ') || '(none)'}.
The coordinator has already performed workflow/skill setup. Do not invoke unavailable skills or search for skill files as a workaround. Use only the supplied tool schemas; report any genuinely missing capability. This does not waive project instructions, permissions, or verification requirements.
${child.failures ? 'A previous call requested an unavailable tool. Correct the tool choice using the available list above; do not repeat the rejected call.' : ''}
${child.progress?.advisory || ''}
${child.tools.includes('nla_report') ? REPORT_GUIDANCE : ''}
${child.reporting?.guidance ? `Supervisor guidance (within original scope): ${child.reporting.guidance}` : ''}
${child.role === 'supervisor' ? supervisorDiagnostics : ''}
${child.resultGuidance || ''}
</NLA_CHILD_CONTRACT>`;
}

export function observeChildTool(child, part) {
  if (!child?.reject || part.type !== 'tool' || !(part.state?.status === 'error' || part.tool === 'invalid' && part.state?.status === 'completed')) return false;
  if (!/Model tried to call unavailable tool|tool (?:is )?not available/i.test(String(part.state.error || part.state.input?.error || part.state.output || ''))) return false;
  const id = part.callID || part.id;
  if (!id || child.seen.has(id)) return false;
  child.seen.add(id);
  child.failures++;
  if (child.failures === 3) {
    child.reject?.(Object.assign(new Error('NLA child repeatedly requested unavailable tools'), { code: 'NLA_CHILD_TOOL_LOOP' }));
  }
  return true;
}
