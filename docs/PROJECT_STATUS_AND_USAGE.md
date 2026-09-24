# Project Status and Usage

This document describes the current operational status of Next Level Agent, the supported way to run it against a project, known limitations, data locations, model configuration, telemetry, evidence from real runs, and the focused roadmap for NLA Core.

For architecture and roles, start with the main [README](../README.md). For the original design, read [Draft 0.4](../TECHNICAL_SPECIFICATION.md). For a detailed comparison between that draft and the current implementation, read the [implementation status audit](DRAFT_0_4_IMPLEMENTATION_STATUS.md).

## Status

**Current maturity: Alpha, active development**

The canonical NLA release is `0.1.0-alpha.2`, tagged
`nla-v0.1.0-alpha.2`. NLA release identity is stored in
[`nla-version.json`](../nla-version.json) and is intentionally separate from the
inherited Superpowers `6.3.0` package and harness-manifest metadata.

The core NLA workflow is operational and has passed real end-to-end tests. NLA can classify work, create specialized child sessions, use role-specific model pools, fail over after model rejection, maintain a private workflow ledger, use Assistant Notebook, run controlled compaction, restore the same primary session, and emit structured telemetry.

NLA is not yet production-ready as a hardened security boundary. Some role restrictions are behavioral contracts in prompts rather than a complete least-privilege permission matrix. The full guard, validator, hard budget enforcement, and managed installation system proposed in Draft 0.4 are not implemented.

## Supported Environment

NLA is currently developed and tested specifically for OpenCode.

| Component | Current status |
| --- | --- |
| Runtime | OpenCode |
| Current locally installed OpenCode | `1.18.9` |
| Historical Draft 0.4 target | `1.17.9` |
| Primary development platform | Linux |
| Persistent TUI/server | Required for controlled post-response compaction |
| Other coding-agent CLIs | Not tested or guaranteed |

The Draft 0.4 version is historical and should not be interpreted as the current tested runtime version. OpenCode is evolving, so compatibility should be verified after every runtime upgrade.

If you need another coding-agent CLI, you are welcome to implement and test the corresponding integration. Support should not be claimed until the complete NLA workflow, tools, memory, failover, compaction, and restoration have passed an end-to-end test on that CLI.

## Requirements

- OpenCode installed and available on `PATH`;
- provider authentication configured through OpenCode;
- at least one working model assigned to the primary `nla` agent;
- at least one available model in every enabled role pool;
- a persistent OpenCode TUI or server for controlled compaction;
- a stable local clone of this repository;
- Git for repository work and normal Superpowers workflows.

API keys and provider credentials do not belong in this repository, model-pool configuration, ledger, Notebook, or telemetry.

## Terminology

| Term | Meaning |
| --- | --- |
| Orchestrator / coordinator | The primary NLA agent: owns the user goal, approvals, delegation, shared state, and final acceptance. It is not a model pool or an orchestra. |
| Orchestra | A named, durable set of role pools and policies. Exactly one is active for new NLA tasks. `go` is seeded from the pool file; other named orchestras live in the private system database. |
| Role | A bounded responsibility such as Explorer, Architect, Implementer, or Reviewer. A child role receives a task packet and uses its own model pool. |
| Model pool | The candidate models and routing rules assigned to one role in an orchestra. A pool has a `selection_mode` and, for `select`, a selection policy. |
| `fallback` | Tries the pool's fixed `models` array in order after a retryable failure. |
| `select` | Filters and ranks candidates using role/task requirements, model facts, scores, policy, and health; a failed choice can be followed by another eligible candidate. |
| `auto` | The `models` value for a dynamic agent `select` pool. At task start, enabled registry bindings are intersected with the OpenCode provider inventory and frozen as that task's candidate list. It is not a model binding. |
| Model binding | An exact `provider/model` ID, such as `openai/gpt-5.6-luna`. Provider names alone are not pool entries or health identities. |
| Registry, inventory, facts, evaluations | The registry stores bindings and operator/runtime facts (for example context and price); the OpenCode inventory says which bindings the runtime exposes; evaluations store quality observations. Inventory presence is not a live endpoint check. |
| Model health | Temporary runtime eligibility such as cooldown or quarantine after an attempt. It is separate from durable registry status (`enabled`/`disabled`) and quality scores. |

