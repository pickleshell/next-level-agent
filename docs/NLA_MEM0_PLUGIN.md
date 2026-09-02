# Optional Mem0 tools plugin

NLA's Mem0 integration is a separate OpenCode plugin. It does not replace the
private NLA workflow ledger or Assistant Notebook, and NLA core does not know
which model Mem0 uses for extraction.

```text
memory_add / memory_search
        ↓
.opencode/plugins/nla-mem0.js
        ↓
bounded HTTP client
        ↓
external Mem0 service
```

The default service URL is `http://127.0.0.1:8765`. Configure the plugin through
the environment before starting OpenCode:

```bash
export NLA_MEM0_URL=http://127.0.0.1:8765
export NLA_MEM0_USER_ID=my-stable-memory-namespace
export NLA_MEM0_TIMEOUT_MS=30000
OPENCODE_CONFIG=/absolute/path/to/next-level-agent/opencode.json opencode /project
```

`NLA_MEM0_USER_ID` is optional when every tool call supplies `user_id`. Reuse a
stable, non-secret ID to retrieve memories from a later OpenCode session. Do not
store credentials, private keys, complete transcripts, or unverified claims as
memories.

The plugin currently exposes only `memory_add` and `memory_search`. The tested
Mem0 spike API publishes `POST /memories` and `POST /search`, but no list,
history, update, or delete endpoints. Those tools should be added only after the
external service defines and tests the corresponding HTTP operations.

Deterministic tests use a fake HTTP service:

```bash
node tests/opencode/test-nla-mem0.mjs
```

The real service test is opt-in and writes one synthetic fact:

```bash
NLA_MEM0_E2E=1 NLA_MEM0_URL=http://127.0.0.1:8765 \
  node tests/opencode/test-nla-mem0-e2e.mjs
```
