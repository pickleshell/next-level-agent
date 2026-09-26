import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NextLevelAgentPlugin } from './fixture-task-admission.mjs';
import { executionStatus, recoverInterruptedTasks, createTask, bindTask, startAttempt } from '../../.opencode/plugins/nla-execution-store.mjs';
import { createRoleReporter, parseSupervisionDecision, validateRoleReport } from '../../.opencode/plugins/nla-supervision.mjs';

assert.throws(() => validateRoleReport({ kind: 'start', report_id: 'a', step: 'test', summary: 'password=secretvalue' }), /secret/i);
assert.throws(() => parseSupervisionDecision('{"action":"handoff","reason":"x","role":"shell"}'));
assert.throws(() => parseSupervisionDecision('{"action":"guidance","reason":"x"}'));
assert.throws(() => parseSupervisionDecision('{"action":"continue","reason":"x","permission":"all"}'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-supervision-'));
const old = { NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR, NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH };
try {
  for (const mode of ['normal','guidance','switch','blocked','handoff','malformed','uncertain','cancel']) {
    const dir = path.join(root, mode); fs.mkdirSync(dir);
    process.env.NLA_MEMORY_DIR = path.join(dir, 'memory');
    process.env.NLA_MODEL_POOLS_PATH = path.join(dir, 'pools.json');
    const file = path.join(process.env.NLA_MEMORY_DIR, 'system.sqlite');
    const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(role => [role, { enabled: role !== 'nla', models: role === 'supervisor' ? ['fixture/auditor'] : ['fixture/a','fixture/b'] }]));
    roles.nla.models = ['fixture/b'];
    fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
    let plugin, sessions = 0, workers = 0, audits = 0, stops = 0, reportReturned;
    let auditStarted, auditRelease;
    const started = new Promise(r => { auditStarted = r; });
    const release = new Promise(r => { auditRelease = r; });
    const abort = new AbortController();
    const report = { report_id: 'step1', kind: mode === 'normal' ? 'start' : 'issue', step: 'Inspect fixture', summary: 'Need to reconcile the current step', evidence: [] };
    const events = () => executionStatus(file, { action: 'recent', limit: 200 });
    const client = { tool: { list: async () => ({ data: ['nla_status','nla_models','read','grep','glob','bash','apply_patch'].map(id => ({ id, parameters: {} })) }) }, session: {
      create: async () => ({ data: { id: `session_${++sessions}` } }),
      abort: async () => { stops++; return { data: true }; },
      prompt: async request => {
        if (request.body.agent === 'supervisor') {
          audits++; assert.ok(events().some(e => e.kind === 'role_report'), 'report committed before Supervisor dispatch');
          assert.ok(!request.body.tools.nla_report, 'Supervisor cannot recursively report to itself');
          auditStarted(); await release;
          const verdict = mode === 'guidance' ? { action: 'guidance', reason: 'Inspect the existing evidence first', guidance: 'Read the fixture before changing approach' }
            : mode === 'handoff' ? { action: 'handoff', reason: 'Architecture clarification is required', role: 'architect' }
            : { action: mode === 'switch' ? 'switch' : 'blocked', reason: 'Reconcile before further work' };
          return { data: { parts: [{ type: 'text', text: mode === 'malformed' ? 'Hello!' : JSON.stringify(verdict) }] } };
        }
        workers++;
        if (workers > 1) {
          assert.equal(mode, 'switch'); assert.ok(stops > 0, 'switch waits for confirmed abort');
          assert.ok(events().some(e => e.kind === 'role_report_decision' && e.data.action === 'switch'));
          return { data: { parts: [{ type: 'text', text: JSON.stringify({ status: 'completed', summary: 'Recovered fixture', artifacts: [], checks: [], remaining: [], blockers: [] }) }] } };
        }
        const ctx = { sessionID: request.path.id, directory: dir, callID: 'report_call' };
        assert.equal(request.body.tools.nla_report, true);
        if (mode === 'uncertain') await plugin['tool.execute.before']({ sessionID: request.path.id, tool: 'bash', callID: 'mutation' }, { args: { command: 'echo fixture' } });
        const submit = plugin.tool.nla_report.execute(report, ctx);
        const duplicate = plugin.tool.nla_report.execute(report, ctx);
        await assert.rejects(plugin.tool.nla_report.execute({ ...report, summary: 'Different claim' }, ctx), /conflicting/);
        if (!['normal','uncertain'].includes(mode)) {
          await started;
          let released = false;
          const waitingTool = plugin['tool.execute.before']({ sessionID: request.path.id, tool: 'read' }, { args: {} }).then(() => { released = true; }, () => {});
          await Promise.resolve(); assert.equal(released, false, 'parallel dispatch waits at incident barrier');
          if (mode === 'cancel') abort.abort();
          auditRelease();
          await waitingTool;
        }
        reportReturned = JSON.parse((await submit).output);
        assert.deepEqual(JSON.parse((await duplicate).output), reportReturned);
        if (!['normal','guidance'].includes(mode)) return new Promise(() => {});
        await plugin['tool.execute.before']({ sessionID: request.path.id, tool: 'read' }, { args: {} });
        const final = { ...report, report_id: 'step1_done', kind: 'completed', summary: 'Fixture step reported complete' };
        await plugin.tool.nla_report.execute(final, ctx);
        return { data: { parts: [{ type: 'text', text: JSON.stringify({ status: 'completed', summary: 'Fixture report', artifacts: [], checks: [], remaining: [], blockers: [] }) }] } };
      },
    } };
    try {
      plugin = await NextLevelAgentPlugin({ client, directory: dir });
      await plugin['chat.message']({ sessionID: 'owner_session', agent: 'nla', directory: dir });
      await assert.rejects(plugin.tool.nla_report.execute(report, { sessionID: 'owner_session' }), /managed worker/);
      const task = plugin.tool.nla_task.execute({ role: 'implementer', description: 'Report fixture', prompt: 'Read fixture and report meaningful boundaries.' }, { sessionID: 'owner_session', directory: dir, abort: abort.signal });
      if (['normal','guidance','switch'].includes(mode)) assert.equal((await task).metadata.outcome, 'report_ready');
      else await assert.rejects(task);
      // Native aborted requests can unwind after the parent return; wait only
      // for fixture microtasks, never for a task lifetime deadline.
      await new Promise(r => setImmediate(r));
      assert.equal(audits, ['normal','uncertain'].includes(mode) ? 0 : 1);
      assert.equal(workers, mode === 'switch' ? 2 : 1);
      const persisted = events();
      assert.equal(persisted.filter(e => e.kind === 'role_report' && e.data.report_id === 'step1').length, 1);
      assert.equal(persisted.filter(e => e.kind === 'role_report_decision' && e.data.source === 'supervisor_gate').length, mode === 'normal' ? 0 : 1);
      const before = persisted.length;
      recoverInterruptedTasks(file, 'new_process');
      assert.ok(executionStatus(file, { action: 'recent', limit: 200 }).length >= before, 'restart preserves reports and decisions without replay');
    } finally { await plugin?.dispose(); }
  }
  const file = path.join(root, 'normal/memory/system.sqlite');
  const taskID = createTask(file, { owner: 'owner_session', root: 'owner_session', role: 'implementer', orchestra: 'go', directory: root, description: 'Persistence fault' });
  bindTask(file, taskID, 'fault_child');
  const attemptID = startAttempt(file, taskID, 1, 'fixture/a');
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_report_decision BEFORE INSERT ON task_events WHEN NEW.kind='role_report_decision' BEGIN SELECT RAISE(ABORT,'database fault fixture'); END");
  let halted;
  const reporter = createRoleReporter({ file, taskID, attempt: () => attemptID, evidence: () => ({ uncertain_effects: false }), alive: () => true, halt: e => { halted = e; }, audit: async () => '{"action":"continue","reason":"Test evidence"}' });
  await assert.rejects(reporter.submit({ report_id: 'fault_report', kind: 'issue', step: 'Check persistence', summary: 'Bounded incident' }), { code: 'NLA_EXECUTION_STORAGE_FAILED' });
  assert.equal(halted.code, 'NLA_EXECUTION_STORAGE_FAILED');
  await assert.rejects(reporter.barrier(), /persistence failed/i);
  db.exec('DROP TRIGGER reject_report_decision'); db.close();
  const lostDecision = executionStatus(file, { action: 'recent', task: taskID });
  assert.equal(lostDecision.filter(e => e.kind === 'role_report').length, 1);
  assert.equal(lostDecision.filter(e => e.kind === 'role_report_decision').length, 0);
  assert.equal(executionStatus(file, { task: taskID })[0].supervision.state, 'unresolved');
  let repeatedAudit = 0;
  const restored = createRoleReporter({ file, taskID, attempt: () => attemptID, evidence: () => ({}), alive: () => true, halt: () => {}, audit: async () => { repeatedAudit++; } });
  assert.equal((await restored.submit({ report_id: 'fault_report', kind: 'issue', step: 'Check persistence', summary: 'Bounded incident' })).action, 'blocked');
  assert.equal(repeatedAudit, 0, 'missing durable decision must not replay an audit');
  console.log('Role supervision: durable-first reports, dedup, barrier, guidance, confirmed switch, handoff, cancellation, storage failure and no recursive audit PASS');
} finally {
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
