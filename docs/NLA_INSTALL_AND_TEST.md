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

`router` and all other configured roles are internal subagents. The approved implementation route is `explorer → implementer → reviewer`; new or ambiguous requests first use `brainstorming → writing-plans → user approval`.

### Tier routing

| Tier | Use | Route |
| --- | --- | --- |
| 0 | Direct answer or focused read-only exploration | NLA works directly |
| 1 | Small, bounded edit | Direct change plus targeted verification |
| 2 | Non-trivial implementation | Explore → implement → verify → independent review when required → checkpoint |
| 3 | High-risk or architectural work | Explore/research → architecture decision → explicit approval → implement → verify → independent review → checkpoint |

## Testing

### Unit Tests
- `pytest tests/test_compact_checkpoint.py` (checkpoint save/load, threshold 50000)
- `pytest tests/test_model_pools.py` (6 roles: coordinator, implementer, reviewer, supervisor, explorer, architect)
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
- Confirm 6 model pool roles in `config/model-pools.json` (`default`, `fallback`, `manual`).

## Run log

NLA writes newline-delimited JSON to `.opencode/agent-run.log` in the target project. Entries are emitted by OpenCode hooks, not authored by the model. They record timestamps, session and call identifiers, primary-agent selection, skill calls, subagent dispatch, and subagent completion. Prompts, tool output, and model replies are not written.

## Verification Log
- `docs/superpowers/plans/verification-log.md` (updated after Phase 2; 30/31 PASS before fix; fix applied in `debbbe1`)
- `docs/superpowers/plans/phase2/plan.md` (Phase 2 scope: A-G completed)

## Ruling / Deferred (from spec self-review)
- Full session-monitor integration (automatic trigger at 50000 tokens during real agent session) — deferred; framework present, manual/test trigger verified.
- `.opencode/plugins/nla.json` created; full harness bootstrap load verified separately.

## Model pools

NLA model pools are implemented by the local plugin, not by prompts. They apply
only to configured subagents. On a retryable provider failure (such as `429`,
`5xx`, or timeout) or when a busy subagent produces no OpenCode progress event
for its role-specific deadline, the plugin aborts that request and resumes the
same bounded subagent session on its one configured fallback model. It records
`model_failure` and `model_fallback_started` in `.opencode/agent-run.log`.

A pool has exactly one fallback in `config/model-pools.json`; this prevents
loops and uncontrolled billed usage. The primary NLA session has no automatic
fallback: it remains visible to the user. Inkling is intentionally not a
long-running subagent fallback because the gtop test exposed repeated upstream
504 responses.
