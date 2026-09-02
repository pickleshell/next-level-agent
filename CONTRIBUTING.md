# Contributing to Next Level Agent

NLA is an experimental OpenCode Alpha built on the Superpowers skills
foundation. Contributions should preserve that attribution and keep NLA's
OpenCode support boundary explicit.

## Before opening a change

1. Read [`README.md`](README.md), [`AGENTS.md`](AGENTS.md), and
   [`docs/PROJECT_STATUS_AND_USAGE.md`](docs/PROJECT_STATUS_AND_USAGE.md).
2. Keep changes focused on NLA Core unless an issue explicitly scopes a broader
   integration.
3. Do not commit credentials, private paths, real session identifiers, runtime
   logs, capability caches, or provider-specific user configuration.
4. Do not add paid-model or network-dependent tests to mandatory CI.

## Testing

Run the deterministic publication checks described in
[`docs/testing.md`](docs/testing.md):

```bash
npm run test:nla
python3 -m pytest -q tests/test_model_pools.py tests/test_compact_checkpoint.py
git diff --check
```

If a provider-backed experiment supports a claim, include a sanitized evidence
artifact and clearly distinguish observation from availability guarantees.

## Pull requests

Describe the problem, the chosen boundary, changed behavior, verification, and
known limitations. Preserve deterministic fail-closed behavior: utility-model
failure must not restore the full tool catalog or weaken role permissions.