## Runtime truth

On first startup, the model-pool resolver seeds the `go` orchestra using a
request/runtime override when supplied, `NLA_MODEL_POOLS_PATH`, or the
repository default. Overrides are complete pool files and invalid overrides
fail closed. The active orchestra then lives in `system.sqlite`; `go` can be
refreshed explicitly from its file with `nla_models_reload`, while other named
orchestras reload from the database. Startup telemetry records the source
without secrets. `nla_models` reports the active roles consumed by `nla_task`.
New tasks use a switched or reloaded snapshot; active child tasks retain theirs.
`nla_work_state` reports a reconciled ledger.

The pool file seeds the named `go` orchestra and remains its explicit reload
source. Named orchestras, their active selection, and all other role pools are
durable in `system.sqlite`. `nla_orchestra` lists, shows, proposes, creates,
updates, changes one role pool with `pool_set`, and activates them. Switching
affects new tasks; existing child tasks keep their resolved model list.
`models: "auto"` is allowed for agent `select`
pools and resolves enabled registry records found in the current OpenCode
provider inventory at task start. It retains `auto` in storage, and the
concrete candidate list is retained by the task for failover. Provider
inventory presence alone does not prove the endpoint will answer. An unavailable
inventory blocks new auto tasks. The coordinator model is updated for new
OpenCode sessions; the current coordinator response is not replaced.

The saved orchestra owns role membership, order, and mode. Its facts seed new model
bindings once; SQLite then owns model facts and empirical scores. Registry
imports therefore affect subsequent `select` choices without changing pool
membership and survive `nla_models_reload`. The typed setting
`routing.selection_policy.<select-role>` persists a `go` role's default policy;
`routing.selection_policy.<orchestra>.<select-role>` does so for another orchestra;
`nla_model_policy` changes only the current process.

On first NLA use, missing context limits and input/output prices are filled from
OpenCode's resolved `/config/providers` inventory and persisted in SQLite.
`nla_models_reload` refreshes this discovery, including after a failed request.
Discovery runs after plugin initialization, is bounded to five seconds, and
coalesces concurrent requests. With fixed pools it fills absent fields for
configured non-utility bindings; an auto pool also discovers provider models.
Existing facts (including zero prices), operator imports,
evaluations, and notes remain authoritative. No provider credentials are stored.
Inventory presence is not proof of live model availability. When discovery is
unavailable, existing facts remain intact and unknown context still fails the
selector's context requirement; inspect `model_inventory_unavailable` in the
run log, correct provider configuration, and run `nla_models_reload`.

For fixed pools the ordered `models` array is the complete attempt budget. An
auto pool materializes an array at task start; its length is that task's attempt
budget. There is no separate `max_failovers` or model-count field.

Work State has two authority classes. NLA owns intent and semantic fields such
as goals, approvals, workflow stage, acceptance criteria, blockers, and planned
next steps. Git owns observable repository facts: branch, HEAD, clean/dirty
status, changed files, and commits since a recorded ancestor. Reconciliation is
performed on session restore, detailed-state inspection, and ledger saves. It
preserves conflicts rather than inferring completion from a changed HEAD.

Verification evidence is revision-bound. Evidence recorded for an older HEAD is
retained as historical evidence and marked non-current after HEAD advances;
tests are not represented as validating a newer revision unless run there.

> Introspection must describe the configuration NLA actually executes, and persisted Work State must be reconciled with observable repository state before it is treated as current.

## Running NLA Against a Project

### Optional browser work

Browser is an optional universal role for research, extraction, web interaction
and browser verification through ordinary `nla_task`. It is disabled by default.
An operator-configured backend and task-owned permissions are required; NLA
does not install browser software or grant unrestricted web access itself.
The initial backend is Playwright MCP behind four bounded NLA tools.
See [Browser setup and boundaries](BROWSER.md) for installation, target policy,
isolated sessions, explicit resume, evidence and unsupported streaming probes.

### Project launch

There is no transactional installer in the current NLA Core. The supported development setup uses OpenCode's custom-config mechanism and keeps the NLA clone in a stable location.

Clone NLA once:

```bash
git clone https://github.com/pickleshell/next-level-agent.git "$HOME/.local/share/nla/next-level-agent"
```

Run OpenCode against your project with the checked-in NLA configuration:

