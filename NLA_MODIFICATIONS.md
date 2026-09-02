# Next Level Agent (NLA) — Modifications over Superpowers

Base: https://github.com/obra/superpowers (cloned at b36e082)

## NLA Code (new / modified)
- `compact/` — new module (checkpoint, restore, compact logic, logger)
- `config/model-pools.json` + `config/model_pools.py`
- `.opencode/plugins/next-level-agent.js` — OpenCode orchestration, pooled failover,
  session telemetry, Supervisor/Compactor handoff, and controlled compaction
- `.opencode/plugins/nla-memory.mjs` — private ledger and notebook storage
- `skills/next-level-agent/` — NLA coordinator workflow and routing tiers
- `skills/assistant-notebook/` — durable fast-memory skill from `pickleshell/skills`
- `tests/test_compact_checkpoint.py`, `tests/test_model_pools.py`, `tests/test_nla_integration.py`
- `tests/opencode/test-nla-memory.mjs`
- `.codex-plugin/plugin.json`: name = "next-level-agent"
- `TECHNICAL_SPECIFICATION.md` — original product brief and architecture draft
- `docs/NLA_INSTALL_AND_TEST.md` — current runtime, installation, and verification guide

## Superpowers Base (unchanged skills, structure, philosophy)
- `skills/` — original superpowers skills (brainstorming, subagent-driven-development, etc.)
- `tests/` — original superpowers tests
- `.opencode/plugins/superpowers.js` — original Superpowers OpenCode plugin retained
- upstream skills other than the NLA bootstrap and added Assistant Notebook
- `assets/`, `.claude-plugin/`, `.cursor-plugin/`, etc.
