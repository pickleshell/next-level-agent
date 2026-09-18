# NLA Browser network broker — N1

This directory contains the first independent network-boundary primitive. It
is deliberately separate from NLA and Playwright. The broker is a privileged
process; its client receives only a typed session descriptor and an opaque
session token.

The broker accepts only:

* create with a validated list of explicit HTTP/HTTPS origins and ports;
* status for the token-owned session;
* destroy for the token-owned session.

It does not accept commands, shell fragments, nftables rules, routes, namespace
names, or arbitrary processes. The namespace has no direct external route. Its
only permitted TCP egress is to the broker's per-session proxy address. The
proxy performs one upstream HTTP request at a time and returns redirects to the
client; the next request is checked before any upstream connection is opened.
CONNECT is supported for native WebSocket/HTTPS transport, but redirect
inspection inside an opaque TLS tunnel is not claimed by N1.

## Development run

Build without adding a repository-wide Go module:

~~~bash
GO111MODULE=off go build -o /tmp/nlabridged ./network-broker
sudo /tmp/nlabridged serve /run/nla/browser-network.sock
~~~

The production unit must create a root-owned socket whose group is the
dedicated unprivileged NLA service group. Do not grant NLA CAP_NET_ADMIN,
unshare, nftables, or unrestricted sudo.

## N1 acceptance

N1 requires a real root-capable Linux host. A deterministic fixture must record
server-side request counts. For each of 301, 302, 303, 307, and 308
allowed-to-forbidden redirects, the forbidden fixture must remain at:

~~~text
request_count == 0
~~~

Also verify direct allowed access, direct forbidden denial, multihop
redirects, port/hostname/IP changes, and destroy cleanup (ip netns list,
veths, nft rules, and broker helpers).

This primitive is not yet an NLA Browser integration. N2/N3 and production
recovery remain gated on an independent security review and on a real browser
being launched inside the session boundary.
