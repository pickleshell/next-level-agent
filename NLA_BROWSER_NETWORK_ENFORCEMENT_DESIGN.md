# NLA Browser Network Enforcement Design

Status: design-only, pending approval. No network-enforcement implementation is
included in this document or this change.

## Decision summary

The current Playwright-only policy is not a preventive egress boundary.
`route.continue()` preserves native browser networking, including WebSocket and
SSE, but a redirect may be followed before Browser can make a reliable target
decision. `route.fetch({maxRedirects: 0})` exposes the redirect before
continuation, but fulfilling the inspected response changes Chromium's
loopback/private-network behavior and breaks the required native WebSocket path.

The smallest architecture that can satisfy the invariant is a privileged,
per-browser-session egress sandbox below Playwright:

```text
NLA Browser capability
        |
        +-- Playwright MCP / Chromium
                |
                +-- dedicated network namespace
                        |
                        +-- only permitted egress path
                                |
                                +-- policy forward proxy / gateway
                                        |
                                        +-- DNS + TCP/TLS/HTTP/WebSocket egress
```

The recommended v1 is a root-managed per-session network namespace with a
deny-by-default egress policy and a policy-aware forward proxy/gateway. The
browser has no direct route to the host network. The gateway resolves and
checks the effective destination before opening each upstream connection. The
proxy is not the sole boundary: namespace routing/firewall rules make a direct
browser bypass impossible.

NLA remains an unprivileged policy client. It requests a sandbox using a narrow
server-owned session descriptor; it never receives `CAP_NET_ADMIN`, firewall
control, raw sockets, or a general network-management API.

## Confirmed current limitation

The production evidence established:

* standalone Playwright MCP/Chromium can complete Upgrade, `101`, Origin,
  browser-to-server traffic, server-to-browser message, DOM update and close;
* NLA preserves SSE and WebSocket only when native network continuation is
  retained;
* HTTP native continuation can reach a forbidden redirect destination before
  post-factum policy reporting;
* `route.fetch({maxRedirects: 0})` can inspect the redirect but
  `route.fulfill()` breaks the native WebSocket/private-network behavior;
* therefore the current Playwright/MCP routing layer cannot provide both
  preventive redirect containment and required native streaming semantics.

This is an architectural limitation, not a reason to weaken the target policy.

## Threat model

The browser page, Browser model, Orchestrator, Playwright script, redirects,
subresources, DNS answers and application servers are untrusted with respect
to egress policy. A page may attempt direct navigation, HTTP redirects, form
submission, fetch/XHR, images, scripts, iframes, popups, EventSource,
WebSocket, alternate ports, IPv4/IPv6 literals, localhost aliases, DNS rebinding
or prompt injection.

The security property is transport-level:

```text
forbidden destination request_count == 0
```

This applies even when Browser makes the wrong decision or Playwright is
bypassed. The design does not treat model instructions, DOM inspection or
post-navigation URL checks as security controls.

Credentials, cookies and request bodies are not part of the network policy
decision and must not be logged by the gateway. DNS queries, destination
decisions and bounded connection outcomes may be recorded without secrets.

## Alternatives

| Option | Preventive redirects | WS/SSE | DNS/IP/alias control | Complexity/privilege | Verdict |
| --- | --- | --- | --- | --- | --- |
| Playwright route/fetch only | No with native continuation; fetch/fulfill breaks required browser networking | Inconsistent | Weak; page can initiate other classes | Low, unprivileged | Rejected; current limitation |
| Dedicated network namespace, deny-by-default, policy gateway | Yes, before host egress; gateway checks every upstream connection | Native browser protocol through proxy/gateway | Strong: gateway owns DNS; firewall blocks direct IPv4/IPv6 | Medium/high; small root-owned helper and namespace lifecycle | Recommended |
| Local forward proxy only | Yes for proxy traffic, but direct browser bypass remains possible | Proxy must support CONNECT/WS/SSE | Good only if DNS and all routes are forced through proxy | Medium; no root if bypass is tolerated | Rejected as sole boundary |
| OS firewall/cgroup attached to browser | Yes if applied to every browser process and child | Native WS/SSE | Strong with IPv4/IPv6 and DNS rules, but policy-to-redirect mapping is harder | High; root/CAP_BPF or CAP_NET_ADMIN, kernel-dependent | Viable fallback |
| Existing MCP/browser backend equivalent boundary | Not present in verified Playwright MCP 0.0.78 setup | Current native protocols work | No verified hard egress boundary | Low operationally | Not available |
| Bubblewrap/user namespace alone | Not proven; browser may retain an allowed network path or bypass proxy | Depends on network setup | Not sufficient without a controlled gateway/firewall | Medium; current unprivileged capability is unverified | Not sufficient alone |

