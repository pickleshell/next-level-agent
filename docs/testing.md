# Testing Next Level Agent

NLA keeps its mandatory publication checks deterministic and offline. Real
provider and model experiments are useful evidence, but they are never required
for pull requests because provider availability, latency, and cost are external.

## Fast NLA tests

From the repository root, run:

```bash
npm run test:nla
python3 -m pytest -q tests/test_model_pools.py tests/test_compact_checkpoint.py
```

`npm run test:nla` covers the OpenCode-side memory, Compactor checkpoint,
utility runtime, prompt optimizer, capability cache, and model-pool retry logic.
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
