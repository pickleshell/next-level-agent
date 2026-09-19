# NLA Browser network broker — N1/N2

This directory contains the first independent network-boundary primitive. It
is deliberately separate from NLA and Playwright. The broker is a privileged
process; its client receives only a typed session descriptor and an opaque
session token.

The broker accepts only:

* create with a validated list of explicit HTTP/HTTPS origins and ports;
* status for the token-owned session;
* destroy for the token-owned session.
* launch of the fixed, operator-approved Browser MCP command for the
  token-owned session.

It does not accept commands, shell fragments, nftables rules, routes, namespace
names, or arbitrary processes. The namespace has no direct external route. Its
only permitted TCP egress is to the broker's per-session proxy address. The
proxy performs one upstream HTTP request at a time and returns redirects to the
client; the next request is checked before any upstream connection is opened.
CONNECT is supported for native WebSocket/HTTPS transport, but redirect
inspection inside an opaque TLS tunnel is not claimed by N1.

## N2 real-browser launch

The `launch` operation accepts only a session ID and token. It does not accept
an executable, arguments, shell text, or environment from NLA. The broker
reads a fixed operator/service configuration from
`NLA_BROWSER_MCP_COMMAND_JSON`, requires the literal
`__NLA_SESSION_PROXY__` placeholder, substitutes only the current session's
proxy endpoint, enters the session namespace, and then drops to the peer UID
and GID with `/usr/bin/setpriv` before starting MCP/Chromium. The command is
given a minimal fixed environment (`HOME=/home/next`, `TMPDIR=/tmp` and a
fixed PATH); the broker never passes its privileged operator environment to
the browser.

The browser-side command must therefore include, as a fixed service argument,
an equivalent of:

~~~text
--proxy-server __NLA_SESSION_PROXY__
~~~

If the placeholder is absent, launch fails closed. A browser process is never
started with host networking as a fallback. The per-session MCP Unix socket is
owned by the requesting peer and is removed during session teardown.

## Development run

Build without adding a repository-wide Go module:

~~~bash
GO111MODULE=off go build -o /tmp/nlabridged ./network-broker
sudo /tmp/nlabridged serve /run/nla-browser/broker.sock
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

This primitive is used by the optional NLA Browser capability. The complete
role-facing setup, Playwright MCP configuration, permissions, sessions,
evidence, and operational limits are documented in `docs/BROWSER.md`.
Production-style installation is documented in `network-broker/SERVICE.md`.