### Evaluation details

The namespace/gateway option handles HTTP and HTTPS by making the gateway the
only route. HTTPS CONNECT is authorized against the requested host/port before
the tunnel is opened. HTTP redirects are evaluated by the gateway before the
next upstream request. WebSocket uses CONNECT or an equivalent proxy path and
then remains native between Chromium and the gateway. SSE remains a long-lived
HTTP response and is not buffered by Playwright.

DNS must be performed by the gateway, not by Chromium or an unrestricted
namespace resolver. The gateway must evaluate the returned IPv4 and IPv6
addresses, reject private/link-local/loopback destinations unless explicitly
allowed, and bind the approved connection to the checked answer. Re-resolution
and DNS rebinding must repeat the policy decision. Hostname, IP literal,
localhost aliases, alternate ports, IPv4-mapped IPv6 and redirects are all
normalized before the connection is authorized.

## Trust boundaries

```text
NLA model / page content
        untrusted data and intent
              |
NLA Browser capability
        typed task permissions; no host privileges
              |
Playwright MCP + Chromium
        automation only; not a security boundary
              |
Root-owned session broker
        validates descriptor; owns namespace/proxy handles
              |
Network namespace + firewall + policy gateway
        preventive egress boundary
              |
External destinations
```

The broker must authenticate the caller through the existing local process
ownership mechanism, validate an opaque session ID, and accept only a bounded
policy descriptor. It must not accept arbitrary shell commands, arbitrary nft
rules, arbitrary proxy configuration, or caller-selected privileged paths.

## Request-flow diagram

```text
Browser request (URL / redirect / subresource / WS / SSE)
        |
        v
Namespace route lookup
        |
        +-- no approved gateway route --> DENY, zero external request
        |
        v
Gateway parses effective scheme, host, port and DNS answer
        |
        +-- policy deny --> close/return bounded error, zero upstream connect
        |
        v
Gateway opens approved upstream connection
        |
        +-- redirect response --> resolve next target, policy check again
        |                         before any next upstream request
        |
        +-- approved HTTP/SSE/CONNECT/WS --> stream native bytes
```

The gateway must count an attempted destination separately from an upstream
connection. A denied request is evidence of a blocked attempt; the forbidden
fixture's server-side counter must remain zero.

## Policy representation

The Browser task continues to use logical HTTP(S) origins, but the broker
receives a canonical immutable session policy, for example:

```json
{
  "session_id": "opaque-broker-id",
  "allowed_origins": [
    {"scheme": "https", "host": "approved.example", "ports": [443]},
    {"scheme": "http", "host": "127.0.0.1", "ports": [18765]}
  ],
  "allow_private_addresses": true,
  "allow_websocket": true,
  "allow_eventsource": true,
  "allow_subresources": true,
  "allow_popups": false,
  "max_redirects": 10,
  "dns_mode": "gateway-only",
  "expires_at": "server-owned-deadline"
}
```

No wildcard should be expanded by the model. Hostnames are canonicalized with
IDNA rules, ports are explicit or scheme-defaulted, and `http`/`https` are not
interchangeable. `ws`/`wss` are mapped to the corresponding gateway policy
class but retain their transport security requirements. Private addresses are
deny-by-default and only enabled for explicitly configured development targets.

## Lifecycle and ownership

1. NLA asks the privileged broker for a session using the validated task policy.
2. The broker creates a unique namespace, veth/gateway path and proxy policy.
3. The broker starts Chromium/MCP in that namespace with an explicit proxy
   endpoint and opaque session metadata.
4. NLA receives only the MCP endpoint/session handle and starts Browser work.
5. Every browser process and child is attributed to the namespace/session.
6. Close, cancellation, timeout, backend crash and parent death revoke the
   policy, terminate the browser tree, remove routes and destroy the namespace.
