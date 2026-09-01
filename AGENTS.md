# Next Level Agent Repository Instructions

This repository contains Next Level Agent for OpenCode.

## Purpose of This File

These instructions are for a coding agent, including OpenCode or Codex, that is helping a user install, verify, update, or develop NLA.

Codex may assist with the installation process, but the complete NLA runtime is currently supported only in OpenCode. Do not describe this file as evidence that NLA supports Codex CLI or any other coding-agent CLI.

## Before Acting

1. Read [README.md](README.md) for product architecture and role boundaries.
2. Read [INSTALL.md](INSTALL.md) for the supported Alpha installation procedure.
3. Read [docs/PROJECT_STATUS_AND_USAGE.md](docs/PROJECT_STATUS_AND_USAGE.md) for current limitations, telemetry, state locations, and roadmap.
4. Read [docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md](docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md) before proposing work from the historical Draft 0.4.
5. Inspect the current Git status and preserve user changes.

## Installation Objective

Install NLA as a stable local clone and launch OpenCode against the user's selected project with:

```bash
OPENCODE_CONFIG=/absolute/path/to/next-level-agent/opencode.json \
  opencode /absolute/path/to/project
```

The supported Alpha installation does not require the unfinished transactional installer described by Draft 0.4.

## Installation Rules

- Ask which project the user wants to run NLA against if it is not clear from the current workspace.
- Use a stable clone path such as `~/.local/share/nla/next-level-agent`.
- Do not overwrite an existing clone, global OpenCode config, project config, shell profile, provider config, or credentials.
- Before updating an existing clone, run `git status --short --branch` and preserve local changes.
- Do not run destructive Git commands.
- Do not store API keys in the repository or NLA state.
- Do not change model bindings without showing the proposed change to the user when it affects provider access or cost.
- Do not install packages or providers unless the user authorizes it.
- Prefer `OPENCODE_CONFIG` over copying the complete NLA configuration into every project.
- Treat `opencode debug config` as a required non-LLM verification step.
- Use a harmless read-only smoke test before a real task.
- Report exact evidence, including OpenCode version, resolved plugin path, default agent, skills path, model bindings, and smoke-test result.

## Required Preflight

Run:

```bash
opencode --version
git --version
git -C /absolute/path/to/next-level-agent status --short --branch
```

Inspect:

```text
opencode.json
config/model-pools.json
```

Check that every enabled pool has at least one model the user can access. Public defaults use models that passed the documented development smoke tests; provider availability can still change, so verify the resolved model list during installation.

## Required Verification

From the target project, run:

```bash
OPENCODE_CONFIG=/absolute/path/to/next-level-agent/opencode.json \
  opencode debug config
```

Verify all of the following:

- the Next Level Agent plugin is loaded from the intended clone;
- `default_agent` is `nla`;
- the NLA roles are present;
- the NLA skills directory is present;
- compaction settings are active;
- no target-project configuration unexpectedly replaced critical NLA fields.

Then start a persistent OpenCode TUI for the target project and run a harmless read-only prompt. Do not use one-shot `opencode run` to validate controlled compaction.

## Expected Installation Report

Report:

```text
NLA clone:
Target project:
OpenCode version:
Resolved plugin:
Default agent:
Skills path:
Primary model:
Enabled role pools:
Config conflicts:
Smoke test:
Known warnings:
```

Do not claim success if any required value is unknown or if the plugin and bootstrap skill were not observed.

## Development Boundaries

NLA Core is the current priority. Focus on:

- hard role permissions;
- Task Context Packet validation;
- workflow transition enforcement;
- Supervisor behavior tests;
- practical Tier 2 and Tier 3 end-to-end tests;
- stable model pools and deterministic failure fixtures;
- memory, compaction, restoration, and telemetry reliability.

Do not restart work on the Draft 0.4 transactional installer, managed launcher, immutable catalog, or full benchmark laboratory unless the user explicitly places NLA Managed Profile back in scope.

## Repository Safety

- Preserve unrelated and pre-existing changes.
- Use focused tests proportional to the change.
- Never claim completion without fresh verification evidence.
- Do not commit or push unless the user asks for it.
- Do not open a pull request to Superpowers upstream for NLA-specific changes.
- Preserve Superpowers attribution and license boundaries.
- Do not claim support for another CLI without a complete NLA end-to-end integration test.
