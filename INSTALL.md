# Install Next Level Agent for OpenCode

NLA is currently developed and tested for OpenCode. These instructions install the NLA configuration and plugin for use with an existing project. They do not claim support for running the complete NLA system inside another coding-agent CLI.

For status, limitations, storage, telemetry, and the roadmap, read [Project Status and Usage](docs/PROJECT_STATUS_AND_USAGE.md).

These instructions currently describe NLA `0.1.0-alpha.2`
(`nla-v0.1.0-alpha.2`). The canonical release identity is
[`nla-version.json`](nla-version.json); inherited Superpowers manifests keep
their separate upstream version.

## Requirements

- Linux or another environment where the current OpenCode build works;
- OpenCode installed and available on `PATH`;
- Git;
- provider authentication already configured in OpenCode;
- at least one working model for primary NLA and every enabled role pool;
- a persistent OpenCode TUI or server for controlled compaction.

Check the runtime:

```bash
opencode --version
git --version
```

The current development environment reports OpenCode `1.18.9`. The version in the historical Draft 0.4 is not the current compatibility target.

## 1. Clone NLA

Keep the clone at a stable absolute path:

```bash
mkdir -p "$HOME/.local/share/nla"
git clone https://github.com/pickleshell/next-level-agent.git \
  "$HOME/.local/share/nla/next-level-agent"
```

If the repository already exists, inspect it before updating:

```bash
git -C "$HOME/.local/share/nla/next-level-agent" status --short --branch
git -C "$HOME/.local/share/nla/next-level-agent" pull --ff-only
```

Do not discard local changes automatically.

## 2. Review Model Pools

Open:

```text
~/.local/share/nla/next-level-agent/config/model-pools.json
```

Each enabled role must contain at least one model available through the user's OpenCode providers.

Before a long run, validate the complete pool file locally. This check rejects
malformed bindings, repeated bindings, and bindings whose model component
incorrectly repeats the provider prefix. It does not contact a provider or
claim that a syntactically valid model is available:

```bash
node scripts/nla-model-pools-preflight.mjs --pools /absolute/path/to/model-pools.json
```

To check availability, supply a JSON inventory collected by the operator from
the intended OpenCode runtime. Inventory matching is exact; NLA never guesses
that a similarly named provider/model is equivalent:

```bash
node scripts/nla-model-pools-preflight.mjs \
  --pools /absolute/path/to/model-pools.json \
  --available-models /absolute/path/to/open-code-model-inventory.json
```

For a machine-local pool assignment without changing repository defaults, point
NLA at a complete external pool file:

```bash
export NLA_MODEL_POOLS_PATH="/absolute/path/to/model-pools.json"
```

The override replaces the complete role-pool file. OpenCode provider definitions
and agent prompts remain OpenCode configuration concerns; direct utility-runtime
provider settings live in the role pool. Keep machine-specific URLs and model
bindings outside the repository.

