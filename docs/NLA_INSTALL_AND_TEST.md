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

The Architect pool is currently ordered as:

```text
nvidia/qwen/qwen3-coder-480b-a35b-instruct
→ opencode/hy3-free
```

The NVIDIA Qwen endpoint currently rejects requests with HTTP 410 because the
model is end-of-life. It is intentionally useful as a failover probe: a real
Architect dispatch must log the failed first attempt and continue with
`opencode/hy3-free` in the same child session. Replace the first entry with a
healthy preferred model when this deliberate probe is no longer needed.

Expected Architect-related run-log events are:

```text
pooled_subagent_created (agent=architect)
model_attempt_started
model_attempt_failed
model_fallback_started
model_attempt_started
model_attempt_succeeded
```
