import assert from 'node:assert/strict';
import { aggregateChecks, browserGateReport, GATE_LAYERS } from './browser-production-gate-result.mjs';
const passing = GATE_LAYERS.map(layer => ({ layer, id: layer, status: 'PASS' }));
assert.equal(browserGateReport({ checks: passing }).result, 'PASS');
for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN']) {
  const checks = [...passing, { layer: 'failure_recovery', id: 'mandatory', status }];
  assert.equal(browserGateReport({ checks }).result, status);
  assert.equal(browserGateReport({ checks }).verdict, 'NLA BROWSER PRODUCTION NOT READY');
}
assert.equal(browserGateReport({ checks: passing.slice(1) }).result, 'NOT_RUN');
assert.equal(aggregateChecks([{ status: 'PASS' }, { status: 'BLOCKED', mandatory: false }]), 'PASS');
assert.throws(() => browserGateReport({ checks: [{ layer: 'functional', status: 'MAYBE' }] }));
console.log('Browser production gate rejects missing, failed, blocked and unexecuted mandatory checks');