Bounded Explorer or Compactor pools may instead select the direct utility-model
runtime. Ollama or generic OpenAI-compatible endpoint settings belong in the
same external pool file; see the [utility-model runtime configuration](docs/PROJECT_STATUS_AND_USAGE.md#utility-model-runtime).

The checked-in default is a ready-to-use OpenCode Go example: all role bindings
use `opencode-go/*`; Architect, Explorer, Implementer, and Reviewer use
`selection_mode: "select"`, while the remaining roles use ordered `fallback`.
The select examples use `quality` for Architect and Reviewer and `balanced`
for Explorer and Implementer. `nla_models` reports the effective policies;
`nla_model_policy` can change one select policy for new tasks without restart,
while file-backed changes become active through `nla_models_reload`.
Provider access still depends on the operator's OpenCode Go package and account,
so inspect `opencode models` before a long run. Ask NLA for `nla_models` to see
the effective role bindings and source; `opencode debug config` alone does not
show pool routing.

A fresh NLA state creates a private SQLite system database at
`~/.local/share/nla/system.sqlite`. On its first use it imports the versioned
`config/model-evaluations.json` example, which seeds `coding`, `reasoning`, and
`tool_use` for 27 `opencode-go` models. Existing installations are migrated
once from `~/.local/share/nla/model-evaluations.json`; neither upgrades nor the
seed overwrite accumulated observations. Provider-specific `reliability` and
`latency` begin at zero and are learned at runtime.

Primary NLA can inspect this state with `nla_system` and `nla_models_registry`.
The former manages safe settings and creates named local databases/tables; the
latter lists or imports model records from structured JSON. Neither tool
executes arbitrary SQL or accepts secrets. Importing a model registers its
facts and scores, but intentionally does not change role-pool membership.
These are bounded administration tools, not a general row-level database API.
Call `nla_system` action `schema` for the logical table map. Critical workflow
ledgers and fail-closed restore blocks are stored in this database and migrated
lazily from their legacy JSON files. Browser recovery remains in its verified
filesystem store because its witness and lock are security artifacts.
[`config/model-registry.example.json`](config/model-registry.example.json)
shows the accepted import shape. A JSON file must be inside the active project;
the same object may instead be supplied interactively to NLA.

Completed model requests are also recorded in the `model_usage_events` system
table and mirrored to the existing project JSONL run log. Ask NLA for
`nla_usage summary` or `nla_usage recent` to inspect the current workflow tree.
For live operator observation, use
`tail -f /absolute/path/to/project/.opencode/agent-run.log | jq -c 'select(.event == "model_usage")'`.
These records contain only model/role/session identifiers, token/cache counts,
cost, and finish reason; prompts and model responses are not stored.

Role membership and pool mode remain in `model-pools.json`; the pool's facts
seed new bindings once, then SQLite owns them. Registry imports therefore take
effect in `select` routing and survive `nla_models_reload`. A malformed legacy
evaluation JSON stops startup before seeding; repair it and retry rather than
discarding observations. The supported writable settings are
`operator_databases.enabled` (boolean) and
`routing.selection_policy.<select-role>` (`quality`, `balanced`, `cost`). The
latter changes the default policy immediately and persists across restart;
`nla_model_policy` remains a runtime-only preference. Unknown operational
settings and secrets are rejected.

After startup, ask the primary NLA to run `nla_system` with `status` and
`schema` to confirm the database and its tables. To persist a policy without
editing the pool file, ask it to set `routing.selection_policy.explorer` to
the JSON string `"cost"`, then inspect `nla_models`; a new task uses the
updated default. For a model import, place JSON matching
[`config/model-registry.example.json`](config/model-registry.example.json)
inside the active project and ask NLA to import that relative file using
`nla_models_registry`. Importing facts for an existing pool member changes
subsequent `select` decisions; importing an unassigned model does not add it
to any pool. Existing empirical scores require an explicit `overwrite_scores`
request to replace them.

Never place API keys in `opencode.json`, `model-pools.json`, Notebook, ledger, or telemetry.

## 3. Start NLA in a Project

Use OpenCode's custom configuration path:

```bash
"$HOME/.local/share/nla/next-level-agent/scripts/nla" /absolute/path/to/your/project
```

The launcher locates its own clone, loads its `opencode.json`, and automatically
uses `~/.config/nla/model-pools.json` and `~/.config/nla/browser.json` only when
they exist (or `$XDG_CONFIG_HOME/nla/` when configured). Explicit environment
overrides take precedence. A fresh clone needs neither private file.
The plugin and skills resolve relative to `opencode.json`; the project argument
remains your working project. No shell profile edit or global config copy is needed.

This is the supported Alpha installation method. It does not copy NLA files into the target repository and does not overwrite global OpenCode configuration.

## 4. Verify the Resolved Configuration

From the target project:

```bash
OPENCODE_CONFIG="$HOME/.local/share/nla/next-level-agent/opencode.json" \
  opencode debug config
```

Confirm:

- the plugin path ends in `.opencode/plugins/next-level-agent.js`;
- `default_agent` is `nla`;
- the NLA role catalog is present;
- the skills path points to the NLA clone;
- compaction has `auto: true`, `prune: true`, and `reserved: 32000`;
- model bindings match the intended installation.

OpenCode merges remote, global, custom, project, `.opencode`, inline, and managed configuration sources. A project or managed configuration may override NLA. The current Alpha does not include the deterministic resolved-config validator proposed by Draft 0.4.

## 5. Run a Smoke Test

Start the persistent TUI:

```bash
OPENCODE_CONFIG="$HOME/.local/share/nla/next-level-agent/opencode.json" \
  opencode /absolute/path/to/your/project
```

A healthy session should:

- show `nla` as the primary agent;
- print the Next Level Agent activation banner;
- invoke the `next-level-agent` bootstrap skill before the first answer;
- expose `nla_task`, `nla_state`, `nla_notebook`, `nla_usage`, and `nla_compact`;
- write lifecycle telemetry to `<project>/.opencode/agent-run.log` after activity.

Use a harmless first request, for example:

```text
Inspect this repository without changing files and tell me which Tier this task belongs to.
```

## Optional Shell Helper

The user may define a shell function outside the repository:

```bash
nla() {
  "$HOME/.local/share/nla/next-level-agent/scripts/nla" "$@"
}
```

Then run:

```bash
nla /absolute/path/to/project
```

Do not edit shell startup files without explicit user approval.

## Optional Browser

Normal NLA installation needs no browser or privileged service. To enable web
tasks, follow the [Browser quick start](docs/BROWSER.md#quick-start).
It installs a separate Playwright backend and creates two private config files;
the launcher picks them up on the next run. Linux broker isolation is a separate
installation for operators who need preventive network containment.

## Updating

```bash
git -C "$HOME/.local/share/nla/next-level-agent" status --short --branch
git -C "$HOME/.local/share/nla/next-level-agent" pull --ff-only
```

Restart OpenCode after updating. Re-run `opencode debug config` and a smoke test after changes to OpenCode, NLA configuration, models, plugin code, or skills.

## Uninstalling

If NLA was used only through `OPENCODE_CONFIG`, stop exporting that variable or remove the optional shell helper. The target project was not modified by the installation itself.

Do not delete the clone until checking whether it contains local changes or whether Notebook and session state should be retained. Durable NLA state is stored separately under:

```text
~/.local/share/nla/system.sqlite
~/.local/share/nla/assistant-notebook/
```

Removing the clone does not remove those state directories.

## Important Boundaries

- NLA is Alpha software.
- NLA is not an operating-system sandbox.
- Some role restrictions are behavioral rather than hard permission enforcement.
- Controlled compaction requires a persistent TUI or server.
- One-shot `opencode run` may exit before the idle compaction pipeline completes.
- Do not overwrite existing global or project OpenCode configuration.
- Do not install or modify providers without explicit user approval.
- Do not expose secrets in commands, logs, configuration, Notebook, or ledger.
- NLA blocks common full-environment dump commands (`env`, `printenv`,
  `export -p`, `declare -p`, `set`, and `/proc/*/environ`), nested shell
  launchers, and direct privilege tools (`sudo`, `doas`, `runuser`, `su`) for
  NLA-managed sessions. This is a narrow OpenCode hook policy, not a shell
  sandbox; keep credentials out of the process environment where practical.
