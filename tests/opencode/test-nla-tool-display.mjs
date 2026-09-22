import assert from 'node:assert/strict';

import { nlaToolDescription, nlaToolLabel, nlaToolTitle, withNlaToolDisplay } from '../../.opencode/plugins/nla-tool-display.mjs';

assert.equal(nlaToolLabel('nla_task'), 'Task');
assert.equal(nlaToolLabel('nla_model_policy'), 'Model Policy');
assert.equal(nlaToolLabel('nla_browser_session'), 'Browser Session');

assert.equal(nlaToolTitle('nla_task', { description: 'Harden durable rollback' }), 'Task: Harden durable rollback');
assert.equal(nlaToolTitle('nla_state', { snapshot: JSON.stringify({ intent: 'Complete focused Gate F correction' }) }), 'State: Complete focused Gate F correction');
assert.equal(nlaToolTitle('nla_notebook', { action: 'restore', page: 'NLA' }), 'Notebook: NLA');
assert.equal(nlaToolTitle('nla_models'), 'Models: Current configuration');
assert.equal(nlaToolTitle('nla_models_reload'), 'Models Reload: Reload configuration');
assert.equal(nlaToolTitle('nla_model_policy', { role: 'implementer', policy: 'quality' }), 'Model Policy: implementer → quality');
assert.equal(nlaToolTitle('nla_model_health_reset', { binding: 'opencode-go/gpt-5.6-luna' }), 'Model Health Reset: opencode-go/gpt-5.6-luna');
assert.equal(nlaToolTitle('nla_work_state'), 'Work State: Reconcile repository');
assert.equal(nlaToolTitle('nla_compact', { snapshot: JSON.stringify({ intent: 'Gate F correction' }) }), 'Compact: Gate F correction');
assert.equal(nlaToolTitle('nla_browser_session', { request: '{"operation":"preflight"}' }), 'Browser Session: preflight');
assert.equal(nlaToolTitle('nla_browser_check', { request: '{"id":"acceptance"}' }), 'Browser Check: acceptance');
assert.equal(nlaToolDescription('nla_state', { snapshot: '{invalid' }), 'Update workflow state');
assert.equal(nlaToolTitle('nla_task', { description: 'line one\nline two\u0000' }), 'Task: line one line two');

const metadataCalls = [];
const wrapped = withNlaToolDisplay('nla_task', {
  description: 'fixture',
  args: {},
  execute: async () => ({ title: 'old title', output: 'full output', metadata: { retained: true } }),
});
const result = await wrapped.execute({ description: 'Focused change' }, { metadata: (value) => metadataCalls.push(value) });
assert.deepEqual(metadataCalls, [{ title: 'Task: Focused change', metadata: { nla_tool: 'nla_task' } }]);
assert.deepEqual(result, { title: 'Task: Focused change', output: 'full output', metadata: { retained: true } });

const stringResult = await withNlaToolDisplay('nla_models', { execute: async () => 'full output' }).execute({}, {});
assert.deepEqual(stringResult, { title: 'Models: Current configuration', output: 'full output' });

console.log('NLA compact tool display titles passed');
