# Optional universal Browser capability

Browser is available as an optional capability. The production-gate documents
record verification evidence and remaining hardening work; they are not a
prerequisite for using the optional role in a development environment.

Browser is an optional NLA role for research, information extraction, web
application interaction, forms, and browser verification. It receives a goal,
task permissions, success criteria, and an optional session to resume through
ordinary `nla_task`. Browser acceptance is one use case, not the subsystem's
purpose.

The accepted production boundary is:

```text
Luna Orchestrator → Browser child → Browser Capability → Playwright MCP
→ Chromium inside an N1 per-session network namespace → typed evidence
```

The privileged broker is a narrow systemd service/socket component. NLA and
Browser remain unprivileged; the broker alone owns namespace/veth/nft lifecycle.
The service contract, required capabilities, fixed paths, socket ownership and
restart reconciliation are documented in
[`network-broker/SERVICE.md`](../network-broker/SERVICE.md).

```text
Browser role → Browser Capability → Backend interface → Playwright MCP
```

The backend interface is `start(policy)`, `invoke(typedOperation)`, and
`close()`. Roles use four NLA tools rather than raw backend tools. The initial
adapter is Playwright MCP; another backend can implement the same interface.

## Current vertical slice

Implemented: navigation, bounded semantic DOM/text extraction, forms
(fill/click/select/press), tabs, screenshots, explicitly granted uploads and
downloads, deterministic checks, evidence, fresh sessions, explicit resume,
model-pool routing, timeouts and cleanup.

Browser is disabled in the repository default model pool. Absent or invalid
configuration returns Browser `BLOCKED`, while ordinary NLA work continues.
NLA performs no automatic MCP or browser installation.

SSE and WebSocket transports are passed through the isolated browser context;
N1/N2 evidence covers the real browser/network boundary and zero-request
forbidden fixtures. Full traces and specialized XSS checks remain unsupported.
DOM rendering of hostile text can be inspected, but this is not a full XSS
guarantee.

## Quick start

Run from your NLA clone with Node.js 20+ and a configured OpenCode provider:

```bash
npm install --prefix "$HOME/.local/share/nla-browser" @playwright/mcp@0.0.78
node "$HOME/.local/share/nla-browser/node_modules/playwright/cli.js" install chromium
node scripts/configure-browser.mjs --model opencode-go/gpt-5.6-luna --origin https://example.com
./scripts/nla /absolute/path/to/project
```

Choose a model your account can access and replace the example origin with the
site you need. Repeat `--origin` for additional sites. The setup helper discovers
the installed Node/MCP/Chromium paths and creates private `browser.json` and
`model-pools.json` under `~/.config/nla/` (or `$XDG_CONFIG_HOME/nla/`). It enables
the Browser pool and preserves the other repository role defaults, which must
also be reviewed for provider access. Existing configuration is never overwritten;
use the manual configuration sections below to update an existing installation.

This direct backend uses isolated browser contexts. **It cannot guarantee that
forbidden destinations receive zero requests**, particularly during native
redirects. For preventive network containment, install the Linux broker below.
Browser stays optional; ordinary NLA work requires none of these dependencies.

For a first check, ask NLA: “Use Browser to open https://example.com and verify
that the page heading is Example Domain.” A successful result includes Browser
delegation and a tool-generated check. If Chromium reports missing system
libraries, run the matching package's `playwright/cli.js install-deps chromium`
as an explicit administrator action, then retry. This is separate from NLA.

## Install the optional Playwright MCP backend

Use Node.js 20 or newer and an existing browser executable. Install the
official independent MCP package explicitly, for example:

```bash
npm install --prefix ~/.local/share/nla-browser @playwright/mcp@0.0.78
node ~/.local/share/nla-browser/node_modules/@playwright/mcp/cli.js --help
```

The real development smoke used MCP 0.0.78. Pin a version you have verified;
new versions must still support the reviewed adapter operations.

If no browser is already installed, the operator can separately install the
browser version matching that Playwright package:

```bash
node ~/.local/share/nla-browser/node_modules/playwright/cli.js install chromium
```

This is an operator command, never an action performed by Browser tooling.
Determine the browser executable from the matching package or use your
existing installation:

```bash
node -e 'console.log(require(process.env.HOME + "/.local/share/nla-browser/node_modules/playwright").chromium.executablePath())'
```

