# N2 Security Review

Review mode: read-only second-pass review of the N2 implementation and fresh
fixture evidence. No source or service installation was performed by the
review pass.

## Scope checked

* broker `launch` accepts only owned session ID/token;
* fixed command comes from service/operator configuration, not NLA input;
* missing session-proxy placeholder fails closed;
* `/usr/bin/setpriv` drops to the peer UID/GID after namespace entry;
* browser receives a fixed minimal environment;
* browser process topology is inside the session network namespace;
* proxy is the only permitted namespace egress;
* HTTPS and WebSocket CONNECT authorization is explicit and scheme-aware;
* redirect, forbidden subresource, popup, form, SSE and WebSocket counters;
* MCP socket ownership, session token ownership and destroy cleanup;
* no host-network fallback on launch or backend interruption.

## Findings

No blocker or major finding remains for the N2 boundary. Two integration
defects found during this gate were fixed and retested: privileged `ip
netns exec` was previously demoted too early, and HTTPS CONNECT was incorrectly
coupled to the WebSocket flag. The final implementation enters the namespace
as broker root and demotes only the approved child; HTTPS CONNECT requires an
explicit HTTPS origin, while WebSocket CONNECT additionally requires the
explicit WebSocket policy.

## Evidence reviewed

* Chromium/MCP UID/GID `1010/1010` and common session netns inode;
* HTTP and HTTPS browser navigation PASS;
* SSE two-delivery reconnect and WebSocket two-connection/two-message fixture;
* forbidden fixture request count `0` across navigation, redirects,
  fetch/XHR, subresources, iframe, popup, form, EventSource and WebSocket;
* 30 sequential and four parallel sessions with zero leaked namespaces;
* MCP kill and N1 session destroy both produced controlled `UNREACHABLE`, with
  a fresh session succeeding;
* Go race/vet, NLA Node suite and diff checks PASS.

## Verdict

**N2 ACCEPT**

This verdict is limited to the real-browser/N1 boundary gate. It does not
approve N3 NLA role integration, production systemd installation, or public
publication.
