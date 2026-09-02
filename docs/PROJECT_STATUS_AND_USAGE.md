# Project Status and Usage

This document describes the current operational status of Next Level Agent, the supported way to run it against a project, known limitations, data locations, model configuration, telemetry, evidence from real runs, and the focused roadmap for NLA Core.

For architecture and roles, start with the main [README](../README.md). For the original design, read [Draft 0.4](../TECHNICAL_SPECIFICATION.md). For a detailed comparison between that draft and the current implementation, read the [implementation status audit](DRAFT_0_4_IMPLEMENTATION_STATUS.md).

## Status

**Current maturity: Alpha, active development**

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

## Requirements

- OpenCode installed and available on `PATH`;
- provider authentication configured through OpenCode;
- at least one working model assigned to the primary `nla` agent;
- at least one available model in every enabled role pool;
- a persistent OpenCode TUI or server for controlled compaction;
- a stable local clone of this repository;
- Git for repository work and normal NLA workflows.

API keys and provider credentials do not belong in this repository, model-pool configuration, ledger, Notebook, or telemetry.

## Running NLA Against a Project

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

Model pools are configured in [`config/model-pools.json`](../config/model-pools.json).

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
    "idle_timeout_ms": 300000,
    "max_failovers": 1
  }
}
```

Rules:

- models are tried in order;
- the first entry is preferred;
- the next entry is the bounded fallback;
- `max_failovers` prevents retry loops;
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
      "max_failovers": 0,
      "output_format": "json"
    }
  }
}
```

`provider.api` may be `native` or `openai-compatible`. `models` remains an
ordered bounded pool, and `max_failovers` limits additional attempts. Every
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

### Session ledger

```text
~/.local/share/nla/sessions/<session-id>.json
```

The ledger stores the goal, Tier, stage, acceptance criteria, approved decisions, completed and active work, changed files, verification, blockers, pending gate, and exact next step.

### Assistant Notebook

```text
~/.local/share/nla/assistant-notebook/
```

Notebook contains compact durable knowledge and retrieval cues. It must not contain transcripts, secrets, raw logs, or speculative completion claims.

### Runtime telemetry

```text
<project>/.opencode/agent-run.log
```

Telemetry records lifecycle metadata such as sessions, models, tool events, failover, context usage, and compaction. It does not intentionally copy prompts, model replies, or tool output.

NLA creates private state directories with mode `0700` and state files with mode `0600`. Writes use atomic replacement. Obvious secret assignments are rejected, but this is not a complete secret scanner. Users remain responsible for keeping credentials out of memory and logs.

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
- Mem0 is not an NLA-supported integration. Testing Mem0 or other external
  memory systems is separate work and is not an NLA Alpha release gate;
- NLA is not a sandbox and does not replace operating-system security boundaries.

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

## Contributing

Useful contributions include:

- OpenCode runtime fixes;
- role-permission hardening;
- Task Context Packet validation;
- workflow transition checks;
- behavioral and end-to-end tests;
- model-pool integrations and deterministic failure fixtures;
- telemetry analysis tools;

Do not claim support for a model, OpenCode version, operating system, or CLI based only on configuration files being present. Provide end-to-end evidence that routing, tools, child sessions, failover, memory, compaction, restoration, and final acceptance work together.

## Updating NLA

The current development installation is a Git clone. Review changes before updating, then pull the desired branch or pinned commit:

```bash
git -C "$HOME/.local/share/nla/next-level-agent" pull --ff-only
```

Restart OpenCode after updating plugin, skills, or configuration files. Re-run a startup smoke test and inspect `opencode debug config` after OpenCode upgrades or model changes.