## Configure NLA

Create a private operator configuration file, outside application repositories:

The direct configuration below is the portable quick start. It launches an
isolated Playwright context but does not provide the broker's OS-level egress
boundary. Use explicit `allowed_origins` and grant only the permissions needed
by the task.

```json
{
  "command": [
    "node",
    "/absolute/path/to/nla-browser/node_modules/@playwright/mcp/cli.js",
    "--headless",
    "--isolated",
    "--executable-path",
    "/absolute/path/to/browser"
  ],
  "allowed_origins": ["https://approved.example", "http://127.0.0.1:3000"],
  "timeout_ms": 30000,
  "action_timeout_ms": 5000,
  "max_sessions": 2,
  "session_ttl_ms": 600000,
  "upload_files": []
}
```

For the Linux production-style broker, first follow
[`network-broker/SERVICE.md`](../network-broker/SERVICE.md), then use this
operator override instead of a host-launched command:

```json
{
  "broker_socket": "/run/nla-browser/broker.sock",
  "broker_allow_private_addresses": false,
  "broker_allow_websocket": true,
  "allowed_origins": ["https://approved.example"],
  "timeout_ms": 30000,
  "action_timeout_ms": 5000,
  "max_sessions": 2,
  "session_ttl_ms": 600000
}
```

Set `NLA_BROWSER_CONFIG_PATH` to this file when launching NLA/OpenCode.
The broker policy is immutable per session and is enforced below Playwright
for navigation, redirects, subresources, fetch/XHR, SSE and WebSocket traffic.
`command` is operator configuration; child agents cannot choose or modify it.
The client spawns it without a shell. Only a small environment allowlist is
inherited; explicit backend environment values can be supplied through the
optional `environment` object. These values are never introspection output.

The broker service has its own fixed MCP command in
`/etc/nla-browser/network-broker.env`; start from
`network-broker/broker.env.example` and replace every absolute path. Do not
commit the resulting host configuration.

Each Browser session gets a dedicated stdio MCP process with `--isolated`.
Personal profiles, extension mode, shared contexts, initial storage-state
files, and attachment to existing CDP/browser endpoints are rejected.
The adapter verifies a blank page, one context page, and empty cookies before
accepting a fresh session.

The current adapter intentionally uses its own thin MCP client rather than
OpenCode's raw MCP tool exposure. **Do not register raw Playwright tools in the
OpenCode profile to enable this capability.** The public role sees only the
four NLA tools. Standalone HTTP MCP is supported by Playwright itself but is
not implemented by this adapter.

## Enable the model pool

Edit the existing operator model-pool file and add/enable its `browser` entry:

```json
"browser": {
  "enabled": true,
  "models": ["opencode-go/gpt-5.6-luna"],
  "idle_timeout_ms": 180000,
  "max_failovers": 0
}
```

Keep all the other role entries. An override file **replaces the complete
repository pool**, it does not merge individual roles. Confirm the effective
pool with `nla_models`. Model IDs are operator choices; the Browser implementation
does not select a fixed model.

The role follows normal model health/fallback handling. Once an interaction
may have caused a side effect, automatic restart on another model is blocked
until the outcome is verified. Backend calls never retry ambiguous mutations.

## Delegate a browser task

`nla_task` accepts role `browser`, ordinary `description` and `prompt`, plus
a `browser` JSON string. That string has this shape:

```json
{
  "goal": "Find the relevant source and extract its reported value",
  "origins": ["https://approved.example"],
  "permissions": {
    "navigation": true,
    "interaction": false,
    "authentication": false,
    "uploads": false,
    "downloads": false,
    "external_mutation": false
  },
  "success_criteria": [
    {
      "id": "source-value",
      "check": "text_contains",
      "locator": {"role": "heading", "name": "Report"},
      "expected": "Report",
      "wait_ms": 1000,
      "mandatory": true
    }
  ],
  "keep_session": false
}
```

Task origins must be a subset of operator-approved origins. The operator may
configure `allowed_origins: ["*"]` for general web work, but each task still
needs an explicit list of HTTP(S) origins. There is no unrestricted navigation
grant to the role. Requested URLs, redirects and page requests are checked.
Queries/fragments are omitted from default evidence URLs.

