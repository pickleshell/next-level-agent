# NLA Changelog

This is the ongoing change history for Next Level Agent. `Unreleased` does not
mean deployed or tagged. The canonical released version is recorded in
[`nla-version.json`](nla-version.json); historical release announcements and
the inherited Superpowers notes remain in [Release Notes](RELEASE-NOTES.md).

## Unreleased

### Provider switches scoped to auto pools

- Provider `off` excludes models only from `auto` selection, including its
  emergency reserve. Explicit `select` and `fallback` pools and the fixed
  coordinator ignore provider status.
- Individual model switches, inventory, health and policy checks still apply.
  Provider switching never deletes model facts, evaluations or pool membership.
- Update routing, orchestra activation, introspection, tool guidance and tests.

### Free-only model selection

- Add `free` alongside quality, balanced, cost and local for select/auto pools.
  Only explicit numeric zero input/output prices qualify; rank eligible models
  by quality and never fall back to a paid or unknown-price coordinator.
- Preserve the boundary during high-risk assessment and argument recovery;
  skip utility-model prompt optimization for free tasks. Empty eligible pools
  return `NLA_FREE_MODEL_UNAVAILABLE` without making a model request.
- Support live policy changes, SQLite persistence, introspection and regression
  tests. Existing model settings, providers and scores are unchanged.

### Delegation argument recovery

- Treat blank optional `nla_task` fields as absent so Explorer and other roles
  reach model selection when a model supplies an empty Reviewer target.
- Preserve Reviewer/Browser argument boundaries and tell the coordinator to
  omit unused fields and correct invalid arguments before retrying.
- Log role-argument validation failures without task content. Repeated misplaced
  Reviewer targets receive one bounded Supervisor repair attempt using the
  current coordinator model; argument errors never abort the primary session.
- Use the observed coordinator model as a final agent-task reserve, at most
  once, respecting registry/provider status, health, context and local policy.
  Preserve role permissions and cancellation/unsafe-retry safeguards.

### Named orchestras and dynamic model pools

- Preserve the original role and model configuration as the durable `go`
  orchestra; save additional named orchestras and the active choice in SQLite.
- Add `nla_orchestra` to inspect, propose, create, update, change one role pool,
  and activate orchestras without restarting OpenCode. New tasks use the active
  snapshot while running child tasks retain theirs.
- Add `models: "auto"` for agent `select` roles, resolving enabled registry
  models against the OpenCode provider inventory at task start. Keep per-model
  status and empirical scores across orchestra changes; support provider
  preference tie-breakers and stored coordinator guidance.
- Add explicit `selection_mode: "auto"`: an empty `models` array considers the
  full enabled inventory, while listed bindings are soft preferences rather
  than an exclusive pool. Keep older saved `select`/`models: "auto"` orchestras
  readable as empty-preference auto pools; `select` remains fixed-membership.
- Remove the operator-facing `cost_weight` setting and fixed 75/25 `balanced`
  formula. The assessor/coordinator chooses policy; `balanced` favors lower
  cost among similarly suitable models. Legacy pool and SQLite values are
  ignored on load without losing the saved policy or model evaluations.
- Add a durable provider registry with independent `enabled`/`disabled` status
  and NLA tools to list, inspect, and toggle providers. New tasks require both
  provider and model to be enabled; model settings and evaluations are retained.
- Show model, provider, and role switches as `on`/`off` in NLA tools. Accept
  `on`/`off` for model/provider changes while retaining legacy input and SQLite
  values for compatibility.
- Add `local` policy for `select`/`auto` roles: rank only self-hosted Ollama
  bindings, fail closed without cloud fallback, and retain high-risk score
  safeguards within the local candidate set.

### Model inventory context fix

- Fill missing SQLite model context limits and prices from resolved OpenCode
  providers on first use and pool reload, preserving operator facts and scores.
- Bound discovery time, coalesce concurrent requests, and keep provider payloads
  out of telemetry. Regression coverage reproduces zero-attempt context rejection
  and checks persistence, override priority, timeout, and reload recovery.
- Align native OpenCode role defaults with the checked-in OpenCode Go pool
  primaries, and verify that a fresh launcher installation resolves this profile
  without private overrides.

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

### Persistent system database

- Added a private SQLite system database for typed settings, model facts and
  evaluations, model health, workflow ledgers, restore blocks, and a catalog
  of additional operator databases.
- Added primary-coordinator tools `nla_system` and `nla_models_registry` for
  bounded inspection, settings, schema creation, and model-registry import.
  Neither tool exposes arbitrary SQL or row-level CRUD for operator tables.
- Made imported model facts affect `select` routing and persist across pool
  reload; added persistent per-role default selection policy and the
  `nla_model_policy` operator tool.
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
