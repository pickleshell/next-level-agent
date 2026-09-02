# Optional Mem0 tools plugin

NLA's Mem0 integration is a separate OpenCode plugin. It does not replace the
private NLA workflow ledger or Assistant Notebook, and NLA core does not know
which model Mem0 uses for extraction.

```text
memory_add / memory_search / scoped CRUD and history
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

The plugin exposes `memory_add`, `memory_search`, `memory_list`, `memory_get`,
`memory_update`, `memory_delete`, and `memory_history`. All operations use the
same stable `user_id`; the service returns 404 when an ID does not exist or is
outside that namespace. Update replaces memory text. History returns Mem0's
recorded ADD and UPDATE events while the scoped memory still exists; it is not
available through this API after deletion.

Deterministic tests use a fake HTTP service:

```bash
node tests/opencode/test-nla-mem0.mjs
```

The real service CRUD test is opt-in and writes one synthetic fact with
`infer:false` so provider availability does not affect storage/API verification:

```bash
NLA_MEM0_E2E=1 NLA_MEM0_URL=http://127.0.0.1:8765 \
  node tests/opencode/test-nla-mem0-e2e.mjs
```