Permissions belong to the task:
navigation/read, interaction, authentication, uploads, downloads, and external
mutation are separate grants. Missing permissions are false. Clicks and
keypresses conservatively require both interaction and external mutation,
because the adapter cannot establish that an arbitrary application handler is
read-only. Password fields and sensitive input also require authentication.
Typing data may fire application handlers; disallowed HTTP mutation methods
are blocked, but HTTP method alone cannot prove server-side read-only behavior.
Grant interaction only when the task authorizes that interaction.

Task `upload_files` must be an exact subset of operator `upload_files`.
Downloads use generated artifact filenames. There is no arbitrary destination,
cookie export, credential extraction, JavaScript input or shell API.

## Four tools

All tools take `session_id` and a typed JSON `request` string. The child gets
the authoritative contract and operation guide in its bounded task packet.

| Tool | Operations |
| --- | --- |
| `nla_browser_session` | preflight, status, close |
| `nla_browser_observe` | bounded text, URL/title, semantic element state, console categories and network metadata |
| `nla_browser_action` | navigate, click, fill, select, press, tabs, screenshot, upload, download |
| `nla_browser_check` | text_equals, text_contains, element_visible, element_enabled, url_equals, no_console_errors, no_dialogs |

Semantic locators use exactly one of role (+ optional accessible name), label,
test_id or text. An optional tab index targets another owned page. No arbitrary
selector or code is accepted. Browser must perform child preflight before
actions. Preflight verifies a live backend call and evidence storage.

The Playwright adapter uses a fixed reviewed internal program through MCP's
code operation. Agent inputs are serialized as data. That backend operation
can execute arbitrary server code, so it is never exposed to the role or
registered as a public NLA tool. A backend lacking it returns BLOCKED.

## Sessions and cleanup

Default: fresh isolated session for every `nla_task`, closed at task end.
Set `keep_session: true` to retain a session for a bounded lease. The result
returns `session_id`; supply it explicitly in the next Browser task to resume.

Resume requires the same parent NLA session, origins, permissions and file
grants. There is no implicit resume, cross-owner access or permission escalation.
Old child bindings are revoked. Expired retained sessions are reaped;
close/dispose/cancellation/failure close only owned MCP/browser resources.
A shared browser backend is never terminated.

Live sessions are process-local. After an NLA restart, old live IDs are
unavailable and a new attempt starts fresh. Live browser processes are not
restored after a crash. The broker adds network namespaces and process cgroups;
it is not a general filesystem sandbox for the NLA account.

Logical recovery is separate from a retained live browser session. Each new
`nla_task(role=browser)` creates a runtime-generated logical task identity,
returned as `metadata.browser_task_id`. To continue that workflow after a
restart or compaction, pass `browser_task_id` to `nla_task` with the original
complete Browser contract. Only pending criteria execute. Omitting this ID
starts independent work, even if criterion names match an earlier task.
Continuing a completed task or changing its contract is rejected before effects.

NLA writes a private, authenticated runtime recovery record. It binds the owning primary session,
normalized target policy, effective grants and prohibitions, completed and
pending criteria, canonical criterion definitions, evidence references/provenance,
and the next criterion. Run-level evidence includes FAIL, BLOCKED and NOT_RUN,
not only successful checks. Separate attempts retain separate provenance.
Restart and compaction restoration validate it before execution; malformed,
missing, weakened, or unverifiable state blocks durably. The record prevents
model-authored ledger omission or mutation and accidental corruption. It does
not defend against a hostile process running with the same Unix UID, which can
read and alter NLA private state.

`nla_state`, `nla_compact`, and restore use the same evidence validation boundary.
A model snapshot cannot invent Browser evidence, borrow another owner's result,
or remove authenticated history. Restore failures leave a private durable block;
restarting the runtime does not clear it. Start a new session after resolving
the underlying storage/transport problem rather than editing evidence to resume.

Logical task execution is claimed atomically across processes before browser
allocation. Only the runtime's opaque claim owner may finalize it. Successful
terminal evidence persistence releases the claim in the same transaction.
An interrupted process or uncertain allocation may leave an `UNKNOWN` claim:
there is no timed expiry, automatic stealing, or automatic replay of potentially
completed external actions. Such a task requires operator resolution, not a
model's assertion that retry is safe. Ordinary continuation from a persisted
partial terminal result is supported.

