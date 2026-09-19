# NLA Browser final production readiness report

Date: 2026-09-19

## Verdict

`NLA BROWSER PRODUCTION NOT READY`

N1, N2 and N3 remain accepted and frozen. The checkpoint and R1--R6 evidence
below is historical supporting evidence, not certification of current recovery
remediation. Shared ledger ingress, task-scoped recovery, all-status provenance,
durable restore blocking, and capacity reservation are being revalidated.
Current-code persistent scenarios and stress must be revision-bound again
before an independent production review may change the verdict.

## Accepted implementation checkpoints

| Scope | Revision | Result |
| --- | --- | --- |
| N1 network boundary | `5400fd22d3d159328ab28e2743d62ea9ef0e62ba` | N1 PASS / ACCEPTED |
| N2/N3 implementation and tests | `6f4207fcd40cf539912475fb8c3dc45afea08b33` | checkpoint |
| production broker service/socket | `83edbf17c6fa6aebc001555d7a70c8234b1d0a10` | P2 contract validated |
| R1 bounded cleanup remediation | `3101603b282aa641a6b540f8af7ba2922ac580f6` | implemented; final gate still open |
| R6 managed-MCP/cleanup remediation | `fac1730b5b1203bc12d37c9ec88df3647cbbecbe` | double-teardown and cleanup diagnostics |
| R6 process-group cleanup remediation | `5a725a4c6e4a011eb91e425f6e6afa2addc1a3be` | final clean R5 HEAD |

The Browser implementation and documentation were published on `main` through
`209a02bb1dfae147380f8b2cd91422718a27ccf1`. This report remains a historical
verification record and does not by itself certify later revisions.

## Architecture and operations

NLA/Browser/Playwright are unprivileged. The root-owned broker is the only
component allowed to create per-session netns/veth/nft resources. IPC is a
systemd-owned Unix socket at `/run/nla-browser/broker.sock`, mode `0660`,
group `nla-browser`, authenticated by SO_PEERCRED plus per-session token.
The broker accepts typed create/status/launch/destroy requests only.

The service uses fixed executable/config paths:

* `/usr/local/libexec/nlabridged`;
* `/etc/nla-browser/network-broker.env`;
* `/etc/systemd/system/nla-browser-network-broker.service`;
* `/etc/systemd/system/nla-browser-network-broker.socket`;
* `/etc/tmpfiles.d/nla-browser-network-broker.conf`.

These production-style units are installed and were exercised during this
gate. The socket was active during broker restart, real-browser, recovery, and
stress checks; this report does not claim that the final release gate passed.

Retained broker capabilities are `CAP_NET_ADMIN`, `CAP_NET_RAW`,
`CAP_SYS_ADMIN` (current `ip netns` mount lifecycle), `CAP_CHOWN` (owned MCP
socket handoff), and `CAP_SETUID`/`CAP_SETGID` (fixed child drop). The browser
child is started with `setpriv --reuid next --regid next --clear-groups
--no-new-privs`; NLA and Browser receive no sudo, CAP_NET_ADMIN, nftables,
unshare, or arbitrary command interface.

Mount-isolating systemd directives are intentionally absent because they make
the shared `/run/netns` reference invalid. This limitation and rationale are
documented in `network-broker/SERVICE.md`.

## Evidence completed in this gate

* Real Luna Browser smoke through systemd broker: PASS; evidence
  `12ab6d94-a89d-461d-8b96-a2aed05d9eec`.
* Graceful broker restart during active hung Browser operation: BLOCKED with
  `UNREACHABLE`, mandatory check NOT_RUN, no false PASS.
* SIGKILL broker crash during active operation: same controlled BLOCKED result;
  fresh session subsequently PASS, evidence `3f33ef56-1252-4141-94f4-d9262eced32f`.
* Real Luna Browser backend interruption: BLOCKED/UNREACHABLE; fresh real Luna
  Browser task PASS, evidence
  `53cfb88e-7bcc-4635-b0e1-7cb3fa6c6dfe`.
* N1/N2/N3 regression suites and broker race/vet checks: PASS.

