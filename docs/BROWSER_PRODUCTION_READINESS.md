# NLA Browser final production readiness report

Date: 2026-09-18

## Verdict

`NLA BROWSER PRODUCTION NOT READY`

N1, N2 and N3 remain accepted and frozen. The final production gate is not
closed because persistent Orchestrator/child recovery and real compaction
evidence are incomplete, and the first production-broker stress run recorded
one stale namespace before reconciliation.

## Accepted implementation checkpoints

| Scope | Revision | Result |
| --- | --- | --- |
| N1 network boundary | `5400fd22d3d159328ab28e2743d62ea9ef0e62ba` | N1 PASS / ACCEPTED |
| N2/N3 implementation and tests | `6f4207fcd40cf539912475fb8c3dc45afea08b33` | checkpoint |
| production broker service/socket | `83edbf17c6fa6aebc001555d7a70c8234b1d0a10` | P2 contract validated |

No revision was pushed.

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
* Production broker stress: 30 sequential + 2 parallel tasks returned PASS,
  but one stale namespace/veth was observed after the run. Broker restart
  reconciliation removed it. A repeat 10 sequential + 2 parallel run passed
  with no remaining namespace, veth, MCP socket or browser process.

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

1. A real Browser child-session interruption through persistent NLA must be
   exercised and prove no fabricated or duplicate evidence.
2. A persistent Orchestrator restart/restore must preserve partial evidence,
   pending checks, permissions and run identity.
3. Actual OpenCode context compaction must occur during a multi-step Browser
   workflow and the post-compaction result must use real pre/post-compaction
   tool evidence. The attempted persistent server runs were NOT_RUN: one
   lacked provider auth, and the SDK-configured attempt did not dispatch a
   provider response.
4. Explain or reproduce the single stale namespace from the first 30+2 stress
   run, then rerun the full stress gate with zero cleanup incidents.
5. Run the independent final Reviewer after the above evidence is fresh and
   obtain exactly `PRODUCTION ACCEPT`. The current independent final review
   returned `PRODUCTION REJECT` because these blockers remain open.

No production-ready claim should be made until every item is closed.
