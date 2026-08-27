/**
 * Next Level Agent plugin for OpenCode.ai
 *
 * Injects NLA bootstrap context via message transform.
 * Auto-registers skills directory via config hook (no symlinks needed).
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { tool } from '@opencode-ai/plugin';

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

const MODEL_POOLS_PATH = path.resolve(__dirname, '../../config/model-pools.json');

function loadModelPools() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_POOLS_PATH, 'utf8'));
    return parsed && typeof parsed.roles === 'object' ? parsed.roles : {};
  } catch (error) {
    console.error('[Next Level Agent] could not load model pools: ' + error.message);
    return {};
  }
}

function splitModel(model) {
  const slash = typeof model === 'string' ? model.indexOf('/') : -1;
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function retryableProviderError(error) {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === 'string'
      ? error
      : JSON.stringify(error || {});
  return /\b(404|410|429|500|502|503|504)\b|model not found|end of life|\bgone\b|timeout|timed out|upstream|overloaded|temporar(?:y|ily)|network|unavailable|connection reset/i.test(text);
}

function showNlaBanner() {
  if (_nlaBannerShown) return;
  _nlaBannerShown = true;
  console.error("[Next Level Agent] active — orchestration, subagents, and run logs enabled.");
}

export const NextLevelAgentPlugin = async ({ client, directory }) => {
  const homeDir = os.homedir();
  const nlaSkillsDir = path.resolve(__dirname, '../../skills');
  const envConfigDir = normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir);
  const configDir = envConfigDir || path.join(homeDir, '.config/opencode');
  let defaultAgent = 'nla';
  const runLogPath = path.join(directory, '.opencode', 'agent-run.log');

  const pools = loadModelPools();
  const pendingTasks = new Map();
  const trackedSessions = new Map();
  let watchdog = null;

  const touch = (sessionID) => {
    const state = trackedSessions.get(sessionID);
    if (state) state.lastActivity = Date.now();
  };

  const failover = async (sessionID, reason) => {
    const state = trackedSessions.get(sessionID);
    if (!state || state.switching || !state.pool.enabled) return;
    const nextIndex = state.modelIndex + 1;
    const nextModel = state.pool.models && state.pool.models[nextIndex];
    if (!nextModel || state.failovers >= state.pool.max_failovers || !retryableProviderError(reason)) return;
    const model = splitModel(nextModel);
    if (!model) return;

    state.switching = true;
    appendRunLog({
      event: 'model_failure', session_id: sessionID, agent: state.role,
      model: state.model, reason: String(reason).slice(0, 180),
    });
    try {
      await client.session.abort({ path: { id: sessionID } });
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: state.role,
          model,
          parts: [{
            type: 'text',
            text: 'NLA model-pool continuation: the previous provider failed or became unresponsive. Continue the original bounded subtask from the existing session context. Do not repeat completed work; report factual evidence when finished.',
          }],
        },
      });
      state.model = nextModel;
      state.modelIndex = nextIndex;
      state.failovers += 1;
      state.lastActivity = Date.now();
      state.busy = true;
      appendRunLog({
        event: 'model_fallback_started', session_id: sessionID, agent: state.role,
        previous_model: state.pool.models[nextIndex - 1], model: nextModel,
        failover: state.failovers,
      });
    } catch (error) {
      appendRunLog({
        event: 'model_fallback_failed', session_id: sessionID, agent: state.role,
        model: nextModel, reason: String(error && error.message || error).slice(0, 180),
      });
    } finally {
      state.switching = false;
    }
  };

  const startWatchdog = () => {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const now = Date.now();
      for (const [sessionID, state] of trackedSessions) {
        if (!state.busy || state.switching || !state.pool.enabled) continue;
        const timeout = state.pool.idle_timeout_ms || 0;
        if (timeout > 0 && now - state.lastActivity >= timeout) {
          void failover(sessionID, 'NLA watchdog timeout: no OpenCode progress event');
        }
      }
    }, 5000);
  };

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

  const nlaTask = tool({
    description: 'Run one bounded NLA subagent task through its ordered model pool. Use this instead of task for NLA roles so early model errors, provider failures, and timeouts can fall back safely.',
    args: {
      role: tool.schema.string().describe('Configured NLA subagent role, for example explorer, architect, implementer, or reviewer'),
      description: tool.schema.string().max(120).describe('Short task title'),
      prompt: tool.schema.string().describe('Complete bounded task packet for the subagent'),
    },
    execute: async (args, context) => {
      const pool = pools[args.role];
      if (!pool || !pool.enabled || !Array.isArray(pool.models) || pool.models.length === 0) {
        throw new Error(`No enabled NLA model pool for role: ${args.role}`);
      }

      const attempts = pool.models.slice(0, Math.min(pool.models.length, (pool.max_failovers || 0) + 1));
      const created = await client.session.create({
        body: { parentID: context.sessionID, title: args.description },
        query: { directory: context.directory || directory },
        throwOnError: true,
      });
      const childID = created.data.id;
      appendRunLog({
        event: 'pooled_subagent_created', session_id: childID,
        parent_session_id: context.sessionID, agent: args.role,
        models: attempts,
      });

      let lastError = null;
      for (let index = 0; index < attempts.length; index += 1) {
        if (context.abort.aborted) throw new Error('NLA pooled task aborted by caller');
        const modelName = attempts[index];
        const model = splitModel(modelName);
        if (!model) {
          lastError = new Error(`Invalid model identifier in ${args.role} pool: ${modelName}`);
          continue;
        }

        appendRunLog({
          event: 'model_attempt_started', session_id: childID,
          parent_session_id: context.sessionID, agent: args.role,
          model: modelName, attempt: index + 1,
        });

        let timer = null;
        try {
          const request = client.session.prompt({
            path: { id: childID },
            query: { directory: context.directory || directory },
            body: {
              agent: args.role,
              model,
              parts: [{ type: 'text', text: args.prompt }],
            },
            throwOnError: true,
          });
          const timeoutMs = pool.idle_timeout_ms || 0;
          const result = timeoutMs > 0
            ? await Promise.race([
                request,
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    void client.session.abort({ path: { id: childID } });
                    reject(new Error(`NLA pooled task timed out after ${timeoutMs}ms`));
                  }, timeoutMs);
                }),
              ])
            : await request;
          if (timer) clearTimeout(timer);

          if (result.data.info && result.data.info.error) {
            const modelError = result.data.info.error;
            const detail = modelError.data && (modelError.data.message || modelError.data.responseBody);
            const status = modelError.data && modelError.data.statusCode;
            throw new Error(`${modelError.name || 'ModelError'}${status ? ` ${status}` : ''}: ${detail || JSON.stringify(modelError)}`);
          }

          const output = (result.data.parts || [])
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
            .trim();
          if (!output) throw new Error('NLA pooled subagent returned no text result');

          appendRunLog({
            event: 'model_attempt_succeeded', session_id: childID,
            parent_session_id: context.sessionID, agent: args.role,
            model: modelName, attempt: index + 1,
          });
          return {
            title: `${args.description} (${args.role})`,
            output,
            metadata: { sessionID: childID, role: args.role, model: modelName, attempt: index + 1 },
          };
        } catch (error) {
          if (timer) clearTimeout(timer);
          lastError = error;
          const reason = error instanceof Error ? error.message : String(error);
          appendRunLog({
            event: 'model_attempt_failed', session_id: childID,
            parent_session_id: context.sessionID, agent: args.role,
            model: modelName, attempt: index + 1, reason: reason.slice(0, 180),
          });
          if (index + 1 >= attempts.length || !retryableProviderError(error)) break;
          appendRunLog({
            event: 'model_fallback_started', session_id: childID,
            parent_session_id: context.sessionID, agent: args.role,
            previous_model: modelName, model: attempts[index + 1], failover: index + 1,
          });
        }
      }

      const reason = lastError instanceof Error ? lastError.message : String(lastError || 'unknown failure');
      throw new Error(`NLA pooled task failed for ${args.role} after ${attempts.length} model attempt(s): ${reason}`);
    },
  });

  // Helper to generate bootstrap content (cached after first call)
  const getBootstrapContent = () => {
    // Return cached result on subsequent calls
    if (_bootstrapCache !== undefined) return _bootstrapCache;

    // Try to load next-level-agent skill
    const skillPath = path.join(nlaSkillsDir, 'next-level-agent', 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      _bootstrapCache = null;
      return null;
    }

    const fullContent = fs.readFileSync(skillPath, 'utf8');
    const { content } = extractAndStripFrontmatter(fullContent);

    const toolMapping = `**Tool Mapping for OpenCode:**
When skills request actions, substitute OpenCode equivalents:
- Create or update todos → \`todowrite\`
- Run an NLA subagent role → \`nla_task\` with \`role\`, \`description\`, and a bounded \`prompt\`
- Invoke a skill → OpenCode's native \`skill\` tool
- Read files → \`read\`
- Create, edit, or delete files → \`apply_patch\`
- Run shell commands → \`bash\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load skills.`;

    _bootstrapCache = `<EXTREMELY_IMPORTANT>
You are NLA, Next Level Agent.

**IMPORTANT: The Next Level Agent bootstrap is active. On the first user message of each session, invoke the native skill tool for next-level-agent before responding or acting. This makes NLA startup explicit in the UI. After that first invocation, follow the loaded skill and invoke any additional relevant skills normally.**
${content}

${toolMapping}
</EXTREMELY_IMPORTANT>`;

    return _bootstrapCache;
  };

  return {
    tool: {
      nla_task: nlaTask,
    },
    // Inject skills path into live config so OpenCode discovers NLA skills
    // without requiring manual symlinks or config file edits.
    // This works because Config.get() returns a cached singleton — modifications
    // here are visible when skills are lazily discovered later.
    config: async (config) => {
      defaultAgent = config.default_agent || defaultAgent;
      showNlaBanner();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(nlaSkillsDir)) {
        config.skills.paths.push(nlaSkillsDir);
      }
    },

    // Model pools apply only to subagents. NLA primary is deliberately excluded.
    event: async ({ event }) => {
      const props = event.properties || {};
      if (event.type === 'session.created' && props.info && props.info.parentID) {
        const queue = pendingTasks.get(props.info.parentID) || [];
        const role = queue.shift();
        if (queue.length) pendingTasks.set(props.info.parentID, queue);
        else pendingTasks.delete(props.info.parentID);
        const pool = role && pools[role];
        if (pool && pool.enabled) {
          trackedSessions.set(props.info.id, {
            role,
            pool,
            model: pool.models[0],
            modelIndex: 0,
            failovers: 0,
            busy: true,
            switching: false,
            lastActivity: Date.now(),
          });
          appendRunLog({ event: 'model_pool_attached', session_id: props.info.id, parent_session_id: props.info.parentID, agent: role, model: pool.models[0] });
          startWatchdog();
        }
      }
      if (event.type === 'session.status' && props.sessionID) {
        const state = trackedSessions.get(props.sessionID);
        if (state) {
          state.busy = props.status && props.status.type !== 'idle';
          touch(props.sessionID);
        }
      }
      if (event.type === 'message.part.updated' && props.part && props.part.sessionID) touch(props.part.sessionID);
      if (event.type === 'session.compacted' && props.sessionID) {
        appendRunLog({ event: 'context_compacted', session_id: props.sessionID });
        touch(props.sessionID);
      }
      if (event.type === 'session.error' && props.sessionID) void failover(props.sessionID, props.error);
      if (event.type === 'session.idle' && props.sessionID) {
        const state = trackedSessions.get(props.sessionID);
        if (state) {
          state.busy = false;
          touch(props.sessionID);
        }
      }
    },

    // Record role and workflow-tool activity directly from OpenCode hooks.
    'chat.message': async (input) => {
      appendRunLog({ event: 'primary_agent', session_id: input.sessionID, agent: input.agent || defaultAgent, model: input.model ? input.model.providerID + '/' + input.model.modelID : undefined });
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'task') {
        const args = output.args || {};
        const role = args.subagent_type || args.agent || args.type;
        if (typeof role === 'string' && pools[role] && pools[role].enabled) {
          const queue = pendingTasks.get(input.sessionID) || [];
          queue.push(role);
          pendingTasks.set(input.sessionID, queue);
        }
      }
      if (input.tool !== 'skill' && input.tool !== 'task' && input.tool !== 'nla_task') return;
      appendRunLog({
        event: input.tool === 'skill' ? 'skill_invoked' : 'subagent_dispatch',
        session_id: input.sessionID,
        call_id: input.callID,
        tool: input.tool,
        ...safeToolData(output.args),
      });
    },

    'tool.execute.after': async (input) => {
      if (input.tool !== 'skill' && input.tool !== 'task' && input.tool !== 'nla_task') return;
      appendRunLog({
        event: input.tool === 'skill' ? 'skill_finished' : 'subagent_finished',
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
    },

    dispose: async () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      trackedSessions.clear();
      pendingTasks.clear();
    }
  };
};