7. Orphan reaping uses PID start-time identity plus broker-owned session state;
   it never kills an unverified process.

The browser context remains non-persistent by default. Recovery may terminate
an interrupted session deterministically; restoration of browser state is not
promised unless a future approved persistence design adds it.

## Failure behavior

* broker unavailable or privilege missing: Browser `BLOCKED`, reason
  `NETWORK_POLICY_UNAVAILABLE`;
* policy descriptor invalid: `POLICY_DENIED`, no namespace and no egress;
* forbidden DNS/IP/redirect: `POLICY_DENIED`, no upstream connect;
* gateway crash: active Browser task `BLOCKED`, no automatic external-action
  retry, session revoked;
* namespace or browser crash: evidence remains incomplete; fresh session may
  be created after preflight;
* uncertain upstream mutation: `INDETERMINATE`, never replayed automatically;
* cleanup failure: gate FAIL/NOT_READY, never silently converted to PASS.

## Required privileges and operational boundary

The current `next` account cannot create a network namespace or manage nftables:
the verified probes for `unshare -n` and `nft list ruleset` return
`Operation not permitted`. `bubblewrap` is installed, but its network
isolation capability has not been validated and it is not sufficient by itself
for the security invariant.

A small root-owned broker/service would need only the narrowly scoped ability to
create/delete per-session namespaces, veth routes, firewall rules and gateway
processes. It must run with a dedicated service account, private state
directory, bounded IPC socket and a systemd hardening profile. NLA and Browser
must not be granted those capabilities directly. Exact systemd/capability
configuration is an implementation task after design approval.

## Implementation scope after approval

This design deliberately does not implement the broker. The later change would
be limited to:

* a broker protocol and descriptor validator;
* a per-session namespace/gateway launcher and teardown path;
* a policy gateway with HTTP, HTTPS CONNECT, SSE and WebSocket support;
* Chromium/MCP launch wiring that cannot bypass the gateway;
* Browser preflight diagnostics for boundary identity and policy hash;
* bounded evidence for decisions, upstream connection count and cleanup;
* test fixtures and recovery tests.

The existing Browser Capability remains backend-agnostic. Playwright stays the
automation backend; the egress handle is an independent capability supplied by
the broker.

## Required tests

Before production acceptance, the broker test matrix must prove server-side
forbidden request count is exactly zero for:

* direct navigation;
* 301, 302, 303, 307 and 308 allowed-to-forbidden redirects;
* multi-hop, relative, scheme-change, port-change, hostname-change,
  IPv4/IPv6/localhost-alias and loop cases;
* post-interaction navigation and form submission;
* fetch/XHR, image/script, iframe, popup, EventSource and WebSocket;
* DNS rebinding and alternate-IP attempts.

Positive controls must prove approved HTTP/HTTPS, SSE, WebSocket, redirects,
private development targets and normal subresources still work. Tests must
record the gateway decision, resolved address family, upstream-connect count,
fixture counter, Browser evidence and cleanup result without credentials.

The existing Browser suite must then be rerun unchanged for WebSocket, SSE,
reconnect, screenshot masking, prompt injection, sequential stress and parallel
cleanup. Only after that may the deferred real backend restart, child-session
interruption, Orchestrator restart and real compaction tests run.

## Migration from Playwright-only enforcement

The current Playwright allowlist remains a defense-in-depth UX and evidence
check, but it is no longer treated as the security boundary. During migration:

1. start sessions only through the broker in `enforcement_required` mode;
2. pass the policy hash and opaque egress handle to Browser preflight;
3. keep Playwright checks for diagnostics and early denial;
4. require gateway counters for preventive security evidence;
5. fail closed if the broker handle, policy hash or namespace identity is absent;
6. remove the current production `NOT_READY` exception only after the full
   redirect/subresource matrix and reviewer acceptance pass.

There is no compatibility mode that claims production security while the
browser has a direct host-network path.

## Known limitations

The recommended architecture requires a privileged host integration and is not
portable to an arbitrary unprivileged workstation. It does not provide a
general enterprise firewall, malware sandbox, content DLP system or identity
provider. Browser credentials remain a separate policy concern. Kernel, systemd
and proxy implementation details need a follow-up implementation design and
host-specific validation. Until that work is approved and completed, the
authoritative verdict remains:

`NLA BROWSER PRODUCTION NOT READY`
