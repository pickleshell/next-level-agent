# N1 broker security review

Review type: separate read-only security pass over the broker primitive and
fresh root-capable smoke evidence. This is not a production approval.

## Findings

### PASS

* No request field is passed to a privileged shell. Privileged argv are fixed
  broker operations; session names and interface names are derived from broker
  random IDs.
* Policy input contains origins and ports only. Arbitrary nftables rules,
  routes, namespace commands, executable paths, or environment are not
  accepted.
* Session mutation requires both the Unix peer UID and the session token.
  Wrong-token destroy was exercised.
* Namespace output is default-drop and permits only the session proxy port.
  Direct IPv4 access without the proxy and direct access to another host port
  were blocked.
* IPv6 policy literals are rejected and the namespace has no IPv6 route.
  IPv6 answers are skipped by the gateway, so an IPv6-only resolution fails
  closed.
* Hostname policy is exact; localhost alias and unapproved port tests were
  denied. Resolved IPv4 addresses are checked before dialing, and the dial is
  made to the checked address rather than re-resolving after authorization.
* HTTP redirects are returned without following upstream. The next request is
  checked before its upstream connection. HTTPS CONNECT redirects require a
  second CONNECT, which is checked before the forbidden upstream connection.
* Setup failures return before the browser-side boundary is usable. There is
  no host-network fallback.
* Broker startup reaps only broker-prefixed stale namespaces, veths, and
  INPUT rules. SIGKILL/restart cleanup was exercised.
* go test -race, go vet, policy unit tests, direct bypass tests, redirect
  tests, and session cleanup tests passed.

### Remaining findings

* The systemd deployment must create the Unix socket with the dedicated NLA
  service group. The development broker deliberately leaves the socket root
  owned; it must not be made world-accessible.
* DNS resolution is pinned at session creation and checked again before each
  connect. Controlled rebinding and IPv6-only resolution fail closed.
* max_redirects has a finite default of 10 and a hard session counter. Each
  destination still passes the independent policy check.
* A singleton broker service must be enforced operationally; starting a second
  broker against the same host policy namespace can reap the first broker's
  stale-prefix resources. This is fail-closed but must be documented in the
  service unit.

## Review verdict

N1 security boundary behavior: ACCEPT for the tested IPv4/HTTP/CONNECT
primitive.

Production Browser gate: not assessed. The remaining service/socket deployment
contract must be configured before installation, but it does not change the
N1 primitive verdict.
