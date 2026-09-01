# Install Next Level Agent for OpenCode

NLA is currently developed and tested for OpenCode. These instructions install the NLA configuration and plugin for use with an existing project. They do not claim support for running the complete NLA system inside another coding-agent CLI.

For status, limitations, storage, telemetry, and the roadmap, read [Project Status and Usage](docs/PROJECT_STATUS_AND_USAGE.md).

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

For a machine-local pool assignment without changing repository defaults, point
NLA at a complete external pool file:

```bash
export NLA_MODEL_POOLS_PATH="/absolute/path/to/model-pools.json"
```

The override applies to role-pool selection only. Provider definitions and
agent prompts remain OpenCode configuration concerns. Keep machine-specific
provider URLs and model bindings outside the repository.

The current Architect pool begins with:

```text
nvidia/qwen/qwen3-coder-480b-a35b-instruct
```

That endpoint has returned HTTP 410 and is intentionally retained as a live failover probe. Replace it with a healthy preferred model for ordinary use. Keep a working fallback.

Never place API keys in `opencode.json`, `model-pools.json`, Notebook, ledger, or telemetry.

## 3. Start NLA in a Project

Use OpenCode's custom configuration path:

```bash
export NLA_HOME="$HOME/.local/share/nla/next-level-agent"
export OPENCODE_CONFIG="$NLA_HOME/opencode.json"
opencode /absolute/path/to/your/project
```

The NLA plugin and skills resolve relative to `opencode.json`. The path passed to `opencode` remains the working project.

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
- expose `nla_task`, `nla_state`, `nla_notebook`, and `nla_compact`;
- write lifecycle telemetry to `<project>/.opencode/agent-run.log` after activity.

Use a harmless first request, for example:

```text
Inspect this repository without changing files and tell me which Tier this task belongs to.
```

## Optional Shell Helper

The user may define a shell function outside the repository:

```bash
nla() {
  NLA_HOME="$HOME/.local/share/nla/next-level-agent" \
  OPENCODE_CONFIG="$HOME/.local/share/nla/next-level-agent/opencode.json" \
  opencode "${1:-$PWD}"
}
```

Then run:

```bash
nla /absolute/path/to/project
```

Do not edit shell startup files without explicit user approval.

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
~/.local/share/nla/sessions/
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
