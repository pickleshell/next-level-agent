# Next Level Agent (NLA) — Modifications over Superpowers

Base: https://github.com/obra/superpowers (cloned at b36e082)

## NLA Code (new / modified)
- `compact/` — new module (checkpoint, restore, compact logic, logger)
- `config/model-pools.json` + `config/model_pools.py`
- `.opencode/plugins/nla.json`
- `tests/test_compact_checkpoint.py`, `tests/test_model_pools.py`, `tests/test_nla_integration.py`
- `.codex-plugin/plugin.json`: name = "next-level-agent"
- `docs/superpowers/plans/` — Phase 1 + Phase 2 plans and verification
- `docs/superpowers/specs/2026-08-25-nla-compact-model-pools-design.md`

## Superpowers Base (unchanged skills, structure, philosophy)
- `skills/` — original superpowers skills (brainstorming, subagent-driven-development, etc.)
- `tests/` — original superpowers tests
- `.opencode/` — original superpowers OpenCode plugin files
- `README.md` — original superpowers docs (updated below with NLA note)
- `assets/`, `.claude-plugin/`, `.cursor-plugin/`, etc.
