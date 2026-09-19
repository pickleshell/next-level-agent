import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { aggregateChecks, browserGateReport, GATE_LAYERS } from './browser-production-gate-result.mjs';
import { ownedProcessInventory, processSnapshot } from './browser-production-process-inventory.mjs';
import { persistentRecoveryNotReadyChecks } from './browser-production-recovery-classification.mjs';
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
assert.equal(ownedProcessInventory({ clientProcess: {}, processes: new Map() }).reason, 'MCP_PROCESS_INVENTORY_UNAVAILABLE');
assert.equal(ownedProcessInventory({ clientProcess: {}, brokerSession: { session_id: 'broker-session' }, processes: new Map() }).reason, 'BROKER_PROCESS_INVENTORY_UNAVAILABLE');
const synthetic = new Map([[101, { pid: 101, parent: 1, start: 'one', rss_kb: 10 }], [102, { pid: 102, parent: 101, start: 'two', rss_kb: 20 }]]);
assert.deepEqual(ownedProcessInventory({ clientProcess: { pid: 101 }, processes: synthetic }).identities.map(process => process.pid), [101, 102]);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
try {
  await once(child, 'spawn');
  const inventory = ownedProcessInventory({ clientProcess: child, processes: processSnapshot() });
  assert.equal(inventory.status, 'OBSERVED', 'a directly spawned MCP process must have real owned-process evidence');
  assert.ok(inventory.identities.some(process => process.pid === child.pid));
} finally {
  child.kill('SIGKILL');
  await once(child, 'exit');
}
const notReady = persistentRecoveryNotReadyChecks();
assert.deepEqual(notReady.map(check => check.id), ['orchestrator-process-restart', 'browser-child-process-restart', 'persistent-compaction-recovery']);
assert.ok(notReady.every(check => check.evidence.status === 'NOT_CONSUMED' && check.evidence.classification.startsWith('NOT_READY_')));
assert.equal(browserGateReport({ checks: [...passing, ...notReady.map(check => ({ layer: 'failure_recovery', ...check, status: 'NOT_RUN' }))] }).result, 'NOT_RUN');
console.log('Browser production gate rejects missing, failed, blocked and unexecuted mandatory checks');