```bash
export OPENCODE_CONFIG="$HOME/.local/share/nla/next-level-agent/opencode.json"
opencode /absolute/path/to/your/project
```

OpenCode resolves the relative plugin and skill paths from the custom configuration file location. The project passed to `opencode` remains the working project.

OpenCode merges configuration sources. A target project's own `opencode.json`, `.opencode` directory, global configuration, or managed configuration may alter or override NLA settings. The current alpha does not provide the Draft 0.4 validator that proves the final resolved configuration. Inspect the result before relying on it:

```bash
OPENCODE_CONFIG="$HOME/.local/share/nla/next-level-agent/opencode.json" \
  opencode debug config
```

Do not overwrite an existing global or project configuration merely to install NLA. Preserve user configuration and resolve conflicts deliberately.

### Demo inside the NLA repository

For a basic smoke test only:

```bash
git clone https://github.com/pickleshell/next-level-agent.git
cd next-level-agent
opencode
```

This proves that the checked-in configuration can load. It is not the normal way to work on an unrelated project.

## Healthy Startup

A healthy session should show the `nla` primary agent and load the `next-level-agent` bootstrap skill before answering.

The effective configuration should include:

- `default_agent: nla`;
- the local `next-level-agent.js` plugin;
- the repository `skills` path;
- the configured role catalog;
- automatic compaction and pruning;
- the expected model bindings.

## What Controls What

NLA is not implemented by prompts alone.

| Layer | Responsibility |
| --- | --- |
| Superpowers skills | Brainstorming, planning, TDD, debugging, review, verification, worktrees, and branch completion discipline |
| NLA coordinator prompt and bootstrap skill | Role identity, routing policy, gates, sequencing, and behavioral contracts |
| NLA OpenCode plugin | Child sessions, role model pools, failover, session graph, private ledger, Notebook tools, controlled compaction, restoration, and telemetry |
| OpenCode runtime | Models, provider access, tools, sessions, permissions, native summarization, and user interface |

Prompts explain what a role should do. The plugin provides the operational mechanisms that make NLA a managed multi-agent system.

## Example Workflow

Consider a request to add resumable uploads to an existing service.

```text
User describes the feature
→ NLA classifies it as Tier 3
→ Explorer maps the current upload path
→ Scout checks applicable storage or protocol documentation when needed
→ Architect compares viable designs
→ NLA discusses the recommendation with the user
→ the user approves the design
→ NLA creates the implementation plan
→ Implementer changes the scoped files and runs checks
→ Reviewer independently evaluates the diff and evidence
→ Supervisor checks completion state
→ NLA checkpoints and reports the accepted result
```

For a small one-file correction, NLA should select Tier 1, make the bounded edit directly, verify it, and avoid the cost of creating a team.

## Evidence from a Real Compaction Run

A real persistent OpenCode test demonstrated the following sequence:

- one primary NLA session remained the root throughout the task;
- the primary model was recorded by telemetry;
- Supervisor and Compactor ran in separate child sessions linked to the same root;
- effective context before controlled compaction was recorded as 17,762 tokens;
- native OpenCode compaction completed;
- the structured ledger was restored into the same primary session;
- NLA returned the correct remembered README heading without reading the file again.

The validation response began with:

```text
TELEMETRY_COMPACT_OK
```

The response also contained the correct legacy README heading. This test verified continuity at that point in project history. The heading has since changed, but the restoration result remains valid evidence for the tested session.

## Tool-schema Prefill Finding

A forensic OpenCode comparison exposed a separate source of local-model
latency: the tool catalog itself. With the full toolset enabled, OpenCode
injected approximately 16.7k prompt tokens of schemas for 31 tools before
useful user content. With `tools: false`, the prompt was approximately 126
tokens and local `qwen3:4b` became fast.

These measurements do not imply that tool-less agents are the general answer;
tool-using work still needs the appropriate capabilities. They show that
eagerly exposing every tool can make schema prefill and context consumption
dominate a small model's execution before it begins the useful task.

The 31-tool/~16.7k-token result is a forensic OpenCode snapshot from the full
runtime surface. It is separate from the checked-in native Ollama benchmark
below, which resolved 16 endpoint entries, excluded one internal error sentinel,
and compared a reproducible 15-tool catalog by serialized schema bytes. The two
measurements must not be combined or presented as the same cohort.

