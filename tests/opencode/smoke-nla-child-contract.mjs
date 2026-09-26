// Real OpenCode + a deterministic local provider; no cloud calls or Core access.
import assert from 'node:assert/strict';
const supervisorMode = process.argv.includes('--supervisor');
const switchReportMode = process.argv.includes('--reports-switch');
const reportsMode = process.argv.includes('--reports') || switchReportMode;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { executionStatus } from '../../.opencode/plugins/nla-execution-store.mjs';
import { ADMISSION_TITLE, ADMISSION_PREFIX } from '../../.opencode/plugins/nla-task-admission.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-contract-live-'));
const target = path.join(root, 'worktree');
fs.mkdirSync(path.join(target, 'internal/hostacceptance'), { recursive: true });
fs.writeFileSync(path.join(target, 'internal/hostacceptance/fixture.txt'), 'READ_ONLY_FIXTURE');
execFileSync('git', ['init', '-q', target]);
execFileSync('git', ['-C', target, '-c', 'user.name=NLA Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Isolated fixture']);
fs.writeFileSync(path.join(target, 'AGENTS.md'), 'PROJECT_FIXTURE_GUARD: this project is read-only; no host changes.\n');
const plugin = fileURLToPath(new URL('../../.opencode/plugins/next-level-agent.js', import.meta.url));
const calls = [];
const reviewMode = process.argv.includes('--review');
let server, stderr = '', checks = [], primary = 0, worker = 0, recovery = 0, admissions = 0;
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  let content, tool;
  const tools = (body.tools || []).map(t => t.function?.name);
  const serialized = JSON.stringify(body.messages);
  const call = (name, args) => ({ index: 0, id: `tool_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const admission = (body.messages || []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('\n')).find(t => t.includes(ADMISSION_PREFIX));
  if (admission) {
    admissions++;
    const data = JSON.parse(admission.split(ADMISSION_PREFIX)[1].split('\n')[0]);
    checks.push({ gateToolFree: tools.length === 0, completePacket: Boolean(data.packet.task.prompt), admissionDirectory: data.packet.directory === target });
    content = JSON.stringify({ verdict: 'approve', packet_hash: data.packet_hash, reason: 'Read-only fixture is complete', issues: [] });
  } else if (body.model === 'coordinator') {
    if (++primary === 1) { calls.push('delegate'); tool = call('nla_task', { role: supervisorMode ? 'supervisor' : reviewMode || reportsMode ? 'implementer' : 'explorer', directory: target, description: 'Read fixture in isolated worktree', acceptance_criteria: '["Fixture file exists and has been read"]', prompt: 'Read-only: inspect internal/hostacceptance/* and report the fixture. Do not edit files or execute shell commands.' }); }
    else if (reviewMode && primary === 2) { calls.push('delegate-review'); tool = call('nla_task', { role: 'reviewer', directory: target, description: 'Independent fixture review', prompt: 'Read the fixture independently and review the pending Implementer report.' }); }
    else if (reviewMode && primary === 3) { calls.push('status'); tool = call('nla_status', { action: 'summary', history: true }); }
    else { calls.push('root-done'); content = 'ROOT_OK'; }
  } else {
    checks.push({ contract: serialized.includes('NLA_CHILD_CONTRACT'), noBootstrap: !serialized.includes('On the first user message of each session, invoke the native skill'), cwd: serialized.includes(target), projectInstructions: serialized.includes('PROJECT_FIXTURE_GUARD'), skillHidden: !tools.includes('skill') });
    if (reportsMode) {
      if (body.model === 'worker') {
        worker++;
        checks.push({ reportingAvailable: tools.includes('nla_report') });
        if (worker === 1) { calls.push('report-start'); tool = call('nla_report', { report_id: 'step1', kind: 'start', step: 'Read fixture', summary: 'Beginning the approved read-only step' }); }
        else if (worker === 2) { calls.push('read-worker'); tool = call('read', { filePath: path.join(target, 'internal/hostacceptance/fixture.txt') }); }
        else if (worker === 3) { calls.push('report-issue'); tool = call('nla_report', { report_id: 'issue1', kind: 'issue', step: 'Reconcile fixture evidence', summary: 'Need guidance on whether the observed fixture is sufficient' }); }
        else if (worker === 4) { checks.push({ guidanceReceived: serialized.includes('Keep the read-only scope') }); calls.push('report-completed'); tool = call('nla_report', { report_id: 'step1_done', kind: 'completed', step: 'Read fixture', summary: 'Read fixture, no changes' }); }
        else { calls.push('worker-result'); content = JSON.stringify({ status: 'completed', summary: 'AUDIT_OK with Supervisor guidance', artifacts: ['internal/hostacceptance/fixture.txt'], checks: [], remaining: [], blockers: [] }); }
      } else if (switchReportMode && body.model === 'recovery') {
        checks.push({ receivedHistory: serialized.includes('READ_ONLY_FIXTURE'), gotSwitchGuidance: serialized.includes('Keep the read-only scope') });
        calls.push('switched-result'); content = JSON.stringify({ status: 'completed', summary: 'AUDIT_OK after supervised switch', artifacts: ['internal/hostacceptance/fixture.txt'], checks: [], remaining: [], blockers: [] });
      } else {
        checks.push({ noRecursiveReporting: !tools.includes('nla_report') });
        if (++recovery === 1) {
          checks.push({ durableFirst: executionStatus(path.join(root, 'memory/system.sqlite'), { action: 'recent', limit: 200 }).some(e => e.kind === 'role_report' && e.data.kind === 'issue') });
          calls.push('audit-status'); tool = call('nla_status', { action: 'recent', history: true });
        } else { calls.push(switchReportMode ? 'audit-switch' : 'audit-guidance'); content = JSON.stringify({ action: switchReportMode ? 'switch' : 'guidance', reason: 'Fixture evidence available', guidance: 'Keep the read-only scope and return a factual report' }); }
      }
    } else if (supervisorMode) {
      worker++;
      checks.push({ readOnly: !tools.some(t => ['bash','write','edit','apply_patch','nla_task','nla_state'].includes(t)), diagnostics: serialized.includes('NLA Supervisor diagnostics') });
      if (worker === 1) { calls.push('supervisor-status'); tool = call('nla_status', { action: 'summary' }); }
      else if (worker === 2) { checks.push({ statusWorked: serialized.includes('task_id') }); calls.push('supervisor-models'); tool = call('nla_models', {}); }
      else if (worker === 3) { checks.push({ modelsWorked: serialized.includes('Active orchestra:') }); calls.push('supervisor-read'); tool = call('read', { filePath: path.join(target, 'internal/hostacceptance/fixture.txt') }); }
      else { checks.push({ readWorked: serialized.includes('READ_ONLY_FIXTURE') }); calls.push('supervisor-verdict'); content = 'CONTINUE: AUDIT_OK, inspected status, models and fixture without changes.'; }
    } else if (reviewMode) {
      if (body.model === 'worker') {
        worker++;
        if (worker === 1) { calls.push('read-worker'); tool = call('read', { filePath: path.join(target, 'internal/hostacceptance/fixture.txt') }); }
        else if (worker === 2) { calls.push('bad-report'); content = 'Hello!'; }
        else { calls.push('repair-report'); checks.push({ repairToolFree: tools.length === 0 }); content = JSON.stringify({ status: 'completed', summary: 'AUDIT_OK', artifacts: ['internal/hostacceptance/fixture.txt'], checks: [], remaining: [], blockers: [] }); }
      } else if (++recovery === 1) { calls.push('read-reviewer'); tool = call('read', { filePath: path.join(target, 'internal/hostacceptance/fixture.txt') }); }
      else { calls.push('review'); content = JSON.stringify({ verdict: 'pass', scores: { coding: 8, reasoning: 7, tool_use: 9 }, evidence: { tests_passed: false, acceptance_criteria_met: true } }); }
    } else if (body.model === 'worker') { worker++; calls.push('bad-tool'); tool = call('skill', { name: 'next-level-agent' }); }
    else if (++recovery === 1) { calls.push('glob'); tool = call('glob', { pattern: 'internal/hostacceptance/*' }); }
    else { calls.push('recovered'); checks.push({ found: serialized.includes('fixture.txt') }); content = JSON.stringify({ status: 'completed', summary: 'AUDIT_OK: fixture found; no changes.', artifacts: ['internal/hostacceptance/fixture.txt'], checks: [], remaining: [], blockers: [] }); }
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [tool] } : { content }) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ]) res.write('data: ' + JSON.stringify({ id: `fixture_${calls.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...chunk }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
try {
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(role => [role, { enabled: !['nla','compactor'].includes(role), models: role === 'nla' ? ['fixture/coordinator'] : ['fixture/worker', 'fixture/recovery'] }]));
  if (reviewMode) { roles.implementer.models = ['fixture/worker']; roles.reviewer.models = ['fixture/recovery']; }
  if (reportsMode) { roles.implementer.models = ['fixture/worker']; roles.supervisor.models = ['fixture/recovery']; }
  if (switchReportMode) { roles.implementer.models = ['fixture/worker','fixture/recovery']; roles.supervisor.models = ['fixture/auditor']; }
  fs.writeFileSync(path.join(root, 'pools.json'), JSON.stringify({ roles }));
  const config = { plugin: [plugin], model: 'fixture/coordinator', small_model: 'fixture/coordinator', default_agent: 'nla', enabled_providers: ['fixture'], permission: { '*': 'allow' },
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: Object.fromEntries(['coordinator','worker','recovery','auditor'].map(id => [id, { name: id, cost: { input: 0, output: 0 }, limit: { context: 65536, output: 4096 } }])) } },
    agent: { nla: { mode: 'primary' }, supervisor: { mode: 'subagent' }, explorer: { mode: 'subagent' }, implementer: { mode: 'subagent' }, reviewer: { mode: 'subagent' } } };
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify(config));
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: {
    PATH: process.env.PATH, LANG: 'C.UTF-8', XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG: path.join(root, 'opencode.json'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    NLA_MEMORY_DIR: path.join(root, 'memory'), NLA_MODEL_POOLS_PATH: path.join(root, 'pools.json'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', c => { stdout += c; }); server.stderr.on('data', c => { stderr += c; });
  const deadline = Date.now() + 45000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) { if (Date.now() > deadline || server.exitCode !== null) throw Error('server startup: ' + stderr.slice(-1000)); await new Promise(r => setTimeout(r, 50)); }
  const base = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = async (url, body) => { const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) }); if (!r.ok) throw Error(await r.text()); return r.json(); };
  const session = await api('/session', { title: 'Child contract smoke' });
  await api(`/session/${session.id}/message`, { agent: 'nla', model: { providerID: 'fixture', modelID: 'coordinator' }, parts: [{ type: 'text', text: 'Delegate the isolated read-only test.' }] });
  const messages = await api(`/session/${session.id}/message`);
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ calls, checks, messages }, null, 2));
  assert.equal(worker, switchReportMode ? 3 : reportsMode ? 5 : supervisorMode ? 4 : 3);
  assert.deepEqual(calls, switchReportMode ? ['delegate','report-start','read-worker','report-issue','audit-status','audit-switch','switched-result','root-done'] : reportsMode ? ['delegate','report-start','read-worker','report-issue','audit-status','audit-guidance','report-completed','worker-result','root-done'] : supervisorMode ? ['delegate','supervisor-status','supervisor-models','supervisor-read','supervisor-verdict','root-done'] : reviewMode ? ['delegate','read-worker','bad-report','repair-report','delegate-review','read-reviewer','review','status','root-done'] : ['delegate','bad-tool','bad-tool','bad-tool','glob','recovered','root-done']);
  assert.ok(checks.every(check => Object.values(check).every(Boolean)), JSON.stringify(checks));
  assert.ok(messages.some(m => m.parts?.some(p => p.type === 'tool' && p.tool === 'nla_task' && p.state?.status === 'completed' && JSON.stringify(p.state).includes('AUDIT_OK'))));
  assert.equal(fs.readFileSync(path.join(target, 'internal/hostacceptance/fixture.txt'), 'utf8'), 'READ_ONLY_FIXTURE');
  assert.equal(admissions, reviewMode ? 2 : 1);
  const status = executionStatus(path.join(root, 'memory/system.sqlite'), { action: 'task' }).filter(t => t.description !== ADMISSION_TITLE);
  if (reportsMode) {
    assert.equal(status.length, 2);
    assert.equal(status.find(t => t.role === 'implementer').status, 'report_ready');
    const decisions = executionStatus(path.join(root, 'memory/system.sqlite'), { action: 'recent', limit: 200 }).filter(e => e.kind === 'role_report_decision');
    assert.deepEqual(decisions.map(e => e.data.action), switchReportMode ? ['continue','switch'] : ['continue','guidance','continue']);
    if (switchReportMode) assert.deepEqual(status.find(t => t.role === 'implementer').attempts.map(a => a.status), ['failed','returned']);
  } else if (supervisorMode) {
    assert.equal(status.length, 1);
    assert.equal(status[0].role, 'supervisor');
    assert.equal(status[0].attempts[0].status, 'returned');
  } else if (reviewMode) {
    assert.equal(status.length, 2);
    const implementation = status.find(t => t.role === 'implementer');
    assert.equal(implementation.status, 'review_pass');
    assert.equal(implementation.review.evaluation_status, 'applied');
  } else {
    assert.equal(status.length, 1);
    assert.equal(status[0].status, 'report_ready');
    assert.equal(status[0].attempts.length, 2);
    assert.equal(status[0].attempts[0].status, 'failed');
    assert.equal(status[0].attempts[1].status, 'returned');
  }
  assert.ok(executionStatus(path.join(root, 'memory/system.sqlite'), { action: 'recent', limit: 200 }).some(e => e.kind === 'tool_observed'));
  console.log(JSON.stringify({ result: 'PASS', root, calls }));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', root, calls, checks, error: error.message, stderr: stderr.slice(-1500) })); process.exitCode = 1; }
finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 3000))]); if (server.exitCode === null) server.kill('SIGKILL'); }
  model.closeAllConnections(); model.close();
}
