# NLA Browser Capability — Discovery and Implementation Decisions

Status: universal Browser contract and initial vertical slice implemented.
Optional NLA infrastructure, independent of PickleShell and target projects.
No automatic installation or host configuration changes.

## Extension points and backend discovery

The OpenCode plugin already owns nla_task, child sessions, tool ceilings,
model resolution/health, task ledgers and revision-bound verification.
The SDK offers tool discovery but no direct MCP invocation API. A thin
stdio JSON-RPC MCP client therefore invokes the operator-configured backend.

Existing Playwright MCP 0.0.78 and Chromium 151.0.7922.10 were reused for local
smokes only. Their host paths are not repository dependencies.
Startup discovers required MCP operations, creates an isolated empty context
and verifies evidence storage. The bound Browser child must perform live
preflight itself; configured does not mean available.

## Universal architecture

```text
nla_task(role=browser, goal + permissions + criteria + optional session)
  → Browser role
  → Browser Capability
  → Backend interface (start / invoke / close)
  → Playwright MCP (initial adapter)
```

Four bounded tools: nla_browser_session, nla_browser_observe,
nla_browser_action, nla_browser_check. Research, extraction, forms and browser
verification use the same task contract. Browser is not a testing subsystem.
Reviewer and Browser acceptance remain independent when both are required.
Browser does not edit application source or repair its own acceptance findings.

## Permissions and target policy

The role ceiling and wildcard denial exclude shell, source writes, deployment,
unrelated MCP tools and arbitrary JavaScript. Tasks separately grant navigation,
interaction, authentication, uploads, downloads and external mutation.
Click/key submission is conservatively gated by external mutation.
Origins and upload paths must fit explicit operator policy.

The adapter invokes only reviewed fixed code; children cannot supply code.
Page content remains untrusted data. HTTP requests enforce origin/method
policy. Navigation redirects are checked before each next request. Resource
redirects, WebSockets and service workers are blocked in this slice.
These controls do not replace OS/container network isolation.

## Ownership and cleanup

Each fresh task reserves an owned isolated MCP process/context. Explicit
resume requires the same parent and identical grants; previous children lose
access. Capacity is reserved before startup. Retained sessions have bounded
TTL. Abort, error, close and plugin disposal clean only owned resources.
Private MCP temporary output is removed on close. Personal profiles and
shared browser attachment are prohibited.

## Evidence and revision

External private manifests hold run/child IDs, observed starting revision,
post-run repository facts, operations, deterministic checks and artifacts.
The existing ledger retains compact evidence references tied to the starting
HEAD, never silently validating a newer revision.

Checks return PASS / FAIL / BLOCKED / NOT_RUN; model prose cannot override
tool truth. Ambiguous interactions are not replayed on model fallback.
Console categories replace raw messages; headers/bodies are omitted and
typed inputs are redacted. Screenshots/downloads may contain sensitive data.

## Changed modules and tests

- nla-browser.mjs: contract, ownership, permissions, evidence and checks.
- nla-browser-mcp.mjs: bounded stdio transport and process cleanup.
- nla-browser-playwright.mjs: initial backend and reviewed operations.
- Existing plugin, optimizer, role config and pool integrate optional Browser.
- docs/BROWSER.md: manual installation, configuration and delegated examples.
- Focused fixtures: lifecycle, ownership, resume, permissions, deterministic
  truth, redaction, cancellation, concurrent capacity and nla_task dispatch.
- Opt-in real smokes: research/extraction, form interaction/screenshot,
  retained storage versus fresh isolation, allowed and forbidden redirects.

## Verified boundary and remaining work

Real MCP → browser → local target is verified. Child dispatch and four-tool
permissions are covered by OpenCode client fixtures and an opt-in live Luna
Orchestrator → nla_task Browser → Playwright MCP → evidence → Orchestrator run.
The Browser extracted an unseen marker from a local DOM; the Orchestrator
returned that marker and the tool-generated PASS evidence.

This is the initial working vertical slice, not every original v1 feature.
SSE/WebSocket observation, reconnect probes, comprehensive hostile-content
checks, full traces and crash-persistent resource recovery remain unsupported.
Artifact byte limits are post-capture; retention is operator-managed. The
browser process is not a security sandbox.

## Local verification

- `npm run test:browser`: PASS, including abort, concurrent capacity,
  private temporary-output cleanup and no fallback replay after mutation.
- `npm run test:nla`: PASS.
- `bash tests/opencode/run-tests.sh`: 3 PASS, 0 FAIL (without paid integration).
- `opencode debug config`: real plugin loaded; Browser is a subagent with
  wildcard denial and exactly four permitted NLA browser tools.
- Opt-in real Playwright MCP smokes: research, form, resume/fresh isolation and
  forbidden redirect prevention PASS against local fixture servers.
- Node syntax checks and `git diff --check`: PASS.
- Python focused tests in the next test virtual environment: 6 PASS.
- Live model-driven Browser gate through the actual operator launcher: PASS.

## Correctness follow-up

Required criteria are bound to their check type, locator and expected value.
Changing an assertion under its ID is denied; closing the Browser before final
checks cannot manufacture PASS. A focused regression covers this scenario.
The backend has its own finite deadline even without wait_ms; tests exercise
eventual PASS, persistent FAIL and omitted-wait FAIL without transport timeout.

The operator's private Browser pool, backend config and actual launcher were
verified together. The nla_task argument describes the exact JSON contract so
the Orchestrator does not need shell/file inspection to delegate correctly.
No further Browser features were added for this readiness gate.
