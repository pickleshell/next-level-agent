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
    architect: {
      enabled: true,
      selection_mode: 'select',
      models: ['fixture/a', 'fixture/b', 'fixture/c'],
      idle_timeout_ms: 0,
    },
    router: { enabled: true, selection_mode: 'select', models: ['fixture/coding', 'fixture/reasoning'], idle_timeout_ms: 0 },
    implementer: { enabled: true, selection_mode: 'select', models: ['fixture/impl'], idle_timeout_ms: 0 },
    reviewer: { enabled: true, selection_mode: 'select', models: ['fixture/reviewer'], idle_timeout_ms: 0 },
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
  instance = await NextLevelAgentPlugin({
    directory: root,
    client: {
      config: { providers: async () => {
        inventoryCalls++;
        return { data: { providers: [{ id: 'fixture', models: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { limit: { context: 131072 } }])) }] } };
      } },
      session: {
        create: async () => ({ data: { id: `child_select_${++selectedChild}` } }),
        prompt: async (request) => {
          selectedCalls.push({ agent: request.body.agent, model: request.body.model });
          return { data: { parts: [{ type: 'text', text: 'selected result' }] } };
        },
        abort: async () => ({ data: true }),
      },
    },
  });
  assert.equal(inventoryCalls, 0, 'provider discovery must not run during plugin initialization');
  await instance['chat.message']({ sessionID: 'primary_select', agent: 'nla', directory: root });
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
  const beforeInvalidReviewTarget = evaluationStore();
  const callsBeforeInvalidReviewTarget = selectedCalls.length;
  await assert.rejects(instance.tool.nla_task.execute({ role: 'architect', description: 'invalid review target role', prompt: 'must not dispatch', review_target_session_id: selected.metadata.sessionID }, { sessionID: 'primary_select', directory: root, abort: new AbortController().signal }), /review_target_session_id/);
  assert.equal(selectedCalls.length, callsBeforeInvalidReviewTarget, 'non-reviewer review target is rejected before model dispatch');
  assert.deepEqual(evaluationStore(), beforeInvalidReviewTarget, 'invalid review target role does not mutate evaluation state');
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
} finally {
  await instance?.dispose();
  if (oldPool === undefined) delete process.env.NLA_MODEL_POOLS_PATH; else process.env.NLA_MODEL_POOLS_PATH = oldPool;
  if (oldMemory === undefined) delete process.env.NLA_MEMORY_DIR; else process.env.NLA_MEMORY_DIR = oldMemory;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('NLA select integration and event-driven failover tests passed');
