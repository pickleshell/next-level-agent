# Next Level Agent (NLA) — Modifications over Superpowers

Pinned base: https://github.com/obra/superpowers at commit
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

## NLA additions and modifications

### Runtime and configuration

- `.opencode/plugins/next-level-agent.js` — OpenCode coordinator, bounded child
  dispatch, role/model pools, deterministic failover, telemetry, and controlled
  compaction orchestration.
- `.opencode/plugins/nla-memory.mjs` — durable workflow ledger and Assistant
  Notebook integration.
- `.opencode/plugins/nla-compaction.mjs` — validated Compactor checkpoints with
  deterministic fallback and provenance preservation.
- `.opencode/plugins/nla-utility-runtime.mjs` — bounded direct utility-model
  calls through native Ollama and generic OpenAI-compatible/cloud endpoints.
- `.opencode/plugins/nla-prompt-optimizer.mjs` — Compactor-owned, fail-closed
  per-step tool-schema shortlisting within role capability ceilings.
- `.opencode/plugins/nla-capability-cache.mjs` — deterministic role capability
  profiles cached against tool-schema and configuration signatures.
- `compact/` — standalone checkpoint, compaction, restoration, and event-logging
  helpers.
- `config/model-pools.json` — public role pools, utility runtime settings, retry
  bounds, and model defaults.
- `config/model_pools.py` — Python model-pool loader and failover helper.
- `opencode.json` — NLA OpenCode agents, models, permissions, and plugin wiring.

### Skills, documentation, and evidence

- `skills/next-level-agent/` — NLA coordinator workflow, routing tiers, role
  contracts, gates, and platform references, evolved from the base bootstrap.
- `skills/assistant-notebook/` — durable fast-memory skill imported for NLA.
- `TECHNICAL_SPECIFICATION.md` — original NLA product brief and architecture
  draft.
- `docs/NLA_INSTALL_AND_TEST.md` — runtime, installation, and verification guide.
- `docs/PROJECT_STATUS_AND_USAGE.md` — current behavior, limitations, telemetry,
  storage, evidence, and roadmap status.
- `docs/nla-qwen3-4b-tool-shortlist-2026-09-01.json` — sanitized local
  tool-schema benchmark evidence.
- `docs/nla-shortlist-e2e-2026-09-02.json` — sanitized real child-shortlist E2E
  evidence.
- `docs/nla-free-cloud-compactor-2026-09-02.json` — sanitized cloud utility
  Compactor and checkpoint/restore evidence.
- `nla-version.json` — canonical NLA release identity, separate from inherited
  package metadata.

### Deterministic verification

- `tests/opencode/` — NLA memory, compaction, utility runtime, prompt optimizer,
  capability cache, model-pool, version, integration, and benchmark entrypoints.
- `tests/test_compact_checkpoint.py` — standalone compaction/checkpoint tests.
- `tests/test_model_pools.py` — Python model-pool and failover tests.
- `tests/test_nla_integration.py` — cross-module NLA workflow smoke test.
- `tests/test_restore.py` — checkpoint restoration test.
- `.github/workflows/nla-ci.yml` — offline deterministic Node and Python NLA
  release gates.

## Inherited Superpowers base

- `.opencode/plugins/superpowers.js` — retained Superpowers OpenCode skills
  loader.
- `skills/` — the Superpowers development-skill library remains the workflow
  foundation; NLA replaces the bootstrap with `skills/next-level-agent/`, adds
  Assistant Notebook, and carries a small number of NLA-specific skill edits.
- `tests/` — inherited Superpowers tests remain alongside the NLA-specific test
  suites listed above.
- `assets/`, `.claude-plugin/`, and `.cursor-plugin/` — inherited distribution
  assets and harness metadata; they are not the NLA OpenCode runtime.
