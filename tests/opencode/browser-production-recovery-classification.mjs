// These checks cannot be certified by the offline production gate. The
// persistent harness is deliberately non-consumed until an exact-revision,
// provenance-validated report is integrated.
const nonConsumed = {
  harness: 'tests/opencode/smoke-nla-browser-persistent.mjs',
  status: 'NOT_CONSUMED',
  requirement: 'fresh live report with exact revision and Browser-task provenance',
};

export function persistentRecoveryNotReadyChecks() {
  return [
    {
      id: 'orchestrator-process-restart',
      evidence: { classification: 'NOT_READY_PERSISTENT_ORCHESTRATOR', ...nonConsumed, coverage: 'The separate harness can exercise an OpenCode server restart, but this gate has no validated report to consume.' },
    },
    {
      id: 'browser-child-process-restart',
      evidence: { classification: 'NOT_READY_BROWSER_CHILD_INTERRUPTION', ...nonConsumed, coverage: 'No active Browser child interruption/recovery is exercised by the separate harness.' },
    },
    {
      id: 'persistent-compaction-recovery',
      evidence: { classification: 'NOT_READY_SUPERVISOR_COMPACTION', ...nonConsumed, coverage: 'The separate harness invokes native summarize; it does not prove Supervisor-triggered compaction during an active Browser workflow.' },
    },
  ];
}
