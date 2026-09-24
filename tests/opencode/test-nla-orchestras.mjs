import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateModelPools } from '../../.opencode/plugins/nla-model-pools.mjs';
import { createModelInventorySync } from '../../.opencode/plugins/nla-model-inventory.mjs';
import { materializeAutoPool, rankModelCandidates } from '../../.opencode/plugins/nla-model-selection.mjs';
import {
  activateOrchestra, getOrchestra, initializeOrchestras, initializeSystemDatabase,
  listModelRegistry, listOrchestras, saveOrchestra, setModelStatus,
  synchronizeConfiguredModelRegistry, synchronizeRuntimeModelFacts, updateOrchestra,
} from '../../.opencode/plugins/nla-system-database.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-orchestras-'));
try {
  const file = initializeSystemDatabase({ stateRoot: root });
  const go = JSON.parse(fs.readFileSync(new URL('../../config/model-pools.json', import.meta.url), 'utf8'));
  assert.equal(initializeOrchestras(file, go), 'go');
  assert.equal(getOrchestra(file).name, 'go');
  const proposal = structuredClone(go);
  proposal.roles.nla.models = ['command-code/gpt-5.6-luna'];
  proposal.roles.implementer.models = 'auto';
  proposal.roles.implementer.selection_mode = 'select';
  delete proposal.roles.implementer.model_facts;
  proposal.guidance = 'Use Command Code for routine work; OpenAI when quality justifies it.';
  validateModelPools(proposal);
  assert.throws(() => validateModelPools({ roles: { implementer: { enabled: true, selection_mode: 'fallback', models: 'auto' } } }), /agent select pool/);
  assert.deepEqual(saveOrchestra(file, 'command-openai', proposal), { name: 'command-openai', roles: 9 });
  assert.throws(() => saveOrchestra(file, 'command-openai', proposal), /already exists/);
  assert.equal(getOrchestra(file).name, 'go', 'saving a proposal must not activate it');
  synchronizeConfiguredModelRegistry(file, proposal.roles);
  const inventory = new Set(['command-code/gpt-5.6-luna', 'openai/gpt-5']);
  synchronizeRuntimeModelFacts(file, proposal.roles, [
    { id: 'command-code', models: { 'gpt-5.6-luna': { limit: { context: 128000 }, cost: { input: 0.2, output: 1.2 } } } },
    { id: 'openai', models: { 'gpt-5': { limit: { context: 200000 }, cost: { input: 1, output: 5 } } } },
  ]);
  assert.ok(listModelRegistry(file, 'openai/gpt-5').length, 'auto discovers a new provider model');
  setModelStatus(file, 'command-code/gpt-5.6-luna', 'disabled');
  const pool = materializeAutoPool(proposal.roles.implementer, listModelRegistry(file), inventory);
  assert.deepEqual(pool.models, ['openai/gpt-5'], 'disabled binding is excluded from auto');
  assert.equal(rankModelCandidates({ role: 'implementer', pool }).models[0], 'openai/gpt-5');
  const tie = { models: ['openai/gpt-5', 'command-code/gpt-5.6-luna'], preferred_providers: ['command-code', 'openai'] };
  const equalScores = { models: Object.fromEntries(tie.models.map((binding) => [binding, { scores: { coding: 8, reasoning: 8, tool_use: 8, reliability: 8, latency: 8 } }])) };
  assert.equal(rankModelCandidates({ role: 'implementer', pool: tie, evaluations: equalScores }).models[0], 'command-code/gpt-5.6-luna');
  assert.equal(proposal.roles.implementer.models, 'auto', 'materialization must not overwrite source config');
  assert.throws(() => materializeAutoPool(proposal.roles.implementer, listModelRegistry(file), null), /inventory/);
  assert.deepEqual(activateOrchestra(file, 'command-openai'), { active: 'command-openai' });
  assert.equal(getOrchestra(file).name, 'command-openai', 'active orchestra survives reopening the database');
  assert.equal(getOrchestra(file).config.guidance, proposal.guidance);
  const sync = createModelInventorySync({
    client: { config: { providers: async () => ({ data: { providers: [
      { id: 'openai', models: { 'gpt-new': { limit: { context: 128000 }, cost: { input: 1, output: 4 } } } },
    ] } }) } },
    directory: root, database: file, roles: () => go.roles,
  });
  await sync({ force: true, rolesOverride: proposal.roles });
  assert.ok(sync.availableBindings().has('openai/gpt-new'));
  assert.equal(listModelRegistry(file, 'openai/gpt-new')[0].facts.context_window, 128000);
  const changed = structuredClone(proposal);
  changed.roles.reviewer.models = 'auto';
  assert.equal(updateOrchestra(file, 'command-openai', changed).name, 'command-openai');
  assert.equal(getOrchestra(file).config.roles.reviewer.models, 'auto');
  assert.throws(() => updateOrchestra(file, 'go', changed), /original pool file/);
  assert.equal(getOrchestra(file, 'go').config.roles.implementer.models.length, 27, 'go snapshot is retained');
  assert.equal(listOrchestras(file).length, 2);
  assert.equal(activateOrchestra(file, 'go').active, 'go');
  assert.equal(listModelRegistry(file, 'command-code/gpt-5.6-luna')[0].status, 'disabled', 'switching preserves registry status');
  console.log('NLA named orchestras, auto inventory, disabled status, switching, and persistence passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
