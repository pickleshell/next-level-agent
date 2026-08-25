# Next Level Agent — Installation + Testing

Base: Superpowers (https://github.com/obra/superpowers, commit b36e082)
Plugin: `next-level-agent` (`.codex-plugin/plugin.json`)

## Installation

1. Clone base:
   `git clone https://github.com/obra/superpowers.git`
2. Copy/merge NLA files: `compact/`, `config/model-pools.json`, `.opencode/plugins/nla.json`, `tests/test_*.py`, `docs/superpowers/plans/`, `docs/superpowers/specs/`.
3. Verify plugin entry: `.codex-plugin/plugin.json` must contain `"name":"next-level-agent"`.
4. Verify OpenCode plugin: `.opencode/plugins/nla.json` points to current entrypoint.
5. Restart harness (OpenCode / Codex / Claude) after installation.

Boundary (see `NLA_MODIFICATIONS.md`):
- NLA: `compact/`, `config/`, `.opencode/plugins/nla.json`, `tests/test_*`, `docs/superpowers/plans/`, `.codex-plugin/plugin.json` (name only)
- Superpowers base: `skills/`, `.claude-plugin/`, `.cursor-plugin/`, `assets/`, `README.md` (updated with NLA note)

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

## Verification Log
- `docs/superpowers/plans/verification-log.md` (updated after Phase 2; 30/31 PASS before fix; fix applied in `debbbe1`)
- `docs/superpowers/plans/phase2/plan.md` (Phase 2 scope: A-G completed)

## Ruling / Deferred (from spec self-review)
- Full session-monitor integration (automatic trigger at 50000 tokens during real agent session) — deferred; framework present, manual/test trigger verified.
- `.opencode/plugins/nla.json` created; full harness bootstrap load verified separately.
