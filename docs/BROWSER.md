# Optional universal Browser capability

Browser is an optional NLA role for research, information extraction, web
application interaction, forms, and browser verification. It receives a goal,
task permissions, success criteria, and an optional session to resume through
ordinary `nla_task`. Browser acceptance is one use case, not the subsystem's
purpose.

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

SSE, WebSocket, reconnect, full traces and specialized XSS checks are **not
implemented in this slice**. The adapter blocks WebSockets and uses buffered
HTTP interception; streaming pages are not supported. Report
`UNSUPPORTED_CAPABILITY`/BLOCKED for these requirements. DOM rendering of
hostile text can be inspected, but this is not a full XSS guarantee.

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

Set `NLA_BROWSER_CONFIG_PATH` to this file when launching NLA/OpenCode.
`command` is operator configuration; child agents cannot choose or modify it.
The client spawns it without a shell. Only a small environment allowlist is
inherited; explicit backend environment values can be supplied through the
optional `environment` object. These values are never introspection output.

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

Sessions are process-local. After an NLA restart, old IDs are unavailable and
a new task starts fresh. This slice does not restore live browser processes
after an OS crash or provide a system-level process sandbox.

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

Non-navigation resource redirects are blocked. Service workers are blocked.
Streaming transports and network isolation need further backend work; this facade is not a
substitute for OS/container network policy. Page content remains untrusted
data throughout the role's work.

## Verification

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
interaction/forms, explicit resume, fresh state, and forbidden redirects.
It neither visits production applications nor installs browser software.

Official references:

- [Playwright MCP getting started](https://playwright.dev/docs/getting-started-mcp)
- [Playwright MCP configuration](https://playwright.dev/mcp/configuration/options)
- [Playwright MCP profile and state](https://playwright.dev/mcp/configuration/user-profile)
