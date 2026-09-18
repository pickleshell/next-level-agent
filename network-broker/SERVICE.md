# Broker service contract

This file is the installation and operations contract. The production-style
units described here are installed on the BOS test host for the gated NLA
Browser service; repository changes still do not perform installation or
enablement automatically.

Create a dedicated nla-browser group and run the broker as UID 0 with only
the capabilities required to create/delete the per-session namespace and
install its policy. The NLA account must be a member of that group, but must
not receive sudo, CAP_NET_ADMIN, unshare, or nftables access.

Install the reviewed binary at:

/usr/local/libexec/nlabridged

Create `/run/nla-browser` with the supplied tmpfiles entry: root-owned, mode
0751, group `nla-browser`, and use the supplied systemd service and socket
units. The socket must be root-owned,
group nla-browser, mode 0660. The socket unit owns the path and passes one
validated listener to the broker through systemd socket activation.

The broker is a singleton. A second instance must not be started against the
same host. On every startup it reaps only resources carrying the broker's
nla- / nlah- ownership prefixes and the fixed `nla-mcp-*.sock` endpoint
prefix. Startup
failure is fail-closed: no Browser process is launched.

Broker-child stderr is forwarded to the service journal through a 16 KiB
per-process bounded writer. Browser stdout, page content, credentials, and
tokens are not logged.

The NLA client may send only typed JSON create/status/destroy/launch requests.
Launch accepts only the owned session ID and opaque token; the fixed browser
command and its minimal environment are service configuration, never client
input. The broker authenticates the Unix peer with SO_PEERCRED and additionally
requires the opaque session token for status/destroy/launch. Browser policy is
immutable for the lifetime of a session. The configured command must contain
`__NLA_SESSION_PROXY__`; the broker substitutes the current session proxy and
fails closed if the placeholder is absent.

The service retains `CAP_NET_ADMIN` and `CAP_NET_RAW` because it creates the
namespace/veth and installs the nft policy, and `CAP_SYS_ADMIN` because the
current `ip netns add` lifecycle must mount and manage `/run/netns`, and
`CAP_CHOWN` is required to hand each MCP socket to its requesting NLA UID.
`CAP_SETUID` and `CAP_SETGID` are required for the fixed child privilege
drop.
These are the only retained capabilities; NLA and Browser receive no
sudo, CAP_NET_ADMIN, unshare, nftables, or arbitrary-command authority.
`PrivateTmp` is intentionally not enabled: the broker publishes per-session
MCP Unix sockets in `/run/nla-browser` so the unprivileged NLA client can
connect to them. That directory is fixed and restricted; each MCP socket is
owned by the requesting NLA UID and removed during session teardown.

`ProtectSystem`, `ProtectHome`, `ProtectKernelTunables`,
`ProtectKernelModules`, and `ProtectControlGroups` are intentionally omitted.
`ReadWritePaths` is also intentionally omitted because it creates mount setup
even without `ProtectSystem`. These directives (and any implicit private mount namespace) are incompatible
with the current shared-netns lifecycle. The
current `ip netns add` implementation creates a bind-mounted namespace under
`/run/netns`; systemd mount-namespace hardening would make that reference
private to the broker and cause child `ip netns exec` to fail. The broker is
instead constrained by its fixed executable/config paths, capability bounding,
address-family allowlist, fixed socket ownership, and typed protocol. The
browser child itself is started by `setpriv --no-new-privs` after the fixed
UID/GID drop. The broker cannot set `NoNewPrivileges` at its own level because
that would prohibit the required root-to-NLA UID transition. A future
namespace implementation that does not rely on shared
`/run/netns` may re-enable those directives after a dedicated test.

`RestrictSUIDSGID` is also omitted because the broker must perform its one
fixed `setpriv` UID/GID drop; the child-side `--no-new-privs` flag prevents
that browser process from gaining privileges afterward.