Recovery format v2 stores authenticated task membership and history atomically.
Legacy v1 records lack the complete contract/provenance needed for safe automatic
migration and are rejected, not rewritten. Preserve old state for diagnosis;
use a separately configured private state root for a new workflow after operator
review. Abandoned storage locks also fail closed and require investigation;
do not remove them while another runtime may still be using the state root.

## Results and evidence

The runtime executes declared success criteria at task completion and computes
the result from tool facts. Model prose cannot turn FAIL into PASS. Every check
ends in PASS, FAIL, BLOCKED or NOT_RUN; mandatory blocked/unexecuted checks
prevent PASS. Infrastructure failures carry stable reason codes such as
NOT_CONFIGURED, UNREACHABLE, AUTH_REQUIRED, UNSUPPORTED_CAPABILITY,
POLICY_DENIED or RESOURCE_EXHAUSTED. Timed-out actions have UNKNOWN outcomes.

Results include structured checks, the last bounded observation, and an evidence
reference. Private artifacts live under
`NLA_MEMORY_DIR/evidence/browser/<run-id>/`, outside target repositories by
default. Manifests record the run/child IDs, browser metadata, operation/check
facts, timestamps, initial repository revision and repository state after the
run. A compact reference is added to an existing NLA ledger with the observed
HEAD; evidence is never silently rebound to a newer revision.

Console diagnostics contain categories/counts rather than raw messages.
Network metadata excludes headers and bodies; typed input is redacted from
evidence. Screenshots and downloads may themselves contain sensitive data:
they remain private artifacts. Screenshots use a bounded viewport, artifacts
are limited to 10 MB after capture, pages to four, observations to 12,000
characters and runs to 100 operations. Artifact byte limits are post-capture,
not a disk/memory sandbox. Session leases are bounded; evidence retention is
operator-managed in this slice.

The intended v1 policy covers top-level navigation, HTTP(S) subresources,
EventSource, WebSocket, forms, iframes and popups. The N1 network boundary is
authoritative: forbidden fixture request counters must remain zero even when
Playwright routing is bypassed. Service workers are blocked. This facade is
not a substitute for the OS/network boundary; page content remains untrusted
data throughout the role's work.

## Verification

Mandatory checks are bound to their original check type, locator and expected
value, not only their ID. A child cannot substitute another condition under
the same ID. Closing the session before final verification produces BLOCKED;
return normally and let NLA perform final checks and cleanup.

Checks have an internal deadline even when `wait_ms` is omitted (default
1,000 ms, maximum 10,000 ms). An unsatisfied condition ends as FAIL inside
the backend, without waiting for the MCP transport timeout.

```bash
npm run test:browser
npm run test:nla
```

Opt-in real smoke with existing installations:

```bash
NLA_SMOKE_MCP_CLI=/absolute/path/to/@playwright/mcp/cli.js \
NLA_SMOKE_BROWSER_EXECUTABLE=/absolute/path/to/browser \
node tests/opencode/smoke-nla-browser.mjs
```

The smoke uses its own local fixture services and verifies research/extraction,
interaction/forms, explicit resume, fresh state, and policy-denial reporting.
Direct mode reports observed forbidden requests and does not certify preventive
containment. To require zero requests, also set
`NLA_SMOKE_BROKER_SOCKET=/run/nla-browser/broker.sock`; that mode uses the installed
broker's fixed MCP command and asserts the forbidden fixture counter is zero.
It neither visits production applications nor installs browser software.

For the final model-driven integration gate, configure the actual launcher
with an enabled private Browser pool and backend policy permitting the local
fixture origin `http://127.0.0.1:18765`. Then explicitly opt into model usage:

```bash
NLA_SMOKE_MODEL_E2E=1 NLA_SMOKE_LAUNCHER=/absolute/path/to/nla \
  node tests/opencode/smoke-nla-browser-model.mjs
```

This test asks the Orchestrator a normal browser task, verifies actual
`nla_task(role=browser)` delegation, an unseen value extracted through the
Browser child, tool-produced checks/evidence and the Orchestrator's final
answer. It is optional and never part of mandatory offline CI.

Official references:

- [Playwright MCP getting started](https://playwright.dev/docs/getting-started-mcp)
- [Playwright MCP configuration](https://playwright.dev/mcp/configuration/options)
- [Playwright MCP profile and state](https://playwright.dev/mcp/configuration/user-profile)
