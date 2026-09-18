# NLA Browser production gate

Browser user-testing readiness is distinct from production readiness.
The production gate is closed only if every mandatory check in all four
layers was exercised and passed. FAIL, BLOCKED, NOT_RUN or a missing layer
prevents production PASS. A model summary cannot change the tool evidence.

## Required coverage

| Layer | Required scenarios | Evidence |
| --- | --- | --- |
| Functional acceptance | Navigation, tabs, semantic DOM, click/fill/select/keyboard, finite waits, screenshots, live DOM, SSE/WebSocket, reconnect, allowed/forbidden redirects, SPA, console errors and timeouts | Browser/tool observations, deterministic assertions and per-task manifests |
| Isolation/security | Fresh cookie/storage contexts, concurrent isolation, target policy and redirect escape, file denial, upload/download grants and denial, live prompt injection, credential-free evidence, Browser tool denial for shell/write/sudo | Owned-context checks, request counters, private canaries, actual child tool profile and adversarial model smoke |
| Failure/recovery | Backend/browser/page crash, MCP EOF, target unavailability, malformed HTML, slow/hung pages, retained-session expiry, orphan cleanup, actual Orchestrator/Browser restart and persistent compaction/recovery | Fault injection limited to owned fixtures; blocked outcomes cannot become PASS |
| Repeated use | At least 30 sequential tasks (default 40), six two-session concurrent batches, resource-cap denial, contexts/processes/FD/heap/RSS cleanup | Baseline/final/peak samples and tracked owned process identities |

An expected policy denial or expected blocked crash outcome is a PASS for the
safety test only when the deterministic assertions confirm that behavior.
The underlying Browser task remains BLOCKED. Assertion failures are gate FAIL,
not infrastructure BLOCKED.

## Run

Use Linux, Node 20+, an existing Playwright MCP package and an existing matching
Chromium executable. The gate never installs software or changes host networking.

```bash
npm run test:browser:gate-result

NLA_SMOKE_MCP_CLI=/absolute/path/to/@playwright/mcp/cli.js \
NLA_SMOKE_BROWSER_EXECUTABLE=/absolute/path/to/chrome \
NLA_PRODUCTION_TASKS=40 \
npm run test:browser:production
```

Local HTTP fixtures use ephemeral loopback ports. The optional paid adversarial
model smoke uses the actual NLA launcher and its private target policy. Enable
it explicitly; that policy must permit `http://127.0.0.1:18765`:

```bash
NLA_PRODUCTION_MODEL_TEST=1 \
NLA_SMOKE_LAUNCHER=/absolute/path/to/nla \
NLA_SMOKE_MCP_CLI=/absolute/path/to/@playwright/mcp/cli.js \
NLA_SMOKE_BROWSER_EXECUTABLE=/absolute/path/to/chrome \
npm run test:browser:production
```

Reports, screenshots, downloads and model transcripts are private artifacts
outside source repositories. The runner prints the report path.
Exit status 0 means production PASS; 2 means the gate is not closed.
Absent dependencies produce a structured BLOCKED report.

The report records the starting Git revision **and worktree facts**. Results
from a dirty checkout must not be relabelled as validation of a different commit.
Optional model outputs remain private and are not added to offline CI.

## Resource and cleanup limits

Warm up three tasks before measuring. Default budgets: final runner FD count
no more than baseline +2, retained heap growth at most 16 MiB and runner RSS
growth at most 64 MiB. Every measured Browser session must remove its owned
MCP output directory and process tree. Captured PID/start-time pairs prevent
PID reuse from being mistaken for an owned process.

If fixture resources outlive cleanup, the gate records the failure before
terminating only positively identified owned resources. Cleanup never turns
that failed check into PASS. Samples cover a bounded repeated run and two
parallel sessions, not an indefinite service lifetime. Browser contexts are
measured through real owned backend lifecycles and processes, not only an
in-memory registry count.

## Current open production gates

The adapter now preserves approved SSE responses and proxies approved
WebSockets through the isolated context. The production fixture still needs
to exercise message delivery, disconnect/reconnect and backend failure while
those connections are active before this layer can be marked PASS.
Fresh/retained context tests do not substitute for actual persistent OpenCode
Orchestrator restart, child restart or compaction/recovery experiments.
These unexecuted experiments remain NOT_RUN.

Manifests redact typed values, omit raw console messages, credentials,
headers and bodies, and normalize network URL metadata. Screenshots mask
password inputs and DOM regions marked or named as secret/token/API-key/auth
fields. The policy must continue to be tested with secret-bearing fixtures;
private storage alone is not proof of secret-free image content.

A successful basic model smoke or the repeated-use layer does not close the
remaining mandatory gates. Until those are implemented/exercised, the verdict
must remain:

`NLA BROWSER PRODUCTION NOT READY`
