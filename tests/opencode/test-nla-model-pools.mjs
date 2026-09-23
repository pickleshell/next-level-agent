import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelPoolSummary, preflightModelPools, validateModelPools } from '../../.opencode/plugins/nla-model-pools.mjs';
import { ModelHealthManager, classifyProviderError, retryAfterMs } from '../../.opencode/plugins/nla-model-health.mjs';
import { runUtilityModel, utilityHealthEndpoint } from '../../.opencode/plugins/nla-utility-runtime.mjs';
import { NextLevelAgentPlugin, availablePoolModels, effectiveModelPools, formatModelPools, modelCooldownMs, modelPoolsPath, retryableProviderError } from '../../.opencode/plugins/next-level-agent.js';

const defaultPath = path.resolve('config/model-pools.json');
const defaultOpenCodeConfig = JSON.parse(fs.readFileSync('opencode.json', 'utf8'));
const original = process.env.NLA_MODEL_POOLS_PATH;
try {
  delete process.env.NLA_MODEL_POOLS_PATH;
  const resolved = effectiveModelPools();
  assert.equal(resolved.source, defaultPath);
  assert.equal(resolved.resolution, 'repository/package default');
  assert.ok(Object.values(resolved.roles).every((pool) => !pool.models.some((model) => model.startsWith('ollama/'))), 'production pools do not assign local Ollama models');
  assert.ok(Object.values(resolved.roles).every((pool) => pool.models.every((model) => model.startsWith('opencode-go/'))), 'production default contains only OpenCode Go bindings');
  for (const [role, pool] of Object.entries(resolved.roles)) {
    const nativeRole = defaultOpenCodeConfig.agent[role];
    assert.ok(nativeRole, `default OpenCode config defines ${role}`);
    assert.equal(nativeRole.model, pool.models[0], `default OpenCode ${role} model matches its pool primary`);
  }
  for (const role of ['build', 'plan']) assert.equal(defaultOpenCodeConfig.agent[role].model, 'opencode-go/gpt-5.6-luna', `${role} stays inside the ready-to-use OpenCode Go profile`);
  assert.ok(Object.values(resolved.roles).every((pool) => ['fallback', 'select'].includes(pool.selection_mode)), 'every production role declares its pool mode');
  for (const role of ['architect', 'explorer', 'implementer', 'reviewer']) assert.equal(resolved.roles[role].selection_mode, 'select', `${role} uses adaptive selection by default`);
  const seededModels = Object.keys(JSON.parse(fs.readFileSync('config/model-evaluations.json', 'utf8')).models).sort();
  assert.deepEqual([...resolved.roles.implementer.models].sort(), seededModels, 'production Implementer pool is fully covered by initial evaluations');
  assert.ok(resolved.roles.explorer.model_facts['opencode-go/gpt-5.6-luna'], 'static model facts are shared across role pools');
  for (const role of ['explorer', 'reviewer']) {
    assert.equal(resolved.roles[role].selection_mode, 'select', `${role} production example uses adaptive selection`);
    assert.ok(resolved.roles[role].models.length >= 3 && resolved.roles[role].models.length <= 5, `${role} keeps a bounded specialized pool`);
    assert.ok(resolved.roles[role].models.every((model) => model.startsWith('opencode-go/')), `${role} example contains only OpenCode Go bindings`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-pool-test-'));
  try {
    const override = path.join(tempDir, 'pools.json');
    fs.writeFileSync(override, JSON.stringify({ roles: { explorer: { enabled: true, models: ['fixture/primary', 'fixture/fallback'] } } }));
    process.env.NLA_MODEL_POOLS_PATH = override;
    const overridden = effectiveModelPools();
    assert.equal(overridden.source, override);
    assert.equal(overridden.resolution, 'NLA_MODEL_POOLS_PATH');
    assert.deepEqual(overridden.roles.explorer.models, ['fixture/primary', 'fixture/fallback']);
    assert.match(formatModelPools(overridden), /fixture\/primary.*fixture\/fallback/s);
    const explicit = path.join(tempDir, 'explicit.json');
    fs.writeFileSync(explicit, JSON.stringify({ roles: { explorer: { models: ['fixture/explicit'] } } }));
    assert.deepEqual(effectiveModelPools({ explicitPath: explicit }).roles.explorer.models, ['fixture/explicit']);
    process.env.NLA_MODEL_POOLS_PATH = path.join(tempDir, 'missing.json');
    assert.throws(() => effectiveModelPools(), /Could not load model pools/);
    const provider = 'fixture';
    const repeatedProviderBinding = [provider, provider, 'model'].join('/');
    assert.throws(
      () => validateModelPools({ roles: { explorer: { enabled: true, models: [repeatedProviderBinding] } } }),
      /must not repeat its provider prefix/,
    );
    assert.throws(
      () => validateModelPools({ roles: { explorer: { enabled: true, models: ['fixture/model', 'fixture/model'] } } }),
      /repeats model binding/,
    );
    const preflightPool = { roles: { explorer: { enabled: true, models: ['provider-a/model-x'] } } };
    assert.throws(
      () => preflightModelPools(preflightPool, ['provider-b/model-x']),
      /absent from supplied runtime inventory: explorer:provider-a\/model-x/,
      'availability is exact and never guessed from a similarly named model',
    );
    assert.deepEqual(preflightModelPools(preflightPool, ['provider-a/model-x']), { roles: 1, checkedAvailability: true });
    preflightPool.roles.explorer.model_facts = { 'provider-a/model-x': { status: 'disabled' } };
    assert.deepEqual(preflightModelPools(preflightPool, []), { roles: 1, checkedAvailability: true }, 'disabled binding needs no live runtime inventory entry');
  } finally { fs.rmSync(tempDir, { recursive: true }); }
} finally {
  if (original === undefined) delete process.env.NLA_MODEL_POOLS_PATH;
  else process.env.NLA_MODEL_POOLS_PATH = original;
}
process.env.NLA_MODEL_POOLS_PATH = '~/machine-local/model-pools.json';
assert.equal(modelPoolsPath('/tmp/nla-home'), '/tmp/nla-home/machine-local/model-pools.json');
if (original === undefined) delete process.env.NLA_MODEL_POOLS_PATH;
else process.env.NLA_MODEL_POOLS_PATH = original;
assert.equal(retryableProviderError(new Error('Unexpected server error')), true);
assert.equal(retryableProviderError(new Error('permission denied')), false);
const health = new Map([['provider/down', { until: 2_000, reason: '502 overloaded' }]]);
assert.deepEqual(availablePoolModels(['provider/down', 'provider/backup'], 2, health, 1_000), ['provider/backup']);
assert.deepEqual(availablePoolModels(['provider/down'], 1, health, 1_000), []);
assert.deepEqual(availablePoolModels({ client: {}, project: {}, directory: '/tmp' }), [], 'OpenCode export probing must not crash on runtime context');
assert.equal(modelCooldownMs({ cooldown_ms: 1234 }, {}), 1234);
console.log('NLA model-pool resolution, introspection, and retry tests passed');
assert.deepEqual(modelPoolSummary({ client: {}, project: {} }), []);
assert.equal(formatModelPools({ client: {}, project: {} }), '');
assert.equal(modelPoolSummary({ roles: { explorer: { models: ['fixture/model'] } } })[0].enabled, false);
assert.equal(modelPoolSummary({ roles: { explorer: { enabled: true, models: ['fixture/model'] } } })[0].enabled, true);
const coordinatorSummary = modelPoolSummary({ roles: { nla: { enabled: false, models: ['fixture/coordinator'] } } })[0];
assert.equal(coordinatorSummary.enabled, null);
assert.equal(coordinatorSummary.pooled, false);
assert.equal(coordinatorSummary.status, 'orchestrator');
assert.match(formatModelPools({ roles: { nla: { enabled: false, models: ['fixture/coordinator'] } } }), /nla.*orchestrator/s);
assert.equal(classifyProviderError(new Error('Rate limit exceeded. Please try again later.')).category, 'transient');
assert.deepEqual(
  classifyProviderError({ data: { statusCode: 500, message: 'no user query found in messages' } }),
  { category: 'defective', reason: 'provider_message_validation_failed', retryAfterMs: 0 },
  'deterministic Ollama message validation failures must bypass transient retry/cooldown handling',
);
assert.equal(classifyProviderError({ data: { statusCode: 410 }, message: 'gone' }).category, 'defective');
const clock = { value: 1000 };
const healthManager = new ModelHealthManager({ now: () => clock.value });
healthManager.failure('p/a', new Error('429 rate limit'));
assert.deepEqual(healthManager.candidates(['p/a', 'p/b'], 2).models, ['p/b']);
assert.equal(healthManager.candidates(['p/a'], 1).models.length, 0);
healthManager.failure('p/b', new Error('model not found'));
assert.equal(healthManager.candidates(['p/b'], 1).allQuarantined, true);
healthManager.reset('p/b');
assert.equal(healthManager.candidates(['p/b'], 1).models[0], 'p/b');

assert.equal(classifyProviderError(new Error('caller cancelled request after timeout')).category, 'non_provider');
assert.equal(classifyProviderError({ status: 404, message: 'model endpoint missing' }).category, 'configuration');
assert.equal(classifyProviderError({ status: 404, message: 'model missing' }).category, 'defective');
assert.equal(classifyProviderError(new Error('HTTP 401')).category, 'configuration');
assert.equal(retryAfterMs('60', 1000), 60000);
assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 119000);
assert.equal(retryAfterMs('-1', 1000), null);
assert.equal(retryAfterMs('invalid', 1000), null);
assert.equal(modelCooldownMs({ cooldown_ms: 0 }, { NLA_MODEL_COOLDOWN_MS: '99' }), 0);
assert.equal(modelCooldownMs({}, { NLA_MODEL_COOLDOWN_MS: '99' }), 99);
clock.value = 31000;
assert.equal(healthManager.claim('p/a'), true);
assert.equal(healthManager.claim('p/a'), false, 'only one recovery probe');
assert.equal(healthManager.state('p/a').eligible, false);
assert.throws(() => healthManager.reset('p/a'), /in-flight/);
healthManager.failure('p/a', new Error('caller cancelled after timeout'));
assert.equal(healthManager.claim('p/a'), true, 'cancel releases probe without poisoning');
healthManager.failure('p/a', { status: 429, retryAfter: 'Thu, 01 Jan 1970 00:02:00 GMT' }, '', 10);
assert.equal(healthManager.state('p/a').until, 120000);
clock.value = 120000;
assert.equal(healthManager.claim('p/a'), true);
healthManager.success('p/a');
assert.equal(healthManager.state('p/a').state, 'available');

const utilityPool = { runtime: 'utility', backend: 'ollama', provider: { api: 'native', base_url: 'http://example.test/a?token=SECRET' }, models: ['one', 'two', 'three'], request_timeout_ms: 1000, cooldown_ms: 77 };
const endpoint = utilityHealthEndpoint(utilityPool);
assert.notEqual(endpoint, utilityHealthEndpoint({ ...utilityPool, provider: { ...utilityPool.provider, base_url: 'http://example.test/b?token=SECRET' } }));
assert.ok(!endpoint.includes('SECRET'));
const utilityHealth = new ModelHealthManager({ now: () => 1000 });
utilityHealth.failure('one', new Error('rate limit'), endpoint);
const calls = [];
const utilityResult = await runUtilityModel({ role: 'compactor', pool: utilityPool, prompt: 'test', healthManager: utilityHealth, fetchImpl: async (_url, options) => {
  const model = JSON.parse(options.body).model;
  calls.push(model);
  if (model === 'two') return new Response('rate limit token=SECRET', { status: 429, headers: { 'retry-after': '60' } });
  return new Response(JSON.stringify({ message: { content: 'ok' } }));
} });
assert.deepEqual(calls, ['two', 'three'], 'skips do not consume attempts');
assert.equal(utilityResult.output, 'ok');
assert.equal(utilityHealth.state('two', endpoint).until, 61000);
await assert.rejects(runUtilityModel({ role: 'compactor', pool: { ...utilityPool, models: ['two'] }, prompt: 'test', healthManager: utilityHealth, fetchImpl: () => { throw new Error('must not call'); } }), /0 model attempts/);
const secretHealth = new ModelHealthManager();
await assert.rejects(runUtilityModel({ role: 'compactor', pool: { ...utilityPool, models: ['one'] }, prompt: 'test', healthManager: secretHealth, fetchImpl: async () => new Response('token=SECRET unauthorized', { status: 401 }) }), (error) => !error.message.includes('SECRET'));
assert.ok(!JSON.stringify(secretHealth.snapshot()).includes('SECRET'));
console.log('NLA health recovery, Retry-After, scoped bindings, budget and secret regressions passed');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-health-plugin-'));
const savedEnv = { pool: process.env.NLA_MODEL_POOLS_PATH, memory: process.env.NLA_MEMORY_DIR };
let plugin;
try {
    const fixturePool = path.join(fixture, 'pools.json');
    fs.writeFileSync(fixturePool, JSON.stringify({ roles: { architect: { enabled: true, selection_mode: 'select', models: ['fixture/a', 'fixture/b', 'fixture/c'], cooldown_ms: 123456, idle_timeout_ms: 0 }, router: { enabled: true, selection_mode: 'fallback', models: ['fixture/a', 'fixture/b', 'fixture/c'], idle_timeout_ms: 0 } } }));
  process.env.NLA_MODEL_POOLS_PATH = fixturePool;
  process.env.NLA_MEMORY_DIR = path.join(fixture, 'memory');
  const actual = [];
  const continued = [];
  let serial = 0;
  plugin = await NextLevelAgentPlugin({ directory: fixture, client: { session: {
    create: async () => ({ data: { id: `child-${++serial}` } }),
    abort: async () => {},
    prompt: async (request) => {
      const model = request.body.model.modelID;
      actual.push(model);
      if (model !== 'c') return { data: { info: { error: { name: 'APIError', data: { statusCode: 429, message: 'rate limit token=SECRET' } } } } };
      return { data: { parts: [{ type: 'text', text: 'done' }] } };
    },
    promptAsync: async (request) => { continued.push(request.body.model.modelID); },
  } } });
  await plugin['chat.message']({ sessionID: 'primary_123', agent: 'nla', directory: fixture });
  await assert.rejects(
    plugin['tool.execute.before']({ tool: 'bash', sessionID: 'primary_123' }, { args: { command: 'env' } }),
    error => error.code === 'NLA_SHELL_POLICY_BLOCKED',
  );
  await assert.rejects(
    plugin['tool.execute.before']({ tool: 'bash', sessionID: 'primary_123' }, { args: { command: 'sudo -n id' } }),
    error => error.code === 'NLA_SHELL_POLICY_BLOCKED',
  );
  await plugin['tool.execute.before']({ tool: 'bash', sessionID: 'primary_123' }, { args: { command: 'npm test -- --runInBand' } });
  const context = { sessionID: 'primary_123', directory: fixture, abort: new AbortController().signal };
  const result = await plugin.tool.nla_task.execute({ role: 'architect', description: 'fixture', prompt: 'do bounded task' }, context);
  assert.deepEqual(actual, ['a', 'b', 'c']);
  assert.equal(result.metadata.attempt, 3);
  const inspection = await plugin.tool.nla_models.execute({}, context);
  const changedPolicy = await plugin.tool.nla_model_policy.execute({ role: 'architect', policy: 'balanced', cost_weight: '0.4' }, context);
  assert.equal(changedPolicy.metadata.policy, 'balanced');
  assert.equal(changedPolicy.metadata.cost_weight, 0.4);
  assert.equal((await plugin.tool.nla_models.execute({}, context)).metadata.roles.find((item) => item.role === 'architect').selection_policy, 'balanced');
  await assert.rejects(plugin.tool.nla_model_policy.execute({ role: 'router', policy: 'cost' }, context), /uses fallback/);
  const cooling = inspection.metadata.health.find((item) => item.binding === 'fixture/a');
  assert.ok(cooling.until - cooling.since === 123456, 'pool cooldown used by routing manager');
  assert.equal(inspection.metadata.health.find((item) => item.binding === 'fixture/c').state, 'available');
  actual.length = 0;
  await plugin.tool.nla_models_registry.execute({ action: 'status_set', binding: 'fixture/c', status: 'disabled' }, context);
  await assert.rejects(plugin.tool.nla_task.execute({ role: 'router', description: 'disabled fallback', prompt: 'next' }, context), (error) => error.code === 'NLA_MODEL_POOL_UNAVAILABLE' && error.attempted === 0);
  assert.deepEqual(actual, [], 'fallback never dispatches an operator-disabled model');
  await plugin.tool.nla_models_registry.execute({ action: 'status_set', binding: 'fixture/c', status: 'enabled' }, context);
  await plugin.tool.nla_task.execute({ role: 'router', description: 'next', prompt: 'next' }, context);
  assert.deepEqual(actual, ['c'], 'health shared across roles');
  await assert.rejects(plugin.tool.nla_model_health_reset.execute({ binding: 'unknown/secret' }, context), /Unknown configured/);
  await assert.rejects(plugin.tool.nla_model_health_reset.execute({ binding: 'fixture/a' }, { ...context, sessionID: 'other' }), /primary/i);
  await plugin['tool.execute.before']({ tool: 'task', sessionID: 'primary_123' }, { args: { subagent_type: 'architect' } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'native', parentID: 'primary_123' } } } });
  await Promise.all([
    plugin.event({ event: { type: 'session.error', properties: { sessionID: 'native', error: new Error('rate limit token=SECRET') } } }),
    plugin.event({ event: { type: 'session.error', properties: { sessionID: 'native', error: new Error('rate limit duplicate event') } } }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(continued, ['c'], 'watchdog continuation skips shared cooling binding');
  assert.equal((await plugin.tool.nla_models.execute({}, context)).metadata.health.find((item) => item.binding === 'fixture/c').state, 'probe-in-flight');
  actual.length = 0;
  await assert.rejects(plugin.tool.nla_task.execute({ role: 'router', description: 'busy', prompt: 'busy' }, context), (error) => error.code === 'NLA_MODEL_POOL_UNAVAILABLE' && error.attempted === 0);
  assert.deepEqual(actual, [], 'no early probe when cooling or in-flight');
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'native' } } });
  assert.equal((await plugin.tool.nla_models.execute({}, context)).metadata.health.find((item) => item.binding === 'fixture/c').state, 'available');
  fs.writeFileSync(fixturePool, JSON.stringify({ roles: {
    architect: { enabled: true, models: ['fixture/reloaded'], idle_timeout_ms: 0 },
    router: { enabled: true, models: ['fixture/reloaded'], idle_timeout_ms: 0 },
  } }));
  const reloaded = await plugin.tool.nla_models_reload.execute({}, context);
  assert.deepEqual(reloaded.metadata.roles.find((item) => item.role === 'architect').fallbacks, []);
  assert.equal(reloaded.metadata.roles.find((item) => item.role === 'architect').primary, 'fixture/reloaded');
  assert.equal((await plugin.tool.nla_models.execute({}, context)).metadata.roles.find((item) => item.role === 'architect').primary, 'fixture/reloaded');
  fs.writeFileSync(fixturePool, JSON.stringify({ roles: { architect: { enabled: true, models: ['fixture/reloaded', 'fixture/reloaded'] } } }));
  await assert.rejects(plugin.tool.nla_models_reload.execute({}, context), /repeats model binding/);
  assert.equal((await plugin.tool.nla_models.execute({}, context)).metadata.roles.find((item) => item.role === 'architect').primary, 'fixture/reloaded', 'failed reload preserves current snapshot');
  assert.ok(!fs.readFileSync(path.join(fixture, '.opencode', 'agent-run.log'), 'utf8').includes('SECRET'));
} finally {
  if (plugin) await plugin.dispose();
  for (const [key, value] of [['NLA_MODEL_POOLS_PATH', savedEnv.pool], ['NLA_MEMORY_DIR', savedEnv.memory]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log('NLA task, introspection, primary reset and watchdog health integration passed');

// Exercise events delivered before promptAsync resolves, and real cancellation
// while prompt is pending. No provider or OpenCode service is contacted.
for (const mode of ['reject', 'response-error', 'early-idle', 'early-status-idle', 'early-error', 'cancel', 'cancel-reject-abort']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-lifecycle-'));
  const oldPool = process.env.NLA_MODEL_POOLS_PATH;
  const oldMemory = process.env.NLA_MEMORY_DIR;
  let instance;
  try {
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles: { architect: { enabled: true, models: ['p/a', 'p/b', 'p/c'], idle_timeout_ms: 0 } } }));
    const calls = [];
    let finish;
    let aborts = 0;
    const event = async (type, extra = {}) => instance.event({ event: { type, properties: { sessionID: 'native_123', ...extra } } });
    instance = await NextLevelAgentPlugin({ directory: dir, client: { session: {
      create: async () => ({ data: { id: 'child_123' } }),
      abort: async () => {
        aborts += 1;
        if (mode === 'cancel-reject-abort') throw new Error('abort transport failed');
        // Old-attempt terminal events must not complete the new attempt.
        await event('session.idle');
        await event('session.error', { error: new Error('old attempt cancelled') });
      },
      prompt: async () => new Promise((resolve) => { finish = resolve; }),
      promptAsync: async (request) => {
        const model = request.body.model.modelID;
        calls.push(model);
        if (model === 'b' && mode === 'reject') throw new Error('429 rate limit');
        if (model === 'b' && mode === 'response-error') return { error: { statusCode: 429, message: 'rate limit' } };
        if (model === 'b' && mode === 'early-error') {
          await event('session.error', { error: new Error('429 rate limit') });
          await event('session.idle');
        } else if (mode === 'early-status-idle') {
          await event('session.status', { status: { type: 'idle' } });
        } else {
          await event('session.idle');
        }
      },
    } } });
    await instance['chat.message']({ sessionID: 'primary_123', agent: 'nla', directory: dir });
    const controller = new AbortController();
    const ctx = { sessionID: 'primary_123', directory: dir, abort: controller.signal };
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    if (mode.startsWith('cancel')) {
      const task = instance.tool.nla_task.execute({ role: 'architect', description: 'cancel fixture', prompt: 'bounded task' }, ctx);
      const rejected = assert.rejects(task, /caller_or_application_error/);
      await tick();
      controller.abort();
      await rejected;
      await tick();
      assert.equal(aborts, 1);
      assert.equal((await instance.tool.nla_models.execute({}, ctx)).metadata.health[0].state, 'available');
      finish({ data: { parts: [{ type: 'text', text: 'late success' }] } });
      await tick();
      assert.ok(!fs.readFileSync(path.join(dir, '.opencode', 'agent-run.log'), 'utf8').includes('model_attempt_succeeded'));
    } else {
      await instance['tool.execute.before']({ tool: 'task', sessionID: 'primary_123' }, { args: { subagent_type: 'architect' } });
      await instance.event({ event: { type: 'session.created', properties: { info: { id: 'native_123', parentID: 'primary_123' } } } });
      await event('session.error', { error: new Error('429 rate limit') });
      await tick();
      await tick();
      assert.deepEqual(calls, ['reject', 'response-error', 'early-error'].includes(mode) ? ['b', 'c'] : ['b'], mode);
      const health = (await instance.tool.nla_models.execute({}, ctx)).metadata.health;
      assert.ok(health.every((entry) => entry.state !== 'probe-in-flight'), `${mode}: no leaked claim`);
      assert.equal(health.find((entry) => entry.binding === `p/${calls.at(-1)}`).state, 'available');
      if (calls.length === 2) assert.equal(health.find((entry) => entry.binding === 'p/b').state, 'cooling');
    }
  } finally {
    await instance?.dispose();
    for (const [key, value] of [['NLA_MODEL_POOLS_PATH', oldPool], ['NLA_MEMORY_DIR', oldMemory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('NLA switching event races, third fallback and active cancellation regressions passed');

for (const outcome of ['reject', 'error-result', 'false-result', 'confirmed']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-stop-check-'));
  const oldPool = process.env.NLA_MODEL_POOLS_PATH;
  const oldMemory = process.env.NLA_MEMORY_DIR;
  let instance;
  try {
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles: { architect: { enabled: true, models: ['p/a', 'p/b'], idle_timeout_ms: 5 } } }));
    const calls = [];
    let stopped = false;
    let releaseStop;
    let stopStarted;
    const stopping = new Promise((resolve) => { stopStarted = resolve; });
    instance = await NextLevelAgentPlugin({ directory: dir, client: { session: {
      create: async () => ({ data: { id: 'child_123' } }),
      abort: async (request) => {
        assert.equal(request.throwOnError, true);
        stopStarted();
        await new Promise((resolve) => { releaseStop = resolve; });
        if (outcome === 'reject') throw new Error('stop transport failed');
        if (outcome === 'error-result') return { error: { message: 'stop failed' } };
        if (outcome === 'false-result') return { data: false };
        stopped = true;
        return { data: true };
      },
      prompt: async (request) => {
        calls.push(request.body.model.modelID);
        if (calls.length === 1) return new Promise(() => {});
        assert.equal(stopped, true, 'fallback requires confirmed stop');
        return { data: { parts: [{ type: 'text', text: 'done' }] } };
      },
    } } });
    await instance['chat.message']({ sessionID: 'primary_123', agent: 'nla', directory: dir });
    const task = instance.tool.nla_task.execute({ role: 'architect', description: 'stop fixture', prompt: 'task' }, { sessionID: 'primary_123', directory: dir, abort: new AbortController().signal });
    const observed = outcome === 'confirmed' ? task : assert.rejects(task, /caller_or_application_error/);
    await stopping;
    assert.deepEqual(calls, ['a'], 'no fallback while stop is pending');
    releaseStop();
    await observed;
    assert.deepEqual(calls, outcome === 'confirmed' ? ['a', 'b'] : ['a']);
  } finally {
    await instance?.dispose();
    for (const [key, value] of [['NLA_MODEL_POOLS_PATH', oldPool], ['NLA_MEMORY_DIR', oldMemory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const phase of ['fetch', 'body']) {
  const controller = new AbortController();
  const health = new ModelHealthManager();
  let finish;
  let providerSignal;
  const task = runUtilityModel({ role: 'compactor', pool: { ...utilityPool, models: ['one'] }, prompt: 'task', signal: controller.signal, healthManager: health, fetchImpl: async (_url, options) => {
    providerSignal = options.signal;
    if (phase === 'fetch') return new Promise((resolve) => { finish = () => resolve(new Response(JSON.stringify({ message: { content: 'late' } }))); });
    return { ok: true, json: () => new Promise((resolve) => { finish = () => resolve({ message: { content: 'late' } }); }) };
  } });
  const rejected = assert.rejects(task, /caller_or_application_error/);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(providerSignal.aborted, true);
  assert.equal(health.state('one', utilityHealthEndpoint(utilityPool)).state, 'available');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(health.state('one', utilityHealthEndpoint(utilityPool)).state, 'available');
}
console.log('NLA confirmed-stop fallback and utility cancellation regressions passed');

for (const validCatalog of [true, false]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-patch-tools-'));
  const oldPool = process.env.NLA_MODEL_POOLS_PATH;
  const oldMemory = process.env.NLA_MEMORY_DIR;
  let instance;
  try {
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles: { implementer: { enabled: true, models: ['opencode-go/gpt-5.6-luna'] } } }));
    let requests = 0;
    instance = await NextLevelAgentPlugin({ directory: dir, client: {
      tool: { list: async () => ({ data: ['read', 'grep', 'bash', ...(validCatalog ? ['apply_patch'] : [])].map(id => ({ id, parameters: { type: 'object' } })) }) },
      session: {
        create: async () => ({ data: { id: 'child_123' } }),
        abort: async () => ({ data: true }),
        prompt: async request => {
          requests++;
          assert.equal(request.body.tools.apply_patch, true);
          assert.equal(request.body.tools['*'], false);
          assert.equal(request.body.tools.edit, undefined);
          assert.equal(request.body.tools.write, undefined);
          return { data: { parts: [{ type: 'text', text: 'done' }] } };
        },
      },
    } });
    await instance['chat.message']({ sessionID: 'primary_123', agent: 'nla', directory: dir });
    const ctx = { sessionID: 'primary_123', directory: dir, abort: new AbortController().signal };
    const task = instance.tool.nla_task.execute({ role: 'implementer', description: 'patch fixture', prompt: 'Implement a new file and run tests.' }, ctx);
    if (validCatalog) await task;
    else await assert.rejects(task, error => error.code === 'NLA_TASK_PREPARATION_FAILED' && error.attempted === 0 && !/cooling or in-flight/.test(error.message));
    assert.equal(requests, validCatalog ? 1 : 0);
    const health = (await instance.tool.nla_models.execute({}, ctx)).metadata.health;
    assert.ok(health.every(entry => entry.state === 'available'));
  } finally {
    await instance?.dispose();
    for (const [key, value] of [['NLA_MODEL_POOLS_PATH', oldPool], ['NLA_MEMORY_DIR', oldMemory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('NLA model-specific patch tools and preparation failure regressions passed');
