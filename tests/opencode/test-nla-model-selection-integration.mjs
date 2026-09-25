import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { writeEvaluationStoreAtomic } from '../../.opencode/plugins/nla-model-evaluations.mjs';
import { initializeSystemDatabase, loadSystemEvaluations } from '../../.opencode/plugins/nla-system-database.mjs';

const oldPool = process.env.NLA_MODEL_POOLS_PATH;
const oldMemory = process.env.NLA_MEMORY_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-model-selection-plugin-'));
process.env.NLA_MODEL_POOLS_PATH = path.join(root, 'pools.json');
process.env.NLA_MEMORY_DIR = path.join(root, 'memory');

const pool = {
  version: 1,
  roles: {
    nla: { enabled: false, selection_mode: 'fallback', models: ['fixture/a'] },
    supervisor: { enabled: true, selection_mode: 'auto', models: ['fixture/a'] },
    scout: { enabled: true, selection_mode: 'fallback', models: ['fixture/a'] },
    explorer: { enabled: true, selection_mode: 'auto', models: [] },
    architect: {
      enabled: true,
      selection_mode: 'select',
      models: ['fixture/a', 'fixture/b', 'fixture/c'],
      idle_timeout_ms: 0,
    },
    router: { enabled: true, selection_mode: 'select', models: ['fixture/coding', 'fixture/reasoning'], idle_timeout_ms: 0 },
    implementer: { enabled: true, selection_mode: 'select', models: ['fixture/impl'], idle_timeout_ms: 0 },
    reviewer: { enabled: true, selection_mode: 'select', models: ['fixture/reviewer'], idle_timeout_ms: 0 },
    compactor: { enabled: true, selection_mode: 'fallback', models: ['fixture/a'] },
  },
};
fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify(pool));
writeEvaluationStoreAtomic(path.join(process.env.NLA_MEMORY_DIR, 'model-evaluations.json'), {
  version: 1,
  models: {
    'fixture/a': { scores: { coding: 6, reasoning: 6, tool_use: 6, reliability: 8, latency: 6 } },
    'fixture/b': { scores: { coding: 9, reasoning: 9, tool_use: 9, reliability: 9, latency: 9 } },
    'fixture/c': { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 8 } },
    'fixture/coding': { scores: { coding: 10, reasoning: 2, tool_use: 0, reliability: 8, latency: 8 } },
    'fixture/reasoning': { scores: { coding: 2, reasoning: 10, tool_use: 0, reliability: 8, latency: 8 } },
    'fixture/impl': { scores: { coding: 0, reasoning: 0, tool_use: 0, reliability: 0, latency: 0 } },
    'fixture/reviewer': { scores: { coding: 0, reasoning: 0, tool_use: 0, reliability: 0, latency: 0 } },
  },
});
const evaluationStore = () => loadSystemEvaluations(path.join(process.env.NLA_MEMORY_DIR, 'system.sqlite'));
const initializeStore = () => initializeSystemDatabase({
  stateRoot: process.env.NLA_MEMORY_DIR,
  seedPath: path.resolve('config/model-evaluations.json'),
  legacyEvaluationPath: path.join(process.env.NLA_MEMORY_DIR, 'model-evaluations.json'),
});
initializeStore();

