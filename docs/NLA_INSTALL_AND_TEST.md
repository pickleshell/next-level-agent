# Next Level Agent — Installation + Testing

Base: Superpowers (https://github.com/obra/superpowers, commit b36e082)
Plugin: `next-level-agent` (`.codex-plugin/plugin.json`)

## Installation

The authoritative OpenCode profile is the checked-in [`opencode.json`](../opencode.json). It declares the local NLA plugin, the `nla` default agent, primary agents, subagents, model bindings, and `./skills`.

Run it from the repository root:

```bash
git clone <NLA-repository-url> next-level-agent
cd next-level-agent
opencode
```

A healthy new session shows:

```text
> nla · hy3-free
→ Skill "next-level-agent"
```

No provider credentials are stored in this repository. Configure authentication in the user OpenCode profile. That global profile is an installation target; this repository is the source of truth.

### User-selectable agents

| Agent | Model | Purpose |
| --- | --- | --- |
| `nla` | `opencode/hy3-free` | Default workflow: skills, routing, delegation, acceptance |
| `build` | `openrouter/thinkingmachines/inkling:free` | Direct implementation |
| `plan` | `openrouter/thinkingmachines/inkling:free` | Planning without implementation |

`router` and all other configured roles are internal subagents. The approved
implementation route is `explorer → implementer → reviewer`. New or ambiguous
requests enter `brainstorming` first. On the architectural path, brainstorming
must complete the Architect gate described below before `writing-plans`.

### Tier routing

| Tier | Use | Route |
| --- | --- | --- |
| 0 | Direct answer or focused read-only exploration | NLA works directly |
| 1 | Small, bounded edit | Direct change plus targeted verification |
| 2 | Non-trivial implementation | Explore → implement → verify → independent review when required → checkpoint |
| 3 | High-risk or architectural work | Clarify → Explorer → Architect → discuss and approve design → writing-plans → implement → verify → independent review → checkpoint |

### Architect in Tier 3 brainstorming

NLA owns the conversation with the user. After it clarifies the goal,
constraints, and success criteria, it dispatches a bounded read-only Explorer
through `nla_task`. NLA then gives the clarified requirements and complete
Explorer report to Architect, also through `nla_task`.

Architect returns an architecture decision packet containing 2-3 viable
approaches, a recommendation, component boundaries, interfaces, data flow,
failure handling, testing strategy, risks, and acceptance criteria. Architect
does not question the user, edit files, write code, or create the implementation
plan. NLA presents and discusses the result with the user.

The first Architect design pass is mandatory for Tier 3. A second validation
pass is required only when the selected or revised design materially changes
component boundaries, interfaces, data flow, dependencies, or major risks.
`writing-plans` is blocked until a successful Architect design report exists
and the user explicitly approves the resulting written design.

## Testing

### Unit Tests
- `pytest tests/test_compact_checkpoint.py` (checkpoint save/load, threshold 50000)
- `pytest tests/test_model_pools.py` (pool ordering, bounded failover, and disabled primary fallback)
- `pytest tests/test_nla_integration.py` (full workflow: checkpoint → compact → pool → restore)

### Production Behavior (Phase 2)
- Real compression: `python3 -c "from compact.compact import compress_context; print(compress_context({'messages':['test']*100000,'summary':'test'}, 50000))"`
- File log: `cat .logs/compact.log` (structured JSON events)
- Timestamp checkpoint: `ls .checkpoints/*.json`
- Restore: `python3 -c "from compact.restore import load_latest_checkpoint; print(load_latest_checkpoint())"`
- Plugin identity: `cat .codex-plugin/plugin.json | grep name`
- Skill integration: read `skills/subagent-driven-development/` templates (reference `config/model-pools.json`)

### Evidence Before Completion
- Run `tests/` full suite.
- Confirm `.checkpoints/` has timestamped `.json` files.
- Confirm `.logs/compact.log` exists with event types (`compact`, `checkpoint_save`, `checkpoint_restore`, `token_threshold_exceeded`).
- Confirm eight enabled subagent pools and the deliberately disabled primary
  `nla` pool in `config/model-pools.json`; every enabled pool has one fallback
  and `max_failovers: 1`.

## Run log

NLA writes newline-delimited JSON to `.opencode/agent-run.log` in the target project. Entries are emitted by OpenCode hooks, not authored by the model. They record timestamps, session and call identifiers, primary-agent selection, skill calls, subagent dispatch, and subagent completion. Prompts, tool output, and model replies are not written.

## Verification Log
- `docs/superpowers/plans/verification-log.md` (updated after Phase 2; 30/31 PASS before fix; fix applied in `debbbe1`)
- `docs/superpowers/plans/phase2/plan.md` (Phase 2 scope: A-G completed)

## Ruling / Deferred (from spec self-review)
- Full session-monitor integration (automatic trigger at 50000 tokens during real agent session) — deferred; framework present, manual/test trigger verified.
- `.opencode/plugins/nla.json` created; full harness bootstrap load verified separately.

## Model pools

NLA model pools are implemented by the local plugin, not by prompts. NLA uses
the `nla_task` tool for configured subagents. The tool creates the child session
first, then tries the role's ordered model list in that same session. This makes
early model rejection (`404`, `410`, `Model not found`, or model end-of-life),
retryable provider failure (`429`, `5xx`, network failure), and role-specific
timeout eligible for fallback. It records each attempt and fallback in
`.opencode/agent-run.log`.

The raw OpenCode `task` tool is not pool-safe for early rejection because it
selects the agent model before the child task becomes controllable by the NLA
plugin. NLA therefore uses `nla_task` for every pooled role.

A pool has exactly one fallback in `config/model-pools.json`; this prevents
loops and uncontrolled billed usage. The primary NLA session has no automatic
fallback: it remains visible to the user. Inkling is intentionally not a
long-running subagent fallback because the gtop test exposed repeated upstream
504 responses.

The public Architect pool is currently ordered as:

```text
opencode/mimo-v2.5-free
→ opencode/hy3-free
```

Both entries were usable during the documented development smoke tests, but
free-provider availability is external and must be verified during installation.
Provider rejection, including HTTP 410, remains covered by deterministic test
fixtures; public defaults do not intentionally call a broken live endpoint.

When a deterministic or real provider failure exercises bounded Architect
failover, the expected run-log sequence is:

```text
pooled_subagent_created (agent=architect)
model_attempt_started
model_attempt_failed
model_fallback_started
model_attempt_started
model_attempt_succeeded
```

## Supervisor, session memory, and compaction

Primary `nla` is the coordinator. Supervisor is a bounded independent auditor,
not a second coordinator. Tier 3 uses Supervisor at the design gate, execution
gate, material milestones or anomalies, pre-compaction, and completion. Tier 2
uses it only for repeated failures, blockers, scope drift, long-running
milestones, or compaction. Tier 0 and Tier 1 do not use Supervisor.

Primary NLA maintains a private structured ledger with `nla_state`. The ledger
is stored outside the repository under:

```text
~/.local/share/nla/sessions/<session-id>.json
```

It preserves the goal, Tier, workflow stage, acceptance criteria, approved
decisions, completed and active work, changed files, verification, blockers,
pending gate, and exact next step. Files are atomically replaced with mode
`0600`; directories use `0700`. Obvious secret assignments are rejected.

### Assistant Notebook

The checked-in `skills/assistant-notebook` is vendored unchanged from
`pickleshell/skills`. Only primary NLA may use `nla_notebook`; subagents receive
bounded context packets and cannot use the shared memory. The default local
backend is:

```text
~/.local/share/nla/assistant-notebook
```

Set `ASSISTANT_NOTEBOOK_DIR` to override it. NLA reads Contents plus one
relevant page at substantive session entry, project switch, or restoration,
then reuses that context. Notebook pages contain durable retrieval cues, not
transcripts, logs, secrets, or unverified completion claims.

### Safe automatic compaction

Built-in OpenCode `compaction.auto` remains enabled as an emergency fallback,
with native pruning enabled and `reserved: 32000`. Planned NLA compaction should
normally run earlier with a workflow checkpoint; native auto protects the TUI
if NLA or its plugin cannot complete that path. NLA monitors the latest prompt
token usage reported by OpenCode:

```text
NLA_CONTEXT_SOFT_TOKENS=50000
NLA_CONTEXT_HARD_TOKENS=70000
```

At the soft threshold, NLA receives a one-time instruction to save its ledger
and compact at the next safe boundary. At the hard threshold, compaction is
scheduled automatically. It waits until the primary session is idle and no
pooled child task is active, then runs:

```text
Supervisor audit
→ optional intelligent Compactor checkpoint through its model pool
→ client.session.summarize()
→ session.compacted
→ noReply restore packet
```

The deterministic ledger is saved before either model-backed step. The
Supervisor audit remains a required safety gate: if Supervisor is unavailable,
fails, or returns `BLOCK`, controlled compaction stops and logs
`compaction_failed`. Compactor alone is optional. When `roles.compactor` is
absent, disabled, or has no models, NLA skips the intelligent pass. It also
falls back to the saved ledger on provider rejection, timeout, other task
errors, or invalid Compactor JSON. Validation requires the complete ledger
shape and prevents alteration or loss of critical workflow state and
provenance. Native OpenCode summarization and restore then proceed with
whichever checkpoint was selected.

Compactor uses the existing role/model-pool boundary; its role prompt is in
`opencode.json`, while its ordered provider models and timeout are configured in
`config/model-pools.json`. For example:

```json
"compactor": {
  "enabled": true,
  "models": ["provider/preferred-model", "provider/fallback-model"],
  "idle_timeout_ms": 90000,
  "max_failovers": 1
}
```

To keep deterministic-only behavior, omit that entry or set `enabled` to
`false`. No local provider, credential, or machine-specific model setting is
required by the repository.

Compactor and Explorer are the two roles that may use local or utility models
that are weaker as general coding agents, provided NLA supplies the bounded
packet and input data. This does not make arbitrary base models compatible.
Compactor must still obey its narrow summarization and structured-output
contract. Explorer must still obey its bounded read-only analysis contract and
return the expected report. Neither needs tool-calling capability when the
orchestration layer supplies all required data, which can make local Ollama
models useful even when they perform poorly as full OpenCode agents. If
Explorer instead must navigate files or invoke tools through OpenCode, use a
model with sufficiently strong instruction-following and tool-use capability.
Do not apply this allowance to Router; Architect, Implementer, and Supervisor
retain their existing model-capability requirements.

For a direct utility pool, add `runtime: "utility"`, choose `backend: "ollama"`
or `backend: "openai-compatible"`, and provide the matching `provider.api` and
`provider.base_url`. Generic OpenAI-compatible pools may also set
`reasoning_effort` and `max_output_tokens`; support for those request fields is
provider-specific. Keep credentials in the provider's supported user-level
authentication mechanism, never in this repository or the pool file.

`nla_compact` schedules the same pipeline explicitly. It must not call native
summarization from inside its active tool call because OpenCode serializes work
on a session; the idle-boundary handoff avoids that deadlock. A persistent
OpenCode TUI/server completes this post-response lifecycle. A one-shot
`opencode run` process can exit before background idle work completes and is
therefore not a supported automatic-compaction host.

Relevant run-log evidence includes `session_ledger_saved`, `context_threshold`,
`compaction_scheduled`, `compaction_started`, pooled Supervisor and Compactor
attempts, `compactor_checkpoint_created` or `compactor_fallback_used`,
`compaction_requested`, `context_compacted`, and `context_restored`.

### Session and context telemetry

Every event includes `session_id` and, when known, `root_session_id`. A new
session produces `session_created` (or `session_observed` when the plugin
attaches after creation). Child sessions also contain `parent_session_id` and
`kind: subagent`. `session_model_bound` records the effective provider/model.

`context_usage` records input, cache-read, and effective context tokens without
logging prompt contents. A normal compaction keeps the same `session_id` and
emits `compaction_started`, `context_compacted`, `context_restored`, then
`context_after_compaction` with `tokens_reclaimed` and `compaction_number`.
A different root `session_id` means a newly created primary session; a different
child ID with the same `root_session_id` is a Supervisor, Compactor, or other
subagent rather than a restarted NLA session.
