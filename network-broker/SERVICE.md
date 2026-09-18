# Broker service contract

This file is an installation contract, not an installation action. The
experimental worktree does not install or enable a system service.

Create a dedicated nla-browser group and run the broker as UID 0 with only
the capabilities required to create/delete the per-session namespace and
install its policy. The NLA account must be a member of that group, but must
not receive sudo, CAP_NET_ADMIN, unshare, or nftables access.

Install the reviewed binary at:

/usr/local/libexec/nlabridged

Create /run/nla-browser root-owned, mode 0750, group nla-browser, and use
the supplied systemd unit. The socket must be root-owned, group
nla-browser, mode 0660. The unit's fixed environment must set
NLA_BROKER_SOCKET_GID to the numeric GID of that group; the sample value
0 is not suitable for deployment and is intentionally not enabled here.

The broker is a singleton. A second instance must not be started against the
same host. On every startup it reaps only resources carrying the broker's
nla- / nlah- ownership prefixes, then creates the Unix socket. Startup
failure is fail-closed: no Browser process is launched.

The NLA client may send only typed JSON create/status/destroy requests. The
broker authenticates the Unix peer with SO_PEERCRED and additionally requires
the opaque session token for status/destroy. Browser policy is immutable for
the lifetime of a session.
