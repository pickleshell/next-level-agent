# N2 Report — Real Browser Boundary

Status: **N2 PASS — Real Browser Boundary Ready**

Base N1: `5400fd22d3d159328ab28e2743d62ea9ef0e62ba`

This gate used an ephemeral root broker only. The production systemd broker was
not installed or enabled.

## Implementation

The broker now has a narrow `launch` operation. The caller supplies only an
owned session ID and token. The broker reads a fixed operator-configured MCP
command, requires `__NLA_SESSION_PROXY__`, substitutes the current session
proxy, enters the session namespace, and uses fixed `/usr/bin/setpriv` to drop
to the requesting peer UID/GID before MCP/Chromium starts. The child receives a
minimal fixed environment and no privileged environment.

The NLA Playwright client can connect to the broker-owned per-session Unix
socket. Existing stdio launch remains supported. HTTP/HTTPS routing continues
through Chromium's native network stack; the N1 boundary, not Playwright route
logic, is authoritative for egress.

## Browser/process evidence

Real backend:

* Playwright MCP from `/home/next/.local/share/nla-browser`;
* Chromium `151.0.7922.10`;
* MCP and Chromium renderer/network/GPU/utility processes ran as UID/GID
  `1010/1010`;
* every observed browser process had the session network namespace inode, not
  the host namespace;
* Chromium received only the session proxy, for example
  `http://10.200.21.1:21743`;
* no CAP_NET_ADMIN or sudo was granted to the browser process.

## Functional evidence

Fresh real-browser fixtures passed:

* HTTP navigation and DOM JavaScript update;
* HTTPS navigation through CONNECT with a self-signed fixture;
* allowed multi-hop redirect;
* allowed iframe, image, stylesheet and script;
* allowed fetch/XHR path;
* allowed popup/new page and form submission;
* SSE delivery and reconnect;
* WebSocket handshake, browser-to-server message, server-to-browser message,
  clean close and reconnect;
* screenshot creation with secret-region masking;
* normal semantic DOM checks and interactions.

The functional fixture's forbidden server received `request_count = 0`.
This covered direct policy-denied navigation, 301/302/303/307/308 redirects,
fetch/XHR, image, script, stylesheet, iframe, EventSource, WebSocket, popup,
and form submission. The redirect fixture separately confirmed allowed
redirects succeed and all five forbidden redirect classes return
`POLICY_DENIED` with forbidden count zero.

The real browser also navigated to `http://localhost:18580` through the
hostname/pinned-resolution path. N1's controlled DNS pinning/rebinding tests
remain the authoritative lower-boundary evidence for the rebinding invariant;
N2 confirmed that the real browser uses that boundary rather than a direct host
network path.

## Failure and cleanup evidence

* Killing the real MCP backend during an active task produced `UNREACHABLE`,
  never PASS; the owned session was destroyed and a fresh session completed.
* Destroying the active N1 session made subsequent browser operations fail
  `UNREACHABLE`; a fresh session completed.
* target-unavailable/policy-denied navigation did not produce PASS.
* 30 sequential real-browser sessions completed with zero failures;
  namespaces before/after: `0` / `0`.
* four parallel real-browser sessions completed with all results PASS;
  namespaces after cleanup: `0`.
* final cleanup left no `nla-*` namespace or MCP/Chromium process.

## Verification

Passed:

* `npm run test:nla`;
* `GO111MODULE=off go test -race ./network-broker`;
* `GO111MODULE=off go vet ./network-broker`;
* `git diff --check`;
* real N2 HTTP/HTTPS/streaming/redirect/security/recovery/stress fixtures.

`pytest` is not installed in this repository and no Python test runner is
declared by `package.json`; this is recorded rather than silently claiming a
Python suite pass. The existing Browser production-gate runner remains
`NLA BROWSER PRODUCTION NOT READY` without production Browser configuration;
that is the separate N3/configuration gate and was not used to invalidate this
N2 boundary gate.

## Review

The read-only N2 security review is recorded in
`network-broker/N2_SECURITY_REVIEW.md`. It checked namespace placement, child
process credentials, proxy-only topology, redirect/forbidden counters,
HTTPS/WS/SSE behavior, fail-closed launch, ownership, and cleanup.

No commit or push was performed. Experimental changes remain uncommitted as
required by the gate instructions.
