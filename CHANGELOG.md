# NLA Changelog

This is the ongoing change history for Next Level Agent. `Unreleased` does not
mean deployed or tagged. The canonical released version is recorded in
[`nla-version.json`](nla-version.json); historical release announcements and
the inherited Superpowers notes remain in [Release Notes](RELEASE-NOTES.md).

## Unreleased

### Model inventory context fix (in development)

- Fill missing SQLite model context limits and prices from resolved OpenCode
  providers on first use and pool reload, preserving operator facts and scores.
- Bound discovery time, coalesce concurrent requests, and keep provider payloads
  out of telemetry. Regression coverage reproduces zero-attempt context rejection
  and checks persistence, override priority, timeout, and reload recovery.

### Committed since `nla-v0.1.0-alpha.2` (not tagged as a new NLA release)

- Added optional Browser tasks with bounded permissions, isolated sessions,
  durable recovery, trusted evidence, and fail-closed cleanup and broker
  boundaries.
- Added optional scoped Mem0 tools and usage guidance.
- Added shared model-health handling, cooldowns, quarantine, Retry-After,
  confirmed-stop failover, and safer child-task cancellation.
- Added live model-pool introspection and reload, complete fallback chains,
  adaptive `fallback`/`select` pools, quality/balanced/cost policies, and the
  Hybrid Risk & Complexity Assessor.
- Hardened pool validation and telemetry redaction; corrected Ollama
  message-validation failover and preserved restore failures.

### In development on `feature/nla-system-database` (not merged or released)

- Added a private SQLite system database for typed settings, model facts and
  evaluations, model health, workflow ledgers, restore blocks, and a catalog
  of additional operator databases.
- Added primary-coordinator tools `nla_system` and `nla_models_registry` for
  bounded inspection, settings, schema creation, and model-registry import.
  Neither tool exposes arbitrary SQL or row-level CRUD for operator tables.
- Made imported model facts affect `select` routing and persist across pool
  reload; added persistent per-role default selection policy while retaining
  the runtime-only `nla_model_policy` override.
- Added one-time legacy evaluation migration that fails on malformed input
  rather than silently replacing observations with seed scores; legacy
  workflow ledgers and restore blocks migrate on first access.
- Fixed first-startup pool synchronization so it fills empty facts on seeded
  model records before selection, while preserving later operator imports.
- Updated README, installation, architecture, status, and regression tests for
  the new storage authority and tool boundaries. Browser recovery artifacts
  remain outside SQLite.

## [0.1.0-alpha.2] - 2026-09-02

- Established `nla-version.json` and the separate `nla-v*` release namespace.
- Added consistency checks for release identity and documentation.

## [0.1.0-alpha.1] - 2026-09-02

- First experimental NLA Alpha for OpenCode, with role delegation, bounded
  failover, structured memory, controlled compaction, and restoration.
- Added utility-model runtime support, tool-schema shortlisting, deterministic
  checks, security guidance, and publication evidence.

For the detailed Alpha announcements and upstream Superpowers history, see
[Release Notes](RELEASE-NOTES.md).