The implemented architecture is dynamic prompt optimization per step:

- target a shortlist of 2–5 relevant tools rather than all 31;
- keep Router focused on task and model routing (Tier, roles, gates, budgets,
  and model class/pool);
- broaden Compactor beyond context compression so it also shapes bounded
  prompts and prunes or shortlists tool schemas before model invocation;
- do not introduce a separate Selector role.

Reducing 31 schemas to a small shortlist is intended to cut tool-schema prefill
and context use by roughly an order of magnitude. The benefit is most important
for small/local models, but may also reduce latency and input cost for cloud
models. `nla_task` now computes the shortlist before creating a tool-using
OpenCode child prompt and passes `{"*": false, ...shortlistAllows}` through
OpenCode's native per-prompt tool map. The bounded prompt remains unchanged.
Tool-free roles and explicitly tool-free steps receive only the wildcard deny.

Role capability discovery has a small persistent cache at
`.opencode/nla-role-capabilities.json` in the target project. It stores tool IDs
and schema hashes, not prompts or tool output. Entries are invalidated by the
NLA cache format/version, role pool and model configuration, expected role
ceiling, or any relevant resolved OpenCode schema change. Corrupt entries are
treated as misses. A hit reuses the stable role profile, after which Compactor
may only narrow it for the current bounded step. Required capabilities missing
from the live catalog fail closed; cache failure never exposes the catalog.

Compactor's optimization may remove redundant context and narrow capabilities,
but it must preserve task meaning, acceptance criteria, safety constraints,
permissions, and provenance. It cannot add tools forbidden to the target role.
Tool-free work receives no schemas. If Compactor is unavailable or returns an
invalid optimization, NLA falls back to a conservative deterministic subset
derived from the role and bounded step, never automatically to all tools. If no
safe sufficient subset can be determined, NLA fails closed and requests
clarification, re-routes the step, or chooses a more capable model/runtime.

### qwen3:4b development-workstation measurement (2026-09-01)

The reproducible benchmark is
[`tests/opencode/benchmark-nla-tool-shortlist.mjs`](../tests/opencode/benchmark-nla-tool-shortlist.mjs),
with raw results in
[`docs/nla-qwen3-4b-tool-shortlist-2026-09-01.json`](nla-qwen3-4b-tool-shortlist-2026-09-01.json).
It used the same bounded Implementer prompt for both native Ollama requests.
The current OpenCode 1.18.9 endpoint resolved 16 entries; the benchmark omitted
the internal `invalid` error sentinel, leaving a 15-tool full baseline, and
compared it with `read`, `edit`, `write`, and `bash`.

The full baseline serialized 25,419 schema bytes and failed in all three runs
with Ollama HTTP 500 `unexpected EOF` after 11.8–14.2 seconds. Because the
provider failed before producing a response, it reported no prompt token count;
the raw result records that value as null rather than inventing an estimate.
The four-tool shortlist serialized 9,998 schema bytes, completed all three
runs, and consistently reported 2,215 prompt tokens. Wall time was 3.0 seconds
with a warm retained model and about 13.5 seconds when Ollama reloaded or
re-prefilled it. No request reached the 30-second benchmark timeout. This is a
provider compatibility/failure comparison as well as a size comparison; it is
not evidence of a successful full-catalog latency value.

### Real `nla_task` E2E (2026-09-02)

The raw evidence is
[`docs/nla-shortlist-e2e-2026-09-02.json`](nla-shortlist-e2e-2026-09-02.json).
On OpenCode 1.18.9, NLA dispatched a real Explorer child through `nla_task`.
The child session permission state was exactly wildcard deny followed by allows
for `read`, `grep`, and `glob`; it executed only `read`, returned
`# Next Level Agent`, reported no file changes, and completed successfully on
`opencode/mimo-v2.5-free`.

The same full OpenCode child flow with local `qwen3:4b` received the same
three-tool shortlist but timed out after 120 seconds. This preserves the
existing distinction between success in bounded native Ollama calls and the
larger OpenCode agent loop. It does not weaken or bypass the shortlist policy.

## Model Pools

### Per-model Compactor prompt optimization