const tick = () => new Promise((resolve) => setImmediate(resolve));
let instance;
try {
  const selectedCalls = [];
  let selectedChild = 0;
  let inventoryCalls = 0;
  const abortedSessions = [];
  let repairAction = 'omit_review_target';
  instance = await NextLevelAgentPlugin({
    directory: root,
    client: {
      tool: { list: async () => ({ data: ['read', 'grep', 'glob'].map((id) => ({ id, parameters: { type: 'object' } })) }) },
      config: { providers: async () => {
        inventoryCalls++;
        return { data: { providers: [{ id: 'fixture', models: Object.fromEntries(['a', 'b', 'c', 'coding', 'reasoning', 'impl', 'reviewer'].map((id) => [id, { limit: { context: 131072 } }])) }] } };
      } },
      session: {
        create: async () => ({ data: { id: `child_select_${++selectedChild}` } }),
        prompt: async (request) => {
          selectedCalls.push({ agent: request.body.agent, model: request.body.model });
          return { data: { parts: [{ type: 'text', text: request.body.parts[0].text.startsWith('Check a malformed delegation.') ? JSON.stringify({ action: repairAction }) : 'selected result' }] } };
        },
        abort: async (request) => { abortedSessions.push(request.path.id); return { data: true }; },
      },
    },
  });
  assert.equal(inventoryCalls, 0, 'provider discovery must not run during plugin initialization');
  await instance['chat.message']({ sessionID: 'primary_select', agent: 'nla', directory: root, model: { providerID: 'fixture', modelID: 'b' } });
  await instance.event({ event: { type: 'message.updated', properties: { info: {
    id: 'message_usage_primary', sessionID: 'primary_select', role: 'assistant', providerID: 'fixture', modelID: 'b',
    tokens: { input: 101, output: 23, reasoning: 11, cache: { read: 31, write: 7 }, total: 173 }, cost: 0.0123, finish: 'stop',
  } } } });
  await instance.event({ event: { type: 'message.updated', properties: { info: {
    id: 'message_usage_primary', sessionID: 'primary_select', role: 'assistant', providerID: 'fixture', modelID: 'b',
    tokens: { input: 101, output: 23, reasoning: 11, cache: { read: 31, write: 7 }, total: 173 }, cost: 0.0123, finish: 'stop',
  } } } });
  const usageSummary = await instance.tool.nla_usage.execute({ action: 'summary' }, { sessionID: 'primary_select', directory: root });
  assert.match(usageSummary.output, /\| nla \| fixture\/b \| 1 \| 101 \| 23 \| 11 \| 31 \| 7 \| 173 \| 0.0123 \|/, 'nla_usage reports durable per-workflow token accounting');
  const usageEvents = fs.readFileSync(path.join(root, '.opencode', 'agent-run.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.event === 'model_usage');
  assert.equal(usageEvents.length, 1, 'the existing tail-able JSONL run log receives one deduplicated model usage event');
  assert.equal(usageEvents[0].total_tokens, 173);
  assert.ok(!JSON.stringify(usageEvents[0]).includes('prompt'), 'usage telemetry never includes prompt content');
  const selected = await instance.tool.nla_task.execute({ role: 'architect', description: 'selection fixture', prompt: 'bounded task', context_window: '20000' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(inventoryCalls, 1, 'resolved inventory is cached across chat and task');
  assert.equal(selected.metadata.model, 'fixture/b', 'nla_task select uses the highest-ranked model');
  const coding = await instance.tool.nla_task.execute({ role: 'router', description: 'coding weights', prompt: 'bounded task', selection_weights: '{"coding":10}' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  const reasoning = await instance.tool.nla_task.execute({ role: 'router', description: 'reasoning weights', prompt: 'bounded task', selection_weights: '{"reasoning":10}' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(coding.metadata.model, 'fixture/coding', 'task-specific coding weights reach the selector');
  assert.equal(reasoning.metadata.model, 'fixture/reasoning', 'task-specific reasoning weights reach the selector');
  assert.deepEqual(selectedCalls.map(({ agent, model }) => `${agent}:${model.providerID}/${model.modelID}`), ['architect:fixture/b', 'router:fixture/coding', 'router:fixture/reasoning']);
  const assessmentEvents = fs.readFileSync(path.join(root, '.opencode', 'agent-run.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.event === 'task_assessed');
  assert.equal(assessmentEvents.length, 3, 'every select delegation runs the mandatory task assessor');
  assert.equal(assessmentEvents[0].source, 'hybrid');
  assert.equal(assessmentEvents[1].source, 'hybrid');
  assert.equal(assessmentEvents[1].selected_model, 'fixture/coding');
  assert.ok(assessmentEvents.every((entry) => !Object.hasOwn(entry, 'prompt') && !Object.hasOwn(entry, 'description')), 'assessment telemetry excludes task content');
  const autoView = await instance.tool.nla_models.execute({}, { sessionID: 'primary_select', directory: root });
  assert.equal(autoView.metadata.auto.find((entry) => entry.role === 'supervisor').candidates, 7);
  assert.deepEqual(autoView.metadata.auto.find((entry) => entry.role === 'supervisor').preferences, ['fixture/a']);
  const autoTask = await instance.tool.nla_task.execute({ role: 'supervisor', description: 'auto suitability fixture', prompt: 'bounded task' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(autoTask.metadata.model, 'fixture/b', 'auto selects better unlisted model, not only configured preference');
  await instance.tool.nla_model_health_reset.execute({ binding: 'fixture/b' }, { sessionID: 'primary_select', directory: root });
  const turnedOff = await instance.tool.nla_models_registry.execute({ action: 'status_set', binding: 'fixture/b', status: 'off' }, { sessionID: 'primary_select', directory: root });
  assert.equal(JSON.parse(turnedOff.output).status, 'off');
  const disabledRegistry = await instance.tool.nla_models_registry.execute({ action: 'show', binding: 'fixture/b' }, { sessionID: 'primary_select', directory: root });
  assert.equal(JSON.parse(disabledRegistry.output).status, 'off', 'model switch is visible through NLA');
  assert.equal(JSON.parse(disabledRegistry.output).facts.status, 'off', 'raw facts in tool output use the same switch label');
  const disabledView = await instance.tool.nla_models.execute({}, { sessionID: 'primary_select', directory: root });
  assert.equal(disabledView.metadata.health.find((entry) => entry.binding === 'fixture/b').eligible, false, 'nla_models reports operator-disabled binding as ineligible');
  assert.match(disabledView.output, /Models off: fixture\/b/, 'nla_models makes off models visible without inspecting health JSON');
  assert.equal(disabledView.metadata.health.find((entry) => entry.binding === 'fixture/b').status, 'off');
  const afterDisable = await instance.tool.nla_task.execute({ role: 'architect', description: 'disabled binding fixture', prompt: 'bounded task' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(afterDisable.metadata.model, 'fixture/c', 'new select task skips disabled highest-ranked model');
  await instance.tool.nla_models_registry.execute({ action: 'status_set', binding: 'fixture/b', status: 'on' }, { sessionID: 'primary_select', directory: root });
  const afterEnable = await instance.tool.nla_task.execute({ role: 'architect', description: 're-enabled binding fixture', prompt: 'bounded task' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(afterEnable.metadata.model, 'fixture/b', 'model is selectable again without pool reload');
  await instance.tool.nla_models_registry.execute({ action: 'import', json: JSON.stringify({ models: {
    'fixture/a': { facts: { context_window: 131072 } },
    'fixture/b': { facts: { context_window: 32768 } },
    'fixture/c': { facts: { context_window: 131072 } },
  } }) }, { sessionID: 'primary_select', directory: root });
  const contextSelected = await instance.tool.nla_task.execute({ role: 'architect', description: 'imported context fixture', prompt: 'bounded task', context_window: '100000' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(contextSelected.metadata.model, 'fixture/c', 'imported SQLite model facts affect live selection');
  await instance.tool.nla_system.execute({ action: 'setting_set', key: 'routing.selection_policy.architect', value_json: '"balanced"' }, { sessionID: 'primary_select', directory: root });
  assert.equal((await instance.tool.nla_models_reload.execute({}, { sessionID: 'primary_select', directory: root })).metadata.roles.find((row) => row.role === 'architect').selection_policy, 'balanced', 'SQLite policy survives pool reload');
  assert.equal(inventoryCalls, 2, 'reload refreshes resolved provider inventory');
  const afterReload = await instance.tool.nla_task.execute({ role: 'architect', description: 'preserve operator context', prompt: 'bounded task', context_window: '100000' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(afterReload.metadata.model, 'fixture/c', 'inventory refresh must preserve operator context overrides');
  await instance.tool.nla_model_policy.execute({ role: 'architect', policy: 'local' }, { sessionID: 'primary_select', directory: root });
  const callsBeforeLocal = selectedCalls.length;
  const childrenBeforeLocal = selectedChild;
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'production migration', prompt: 'must not leave local infrastructure' }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal }), /No available local Ollama model.*cloud fallback is disabled/);
  assert.equal(selectedCalls.length, callsBeforeLocal, 'local policy never dispatches a cloud request');
  assert.equal(selectedChild, childrenBeforeLocal, 'local policy fails before creating a child session');
  await instance.tool.nla_model_policy.execute({ role: 'architect', policy: 'balanced' }, { sessionID: 'primary_select', directory: root });
  assert.equal((await instance.tool.nla_models.execute({}, { sessionID: 'primary_select', directory: root })).metadata.roles.find((row) => row.role === 'architect').selection_policy, 'balanced');
  const beforeInvalidReviewTarget = evaluationStore();
  const callsBeforeInvalidReviewTarget = selectedCalls.length;
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'invalid review target role', prompt: 'must not dispatch', review_target_session_id: selected.metadata.sessionID }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal }), /review_target_session_id/);
  assert.equal(selectedCalls.length, callsBeforeInvalidReviewTarget, 'non-reviewer review target is rejected before model dispatch');
  assert.deepEqual(evaluationStore(), beforeInvalidReviewTarget, 'invalid review target role does not mutate evaluation state');
  const blankTask = {
    role: 'explorer', description: 'Repository discovery', prompt: 'Read-only inspect repository files',
    selection_weights: '', context_window: '  ', selection_policy: '', minimum_score: '',
    review_target_session_id: '', browser_task_id: '', browser: '',
  };
  const beforeBlankCalls = selectedCalls.length;
  const blankResult = await instance.tool.nla_task.execute(blankTask, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(selectedCalls.length, beforeBlankCalls + 1, 'blank optional fields reach a real child dispatch');
  assert.equal(blankResult.metadata.model, 'fixture/b', 'Explorer auto selection ranks the inventory after normalization');
  assert.equal(blankTask.review_target_session_id, '', 'normalization must not mutate caller-owned arguments');
  const dispatchesBeforeRejection = selectedCalls.length;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(instance.tool.nla_task.execute({ ...blankTask, description: `changed title ${attempt}`, prompt: `changed private packet ${attempt}`, review_target_session_id: 'real-session-id' }, { sessionID: 'primary_select', directory: root }), (error) => {
      assert.equal(error.code, 'NLA_TASK_ARGUMENTS_INVALID');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(abortedSessions.length, 0, 'argument errors never stop the coordinator');
  }
  assert.equal(selectedCalls.length, dispatchesBeforeRejection, 'invalid Reviewer ID never dispatches an Explorer model');
  const repaired = await instance.tool.nla_task.execute({ ...blankTask, review_target_session_id: 'real-session-id' }, { sessionID: 'primary_select', directory: root });
  assert.equal(repaired.metadata.role, 'explorer');
  assert.deepEqual(selectedCalls.slice(-2).map(call => call.agent), ['supervisor', 'explorer'], 'coordinator-backed Supervisor approves repair before Explorer dispatch');
  assert.equal(selectedCalls.at(-2).model.modelID, 'b', 'repair uses the observed coordinator, not Supervisor pool ranking');
  assert.equal(abortedSessions.length, 0);
  const rejectionEvents = fs.readFileSync(path.join(root, '.opencode', 'agent-run.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.event === 'task_arguments_rejected');
  assert.deepEqual(rejectionEvents.slice(-3).map((entry) => entry.failure_count), [1, 2, 3]);
  assert.ok(!JSON.stringify(rejectionEvents).includes('real-session-id') && !JSON.stringify(rejectionEvents).includes('private packet'), 'validation telemetry excludes parameter values and task content');
  const recovered = await instance.tool.nla_task.execute(blankTask, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal });
  assert.equal(recovered.metadata.model, 'fixture/b', 'corrected arguments recover without restart or health reset');
  await assert.rejects(instance.tool.nla_task.execute({ ...blankTask, review_target_session_id: 'real-session-id' }, { sessionID: 'primary_select', directory: root }), (error) => error.code === 'NLA_TASK_ARGUMENTS_INVALID');
  assert.equal(abortedSessions.length, 0, 'a valid call resets the rejection counter');
  await instance['chat.message']({ sessionID: 'other_primary', agent: 'nla', directory: root, model: { providerID: 'fixture', modelID: 'b' } });
  await assert.rejects(instance.tool.nla_task.execute({ ...blankTask, review_target_session_id: 'real-session-id' }, { sessionID: 'other_primary', directory: root }), (error) => error.code === 'NLA_TASK_ARGUMENTS_INVALID');
  assert.equal(abortedSessions.length, 0, 'validation counters are isolated between sessions');
  const beforeBrowserReject = selectedCalls.length;
  const beforeRejectedScores = evaluationStore();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(instance.tool.nla_task.execute({ ...blankTask, browser_task_id: 'owned-browser-task' }, { sessionID: 'other_primary', directory: root }), (error) => error.reason === 'browser_arguments_role_mismatch');
  }
  assert.equal(selectedCalls.length, beforeBrowserReject, 'nonempty Browser fields cannot dispatch another role');
  assert.deepEqual(evaluationStore(), beforeRejectedScores, 'local argument failures never penalize model scores');
  const stopEvents = fs.readFileSync(path.join(root, '.opencode', 'agent-run.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.event.startsWith('task_argument_loop_'));
  assert.equal(stopEvents.length, 0, 'no session stop is requested for argument failures');
  repairAction = 'blocked';
  const beforeDeclined = selectedCalls.length;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(instance.tool.nla_task.execute({ ...blankTask, review_target_session_id: 'real-session-id' }, { sessionID: 'other_primary', directory: root }), /NLA_TASK_ARGUMENTS_INVALID/);
  }
  assert.equal(selectedCalls.length, beforeDeclined + 1, 'a declined repair is attempted once, not on every repeated call');
  assert.equal(abortedSessions.length, 0, 'declined recovery leaves the session usable for corrected work');
  await instance.dispose();
  instance = null;

  const failoverCalls = [];
  instance = await NextLevelAgentPlugin({
    directory: root,
    client: {
      session: {
        abort: async () => ({ data: true }),
        promptAsync: async (request) => {
          failoverCalls.push(`${request.body.model.providerID}/${request.body.model.modelID}`);
          return {};
        },
      },
    },
  });
  await instance['chat.message']({ sessionID: 'primary_event', agent: 'nla', directory: root });
  assert.equal((await instance.tool.nla_models.execute({}, { sessionID: 'primary_event', directory: root })).metadata.roles.find((row) => row.role === 'architect').selection_policy, 'balanced', 'restart retains restored policy');
  await instance['tool.execute.before']({ tool: 'task', sessionID: 'primary_event' }, { args: { subagent_type: 'architect' } });
  await instance.event({ event: { type: 'session.created', properties: { info: { id: 'child_event', parentID: 'primary_event', model: { providerID: 'fixture', modelID: 'a' } } } } });
  await instance.event({ event: { type: 'session.error', properties: { sessionID: 'child_event', error: { status: 429, message: 'rate limit' } } } });
  await tick();
  await tick();
  assert.deepEqual(failoverCalls, ['fixture/b'], 'event-driven select failover ranks remaining candidates');
  await instance.tool.nla_model_health_reset.execute({ binding: 'fixture/a' }, { sessionID: 'primary_event', directory: root, abort: new AbortController().signal });
  await instance.event({ event: { type: 'session.error', properties: { sessionID: 'child_event', error: { status: 429, message: 'rate limit' } } } });
  await tick();
  await tick();
  await instance.event({ event: { type: 'session.error', properties: { sessionID: 'child_event', error: { status: 429, message: 'rate limit' } } } });
  await tick();
  await tick();
  assert.deepEqual(failoverCalls, ['fixture/b', 'fixture/c'], 'event-driven failover does not retry an earlier model after it recovers');
  await instance.event({ event: { type: 'session.idle', properties: { sessionID: 'child_event' } } });
  await instance.dispose();
  instance = null;

  let createCount = 0;
  instance = await NextLevelAgentPlugin({
    directory: root,
    client: {
      tool: { list: async () => ({ data: ['read', 'grep', 'edit', 'write', 'apply_patch', 'bash'].map((id) => ({ id, parameters: { type: 'object' } })) }) },
      session: {
        create: async () => ({ data: { id: `child_review_${++createCount}` } }),
        prompt: async (request) => ({ data: { parts: [{ type: 'text', text: request.body.agent === 'reviewer' ? (request.body.parts.some((part) => part.text.includes('malformed')) ? 'not JSON' : JSON.stringify({ verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 } })) : 'implementation complete' }] } }),
        abort: async () => ({ data: true }),
      },
    },
  });
  await instance['chat.message']({ sessionID: 'primary_review', agent: 'nla', directory: root });
  const unscoredReview = await instance.tool.nla_task.execute({ role: 'reviewer', description: 'review without scoring target', prompt: 'review fixture', review_target_session_id: ' \t ' }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  assert.equal(unscoredReview.metadata.model, 'fixture/reviewer', 'blank review target means ordinary review without score attribution');
  const implementation = await instance.tool.nla_task.execute({ role: 'implementer', description: 'implementation fixture', prompt: 'bounded implementation' }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  const targetID = implementation.metadata.sessionID;
  await instance.tool.nla_task.execute({ role: 'reviewer', description: 'review fixture', prompt: 'return strict review JSON', review_target_session_id: targetID }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  const reviewed = evaluationStore();
  assert.deepEqual({ coding: reviewed.models['fixture/impl'].scores.coding, reasoning: reviewed.models['fixture/impl'].scores.reasoning, tool_use: reviewed.models['fixture/impl'].scores.tool_use }, { coding: 8, reasoning: 7, tool_use: 9 }, 'review scores are attributed to the exact Implementer model');
  assert.deepEqual({ coding: reviewed.models['fixture/reviewer'].scores.coding, reasoning: reviewed.models['fixture/reviewer'].scores.reasoning, tool_use: reviewed.models['fixture/reviewer'].scores.tool_use }, { coding: 0, reasoning: 0, tool_use: 0 }, 'reviewer model does not receive Implementer review scores');

  const unchangedTargetScores = { ...reviewed.models['fixture/impl'].scores };
  await instance.tool.nla_task.execute({ role: 'reviewer', description: 'missing target fixture', prompt: 'not JSON', review_target_session_id: 'missing-session' }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  const afterMissing = evaluationStore();
  assert.deepEqual(afterMissing.models['fixture/impl'].scores, unchangedTargetScores, 'missing review target does not mutate target evaluation');

  const secondImplementation = await instance.tool.nla_task.execute({ role: 'implementer', description: 'second implementation fixture', prompt: 'bounded implementation' }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  const beforeMalformed = evaluationStore().models['fixture/impl'].scores;
  await instance.tool.nla_task.execute({ role: 'reviewer', description: 'malformed review fixture', prompt: 'return malformed review JSON', review_target_session_id: secondImplementation.metadata.sessionID }, { sessionID: 'primary_review', directory: root, abort: new AbortController().signal });
  assert.deepEqual(evaluationStore().models['fixture/impl'].scores, beforeMalformed, 'malformed reviewer output does not mutate target evaluation');
  await instance.dispose();
  instance = null;

  const beforeCallerAbort = evaluationStore();
  instance = await NextLevelAgentPlugin({ directory: root, client: { session: {
    create: async () => ({ data: { id: 'child_caller_abort' } }),
    prompt: async () => { throw new Error('caller cancelled'); },
    abort: async () => ({ data: true }),
  } } });
  await instance['chat.message']({ sessionID: 'primary_caller_abort', agent: 'nla', directory: root });
  for (const binding of ['fixture/a', 'fixture/b', 'fixture/c']) await instance.tool.nla_model_health_reset.execute({ binding }, { sessionID: 'primary_caller_abort', directory: root });
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'caller abort fixture', prompt: 'bounded task' }, { sessionID: 'primary_caller_abort', directory: root, abort: new AbortController().signal }), /failed/);
  assert.deepEqual(evaluationStore(), beforeCallerAbort, 'caller abort does not record reliability failure');
  await instance.dispose();
  instance = null;

  const beforeAuthFailure = evaluationStore();
  instance = await NextLevelAgentPlugin({ directory: root, client: { session: {
    create: async () => ({ data: { id: 'child_auth_failure' } }),
    prompt: async () => { throw new Error('401 unauthorized'); },
    abort: async () => ({ data: true }),
  } } });
  await instance['chat.message']({ sessionID: 'primary_auth_failure', agent: 'nla', directory: root });
  for (const binding of ['fixture/a', 'fixture/b', 'fixture/c']) await instance.tool.nla_model_health_reset.execute({ binding }, { sessionID: 'primary_auth_failure', directory: root });
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'auth failure fixture', prompt: 'bounded task' }, { sessionID: 'primary_auth_failure', directory: root, abort: new AbortController().signal }), /failed/);
  assert.deepEqual(evaluationStore(), beforeAuthFailure, 'provider authorization failure does not record reliability failure');
  await instance.dispose();
  instance = null;

  const beforeProtocolFailure = evaluationStore();
  instance = await NextLevelAgentPlugin({ directory: root, client: { session: {
    create: async () => ({ data: { id: 'child_protocol_failure' } }),
    prompt: async () => { throw Object.assign(new Error('no user query found in messages'), { data: { statusCode: 500, message: 'no user query found in messages' } }); },
    abort: async () => ({ data: true }),
  } } });
  await instance['chat.message']({ sessionID: 'primary_protocol_failure', agent: 'nla', directory: root });
  for (const binding of ['fixture/a', 'fixture/b', 'fixture/c']) await instance.tool.nla_model_health_reset.execute({ binding }, { sessionID: 'primary_protocol_failure', directory: root });
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'protocol failure fixture', prompt: 'bounded task' }, { sessionID: 'primary_protocol_failure', directory: root, abort: new AbortController().signal }), /failed/);
  assert.deepEqual(evaluationStore(), beforeProtocolFailure, 'deterministic message-validation failure does not record model reliability');
  await instance.dispose();
  instance = null;

  // A fixed pool can use the observed coordinator as a final reserve, without
  // changing the delegated role, prompt or tool permissions.
  for (const scenario of ['success', 'unknown', 'disabled', 'local', 'free', 'context', 'reserve-fails', 'preparation']) {
    process.env.NLA_MEMORY_DIR = path.join(root, `reserve-${scenario}`);
    const calls = [];
    instance = await NextLevelAgentPlugin({ directory: root, client: {
      config: { providers: async () => ({ data: { providers: [{ id: 'fixture', models: Object.fromEntries(['a', 'b', 'c', 'coding', 'reasoning', 'impl', 'reviewer'].map(id => [id, { limit: { context: 131072 } }])) }] } }) },
      tool: { list: async () => {
        if (scenario === 'preparation') throw new Error('local tool catalog unavailable');
        return { data: ['read', 'grep', 'glob', 'webfetch'].map(id => ({ id, parameters: { type: 'object' } })) };
      } },
      session: {
        create: async () => ({ data: { id: `reserve-child-${scenario}` } }),
        abort: async () => ({ data: true }),
        prompt: async request => {
          calls.push(request.body);
          if (request.body.model.modelID !== 'b' || scenario === 'reserve-fails') throw new Error(scenario === 'unknown' ? 'unclassified model protocol failure' : '503 service unavailable');
          return { data: { parts: [{ type: 'text', text: 'reserve success' }] } };
        },
      },
    } });
    const context = { sessionID: `reserve-primary-${scenario}`, directory: root, abort: new AbortController().signal };
    await instance['chat.message']({ ...context, agent: 'nla', model: { providerID: 'fixture', modelID: 'b' } });
    if (scenario === 'disabled') await instance.tool.nla_models_registry.execute({ action: 'status_set', binding: 'fixture/b', status: 'off' }, context);
    if (scenario === 'free') {
      await instance.tool.nla_models_registry.execute({ action: 'import', json: JSON.stringify({ models: { 'fixture/b': { facts: { input_cost: 1, output_cost: 1, context_window: 131072 } } } }) }, context);
      await instance.tool.nla_model_policy.execute({ role: 'explorer', policy: 'free' }, context);
      const blockedTask = { role: 'explorer', description: 'Free-only task', prompt: 'Read a file' };
      await assert.rejects(instance.tool.nla_task.execute(blockedTask, context), error => error.code === 'NLA_FREE_MODEL_UNAVAILABLE');
      for (let i = 0; i < 3; i++) await assert.rejects(instance.tool.nla_task.execute({ ...blockedTask, review_target_session_id: 'wrong-role-target' }, context));
      assert.equal(calls.length, 0, 'neither empty free pool nor argument repair can invoke the paid coordinator');
      await instance.tool.nla_models_registry.execute({ action: 'import', json: JSON.stringify({ models: { 'fixture/a': { facts: { input_cost: 0, output_cost: 0, context_window: 131072 } } } }) }, context);
      await assert.rejects(instance.tool.nla_task.execute(blockedTask, context));
      assert.deepEqual(calls.map(call => call.model.modelID), ['a'], 'failed free candidate cannot escalate to the paid coordinator');
      await instance.dispose();
      instance = null;
      continue;
    }
    if (scenario === 'context') await instance.tool.nla_models_registry.execute({ action: 'import', json: JSON.stringify({ models: { 'fixture/b': { facts: { context_window: 1024 } } } }) }, context);
    const args = { role: 'scout', description: 'Inspect a file', prompt: 'Read README only; make no changes.', ...(scenario === 'local' ? { selection_policy: 'local' } : {}), ...(scenario === 'context' ? { context_window: '20000' } : {}) };
    if (['success', 'unknown'].includes(scenario)) {
      const result = await instance.tool.nla_task.execute(args, context);
      assert.equal(result.metadata.model, 'fixture/b');
      assert.equal(result.metadata.coordinator_fallback, true);
      assert.deepEqual(calls.map(call => call.model.modelID), ['a', 'b']);
      assert.ok(calls.every(call => call.agent === 'scout' && call.parts[0].text === args.prompt));
      assert.deepEqual(calls[1].tools, calls[0].tools, 'reserve retains role tool boundaries');
    } else {
      await assert.rejects(instance.tool.nla_task.execute(args, context));
      assert.equal(calls.filter(call => call.model.modelID === 'b').length, scenario === 'reserve-fails' ? 1 : 0);
      if (scenario === 'preparation') assert.equal(calls.length, 0);
    }
    await instance.dispose();
    instance = null;
  }
} finally {
  await instance?.dispose();
  if (oldPool === undefined) delete process.env.NLA_MODEL_POOLS_PATH; else process.env.NLA_MODEL_POOLS_PATH = oldPool;
  if (oldMemory === undefined) delete process.env.NLA_MEMORY_DIR; else process.env.NLA_MEMORY_DIR = oldMemory;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('NLA select integration and event-driven failover tests passed');
