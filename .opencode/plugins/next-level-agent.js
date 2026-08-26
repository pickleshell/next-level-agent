/**
 * Next Level Agent plugin for OpenCode.ai
 *
 * Injects superpowers bootstrap context via message transform.
 * Auto-registers skills directory via config hook (no symlinks needed).
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple frontmatter extraction (avoid dependency on skills-core for bootstrap)
const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };

  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: body };
};

// Normalize a path: trim whitespace, expand ~, resolve to absolute
const normalizePath = (p, homeDir) => {
  if (!p || typeof p !== 'string') return null;
  let normalized = p.trim();
  if (!normalized) return null;
  if (normalized.startsWith('~/')) {
    normalized = path.join(homeDir, normalized.slice(2));
  } else if (normalized === '~') {
    normalized = homeDir;
  }
  return path.resolve(normalized);
};

// Module-level cache for bootstrap content.
// The SKILL.md file does not change during a session, so reading + parsing it
// once eliminates redundant fs.existsSync + fs.readFileSync + regex work on
// every agent step.  See #1202 for the full analysis.
let _bootstrapCache = undefined; // undefined = not yet loaded, null = file missing
let _nlaBannerShown = false;

function showNlaBanner() {
  if (_nlaBannerShown) return;
  _nlaBannerShown = true;
  console.error("[Next Level Agent] active — orchestration, subagents, and run logs enabled.");
}

export const NextLevelAgentPlugin = async ({ client, directory }) => {
  const homeDir = os.homedir();
  const superpowersSkillsDir = path.resolve(__dirname, '../../skills');
  const envConfigDir = normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir);
  const configDir = envConfigDir || path.join(homeDir, '.config/opencode');
  let defaultAgent = 'nla';
  const runLogPath = path.join(directory, '.opencode', 'agent-run.log');

  // The run log is evidence from OpenCode hooks, not model-authored prose.
  // Keep it JSONL and retain only identifiers needed to trace workflow roles.
  const appendRunLog = (entry) => {
    try {
      fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
      const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + String.fromCharCode(10);
      fs.appendFileSync(runLogPath, line, { mode: 0o600 });
    } catch (error) {
      console.error('[Next Level Agent] could not append run log: ' + error.message);
    }
  };

  const safeToolData = (args) => {
    const source = args && typeof args === 'object' ? args : {};
    const detail = { arg_keys: Object.keys(source).sort().slice(0, 12) };
    for (const key of ['agent', 'subagent', 'subagent_type', 'type', 'name', 'skill']) {
      if (typeof source[key] === 'string') detail[key] = source[key].slice(0, 96);
    }
    return detail;
  };

  // Helper to generate bootstrap content (cached after first call)
  const getBootstrapContent = () => {
    // Return cached result on subsequent calls
    if (_bootstrapCache !== undefined) return _bootstrapCache;

    // Try to load next-level-agent skill
    const skillPath = path.join(superpowersSkillsDir, 'next-level-agent', 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      _bootstrapCache = null;
      return null;
    }

    const fullContent = fs.readFileSync(skillPath, 'utf8');
    const { content } = extractAndStripFrontmatter(fullContent);

    const toolMapping = `**Tool Mapping for OpenCode:**
When skills request actions, substitute OpenCode equivalents:
- Create or update todos → \`todowrite\`
- \`Subagent (general-purpose):\` → \`task\` with \`subagent_type: "general"\`
- Invoke a skill → OpenCode's native \`skill\` tool
- Read files → \`read\`
- Create, edit, or delete files → \`apply_patch\`
- Run shell commands → \`bash\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load skills.`;

    _bootstrapCache = `<EXTREMELY_IMPORTANT>
You are running Next Level Agent (NLA), with Superpowers providing its skills framework.

**IMPORTANT: The Next Level Agent bootstrap is active. On the first user message of each session, invoke the native skill tool for next-level-agent before responding or acting. This makes the active skills framework explicit in the UI. After that first invocation, follow the loaded skill and invoke any additional relevant skills normally.**
${content}

${toolMapping}
</EXTREMELY_IMPORTANT>`;

    return _bootstrapCache;
  };

  return {
    // Inject skills path into live config so OpenCode discovers superpowers skills
    // without requiring manual symlinks or config file edits.
    // This works because Config.get() returns a cached singleton — modifications
    // here are visible when skills are lazily discovered later.
    config: async (config) => {
      defaultAgent = config.default_agent || defaultAgent;
      showNlaBanner();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(superpowersSkillsDir)) {
        config.skills.paths.push(superpowersSkillsDir);
      }
    },

    // Record role and workflow-tool activity directly from OpenCode hooks.
    'chat.message': async (input) => {
      appendRunLog({ event: 'primary_agent', session_id: input.sessionID, agent: input.agent || defaultAgent, model: input.model ? input.model.providerID + '/' + input.model.modelID : undefined });
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'skill' && input.tool !== 'task') return;
      appendRunLog({
        event: input.tool === 'task' ? 'subagent_dispatch' : 'skill_invoked',
        session_id: input.sessionID,
        call_id: input.callID,
        tool: input.tool,
        ...safeToolData(output.args),
      });
    },

    'tool.execute.after': async (input) => {
      if (input.tool !== 'skill' && input.tool !== 'task') return;
      appendRunLog({
        event: input.tool === 'task' ? 'subagent_finished' : 'skill_finished',
        session_id: input.sessionID,
        call_id: input.callID,
        tool: input.tool,
      });
    },

    // Inject bootstrap into the first user message of each session.
    // Using a user message instead of a system message avoids:
    //   1. Token bloat from system messages repeated every turn (#750)
    //   2. Multiple system messages breaking Qwen and other models (#894)
    //
    // The hook fires on every agent step (not just every turn) because
    // opencode's prompt.ts reloads messages from DB each step.  Fresh message
    // arrays may need injection again, so getBootstrapContent() must not do
    // repeated disk work.
    'experimental.chat.messages.transform': async (_input, output) => {
      const bootstrap = getBootstrapContent();
      if (!bootstrap || !output.messages.length) return;
      const firstUser = output.messages.find(m => m.info.role === 'user');
      if (!firstUser || !firstUser.parts.length) return;

      // Guard: skip if first user message already contains bootstrap.
      // This prevents double injection when OpenCode passes an already
      // transformed in-memory message array through the hook again.
      if (firstUser.parts.some(p => p.type === 'text' && p.text.includes('EXTREMELY_IMPORTANT'))) return;

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: bootstrap });
    }
  };
};