The Compactor pool accepts `prompt_optimization` with `enabled` (default true)
and `exclude_models` (default empty). Entries match exact target provider/model
IDs or a prefix ending in `*`, such as `ollama/*`. The policy is evaluated for
each actual child-model attempt, including fallbacks. Excluded models skip the
utility Compactor call and retain the deterministic tool shortlist and original
bounded prompt. Invalid policies reject the invocation rather than broaden tools.
This setting does not disable recovery checkpoints or OpenCode native compaction.
Omitting the policy preserves the previous behavior. Example:

```json
"prompt_optimization": {
  "exclude_models": ["ollama/*", "opencode/mimo-v2.5-free"]
}
```


The [`config/model-pools.json`](../config/model-pools.json) file supplies the
`go` orchestra; other named orchestras are configured through `nla_orchestra`
and stored in SQLite.

NLA keeps one process-local health manager for child and utility invocations.
Rate limits, overloads, transient network errors, and bounded timeouts place a
binding in a 30-second cooldown by default; `cooldown_ms`, environment policy,
and a valid provider Retry-After may extend that delay. Missing or retired
bindings and authorization/configuration failures are quarantined instead of
being treated as transient overload. Numeric and HTTP-date `Retry-After` values
can extend, but not shorten, the configured cooldown. Caller cancellation does
not poison health. Claims are exclusive per binding and released on local
failure; watchdog continuations retain their claim until idle/error, not merely
until the asynchronous request is accepted. Utility endpoint identities include
the runtime/API and complete URL and are hashed before introspection. Reset is
primary-only, validates configured bindings, and rejects in-flight targets.
Diagnostics contain bounded reason codes rather than raw provider errors.
Unavailable pools expose a structured error with actual attempt count and retry
or reset information. These rules are covered by deterministic manager,
utility-runtime and public plugin-tool/event regression tests.

### Model-pool preflight

The resolver fails closed on malformed role pools before dispatch. Every binding
must have a provider and model component, may not repeat its provider prefix in
the model component, and may not appear twice in one role. Run the offline
preflight before a long task:

```bash
node scripts/nla-model-pools-preflight.mjs --pools /absolute/path/to/model-pools.json
```

The optional `--available-models` JSON inventory adds an exact runtime-binding
check. The offline preflight does not query providers or infer availability
from a similar model name. Thus a configured
`provider-a/model-x` remains blocked if the supplied runtime inventory
contains only `provider-b/model-x`.

Quarantined bindings are excluded rather than
being retried on every cooldown cycle. Cooling or quarantined models are
excluded before actual-call failover budgets are applied. If every model is
cooling, NLA reports the earliest retry time without making a request. If every
model is quarantined, an explicit exact-binding reset/probe is required.
Successful recovery clears cooldown. The state resets when the NLA process
restarts and is visible through model introspection and private telemetry.

Set `NLA_MODEL_POOLS_PATH` to an absolute path (or a path beginning with `~`) to
load a complete machine-local pool file instead. If unset, NLA uses the
repository default. This supports local provider experiments without committing
machine-specific role bindings.

```json
{
  "architect": {
    "enabled": true,
    "models": [
      "preferred/provider-model",
      "fallback/provider-model"
    ],
    "idle_timeout_ms": 300000
  }
}
```

Rules:

- models are tried in order;
- the first entry is preferred;
- the following entries are ordered fallbacks;
- every listed model may be attempted in order until one succeeds;
- each role has its own timeout;
- the same child session is retained across a supported failover;
- the visible primary NLA session does not silently switch models;
- every attempt, failure, fallback, and success is logged.

Compactor follows these same role-pool rules and is not tied to a particular
provider or model. Its intelligent structured checkpoint is optional: omit or
disable the `compactor` pool for deterministic-only compaction. Model
unavailability, timeout/error, or invalid output automatically retains the
already-saved deterministic ledger, after which native compaction and restore
continue normally.

Model suitability depends on the execution class, not only the role name. A
model can succeed on a narrow direct Ollama task yet perform poorly in a full
OpenCode agent loop because system instructions, tool protocols, repository
context, and workflow participation add overhead. That observation supports a
separate utility runtime; it does not establish that the model is a capable
general coding agent.

### Utility-model runtime

NLA has two intended execution classes:

- the **agent runtime** uses OpenCode child sessions for roles that need
  multi-step reasoning, tools, repository navigation, or workflow
  participation;
