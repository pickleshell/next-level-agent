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
import {
  contextTokens, initializeNotebook, loadLedger, memoryRoot, notebookRoot,
  parseLedgerJSON, readNotebook, restorePacket, saveLedger,
  thresholdState, writeNotebookPage,
} from './nla-memory.mjs';
import { intelligentCheckpoint } from './nla-compaction.mjs';

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
  let defaultModel = null;
  const runLogPath = path.join(directory, '.opencode', 'agent-run.log');
  const stateRoot = memoryRoot(homeDir);
  const notebookDir = notebookRoot(homeDir);
  const softContextTokens = Number(process.env.NLA_CONTEXT_SOFT_TOKENS || 50000);
  const hardContextTokens = Number(process.env.NLA_CONTEXT_HARD_TOKENS || 70000);

  const pools = loadModelPools();
  const pendingTasks = new Map();
  const trackedSessions = new Map();
  const primarySessions = new Map();
  const activeChildren = new Map();
  const compactionState = new Map();
  const sessionRoots = new Map();
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
      const enriched = { ...entry };
      if (enriched.session_id && !enriched.root_session_id) {
        enriched.root_session_id = sessionRoots.get(enriched.session_id) || enriched.session_id;
      }
      const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, enriched)) + String.fromCharCode(10);
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

  const runPooledTask = async (args, context) => {
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
      sessionRoots.set(childID, sessionRoots.get(context.sessionID) || context.sessionID);
      activeChildren.set(context.sessionID, (activeChildren.get(context.sessionID) || 0) + 1);
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
  };

  const pooledTaskWithTracking = async (args, context) => {
    try {
      return await runPooledTask(args, context);
    } finally {
      const count = Math.max(0, (activeChildren.get(context.sessionID) || 1) - 1);
      if (count) activeChildren.set(context.sessionID, count);
      else activeChildren.delete(context.sessionID);
    }
  };

  const nlaTask = tool({
    description: 'Run one bounded NLA subagent task through its ordered model pool. Use this instead of task for NLA roles so early model errors, provider failures, and timeouts can fall back safely.',
    args: {
      role: tool.schema.string().describe('Configured NLA subagent role, for example explorer, architect, implementer, or reviewer'),
      description: tool.schema.string().max(120).describe('Short task title'),
      prompt: tool.schema.string().describe('Complete bounded task packet for the subagent'),
    },
    execute: pooledTaskWithTracking,
  });

  const assertPrimaryNla = (sessionID) => {
    const primary = primarySessions.get(sessionID);
    if (!primary || primary.agent !== 'nla') throw new Error('This NLA memory tool is restricted to the primary nla agent');
  };

  const nlaState = tool({
    description: 'Replace the primary NLA session ledger with a complete structured snapshot. Call after classification, approvals, milestones, blockers, and before completion.',
    args: {
      snapshot: tool.schema.string().describe('Complete JSON object containing goal, tier, workflow_stage, acceptance_criteria, approved_decisions, completed_tasks, active_task, changed_files, verification, blockers, pending_gate, and next_step'),
    },
    execute: async (args, context) => {
      assertPrimaryNla(context.sessionID);
      const ledger = parseLedgerJSON(args.snapshot, context.sessionID, context.directory || directory);
      const file = saveLedger(stateRoot, ledger);
      appendRunLog({ event: 'session_ledger_saved', session_id: context.sessionID, workflow_stage: ledger.workflow_stage, tier: ledger.tier });
      return { title: 'NLA session ledger saved', output: `Saved private session ledger. Next step: ${ledger.next_step || 'not recorded'}`, metadata: { file } };
    },
  });

  const nlaNotebook = tool({
    description: 'Read or replace one durable Assistant Notebook page. Primary NLA only. Current conversation and verified artifacts remain authoritative; never store secrets or transcripts.',
    args: {
      action: tool.schema.enum(['restore', 'update']).describe('restore reads Contents plus one optional page; update atomically replaces one page'),
      page: tool.schema.string().max(120).optional().describe('Notebook page title or filename, for example NLA or gpu-top'),
      content: tool.schema.string().max(64000).optional().describe('Complete compact Markdown page for update'),
    },
    execute: async (args, context) => {
      assertPrimaryNla(context.sessionID);
      if (args.action === 'restore') {
        const result = readNotebook(notebookDir, args.page);
        appendRunLog({ event: 'notebook_restored', session_id: context.sessionID, page: result.page });
        return { title: 'Assistant Notebook restored', output: `${result.contents}${result.content ? `\n\n--- ${result.page} ---\n${result.content}` : ''}`, metadata: { page: result.page } };
      }
      if (!args.page || !args.content) throw new Error('Notebook update requires page and content');
      const page = writeNotebookPage(notebookDir, args.page, args.content);
      appendRunLog({ event: 'notebook_updated', session_id: context.sessionID, page });
      return { title: 'Assistant Notebook updated', output: `Updated durable notebook page ${page}.`, metadata: { page } };
    },
  });

  const performCompaction = async (sessionID, trigger) => {
    const current = compactionState.get(sessionID) || {};
    if (current.running) return;
    if ((activeChildren.get(sessionID) || 0) > 0) {
      appendRunLog({ event: 'compaction_deferred', session_id: sessionID, reason: 'active_subagents' });
      return;
    }
    const primary = primarySessions.get(sessionID);
    const ledger = loadLedger(stateRoot, sessionID);
    if (!primary || primary.agent !== 'nla' || !ledger) {
      appendRunLog({ event: 'compaction_deferred', session_id: sessionID, reason: !ledger ? 'missing_ledger' : 'not_primary_nla' });
      return;
    }

    current.running = true;
    current.requested = false;
    current.compactionCount = (current.compactionCount || 0) + 1;
    current.tokensBeforeCompaction = current.tokens || 0;
    compactionState.set(sessionID, current);
    const primaryModel = primary.model || defaultModel;
    appendRunLog({
      event: 'compaction_started', session_id: sessionID, trigger,
      model: primaryModel ? `${primaryModel.providerID}/${primaryModel.modelID}` : undefined,
      tokens_before: current.tokensBeforeCompaction, compaction_number: current.compactionCount,
    });
    const context = { sessionID, directory: primary.directory || directory, abort: { aborted: false } };
    try {
      const audit = await pooledTaskWithTracking({
        role: 'supervisor',
        description: 'Pre-compaction workflow audit',
        prompt: `Audit this NLA session ledger before compaction. Check goal, acceptance criteria, workflow stage, approvals, active work, evidence, blockers, and exact next step. Return one verdict (CONTINUE, BLOCK, MANDATE_REVIEW, MANDATE_CHECKPOINT, or MANDATE_COMPACTION) and concise corrections. Ledger:\n${JSON.stringify(ledger)}`,
      }, context);
      if (/^\s*BLOCK\b/i.test(audit.output)) throw new Error(`Supervisor blocked compaction: ${audit.output.slice(0, 500)}`);

      const resolved = await intelligentCheckpoint({
        ledger,
        sessionID,
        directory: primary.directory || directory,
        pool: pools.compactor,
        runCompactor: (prompt) => pooledTaskWithTracking({
          role: 'compactor',
          description: 'Create intelligent compaction checkpoint',
          prompt,
        }, context),
      });
      const checkpoint = resolved.checkpoint;
      appendRunLog({
        event: resolved.mode === 'intelligent' ? 'compactor_checkpoint_created' : 'compactor_fallback_used',
        session_id: sessionID,
        mode: resolved.mode,
        reason: resolved.reason || undefined,
      });
      saveLedger(stateRoot, checkpoint);
      current.checkpoint = checkpoint;
      current.awaitingEvent = true;

      const model = primary.model || defaultModel;
      if (!model) throw new Error('No model is available for native session summarization');
      const body = { providerID: model.providerID, modelID: model.modelID };
      await client.session.summarize({
        path: { id: sessionID },
        query: { directory: primary.directory || directory },
        body,
        throwOnError: true,
      });
      appendRunLog({ event: 'compaction_requested', session_id: sessionID, trigger, model: `${model.providerID}/${model.modelID}`, tokens_before: current.tokensBeforeCompaction, compaction_number: current.compactionCount });
    } catch (error) {
      current.running = false;
      current.awaitingEvent = false;
      appendRunLog({ event: 'compaction_failed', session_id: sessionID, reason: String(error && error.message || error).slice(0, 300) });
    }
  };

  const nlaCompact = tool({
    description: 'Schedule safe native OpenCode compaction for the primary NLA session. Saves a deterministic ledger, optionally improves it with the configured Compactor role, then runs native summarization and restore at the next safe idle boundary.',
    args: {
      snapshot: tool.schema.string().describe('Complete current NLA ledger JSON, using the same schema as nla_state'),
      reason: tool.schema.string().max(240).optional().describe('Why compaction is needed'),
    },
    execute: async (args, context) => {
      assertPrimaryNla(context.sessionID);
      const ledger = parseLedgerJSON(args.snapshot, context.sessionID, context.directory || directory);
      saveLedger(stateRoot, ledger);
      const current = compactionState.get(context.sessionID) || {};
      current.requested = true;
      current.trigger = args.reason || 'manual_model_request';
      compactionState.set(context.sessionID, current);
      appendRunLog({ event: 'compaction_scheduled', session_id: context.sessionID, trigger: current.trigger });
      return { title: 'NLA compaction scheduled', output: 'Deterministic checkpoint saved. An available configured Compactor may improve it before native summarization and restore run after this response at the next safe idle boundary. Any Compactor failure falls back to this checkpoint. Do not start another task before the compaction events complete.' };
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
	- Save the workflow ledger → \`nla_state\` with a complete JSON snapshot
	- Read or update durable memory → \`nla_notebook\` (primary NLA only)
	- Safely compact context → \`nla_compact\` with the complete current ledger
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
      nla_state: nlaState,
      nla_notebook: nlaNotebook,
      nla_compact: nlaCompact,
    },
    // Inject skills path into live config so OpenCode discovers NLA skills
    // without requiring manual symlinks or config file edits.
    // This works because Config.get() returns a cached singleton — modifications
    // here are visible when skills are lazily discovered later.
    config: async (config) => {
      defaultAgent = config.default_agent || defaultAgent;
      defaultModel = typeof config.model === 'string' ? splitModel(config.model) : defaultModel;
      showNlaBanner();
      initializeNotebook(notebookDir);
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(nlaSkillsDir)) {
        config.skills.paths.push(nlaSkillsDir);
      }
    },

    // Model pools apply only to subagents. NLA primary is deliberately excluded.
    event: async ({ event }) => {
      const props = event.properties || {};
      if (event.type === 'session.created' && props.info && props.info.id) {
        const parentID = props.info.parentID || null;
        const rootID = parentID ? (sessionRoots.get(parentID) || parentID) : props.info.id;
        sessionRoots.set(props.info.id, rootID);
        appendRunLog({
          event: 'session_created', session_id: props.info.id,
          parent_session_id: parentID, root_session_id: rootID,
          kind: parentID ? 'subagent' : 'primary',
        });
      }
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
      if (event.type === 'message.updated' && props.info && primarySessions.get(props.info.sessionID)?.agent === 'nla') {
        const sessionID = props.info.sessionID;
        const tokens = contextTokens(props.info);
        const level = thresholdState(tokens, softContextTokens, hardContextTokens);
        const current = compactionState.get(sessionID) || {};
        current.tokens = tokens;
        const primary = primarySessions.get(sessionID);
        const model = primary.model || defaultModel;
        const compactionSummaryInFlight = current.running || current.awaitingEvent;
        if (tokens > 0 && !compactionSummaryInFlight && current.lastLoggedTokens !== tokens) {
          appendRunLog({
            event: current.awaitingAfterUsage ? 'context_after_compaction' : 'context_usage',
            session_id: sessionID,
            model: model ? `${model.providerID}/${model.modelID}` : undefined,
            input_tokens: Number(props.info.tokens && props.info.tokens.input || 0),
            cache_read_tokens: Number(props.info.tokens && props.info.tokens.cache && props.info.tokens.cache.read || 0),
            effective_context_tokens: tokens,
            tokens_reclaimed: current.awaitingAfterUsage ? Math.max(0, Number(current.tokensBeforeCompaction || 0) - tokens) : undefined,
            compaction_number: current.compactionCount || 0,
          });
          current.lastLoggedTokens = tokens;
          current.awaitingAfterUsage = false;
        }
        if (level !== 'normal' && current.level !== level) {
          current.level = level;
          current.noticePending = true;
          appendRunLog({ event: 'context_threshold', session_id: sessionID, level, tokens, soft: softContextTokens, hard: hardContextTokens });
        }
        if (level === 'hard') {
          current.requested = true;
          current.trigger = 'automatic_hard_threshold';
        }
        compactionState.set(sessionID, current);
      }
      if (event.type === 'session.compacted' && props.sessionID) {
        const current = compactionState.get(props.sessionID) || {};
        current.compactionCount = current.compactionCount || 1;
        const primary = primarySessions.get(props.sessionID);
        const model = (primary && primary.model) || defaultModel;
        current.tokensBeforeCompaction = current.tokensBeforeCompaction || current.tokens || 0;
        current.awaitingAfterUsage = true;
        appendRunLog({
          event: 'context_compacted', session_id: props.sessionID,
          model: model ? `${model.providerID}/${model.modelID}` : undefined,
          tokens_before: current.tokensBeforeCompaction,
          compaction_number: current.compactionCount || 1,
        });
        const checkpoint = current.checkpoint || loadLedger(stateRoot, props.sessionID);
        if (checkpoint) {
          const primary = primarySessions.get(props.sessionID) || { agent: 'nla', directory: checkpoint.directory || directory, model: defaultModel };
          try {
            await client.session.prompt({
              path: { id: props.sessionID },
              query: { directory: primary.directory || directory },
              body: { noReply: true, parts: [{ type: 'text', text: restorePacket(checkpoint) }] },
              throwOnError: true,
            });
            appendRunLog({ event: 'context_restored', session_id: props.sessionID, next_step: String(checkpoint.next_step || '').slice(0, 180) });
          } catch (error) {
            appendRunLog({ event: 'context_restore_failed', session_id: props.sessionID, reason: String(error && error.message || error).slice(0, 300) });
          }
        }
        current.running = false;
        current.awaitingEvent = false;
        current.level = 'normal';
        current.noticePending = false;
        compactionState.set(props.sessionID, current);
        touch(props.sessionID);
      }
      if (event.type === 'session.error' && props.sessionID) void failover(props.sessionID, props.error);
      if (event.type === 'session.idle' && props.sessionID) {
        const state = trackedSessions.get(props.sessionID);
        if (state) {
          state.busy = false;
          touch(props.sessionID);
        }
        const compact = compactionState.get(props.sessionID);
        if (compact && compact.requested && !compact.running) void performCompaction(props.sessionID, compact.trigger || 'scheduled');
      }
    },

    // Record role and workflow-tool activity directly from OpenCode hooks.
    'chat.message': async (input) => {
      const agent = input.agent || defaultAgent;
      const model = input.model || defaultModel;
      if (!sessionRoots.has(input.sessionID)) {
        sessionRoots.set(input.sessionID, input.sessionID);
        appendRunLog({ event: 'session_observed', session_id: input.sessionID, parent_session_id: null, kind: agent === 'nla' ? 'primary' : 'unknown', agent });
      }
      primarySessions.set(input.sessionID, { agent, model, directory: input.directory || directory });
      appendRunLog({ event: 'session_model_bound', session_id: input.sessionID, agent, model: model ? `${model.providerID}/${model.modelID}` : undefined });
      appendRunLog({ event: 'primary_agent', session_id: input.sessionID, agent, model: model ? `${model.providerID}/${model.modelID}` : undefined });
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
      if (!['skill', 'task', 'nla_task', 'nla_state', 'nla_notebook', 'nla_compact'].includes(input.tool)) return;
      appendRunLog({
        event: input.tool === 'skill' ? 'skill_invoked' : 'subagent_dispatch',
        session_id: input.sessionID,
        call_id: input.callID,
        tool: input.tool,
        ...safeToolData(output.args),
      });
    },

    'tool.execute.after': async (input) => {
      if (!['skill', 'task', 'nla_task', 'nla_state', 'nla_notebook', 'nla_compact'].includes(input.tool)) return;
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
      const knownSession = _input && _input.sessionID && primarySessions.get(_input.sessionID);
      if (knownSession && knownSession.agent !== 'nla') return;
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
      const sessionID = firstUser.info && firstUser.info.sessionID;
      const compact = sessionID && compactionState.get(sessionID);
      if (compact && compact.noticePending) {
        firstUser.parts.unshift({ ...ref, type: 'text', text: `<NLA_CONTEXT_PRESSURE level="${compact.level}" tokens="${compact.tokens}">Save a complete ledger with nla_state. At the next safe boundary call nla_compact; do not start another large subagent task first.</NLA_CONTEXT_PRESSURE>` });
        compact.noticePending = false;
      }
    },

    dispose: async () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      trackedSessions.clear();
      pendingTasks.clear();
      primarySessions.clear();
      activeChildren.clear();
      compactionState.clear();
      sessionRoots.clear();
    }
  };
};
