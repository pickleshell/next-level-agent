# Testing Next Level Agent

NLA keeps its mandatory publication checks deterministic and offline. Real
provider and model experiments are useful evidence, but they are never required
for pull requests because provider availability, latency, and cost are external.

## Fast NLA tests

From the repository root, run:

```bash
npm install --no-save --prefix .opencode @opencode-ai/plugin@1.18.9
npm run test:nla
python3 -m venv .venv
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest -q tests/test_model_pools.py tests/test_compact_checkpoint.py
```

The first command installs the same pinned test dependency as CI. It is needed
on a fresh clone: do not rely on an earlier OpenCode launch having populated
`.opencode/node_modules`. This is test setup, not a paid provider/model call.

`npm run test:nla` covers the OpenCode-side memory, Compactor checkpoint,
utility runtime, prompt optimizer, capability cache, and model-pool retry logic.
It also covers the optional Browser contract, stdio MCP adapter, ownership,
task permissions, deterministic evidence and child-session dispatch.
The Python tests cover the standalone model-pool helpers and compact/checkpoint
helpers. GitHub Actions installs `pytest` in an isolated runner environment.
It also installs the pinned `@opencode-ai/plugin` version used by the checked-in
OpenCode profile; provider/model calls remain disabled.

Individual deterministic entry points include:

- `bash tests/opencode/test-nla-memory.sh`
- `node tests/opencode/test-nla-compaction.mjs`
- `node tests/opencode/test-nla-utility-runtime.mjs`
- `node tests/opencode/test-nla-prompt-optimizer.mjs`
- `node tests/opencode/test-nla-capability-cache.mjs`
- `node tests/opencode/test-nla-model-pools.mjs`
- `npm run test:browser`
- `npm run test:browser:gate-result`

Real-browser checks are separately opt-in, use local fixture services and reuse
an operator-supplied MCP package/browser without installing either. See
[Browser verification](BROWSER.md#verification). A real browser smoke does not
claim that a live provider-driven OpenCode child session was exercised.

The separate [Browser production gate](BROWSER_PRODUCTION_GATE.md) measures all
four mandatory layers and rejects FAIL/BLOCKED/NOT_RUN. It is opt-in and
network/browser dependent; its result aggregator is tested in offline CI.

## Broader inherited tests

This repository retains the Superpowers skills and multi-harness test suites it
is based on. Their entry points live under `tests/`, including:

- `tests/brainstorm-server/` — Node tests (`npm test` in that directory);
- `tests/codex-plugin-sync/test-sync-to-codex-plugin.sh`;
- `tests/codex/`, `tests/kimi/`, `tests/hermes/`, and other harness checks;
- `tests/claude-code/` and `tests/explicit-skill-requests/` — slower or
  environment-dependent behavioral checks.

Two inherited OpenCode bootstrap scripts still assume the upstream
`skills/using-superpowers/SKILL.md` layout and are not valid NLA-fork release
gates. They are tracked as a known fork compatibility limitation rather than
being silently treated as passing NLA tests.

## Real-model evidence

Provider-backed measurements are opt-in and must not run in mandatory CI. The
reproducible local shortlist benchmark is:

```bash
node tests/opencode/benchmark-nla-tool-shortlist.mjs
```

It requires its explicitly configured local provider. Sanitized result files in
`docs/` record historical observations; they do not promise current free-model
availability. Never commit provider credentials, real session identifiers,
private paths, or runtime logs with benchmark evidence.

## Publication checks

Before a release, also verify:

```bash
git diff --check
git status --short --branch
```

Check README links, tracked files for credential/private-key patterns, and the
ignored runtime files `.opencode/agent-run.log` and
`.opencode/nla-role-capabilities.json`. A release must keep the Alpha limitations
and OpenCode-only support boundary explicit.