- the **utility-model runtime** makes a bounded single-shot call, without an
  agent loop or tools, when orchestration supplies the complete packet and
  input data.

This separation deliberately creates a useful place for local, small, cheap, or
specialized models. It is not a workaround for one model. A role pool selects
the second class with `runtime: "utility"`; pools without that setting retain
the OpenCode agent runtime. Compactor is the first proven lifecycle consumer.
Explorer may use the utility runtime only for supplied-data analysis; repository
navigation or tool use requires the agent runtime. This claim does not extend
to Router.

The runtime supports Ollama over non-streaming HTTP (native or
OpenAI-compatible chat API) and generic OpenAI-compatible chat-completions
endpoints. Endpoint joining preserves a base URL path prefix. Pools can bound
OpenAI-compatible hidden reasoning and output with `reasoning_effort` and
`max_output_tokens`; these settings are optional and provider support varies.
Development-workstation validation showed that a direct native Ollama
`qwen3:4b` Compactor completed the lifecycle and restoration continued in the
same session with the expected continuation marker.
Native Ollama diagnostics were also much faster than the OpenAI-compatible
path. The runtime reads only answer content and never mistakes a `thinking` or
`reasoning` field for the answer.

Keep host-specific bindings in a complete external pool file selected with
`NLA_MODEL_POOLS_PATH`. The following is a focused excerpt; retain the other
required roles, especially Supervisor, in the complete file:

```json
{
  "version": 1,
  "roles": {
    "compactor": {
      "enabled": true,
      "runtime": "utility",
      "backend": "ollama",
      "provider": {
        "api": "native",
        "base_url": "http://127.0.0.1:11434"
      },
      "models": ["qwen3:4b"],
      "request_timeout_ms": 90000,
      "output_format": "json"
    }
  }
}
```

`provider.api` may be `native` or `openai-compatible`. `models` remains an
ordered fallback pool; every listed model may be attempted. Every
utility request has an explicit positive `request_timeout_ms`. `output_format`
is optional for general bounded roles; Compactor should use `json`.

For a generic OpenAI-compatible endpoint, use `backend: "openai-compatible"`,
`provider.api: "openai-compatible"`, and the endpoint's base URL. On
2026-09-02, a development workstation exercised OpenCode's free inference endpoint with
`nemotron-3.5-lightning-free`, `reasoning_effort: "none"`, and
`max_output_tokens: 1024`. A real `nla_task` shortlist call completed in 0.599 s
with 139 prompt and 9 completion tokens, selecting only `read` and `grep` from
the Explorer's `read`/`grep`/`glob` ceiling. The child permission map denied
`*` and allowed only those two tools, and the child completed. A meaningful
checkpoint call completed in 7.378 s with 396 prompt and 291 completion tokens
(687 total, 0 reasoning), produced an intelligent checkpoint, survived native
compaction, and restored the exact next step. The endpoint reported no
monetary-cost field (`null`); OpenCode recorded zero cost for the free-model
sessions.

The sanitized raw measurement record is
[`docs/nla-free-cloud-compactor-2026-09-02.json`](nla-free-cloud-compactor-2026-09-02.json).
It includes the bounded utility configuration, tool permissions, wall times,
token telemetry, cost fields, checkpoint outcome, and fallback observation,
without real session IDs, host identifiers, credentials, or private paths.

This free endpoint is useful experimental evidence, not an availability SLA:
other free models returned rate limits or upstream errors during preflight.
With a 256-token cap, the same checkpoint was truncated and correctly used the
deterministic-ledger fallback; 1024 tokens was sufficient for the tested
ledger. Local `qwen3:4b` previously took 9.703 s for the comparable utility
checkpoint on the same workstation and timed out at 120 s in the full
child-agent loop. The
cloud result isolates that local latency from the Compactor architecture, but
does not make a cloud provider a runtime dependency.

Compactor validates the returned checkpoint against the deterministic ledger.
A missing model, HTTP error, timeout, invalid response, or checkpoint that
changes protected facts produces the existing deterministic-ledger fallback.
Supervisor does not use this optional path during controlled compaction: its
audit still runs through the configured OpenCode pool and any Supervisor error
or block stops compaction fail-closed.

