import assert from 'node:assert/strict';

import { assessTask } from '../../.opencode/plugins/nla-task-assessor.mjs';

const ordinary = assessTask({
  role: 'implementer',
  description: 'Add validation',
  prompt: 'Implement the bounded code change and run the tests.',
});
assert.equal(ordinary.source, 'deterministic');
assert.equal(ordinary.risk, 'medium');
assert.equal(ordinary.weights.coding, 10);
assert.equal(ordinary.weights.tool_use, 9);
assert.equal(ordinary.context_window, null, 'small tasks do not invent a context requirement');

const critical = assessTask({
  role: 'implementer',
  description: 'Production credential migration',
  prompt: 'Change production authentication persistence and provide rollback tests.',
  refinement: {
    selection_weights: '{"reliability":2,"reasoning":2,"latency":10}',
    selection_policy: 'cost',
  },
});
assert.equal(critical.source, 'hybrid');
assert.equal(critical.risk, 'critical');
assert.equal(critical.policy, 'quality', 'high-risk work cannot be downgraded to cost policy');
assert.equal(critical.weights.reliability, 10, 'high-risk reliability floor is mandatory');
assert.ok(critical.weights.reasoning >= 9, 'high-risk reasoning floor is mandatory');
assert.ok(critical.weights.latency <= 5, 'high-risk work cannot prioritize latency over safety');
const criticalLocal = assessTask({ role: 'implementer', description: 'Production authentication migration', prompt: 'Review rollback safety.', refinement: { selection_policy: 'local' } });
assert.equal(criticalLocal.policy, 'local', 'high-risk tasks retain an explicit local-only boundary');
const criticalFree = assessTask({ role: 'implementer', description: 'Production authentication migration', prompt: 'Review rollback safety.', refinement: { selection_policy: 'free' } });
assert.equal(criticalFree.policy, 'free');
assert.equal(criticalFree.weights.reliability, 10);
assert.equal(assessTask({ role: 'implementer', refinement: { selection_policy: 'free', context_window: 'invalid' } }).policy, 'free', 'invalid refinements cannot erase a free boundary');
assert.equal(criticalLocal.weights.reliability, 10);
assert.ok(criticalLocal.weights.reasoning >= 9);

const refined = assessTask({
  role: 'explorer',
  description: 'Explore code',
  prompt: 'Inspect this repository and identify the relevant files.',
  refinement: {
    selection_weights: '{"coding":10,"reasoning":10}',
    context_window: '65536',
    selection_policy: 'balanced',
  },
});
assert.equal(refined.source, 'hybrid');
assert.equal(refined.context_window, 65536);
assert.equal(refined.weights.coding, 10, 'model refinement can specialize the task profile');
assert.equal(refined.weights.reasoning, 10);
assert.equal(refined.weights.tool_use, 0, 'omitted refinement dimensions are intentionally ignored');

for (const refinement of [{ selection_weights: '{"unknown":5}' }, { context_window: 'invalid' }, { selection_policy: 'random' }]) {
  const fallback = assessTask({ role: 'explorer', description: 'Inspect code', prompt: 'Read only.', refinement });
  assert.equal(fallback.source, 'deterministic_fallback', 'invalid model refinement falls back without blocking delegation');
  assert.ok(fallback.reasons.includes('invalid model refinement ignored'));
}

console.log('NLA hybrid risk and complexity assessor tests passed');
