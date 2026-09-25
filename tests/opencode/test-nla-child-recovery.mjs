import assert from 'node:assert/strict';
import { incompleteChildResult, recoverChildResult } from '../../.opencode/plugins/nla-child-recovery.mjs';
import { classifyProviderError, ModelHealthManager } from '../../.opencode/plugins/nla-model-health.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NextLevelAgentPlugin } from '../../.opencode/plugins/next-level-agent.js';
const partial = { data: { info: { finish: 'length', tokens: { total: 65536 } }, parts: [{ type: 'text', text: 'partial is not success' }] } };
const ok = { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text: 'verified final report' }] } };
assert.equal(incompleteChildResult(partial, 65536), 'context_limit');
assert.equal(incompleteChildResult(partial, 131072), 'output_limit');
assert.equal(incompleteChildResult({ data: { info: { error: { name: 'ContextOverflowError' } } } }), 'context_limit');
assert.equal(incompleteChildResult(ok), null);
const events = [];
assert.equal(await recoverChildResult({ initial: partial, signal: new AbortController().signal, contextWindow: 65536, compact: async () => { events.push('compact'); }, invoke: async () => { events.push('resume'); return ok; } }), ok);
assert.deepEqual(events, ['compact', 'resume']);
let calls = 0;
let incomplete;
try { await recoverChildResult({ initial: partial, signal: new AbortController().signal, compact: async () => {}, invoke: async () => { calls++; return partial; } }); } catch (error) { incomplete = error; }
assert.equal(calls, 1, 'no unchanged retry loop');
assert.equal(incomplete.code, 'NLA_CHILD_INCOMPLETE');
assert.equal(classifyProviderError(incomplete).category, 'incomplete');
const health = new ModelHealthManager(); health.claim('ollama/test'); health.failure('ollama/test', incomplete);
assert.equal(health.state('ollama/test').state, 'available', 'no reliability/cooldown penalty for result truncation');
const controller = new AbortController();
await assert.rejects(recoverChildResult({ initial: partial, signal: controller.signal, compact: async () => { controller.abort(); }, invoke: async () => { throw Error('must not run'); } }), /aborted by caller/);
console.log('NLA incomplete child recovery unit tests passed');

for (const scenario of ['recover', 'repeat-limit', 'summary-failed', 'stop-unconfirmed', 'empty', 'exhausted']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-child-recovery-'));
  const previous = { NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH, NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR };
  let plugin;
  try {
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
    const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(role => [role, { enabled: role !== 'nla', models: ['fixture/a'] }]));
    roles.implementer = { enabled: true, selection_mode: 'select', selection_policy: 'free', models: ['fixture/a', 'fixture/b'], model_facts: { 'fixture/a': { context_window: 65536, input_cost: 0, output_cost: 0 }, 'fixture/b': { context_window: 65536, input_cost: 0, output_cost: 0 } } };
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
    const artifact = path.join(dir, 'partial.txt');
    let summaries = 0, stopped = false, created = 0;
    const calls = [];
    const history = [];
    plugin = await NextLevelAgentPlugin({ directory: dir, client: {
      tool: { list: async () => ({ data: ['read','grep','glob','bash','edit','write'].map(id => ({ id, parameters: {} })) }) },
      session: {
        create: async () => ({ data: { id: ++created === 1 ? 'child_recovery' : 'independent_review' } }),
        messages: async () => ({ data: history }),
        summarize: async request => {
          assert.equal(request.body.auto, false, 'recovery controls continuation');
          summaries++;
          if (scenario === 'summary-failed') throw Error('summary model failed');
          const out = { context: [] }; await plugin['experimental.session.compacting']({ sessionID: 'child_recovery' }, out);
          assert.match(out.context.join(' '), /Preserve the original assignment/);
          history.push({ info: { id: `summary_${summaries}`, summary: true, finish: 'stop' }, parts: [{ type: 'text', text: 'Partial file exists; tests unverified.' }] });
          return { data: true };
        },
        abort: async () => { stopped = true; return { data: scenario !== 'stop-unconfirmed' }; },
        prompt: async request => {
          if (request.body.agent === 'reviewer') {
            assert.equal(request.path.id, 'independent_review');
            assert.equal(fs.readFileSync(artifact, 'utf8'), 'partial change preserved');
            return { data: { parts: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', scores: { coding: 9, reasoning: 8, tool_use: 9 } }) }] } };
          }
          const model = request.body.model.modelID; calls.push(model);
          if (calls.length === 1) {
            fs.writeFileSync(artifact, 'partial change preserved');
            history.push({ info: { id: 'work' }, parts: [{ type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: artifact } } }] });
            return scenario === 'empty' ? { data: { parts: [] } } : partial;
          }
          assert.equal(fs.readFileSync(artifact, 'utf8'), 'partial change preserved');
          assert.equal(request.body.parts[0].text, 'Implement and verify the scoped change.', 'original task packet remains verbatim');
          assert.match(request.body.parts[1].text, /Earlier tools may have changed files/);
          if (model === 'a' && !['recover', 'empty'].includes(scenario)) return partial;
          if (model === 'b') assert.equal(stopped, true, 'confirm stop before switching model');
          if (scenario === 'exhausted') return partial;
          return ok;
        },
      },
    } });
    const context = { sessionID: 'primary_recovery', directory: dir, abort: new AbortController().signal };
    await plugin['chat.message']({ sessionID: context.sessionID, agent: 'nla', directory: dir });
    const task = plugin.tool.nla_task.execute({ role: 'implementer', description: 'Bounded code change', prompt: 'Implement and verify the scoped change.' }, context);
    if (['stop-unconfirmed','exhausted'].includes(scenario)) await assert.rejects(task, /Prior tools may have changed files/);
    else assert.equal((await task).output, 'verified final report');
    assert.deepEqual(calls, ['recover','empty','stop-unconfirmed'].includes(scenario) ? ['a','a'] : scenario === 'summary-failed' ? ['a','b'] : scenario === 'exhausted' ? ['a','a','b','b'] : ['a','a','b']);
    if (scenario === 'empty') assert.equal(summaries, 0);
    const log = fs.readFileSync(path.join(dir, '.opencode/agent-run.log'), 'utf8');
    assert.doesNotMatch(log, /model_cooldown_started|unknown_provider_failure/);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'partial change preserved');
    if (scenario === 'recover') {
      await plugin.tool.nla_task.execute({ role: 'reviewer', description: 'Independent review', prompt: 'Review the retained artifact and evidence.', review_target_session_id: 'child_recovery' }, context);
      assert.match(fs.readFileSync(path.join(dir, '.opencode/agent-run.log'), 'utf8'), /review_evaluation_recorded/);
      const db = new DatabaseSync(path.join(dir, 'memory/system.sqlite'), { readOnly: true });
      const scores = db.prepare('SELECT coding, reasoning, tool_use FROM model_evaluations WHERE binding=?').get('fixture/a');
      assert.deepEqual({ ...scores }, { coding: 9, reasoning: 8, tool_use: 9 }); db.close();
    }
  } finally {
    await plugin?.dispose();
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('NLA child compaction, same-model continuation, free-pool fallback, preserved writes and honest failure tests passed');