The public Architect pool starts with the smoke-tested
`opencode/mimo-v2.5-free` and retains one bounded fallback. HTTP rejection and
failover behavior are exercised with deterministic fixtures rather than a
deliberately broken live default. Provider health is still installation-specific.

## Local Data and Privacy

### System database and session ledger

```text
~/.local/share/nla/system.sqlite
```

The private database stores system settings, model facts and scores, temporary
model-health state, privacy-preserving model usage accounting, workflow ledgers, and fail-closed restore blocks. The
ledger stores the goal, Tier, stage, acceptance criteria, approved decisions,
completed and active work, changed files, verification, blockers, pending gate,
and exact next step. Existing `sessions/<session-id>.json` and
`restore-blocked/<session-id>.json` files are legacy migration inputs, not the
live source of truth after migration. A malformed legacy evaluation JSON stops
initial migration; NLA does not silently replace accumulated observations with
seed scores.

Primary NLA can inspect the table map and status with `nla_system` (`schema`,
`status`), list or set supported non-secret settings, and create or list named
operator databases and typed tables. The writable operational settings are
`operator_databases.enabled` (boolean) and
`routing.selection_policy.<select-role>` (`quality`, `balanced`, `cost`);
`operator.*` is non-secret metadata. Unsupported operational settings are
rejected. `nla_models_registry` lists, shows, and imports exact model bindings
with facts, initial scores, and notes from interactive JSON or a project-local
file. Importing an unassigned model does not put it into a role pool. Neither
tool exposes arbitrary SQL or row-level CRUD for operator tables.

`model_usage_events` stores one row per completed OpenCode assistant message
when OpenCode provides token accounting: exact model binding, role and session
lineage, input/output/reasoning/cache token counts, total, cost, and finish
reason. It intentionally stores neither prompt text nor model output. The
primary coordinator reads only its current workflow tree through `nla_usage`:
`summary` groups totals by role/model and `recent` lists completed requests.

Browser recovery retains its separate verified filesystem artifacts, witness,
and lock; it was not moved into SQLite.

### Assistant Notebook

```text
~/.local/share/nla/assistant-notebook/
```

Notebook contains compact durable knowledge and retrieval cues. It must not contain transcripts, secrets, raw logs, or speculative completion claims.

### Runtime telemetry

```text
<project>/.opencode/agent-run.log
```

Telemetry records lifecycle metadata such as sessions, models, per-request token/cache/cost accounting, tool events, failover, context usage, and compaction. It does not intentionally copy prompts, model replies, or tool output.

NLA sanitizes its telemetry at the write boundary: command, prompt, request,
response, environment and header fields are omitted, and common secret
assignments are redacted. This does not alter OpenCode's own `opencode.log` or
other host-level logging outside this repository's control.

NLA creates private state directories with mode `0700` and state files with mode `0600`. SQLite provides transactional updates for system data; filesystem artifacts use atomic replacement where applicable. Obvious secret assignments are rejected, but this is not a complete secret scanner. Users remain responsible for keeping credentials out of memory and logs.

## Reading Telemetry

Find failed model attempts:

```bash
rg '"event":"model_attempt_failed"' .opencode/agent-run.log
```

Find model failover:

```bash
rg '"event":"model_fallback_started"' .opencode/agent-run.log
```

Find compaction and restoration:

```bash
rg '"event":"(compaction_started|context_compacted|context_restored|context_after_compaction)"' \
  .opencode/agent-run.log
```

Follow completed model usage live (the same records are durable in SQLite):

```bash
tail -f .opencode/agent-run.log | jq -c 'select(.event == "model_usage")'
```

Trace a complete task tree:

```bash
rg '"root_session_id":"ses_your_root_id"' .opencode/agent-run.log
```

Distinguish session behavior:

- a new root `session_id` means a new primary session;
- a child ID with the same `root_session_id` is a subagent;
- normal compaction retains the primary `session_id`;
- `session_observed` means the plugin attached to an existing session;
- `session_model_bound` records the effective provider and model.

## Known Limitations

- NLA is supported only on OpenCode at present.
- Linux is the primary tested platform.
- some role boundaries are enforced by prompts rather than a complete hard permission matrix;
- the mandatory `profile-guard` proposed in Draft 0.4 is not implemented;
- strict Task Context Packet schema and size validation are not implemented;
- hard token, call, time, and monetary budgets are not enforced;
- Compactor runtime optimization currently prunes tool schemas only for child
  invocations made through `nla_task`; raw OpenCode `task`, selectable `build`
  or `plan`, and other non-NLA prompt paths are outside this control;