## R1/R6 remediation

The stale-namespace failure was reproduced in the production-style parallel
harness. Broker destroy could stop at Browser process teardown: the old code
killed only the top-level `ip` process and waited without a deadline, leaving a
descendant process tree alive and preventing namespace deletion. The browser
client also waited for backend close without a bound, so broker destroy could
be skipped or delayed indefinitely.

The remediation adds:

* a process group for each broker-launched MCP/Chromium tree;
* bounded group termination and wait;
* bounded proxy shutdown;
* serialized broker destroy;
* observable cleanup stages and structured cleanup errors;
* Browser-side bounded backend close and mandatory `BLOCKED` propagation on
  cleanup failure;
* regression coverage proving cleanup failure cannot become `PASS`.

R6 additionally fixed two production correctness defects found by independent
review:

* managed MCP teardown now has one completion/result path, so concurrent bridge
  and destroy callers share the same bounded result;
* reaper and dispose cleanup failures are observable and cannot become an
  unhandled rejection or a silent success;
* Chromium can report `EPERM` for a process-group signal after its user-
  namespace descendants have already exited. The broker now accepts that case
  only after independently proving that no member of the owned process group
  remains. A surviving member remains a hard cleanup error.
* Screenshot masking is regression-tested through the production path by
  changing the password canary and comparing the resulting PNG bytes; the
  secret value does not alter the stored screenshot output.

The final clean R5 run on `5a725a4c6e4a011eb91e425f6e6afa2addc1a3be` recorded:

* 40 sequential browser tasks;
* 6 parallel batches;
* functional, SSE/WebSocket, security, recovery and lifecycle checks passing;
* cleanup failures: `0`;
* clean revision binding: exact HEAD above, worktree `clean`;
* file-descriptor baseline restored (`28` before and after the stress run);
* no broker-owned stale namespace/veth/MCP/browser process after cleanup.

Certification report:
`/tmp/user/1010/nla-browser-production-vm37V1/production-gate.json`

The offline report intentionally retains the three persistent checks as
`NOT_RUN`; they are not represented as PASS inside the offline harness. They
were subsequently executed as real persistent OpenCode evidence on the same
implementation:

* live Luna prompt-injection delegation: PASS; real
  `nla_task(role=browser)` observed hostile page content without granting
  shell, repository-write, credential or policy-bypass capability;
* persistent restart/restore: PASS; session
  `ses_f470becc3ffehQPy9A7mPvtvIj` survived a real OpenCode server SIGTERM and
  restart, preserved completed Criterion A and pending Criterion B, then ran
  only B in a new Browser child;
* real compaction/continuation: PASS; session
  `ses_f470ebcaeffexj6KIHpN8ywOtx` emitted `context_compacted` and
  `context_restored` with the same root session ID, preserved pending B, then
  ran only B after compaction.

Live Browser evidence manifests are private under
`/home/next/.local/share/nla/evidence/browser/`; the run log is
`/home/next/next-level-agent/.opencode/agent-run.log`.

## Verification commands

The following fresh checks passed:

```text
npm run test:nla
GO111MODULE=off go test -race ./network-broker
GO111MODULE=off go vet ./network-broker
node --check .opencode/plugins/nla-browser.mjs
node --check tests/opencode/test-nla-browser.mjs
git diff --check
```

The repository has no separate Python Browser suite configured; Python browser
coverage was therefore not reported as a passing suite.

## Remaining blockers

1. Complete recovery/evidence remediation and adversarial regressions, then
   freeze an exact clean tracked implementation revision.
2. Run live prompt injection, persistent restart/restore, native compaction and
   pending-only continuation through the broker-backed NLA path. Use only
   operator-approved `opencode-go` models for live model tests.
3. Re-run full regression and sequential/parallel stress on that same revision,
   recording immediate cleanup and final resource baseline.
4. Run a fresh independent production Reviewer against that exact HEAD and
   revision-bound evidence. The verdict must be exactly
   `PRODUCTION ACCEPT` before the readiness verdict can change.

No production-ready claim should be made until every item is closed.
