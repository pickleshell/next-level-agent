# Optional Mem0 tools plugin

The Mem0 plugin is part of NLA and is registered by the default `opencode.json`.
The Mem0 service and its Python/model dependencies are deployed separately and
remain optional. NLA core does not import Mem0, manage its process, or know
whether its extraction model is local or cloud-hosted. The integration does not
replace NLA's private workflow ledger or Assistant Notebook.

The public `mem0-memory` skill is discovered from NLA's standard `./skills`
path. It teaches the primary NLA agent to use the optional tool surface with
bounded retrieval and conservative writes; it remains discoverable when the
Mem0 plugin or service is disabled.

```text
memory_add / memory_search / scoped CRUD and history
        ↓
.opencode/plugins/nla-mem0.js
        ↓
bounded HTTP client
        ↓
external NLA Mem0 service adapter
        ↓
Mem0 + Qdrant/SQLite + extraction/embedding models
```

This boundary keeps orchestration independent from semantic-memory operations.
The checked-in adapter implements the bounded HTTP contract used by the plugin;
installation is documented in [MEM0_INSTALL.md](MEM0_INSTALL.md).

## Configuration

The default service URL is `http://127.0.0.1:8765`. Configure the plugin through
the environment before starting OpenCode:

```bash
export NLA_MEM0_URL=http://127.0.0.1:8765
export NLA_MEM0_USER_ID=my-stable-memory-namespace
export NLA_MEM0_TIMEOUT_MS=30000
OPENCODE_CONFIG=/absolute/path/to/next-level-agent/opencode.json opencode /project
```

`NLA_MEM0_USER_ID` is required before a memory tool can run. It is owned by the
plugin configuration and intentionally absent from agent-callable arguments,
so an agent cannot expand its namespace. Reuse a stable, non-secret ID to
retrieve memories from a later OpenCode session. Do not
store credentials, private keys, complete transcripts, or unverified claims as
memories.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NLA_MEM0_URL` | `http://127.0.0.1:8765` | Adapter base URL; HTTP or HTTPS, without embedded credentials |
| `NLA_MEM0_USER_ID` | none | Stable server-owned namespace for every memory tool |
| `NLA_MEM0_TIMEOUT_MS` | `30000` | Per-request timeout, 1–300000 ms |

The plugin reads these values when OpenCode loads it. Restart OpenCode after a
change. If `NLA_MEM0_USER_ID` is absent, a memory call fails before sending a
request; OpenCode and NLA core still start normally.

## Tools and semantics

The plugin exposes `memory_add`, `memory_search`, `memory_list`, `memory_get`,
`memory_update`, `memory_delete`, and `memory_history`. All operations use the
same configured `user_id`; the service returns 404 when an ID does not exist or is
outside that namespace. Update replaces memory text. History returns Mem0's
recorded ADD and UPDATE events while the scoped memory still exists; it is not
available through this API after deletion.

| Tool | Operation |
| --- | --- |
| `memory_add` | Store text with extraction (`infer:true`, default) or directly (`infer:false`) |
| `memory_search` | Semantic search in one namespace, maximum 20 results |
| `memory_list` | List up to 100 memories in one namespace |
| `memory_get` | Read one scoped memory by ID |
| `memory_update` | Replace one scoped memory's complete text |
| `memory_delete` | Delete one scoped memory |
| `memory_history` | Read ADD/UPDATE history for an existing scoped memory |

With `infer:true`, Mem0 asks its configured LLM to extract durable facts. The
model may normalize, omit, or occasionally corrupt details, so verify exact
identifiers after insertion. With `infer:false`, the supplied text is inserted
directly: it avoids the extraction LLM and is suitable when exact wording is
required, but it does not test or provide intelligent extraction. Both paths
still use the local embedder and persistent stores in the supplied deployment.

## Namespace and security boundary

`user_id` is a logical application namespace, not authentication. NLA tools do
not accept it as an argument; the plugin supplies the configured value. The
adapter checks ownership before get, update, delete, and history, and filters
list/search by the same ID. This prevents accidental cross-namespace access
through the seven tools, but anyone who can configure the plugin or reach an
unauthenticated adapter directly can choose a namespace. Bind the supplied
service to loopback; use a trusted authenticated reverse proxy and TLS if
remote access is required. Do not expose port 8765 to an untrusted network.

Memories persist independently of OpenCode sessions in the service's mounted
`data/` directory: Qdrant stores vectors and SQLite stores history. Back up or
remove that directory according to your own retention needs. Neither disabling
the plugin nor stopping the container deletes it.

## Failure behavior

- Service unavailable, DNS/connect errors, non-JSON responses, and HTTP errors
  are returned only when a memory tool is invoked; they do not stop OpenCode or
  NLA from starting.
- Requests abort after `NLA_MEM0_TIMEOUT_MS`.
- An extraction provider can reject, rate-limit, or time out. Free cloud models
  may return HTTP 429. Retry deliberately; for exact trusted text, an agent may
  use `infer:false` rather than silently changing the service profile.
- `infer:true` can return no extracted memories even when the request succeeds.
  Inspect the tool result before claiming persistence.
- Search requires the Ollama embedding service even when extraction is cloud
  hosted. A healthy cloud LLM does not compensate for a missing local embedder.
- Deleted or wrong-namespace IDs return 404. History is unavailable after
  deletion because the adapter requires the current scoped memory to exist.

## Cross-session verification

Use a unique, stable namespace and two genuinely separate OpenCode sessions:

1. Export the same `NLA_MEM0_USER_ID` before starting each session.
2. In session A, ask NLA to remember a synthetic fact for a future session.
3. Confirm session/tool evidence shows NLA invoked `memory_add` and that its
   response contains the stored fact.
4. End A. Start session B without including the answer in its prompt and ask for
   the fact by its synthetic marker.
5. Confirm NLA invokes `memory_search` (and optionally list/get), then returns
   the stored value. Delete only the synthetic memory afterward.

Direct client tests prove the HTTP contract; only two agent sessions prove that
the NLA agent chooses and uses the plugin across sessions.

## Disable or uninstall

To disable the integration, remove only
`./.opencode/plugins/nla-mem0.js` from the `plugin` array in your local copy of
`opencode.json`, then restart OpenCode. To stop the optional service, run
`docker compose down` in `integrations/mem0-service`. This preserves `data/`.
Delete that directory only when you intentionally want to erase all Mem0 data.

## Tests

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

For service health, configuration, and troubleshooting commands, use the
[installation guide](MEM0_INSTALL.md).