- prompt-text rewriting is not implemented; NLA deliberately passes the
  bounded task packet through unchanged while pruning schemas;
- capability cache invalidation still requires fetching and hashing the
  role-relevant resolved schemas; the cache avoids rebuilding the stable role
  profile, not the OpenCode catalog query itself;
- selectable `build` and `plan` agents can bypass the NLA coordinator;
- global, project, remote, or managed OpenCode configuration may alter the resolved profile;
- there is no transactional installer, drift detector, or deterministic profile validator;
- controlled compaction requires a persistent TUI or server;
- one-shot `opencode run` may exit before the idle-boundary compaction pipeline completes;
- the inherited Superpowers OpenCode test runner still contains fork-specific
  bootstrap-layout assumptions in two old tests;
- specifically, `test-plugin-loading.sh` and `test-bootstrap-caching.sh`
  require `skills/using-superpowers/SKILL.md`, which is absent from the
  NLA fork; these legacy harness tests are not part of the deterministic NLA CI
  gate and their incompatibility is documented rather than hidden;
- role model quality and provider availability are installation-specific;
- the Mem0 tools plugin is included and enabled by default, but its external
  Mem0 service, extraction provider, local embedder, and persistent stores are
  optional operator-managed dependencies; their availability is not required
  for ordinary NLA startup or non-Mem0 workflows;
- NLA is not a sandbox and does not replace operating-system security boundaries.
- NLA rejects common full-environment dump commands, nested shell launchers,
  and direct `sudo`/`doas`/`runuser`/`su` commands for NLA-managed sessions,
  but OpenCode exposes `bash` as a coarse capability and this is not a complete
  command parser or shell sandbox. Do not rely on it to protect secrets or to
  contain a process that already has elevated operating-system privileges.
- External-directory controls are not a privilege boundary when the operator
  grants the runtime `sudo`, another privileged shell, or broad filesystem
  access. Do not grant NLA/OpenCode sudo for acceptance runs; use a dedicated
  unprivileged account and a task-owned worktree. This alpha does not enforce
  canonical path containment or prevent a privileged user from bypassing it.

For a full requirement-by-requirement analysis, read [Draft 0.4 Implementation Status](DRAFT_0_4_IMPLEMENTATION_STATUS.md).

## Focused Roadmap

The next milestone is reliability of NLA Core, not expansion of the installer.

1. Enforce hard read-only and delegation permissions for specialized roles.
2. Add a strict Task Context Packet validator to `nla_task`.
3. Prevent optional agents from bypassing the NLA coordinator in an NLA-only profile.
4. Machine-check approval, verification, review, checkpoint, and completion transitions.
5. Exercise Supervisor gates on multiple real Tier 2 and Tier 3 tasks.
6. Run a small practical benchmark across five to ten representative tasks.
7. Extend measurements of implemented Compactor shortlisting across supported
   providers and consider safe prompt-text optimization separately.
8. Add independently tested CLI integrations only when contributors need them.

The installer, managed launcher, immutable snapshots, complete guard, and statistical economic benchmark remain a separate possible product named NLA Managed Profile. They are deferred unless distribution, untrusted projects, or enterprise governance creates a real requirement.

## Contributing

Useful contributions include:

- OpenCode runtime fixes;
- role-permission hardening;
- Task Context Packet validation;
- workflow transition checks;
- behavioral and end-to-end tests;
- model-pool integrations and deterministic failure fixtures;
- telemetry analysis tools;
- independently tested integrations for other coding-agent CLIs.

Do not claim support for a model, OpenCode version, operating system, or CLI based only on configuration files being present. Provide end-to-end evidence that routing, tools, child sessions, failover, memory, compaction, restoration, and final acceptance work together.

## Updating NLA

The current development installation is a Git clone. Review changes before updating, then pull the desired branch or pinned commit:

```bash
git -C "$HOME/.local/share/nla/next-level-agent" pull --ff-only
```

Restart OpenCode after updating plugin, skills, or configuration files. Re-run a startup smoke test and inspect `opencode debug config` after OpenCode upgrades or model changes.
