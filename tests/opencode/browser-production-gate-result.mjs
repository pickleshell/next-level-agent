export const GATE_LAYERS = Object.freeze(['functional', 'isolation_security', 'failure_recovery', 'repeated_use']);
export const CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
export function aggregateChecks(checks) {
  const required = checks.filter(c => c.mandatory !== false);
  if (!required.length) return 'NOT_RUN';
  if (required.some(c => c.status === 'FAIL')) return 'FAIL';
  if (required.some(c => c.status === 'BLOCKED')) return 'BLOCKED';
  if (required.some(c => c.status === 'NOT_RUN')) return 'NOT_RUN';
  if (required.some(c => !CHECK_STATUSES.includes(c.status))) throw new Error('Invalid gate check status');
  return 'PASS';
}
export function browserGateReport({ revision, checks, metrics = {}, started_at, completed_at }) {
  if (checks.some(c => !GATE_LAYERS.includes(c.layer) || !CHECK_STATUSES.includes(c.status))) throw new Error('Invalid production gate check');
  const layers = Object.fromEntries(GATE_LAYERS.map(layer => [layer, aggregateChecks(checks.filter(c => c.layer === layer))]));
  const result = aggregateChecks(GATE_LAYERS.map(id => ({ status: layers[id] })));
  return { version: 1, revision, started_at, completed_at, layers, checks, metrics, result, verdict: result === 'PASS' ? 'NLA BROWSER PRODUCTION READY' : 'NLA BROWSER PRODUCTION NOT READY' };
}
