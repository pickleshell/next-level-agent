import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextLevelAgentPlugin } from './fixture-task-admission.mjs';
import { childContract } from '../../.opencode/plugins/nla-child-contract.mjs';

const diagnostics = fs.readFileSync(new URL('../../skills/nla-supervisor-diagnostics/SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
const supervisorContract = childContract({ role: 'supervisor', directory: '/fixture', tools: [] });
assert.ok(supervisorContract.includes(diagnostics), 'tool-free Supervisor receives the maintained skill body without an extra tool call');
for (const role of ['implementer', 'reviewer', 'explorer', 'compactor']) {
  assert.ok(!childContract({ role, directory: '/fixture', tools: [] }).includes(diagnostics), 'diagnostic instructions stay role-scoped');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-child-contract-'));
const target = path.join(root, 'worktree');
fs.mkdirSync(target);
const old = { NLA_MEMORY_DIR: process.env.NLA_MEMORY_DIR, NLA_MODEL_POOLS_PATH: process.env.NLA_MODEL_POOLS_PATH };
let plugin;
try {
  process.env.NLA_MEMORY_DIR = path.join(root, 'memory');
  process.env.NLA_MODEL_POOLS_PATH = path.join(root, 'pools.json');
  const roles = Object.fromEntries(['nla','router','supervisor','scout','explorer','architect','implementer','reviewer','compactor'].map(role => [role, { enabled: role !== 'nla', models: ['fixture/first', 'fixture/second'] }]));
  roles.nla.models = ['fixture/second'];
  fs.writeFileSync(process.env.NLA_MODEL_POOLS_PATH, JSON.stringify({ roles }));
  const requests = [];
  let attempts = 0, aborts = 0;
  const packet = 'Read-only audit of internal/hostacceptance. Never mutate the host.';
  const ctx = { sessionID: 'parent_123', directory: root, abort: new AbortController().signal };
  const args = { result_contract: 'legacy', role: 'explorer', directory: target, description: 'Audit fixture', prompt: packet };
  const errorPart = id => ({ type: 'tool', id, callID: id, sessionID: 'child_123', state: { status: 'error', error: "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read." } });
  const emit = part => plugin.event({ event: { type: 'message.part.updated', properties: { part } } });
  plugin = await NextLevelAgentPlugin({ directory: root, client: {
    tool: { list: async request => { requests.push(request); return { data: ['read','grep','glob'].map(id => ({ id, parameters: { type: 'object' } })) }; } },
    session: {
      create: async request => { requests.push(request); return { data: { id: 'child_123' } }; },
      abort: async request => { requests.push(request); aborts++; return { data: true }; },
      prompt: async request => { try {
        requests.push(request);
        attempts++;
        assert.equal(request.body.parts[0].text, packet, 'task packet preserved verbatim');
        const output = { messages: [{ info: { role: 'user', sessionID: 'child_123' }, parts: [{ type: 'text', text: packet }] }] };
        await plugin['experimental.chat.messages.transform']({}, output);
        assert.doesNotMatch(JSON.stringify(output), /first user message.*invoke the native skill/i, 'child never gets coordinator bootstrap even when hook input has no sessionID');
        assert.match(JSON.stringify(output), /NLA_CHILD_CONTRACT/);
        await plugin['experimental.chat.messages.transform']({}, output);
        assert.equal(output.messages[0].parts.filter(p => p.synthetic).length, 1, 'contract injection is idempotent');
        assert.equal(output.messages[0].parts.at(-1).text, packet);
        for (const name of Object.keys(request.body.tools).filter(name => request.body.tools[name])) assert.ok(JSON.stringify(output).includes(name));
        if (attempts === 1) {
          await emit(errorPart('one'));
          await emit(errorPart('one')); // duplicate update must not count twice
          await emit({ ...errorPart('ordinary'), tool: 'read', state: { status: 'error', error: 'File not found' } });
          await emit(errorPart('two'));
          assert.equal(aborts, 0);
          const corrected = { messages: [{ info: { role: 'user', sessionID: 'child_123' }, parts: [{ type: 'text', text: packet }] }] };
          await plugin['experimental.chat.messages.transform']({}, corrected);
          assert.match(JSON.stringify(corrected), /unavailable tool/i);
          await emit(errorPart('three'));
          return new Promise(() => {}); // loop can only finish through guarded failover
        }
        assert.equal(aborts, 1, 'previous attempt stopped before failover');
        await emit(errorPart('one')); // stale update from prior candidate
        return { data: { parts: [{ type: 'text', text: 'AUDIT_OK' }] } };
      } catch (error) { console.error(error); throw error; }
      },
    },
  } });
  const result = await plugin.tool.nla_task.execute(args, ctx);
  assert.equal(attempts, 2);
  assert.match(result.output, /AUDIT_OK/);
  await plugin['chat.message']({ sessionID: ctx.sessionID, agent: 'nla', directory: root });
  const health = (await plugin.tool.nla_models.execute({}, ctx)).metadata.health;
  assert.ok(health.every(entry => entry.state === 'available'), 'tool misuse does not quarantine providers');
  assert.ok(requests.every(request => request.query?.directory === target), 'every child API request must use explicit worktree');
  const before = requests.length;
  for (const directory of ['relative', path.join(root, 'missing'), process.env.NLA_MODEL_POOLS_PATH]) {
    await assert.rejects(plugin.tool.nla_task.execute({ result_contract: "legacy", ...args, directory }, ctx), /directory/i);
    assert.equal(requests.length, before, 'invalid directory rejected before child dispatch');
  }
  const rootMessages = { messages: [{ info: { role: 'user', sessionID: 'parent_123' }, parts: [{ type: 'text', text: 'hello' }] }] };
  await plugin['experimental.chat.messages.transform']({}, rootMessages);
  assert.match(JSON.stringify(rootMessages), /Next Level Agent bootstrap/);
  console.log('NLA child directory, bootstrap isolation, tool-loop recovery: PASS');
} finally {
  await plugin?.dispose();
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
