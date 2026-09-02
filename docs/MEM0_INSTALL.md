# Install the optional Mem0 service

NLA ships the OpenCode plugin and a small HTTP service adapter, but it does not
install or start Mem0 automatically. This guide deploys the external service
from a clean NLA clone. It keeps embeddings and storage local in both profiles.

## Prerequisites

- Docker with Compose v2 (`docker compose version`)
- Ollama reachable from the host (`ollama --version`)
- enough disk space for the embedding and optional local extraction models
- an OpenCode installation already configured for NLA

The supplied Compose service uses host networking so its container can reach
host Ollama at `127.0.0.1:11434`, and binds its HTTP adapter to loopback only.
The deployment persists Qdrant vectors and SQLite history under
`integrations/mem0-service/data/`, which is git-ignored.

## 1. Prepare local embeddings

Start Ollama and pull the required embedding model:

```bash
ollama pull nomic-embed-text:latest
curl --fail http://127.0.0.1:11434/api/tags
```

The adapter expects 768-dimensional `nomic-embed-text` vectors. Keep this model
and local storage even when using a cloud extraction model.

## 2. Choose an extraction profile

### Fully local Ollama

Pull the extraction model and use the defaults:

```bash
ollama pull qwen3:4b
cd integrations/mem0-service
docker compose up --build -d
```

The adapter disables hidden thinking and bounds the Ollama context for this
extraction call. Local `qwen3:4b` is usable, but one development comparison
changed a day component in an exact synthetic identifier; verify high-fidelity
values or use direct insertion (`infer:false`).

### OpenAI-compatible cloud extraction

Keep embeddings/storage local and set only the extraction provider:

```bash
cd integrations/mem0-service
export MEM0_LLM_PROVIDER=openai-compatible
export MEM0_LLM_MODEL=provider/model-name
export MEM0_LLM_BASE_URL=https://provider.example/v1
export MEM0_LLM_API_KEY='set-this-outside-the-repository'
docker compose up --build -d
```

Use the provider's chat-completions-compatible base URL and model name. For an
endpoint that intentionally requires no authentication, omit
`MEM0_LLM_API_KEY`; the adapter then omits the placeholder Authorization header.
Never put a real key in `compose.yaml`, shell history, or a committed `.env`.
Cheap/free extraction with local embeddings/storage is the recommended balance,
but free providers may rate-limit requests or change model availability.

Optional service variables are:

| Variable | Default |
| --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `MEM0_LLM_PROVIDER` | `ollama` |
| `MEM0_LLM_MODEL` | `qwen3:4b` |
| `MEM0_LLM_BASE_URL` | `http://127.0.0.1:11434` |
| `MEM0_LLM_API_KEY` | empty |
| `MEM0_EMBED_MODEL` | `nomic-embed-text:latest` |

## 3. Check service health

```bash
curl --fail --silent http://127.0.0.1:8765/health
docker compose ps
docker compose logs --tail=50 mem0
```

The health response reports `status`, extraction provider/model, embedding
model, and persistence path. It does not call the external LLM.

## 4. Configure NLA

From the shell that launches OpenCode:

```bash
export NLA_HOME=/absolute/path/to/next-level-agent
export OPENCODE_CONFIG="$NLA_HOME/opencode.json"
export NLA_MEM0_URL=http://127.0.0.1:8765
export NLA_MEM0_USER_ID=my-stable-non-secret-namespace
export NLA_MEM0_TIMEOUT_MS=30000
opencode /absolute/path/to/project
```

The plugin is already present in the default config. Keep the same
`NLA_MEM0_USER_ID` across sessions that should share memory. Use different IDs
for unrelated users/projects. This ID scopes data but is not an access token.

Verify resolution without calling a model:

```bash
OPENCODE_CONFIG="$NLA_HOME/opencode.json" opencode debug config
```

Confirm both `.opencode/plugins/next-level-agent.js` and
`.opencode/plugins/nla-mem0.js` resolve. The service can be stopped during this
check: the plugin performs no network request until a `memory_*` tool runs.

## 5. Smoke and end-to-end checks

Run the deterministic fake-service contract test:

```bash
npm run test:nla
```

With the real service healthy, run the opt-in CRUD/persistence test. It creates
and removes its own unique synthetic memory and bypasses extraction so provider
availability cannot distort the API check:

```bash
NLA_MEM0_E2E=1 \
NLA_MEM0_URL=http://127.0.0.1:8765 \
node tests/opencode/test-nla-mem0-e2e.mjs
```

For meaningful agent behavior, use the two-session procedure in
[NLA_MEM0_PLUGIN.md](NLA_MEM0_PLUGIN.md#cross-session-verification). Test
`infer:true` separately to verify the selected extraction provider. The direct
insertion path alone is not proof that LLM extraction works.

## Troubleshooting

- **Connection refused:** check `docker compose ps`, `docker compose logs`, and
  `NLA_MEM0_URL`. The default is loopback port 8765.
- **Embedding failure:** confirm Ollama is running and
  `nomic-embed-text:latest` appears in `/api/tags`; cloud extraction still needs
  this local service.
- **HTTP 429 or provider error:** inspect adapter logs, wait for the provider's
  limit, or select another compatible extraction model. Use `infer:false` only
  when direct exact insertion is acceptable.
- **No memory returned:** an `infer:true` extraction may legitimately produce an
  empty result. Use a clear durable fact and inspect the `memory_add` result.
- **Timeout:** increase `NLA_MEM0_TIMEOUT_MS` up to 300000 if the service is
  healthy but extraction is slow; this changes only the NLA HTTP timeout.
- **404 for known ID:** verify the same `NLA_MEM0_USER_ID` was used. IDs are
  scoped and history is unavailable after deletion.

Stop the service without deleting persisted data:

```bash
cd integrations/mem0-service
docker compose down
```
