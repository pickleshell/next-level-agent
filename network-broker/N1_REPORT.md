# NLA Browser Network Boundary — N1 Report

Date: 2026-09-18

## Current gate

N1 PASS — Network Boundary Ready

N2/N3 and recovery were not started.

## Implemented primitive

network-broker/main.go provides a root-run Unix-socket broker with only typed
create, status, and destroy operations. The policy is validated inside the
broker. Session access is bound to the Unix peer UID and an opaque session
token. The caller cannot provide commands, nftables rules, routes, namespace
names, or arbitrary processes.

Each session creates:

* a distinct Linux network namespace;
* a per-session veth pair and IPv4 subnet;
* a namespace nft output chain with default drop;
* one namespace egress rule for the broker's ephemeral proxy port;
* one narrow host INPUT rule for that session veth and proxy port;
* a policy-aware HTTP/CONNECT gateway.

Destroy removes the namespace, host veth, host rule, and broker session.

## Fresh evidence

Unit and static checks:

* GO111MODULE=off go test ./network-broker — PASS;
* GO111MODULE=off go vet ./network-broker — PASS;
* git diff --check — PASS.

Real root-capable host checks:

* namespace/veth/nft creation — PASS;
* allowed HTTP fixture through the namespace — PASS;
* direct forbidden destination — POLICY_DENIED, no upstream request — PASS;
* 301, 302, 303, 307, 308 allowed-to-forbidden redirects — all denied before
  the forbidden fixture — PASS;
* forbidden fixture request counter — absent/zero — PASS;
* wrong token cannot destroy a session — PASS;
* correct token destroys session — PASS;
* 12 sequential/parallel create-use-destroy sessions — PASS;
* final broker-owned namespaces, veths, and host INPUT rules — zero.
* direct IPv4 traffic from the namespace without the proxy — blocked;
* direct connection to the proxy host on a non-proxy port — blocked;
* IPv6 literal policy — rejected fail-closed;
* IPv6 direct connection from the namespace — no route/connection;
* unapproved localhost hostname alias — POLICY_DENIED;
* HTTPS allowed CONNECT — PASS;
* HTTPS redirect to forbidden port — second CONNECT denied before upstream
  connection; forbidden HTTPS fixture counter — zero.
* controlled DNS rebinding unit fixture — initial address pinned, changed
  address rejected before connect — PASS;
* broker SIGKILL followed by restart — stale namespace, veth, and host rule
  reaped — PASS;
* production service/socket contract — documented, not installed — PASS.

## Remaining N1 gate work

The following have not been represented by fresh PASS evidence and therefore
remain blockers:

* the production service must replace the socket GID placeholder and enforce
  singleton activation before installation. This is an operational deployment
  gate, not a gap in the tested primitive.
* broker restart/orphan reaping tests — PASS after adding broker-prefix stale
  reaping; this remains an operational singleton-service requirement.

The broker does not claim these protections yet. In particular, passing the
HTTP redirect tests must not be interpreted as protection for opaque HTTPS
redirects.

## Decision

N1 is ready for a separately gated N2 integration. N2/N3, recovery, and
production Browser acceptance remain unstarted.

The separate review is recorded in SECURITY_REVIEW.md and gives an explicit
N1 ACCEPT for the tested boundary. The production service/socket contract is
documented but intentionally not installed in this experimental worktree.
