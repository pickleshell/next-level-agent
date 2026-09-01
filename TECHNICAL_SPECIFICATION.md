# Next-Level OpenCode Profile — Technical Specification and Architecture

**Status:** Draft 0.4 — final architecture audit, requires approval
**Date:** 2026-08-23
**Repository:** `pickleshell/next-level-agent`
**Target version:** OpenCode `1.17.9` (stable V1 configuration schema)

## 1. Product Definition

The product is a repository-local configuration pack for OpenCode, not a separate
system, daemon, database, or external orchestrator.

Delivery must use OpenCode's native mechanisms:

- primary agent and subagents;
- Task delegation to child sessions;
- per-agent models, permissions, and limits;
- lazily loaded skills;
- custom commands;
- project-local custom tools and plugin hooks;
- automatic compaction and pruning;
- worktree/diff audit, bounded file/content search, targeted read, optional experimental
  LSP, and usage statistics.

The goal is to maximize the quality of the accepted result at minimal cost per accepted
task (`cost per accepted task`). When goals conflict, priorities are as follows:

1. security and absence of data loss;
2. correctness and completion of the Definition of Done;
3. minimization of fresh input, output, reasoning tokens, and actually billed cost;
4. execution speed.

Minimal token count is not itself considered success if the result fails verification.

> **Current implementation evolution:** NLA now distinguishes an OpenCode
> **agent runtime** for multi-step reasoning, tools, repository navigation, and
> workflow participation from a direct **utility-model runtime** for bounded
> single-shot transformations or analysis supplied with a complete packet and
> data. The latter is a deliberate architecture for local, small, cheap, or
> specialized models, not a one-model workaround. Compactor is the first proven
> consumer; Explorer may use it only for supplied-data work. This claim does not
> extend to Router. A model's success on a narrow direct Ollama task does not
> imply success under the instruction, tool, context, and workflow overhead of
> a full OpenCode agent loop. Compactor output remains validated with a
> deterministic fallback, while Supervisor remains fail-closed through
> OpenCode. This evolution postdates the normative Draft 0.4 text below.
>
> A later architecture decision broadens Compactor from context compression to
> prompt optimization before model invocation, including prompt shaping and
> pruning tool schemas to a small relevant subset. Router remains responsible
> only for task and model routing; there is no new Selector role. This responds
> to a forensic OpenCode comparison in which 31 injected tool schemas consumed
> approximately 16.7k prompt tokens and caused local-model latency/timeouts,
> while `tools: false` reduced the prompt to approximately 126 tokens and
> restored fast behavior. Optimization must preserve task meaning, constraints,
> permissions, acceptance criteria, and provenance. On unavailable or invalid
> optimization, NLA uses a conservative deterministic role/step subset rather
> than the full tool universe and fails closed if no safe sufficient subset can
> be determined. This decision is not implemented in the current runtime.

## 2. Delivery Boundaries

### 2.1. Included in the first version

- `opencode.jsonc` (or adopted existing `opencode.json`) with runtime settings and
  role-to-model binding;
- pack-owned `PROFILE_RULES.md` and integration contract with user-owned `AGENTS.md`;
- prompts for the primary agent and specialized subagents;
- core skills and rules for installing project-specific skills;
- custom commands for explicit workflows;
- a mandatory project-local guard/search plugin as a native OpenCode extension;
- compact long-term project context templates;
- configuration and permission validator;
- a thin managed launcher for a sealed config environment and a non-LLM profile doctor;
- a safe installer/updater/uninstaller with manifest-lock;
- a benchmark suite for measuring quality, tokens, and cost;
- a README covering installation, model binding, and operation.

### 2.2. Not included in the first version

- a custom runtime or API on top of OpenCode;
- storage of all session history;
- autonomous modification of user requirements;
- selection of specific providers and model names;
- storage of API keys in the repository;
- universal integration with all IDEs;
- a production profile for OpenCode V2 beta;
- hard inter-process locking of multiple OpenCode sessions;
- an external daemon, proxy, or separate orchestration runtime.

The project-local plugin is not a separate system: it is loaded by OpenCode itself via an
explicit local entry and closes known limitations of the pinned V1 runtime that cannot be
safely expressed through permission globs alone. The managed launcher also does not
orchestrate tasks and does not proxy provider traffic: it only verifies lock/preflight,
establishes an isolated environment, and executes the standard OpenCode process.

## 3. Compatibility and OpenCode Version

The reference implementation is developed and tested on OpenCode `1.17.9`. The V1 schema
is used:

- `agent`, not `agents`;
- `permission`, not `permissions`;
- `bash` and `task`, not `shell` and `subagent`;
- `prompt`, `disable`, `steps`;
- `compaction.prune` and `compaction.reserved`.

The reference V1 template must not be mixed with native examples from `/v2/docs`. V2 may
normalize part of the V1 fields, but it has its own schema and migration semantics; it is
tested by a separate `opencode2` binary and remains a separate future profile.

Updating OpenCode is performed only after passing the validator and regression benchmark.
The normative value of `autoupdate` is `false`.

Reference platform — Linux/macOS on local filesystem with POSIX atomic create/rename;
Windows is supported via WSL. Network filesystems and native Windows require a separate
lease/path regression profile and, until then, receive Fail rather than a relaxation of
guard semantics.
Core managed launch does not coexist with system-managed OpenCode config: Linux/WSL
`/etc/opencode`, macOS managed Application Support, and MDM plist are first checked
without importing code; the presence of any such source yields Fail until a separate
organization profile exists. The launcher then points the managed-config directory at a
controlled empty `0700` root. On macOS the MDM plist is not suppressed by this override,
so its presence unconditionally disables the hard-profile.

## 4. Architectural Principles

1. **Native-first.** Use OpenCode's own config, agents, permissions, skills, commands,
   custom tools, and plugin hooks; no external runtime is introduced.
2. **Direct-first.** A simple task must not spawn subagents and a context packet.
3. **Risk-based delegation.** The cost of a route depends on risk and uncertainty, not
   only on request size.
4. **Fresh child context.** A subagent receives a self-contained brief contract, not a
   copy of the primary session correspondence.
5. **Least privilege.** Each role receives only the executable tool, skill, and subagent
   catalogs it needs; mixed permission maps remain visible only to roles that genuinely
   need the capability.
6. **Lazy instructions.** The persistent prompt is minimal; conditional procedures live
   in skills.
7. **Serialized writers.** The orchestrator must run write tasks sequentially; this is a
   policy, not a built-in OpenCode lock.
8. **Evidence before state.** An unverified result never enters long-term state.
9. **Fail-fast.** A missing model, skill, or invalid config is an error, not grounds for
   a silent fallback.
10. **Model-role separation.** Prompts describe a role's capabilities, while actual models
    are bound at installation.
11. **Measurement over intuition.** Savings are confirmed by provider-reported usage and
    benchmark, not by prompt length at a glance.

## 5. Technical Guarantee Boundaries

### 5.1. OpenCode and the mandatory project-local guard provide

- selection of the primary agent via `default_agent`;
- deterministic managed launch without mixing in user global config;
- prohibition of source-edit via `edit: deny` and prohibition of shell where it is not needed;
- allowlist of callable subagents via `permission.task`;
- prohibition of nested delegation via `task: deny` for every subagent;
- soft finish warning via `steps` and hard LLM/Task-call caps via guard hooks;
- a separate model for each role;
- hiding of unavailable skills via skill permissions;
- automatic compaction and pruning of old tool outputs;
- command isolation in a child session via `subtask: true`;
- pre/post worktree evidence; rollback is performed only via an explicit safe Git/manual workflow.

V1.17.9 itself has five substantial gaps: `grep` permission checks the regex, not paths;
Task may materialize `@file` without child `read` approval; Unix path checks are lexical
and ignore symlink targets; `apply_patch` checks the source but not the `*** Move to:`
destination; the built-in `webfetch` does not protect private/link-local targets and
redirects. Therefore the fail-closed profile requires a pack-owned `profile-guard` plugin,
which also registers the `safe_search` and `safe_fetch` custom tools:

- the committed base config sets root and each role permission wildcard `"*": "deny"`,
  explicitly leaves risk capabilities denied, sets `formatter: false`, `lsp: false`, and
  `disable: true` for all known primary/subagent/maintenance agents; until successful guard
  activation, not even an LLM call is possible;
- the guard is the only external plugin and, via the `config` hook, performs the final
  atomic assignment that sets up and enables the intended six agents + compaction, leaves
  the remaining agents disabled, fixes commands, `mcp: {}`, and ordered permission maps;
  `lsp` remains `false`, except for a separately validated exact profile;
- the built-in `grep` and `glob` are forbidden to all roles; `safe_search` performs a
  bounded file/content search via `rg` without shell, `--follow`, `--hidden`, and
  `--no-ignore`, checking every search root;
- `safe_search.execute` resolves the active role by `sessionID` before enumeration and,
  as its first action, calls native `ctx.ask` for the `safe_search` permission with the
  exact pattern; an unknown/denied role terminates before filesystem access; the guard
  before-hook duplicates the gate;
- the built-in `webfetch` is forbidden to all, while Scout uses bounded HTTPS-only
  `safe_fetch` with permission/role gate and SSRF/redirect/DNS validation;
- the `tool.execute.before` hook rejects attachment syntax in the Task prompt;
- the same hook rejects `apply_patch` move syntax and checks all path arguments;
- `chat.params` before every logical `LLM.stream` attempt first fail-closed compares the
  active role, provider/model, approved variant/options against the locked model snapshot
  (including resume/direct agent/compaction), then atomically reserves budget in a durable
  per-root ledger for an outer retry of the same message and rejects a call beyond the
  per-role/root cap; main work calls keep AI SDK `maxRetries: 0`. The Task hook analogously
  reserves the cumulative child call before creating the child session;
- an existing target is resolved via `realpath`, a new target via `realpath` of the nearest
  existing parent; symlink components are forbidden;
- `lsp.filePath` undergoes the same canonical worktree check; there is no separate built-in
  `list` tool in V1.17.9, and the guard allows built-in `read` only for an existing
  canonical regular file. Directories and missing targets are rejected before listing/typo
  suggestions; discovery is performed only by filtered `safe_search mode=files`;
- the resolved path must remain inside the worktree; the guard resolves the active role by
  `sessionID` and applies the same ordered policy: `deny` is rejected, `ask` is passed to
  the native permission flow, an explicit example `allow` is preserved. `safe_search` has
  no per-match approval and therefore always excludes secret candidates.

The plugin is connected by a single explicit local path from `opencode.jsonc`. The
production entry point is the pack-owned `opencode-profile`, which without LLM before each
launch checks lock/origin hashes and static preflight, rejects `--pure` and config/plugin
override flags, any share/auto-share flags, isolates all XDG roots, `OPENCODE_TEST_HOME`,
and the managed-config directory, removes all inherited `OPENCODE_*` by a deny-by-default
rule, and prohibits external skill discovery. It then sets only the launcher-controlled
`OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`,
`OPENCODE_DISABLE_EXTERNAL_SKILLS=true`, `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, and explicitly
`OPENCODE_DISABLE_MODELS_FETCH=true`, a hash-verified `OPENCODE_MODELS_PATH`, and an
explicitly enabled policy feature flag. The only optional core feature flag is
`OPENCODE_EXPERIMENTAL_LSP_TOOL=true` if the LSP profile has passed checks; the remaining
`OPENCODE_*` are not inherited. The isolated persistent runtime lives outside the worktree
in an owner-only per-user profile root, has mode `0700`, and is closed off by
containment/`external_directory` model-tool rules; provider auth is permitted only via an
exact deployment allowlist of env/API/OAuth credentials. Stored auth metadata is verified
without emitting secrets: `type: "wellknown"`, an active OpenCode account/org remote
config, and any other pre-guard remote-config source yield Fail and require a separate
conditional profile.

If the guard is absent or fails to load, the launcher does not invoke OpenCode. If the hook
did not activate inside an already-running process, the committed `disable: true` prevents
selecting an agent or calling a provider, wildcard denies close the tool surface, and the
config environment contains no foreign MCP/plugin/command/skill sources. A direct `opencode`,
`--pure`, or launch with the host global config is unmanaged and falls outside the hard
guarantees: V1.17.9 may attach a merged remote MCP regardless of tool permission. The
validator must distinguish these states; any unsuccessful guard smoke test blocks managed
work.

V1.17.9 `resolveTools` schema-filter removes a tool when the resulting permission for the
exact pattern `"*"` equals `deny`. Therefore fully forbidden role tools do not reach the
LLM map; a capability with mixed allow/ask/deny rules remains visible and is re-checked at
execution. The validator tests both levels, and the benchmark still measures the actual
cold-input floor rather than calculating from tool names.

### 5.2. The following properties remain policy, not hard guarantees

- correctness of complexity and risk classification;
- compliance with the Task Context Packet size;
- dynamic restriction of the Implementer to files of the current packet only;
- an exact per-task token/dollar budget: the guard limits the number of calls, but the size
  and the actual provider bill of a single call are unknown in advance;
- raw provider HTTP retries inside the adapter/network stack: the hard cap applies to
  logical OpenCode stream attempts; the actual requests/cost are checked by telemetry;
- the sequence `Implement → Verify → Review → Checkpoint`;
- single-writer even within a single session and absence of writers in other processes;
- writing to the Notebook exclusively during checkpoint;
- a mandatory checkpoint before a direct `/new`, closure, or crash;
- completeness and truthfulness of Notebook entries;
- absence of a symlink TOCTOU race between the guard pre-check and built-in tool execution:
  the profile forbids symlinks, but hard race isolation would require replacing all
  filesystem tools or an OS sandbox;
- confidentiality of the internal indexing LSP server: experimental LSP remains optional and
  is disabled for repositories with a hard secret boundary;
- safe sanitization of native custom command arguments: V1.17.9 performs shell/file
  interpolation before `command.execute.before`, so shipped commands are zero-argument and
  passing arguments to them is forbidden by the operational contract;
- prohibition of an intentional direct `@subagent` call by the user: role permissions are
  preserved, but the Orchestrator workflow bypasses such a call;
- confidentiality after an explicitly approved shell command or project verification:
  OpenCode does not analyze the arbitrary side effects and output of such a process.

These limitations must be reflected in prompts, post-diff checks, the validator, and
documentation. They must not be described as technically guaranteed without stronger
isolation or external coordination.

## 6. Artifact Architecture and Installation

The configuration pack is delivered as an installer-managed overlay. The source pack
repository and the installed target layout are separate: the utility benchmark is not copied
into the user's project, while runtime files come from explicitly enumerated
template/script sources.

### 6.1. Source pack repository

```text
README.md
VERSION
profiles/
└── models.env.example
scripts/
├── install-profile.sh
├── run-profile.sh
├── profile-doctor.sh
├── validate-config.sh
└── benchmark.sh
benchmark/
├── scenarios/
├── expected/
└── profiles/
    └── baseline/
        ├── opencode.jsonc
        └── baseline-manifest.json
template/
├── opencode.jsonc
└── .opencode/
    ├── .gitignore
    ├── package.json
    ├── package-lock.json
    ├── PROFILE_RULES.md
    ├── profile/
    │   ├── guard.ts
    │   ├── argv-policy.json
    │   ├── lsp-safe-servers.json
    │   └── policy.json
    ├── prompts/
    │   ├── orchestrator.md
    │   ├── explorer.md
    │   ├── scout.md
    │   ├── architect.md
    │   ├── implementer.md
    │   └── reviewer.md
    ├── commands/
    │   ├── route.md
    │   ├── review.md
    │   ├── diagnose.md
    │   ├── checkpoint.md
    │   ├── handoff.md
    │   └── status.md
    ├── skills/
    │   └── <skill-name>/SKILL.md
    └── notebook/
        ├── MANIFEST.md
        ├── INDEX.md
        ├── DECISIONS.md
        └── STATE.md
```

Agents are declared in `opencode.jsonc`. Their large prompts are attached via
`{file:./.opencode/prompts/<role>.md}`, and models via `{env:...}`. This allows validating
a single schema and not relying on env-variable substitution in YAML frontmatter of agent
Markdown.

The root `plugin` list contains exactly one explicit local entry for
`./.opencode/profile/guard.ts`; auto-discovered or global external plugins are forbidden in
the core profile. A project-specific plugin requires a separate audited profile where the
guard remains the last hook and regression probes confirm the same deny-mode.

Skills always use the portable format `.opencode/skills/<name>/SKILL.md` with correct YAML
frontmatter. Each permitted skill is associated not only with a name but also with a
canonical relative origin and SHA-256 in the lock. Core forbids `skills.paths`,
`skills.urls`, duplicate logical names, and any discovered skill outside the adopted origin
map. A project-specific skill first passes explicit adoption and receives its own locked
origin/hash; a name match alone is insufficient. The only core exception is the pinned
V1.17.9 built-in `customize-opencode` with pseudo-origin `<built-in>`: binary/source
version and expected content hash are attested in the lock, `permission.skill` for it is
exact deny for all roles, and the slash alias is safely shadowed. It is discovered but
never allowed.

`.opencode/profile/guard.ts`, `.opencode/package.json`, and `package-lock.json` are part of
a single pinned compatibility unit. The guard simultaneously implements enforcement hooks and
registers `safe_search`/`safe_fetch`. The package contains only the exact compatible version
of `@opencode-ai/plugin`, and the npm lock fixes the resolved artifact and integrity; runtime
dependency drift is forbidden. The V1.17.9 config loader uses npm/Arborist and
`package-lock.json`, not a Bun lock. A custom tool runs `rg` via the argv API without shell
interpolation; the presence of a supported `rg` version is checked at preflight.

`profile/argv-policy.json` — a pack-owned strict contract pinned to CLI 1.17.9. The launcher
parses argv structurally (`--flag=value`, short aliases, `--`, positionals) and accepts only
mode-specific subcommands/flags; substring filtering is forbidden. Production permits the TUI
only for the canonical current locked worktree without a project positional, bounded `run`
with prompt/`--format`/resume of the same isolated session, read-only `models`/`agent list`,
and exact isolated `auth` operations. It forbids `--attach`, `--dir`, file attachment,
`--dangerously-skip-permissions`, share, model/variant/agent override, remote/server
credentials, and any unknown flag. `attach`, `plugin`, `upgrade`, `uninstall`, `mcp`,
`import`, `github`, `pr`, `acp`, server/web, and debug verbs are absent from the production
allowlist. Installer/validator and benchmark have separate, narrower internal allowlists;
arbitrary forwarding is never used.

`profile/lsp-safe-servers.json` — a pack-owned allowlist of pinned V1.17.9 server IDs for
which the native implementation uses only a preinstalled PATH binary and does not invoke
`Npm.which`, the global cache, an installer, or a `latest` download. Conditional policy may
select only these IDs and fixes the canonical binary/version/SHA; all other built-ins always
receive `{ "disabled": true }`.

`profile/policy.json` — the single machine-readable project policy with a strict schema and
`policy_version`. It contains only additional relative secret paths, exact hidden search
allow-roots, an optional LSP profile with exact audited server IDs and canonical preinstalled
binary/version/SHA-256, per-role exact verification command allowlists, and bounded per-role
LLM calls, root Task calls, and compaction counts. `instruction_files` contains only
explicitly adopted relative auto-instruction origins and expected SHA/size; remote/secret/
control origins are forbidden. Optional `project_skills` contains only an adopted logical
name, canonical relative `SKILL.md`, exact allowed agents, and expected SHA-256; it accepts
no URLs, resources, or arbitrary discovery paths. `provider_env_names` and `project_env_names`
are non-secret exact-name allowlists; values never enter policy/lock/logs. Names must match
`[A-Z][A-Z0-9_]{0,63}`, must not start with `OPENCODE_`/`OC_MODEL_`, and must not be
process-loader/shell variables (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BUN_OPTIONS`,
`PYTHONPATH`, `PYTHONSTARTUP`, `RUBYOPT`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
`NPM_CONFIG_*`, `GIT_CONFIG_*`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `CDPATH`, `IFS`,
`PROMPT_COMMAND`, and the versioned validator denylist). Generic readers, interpreters,
command substitutions, and shell control operators are forbidden by the schema/semantic
validator; a fixed audited interpreter + script invocation may be a separate exact entry. The
guard reads policy directly via the filesystem API before changing config; a missing,
invalid, or contract-incompatible policy leaves base deny-mode. Markdown is never parsed as a
permission source.

The guard creates `<managed-runtime-root>/budgets/` only for minimal append-only counters:
root/session IDs, reservation ID, role, event kind, and timestamp; prompts/tool outputs are
forbidden there. Before every `chat.params`, Task, and compaction the guard takes an atomic
per-root filesystem lease, appends + fsyncs a reservation, and only then permits the call. The
runtime root undergoes a separate containment check against the chosen per-user state base and
no-symlink/owner/mode checks; files are opened exclusive/no-follow where the platform supports
it. This serializes budget reservations even for parallel children and multiple OpenCode
processes, but is not a general worktree writer lock. A crash after reservation can only
overcount usage; a reservation is not returned automatically. A stale lease or corrupt ledger
yields deny until explicit recovery via the profile doctor. The runtime root is defined as a
platform-specific per-user state base plus SHA-256 of the canonical worktree path and a random
install UUID from the lock; the raw path is not stored in the name. It must lie outside the
worktree, belong to the current uid, have no symlink components, and not inherit host OpenCode
directories. The runtime ledger is user-owned, is not transferred by the installer, and is not
deleted automatically.
If the platform default intersects the worktree (for example, the repository spans the
user-home), managed launch requires an explicit `OPENCODE_PROFILE_RUNTIME_ROOT` outside both
trees and applies the same owner/mode/canonical checks to it; an unsafe fallback inside the
project is forbidden.

Recovery is LLM-independent: the pack-owned `profile-doctor --audit-budget` performs a
read-only check, and `--recover-budget <root-id> --apply` after verifying no live holder and
capturing a recovery lease saves the original ledger/lease in quarantine, marks the corrupted
root terminal/cap-exhausted, and permits work only in a new root session. It never zeroes the
cap of the current root and deletes nothing silently.

### 6.2. Target layout and ownership

In the target git repository the installer creates `opencode.jsonc`, `.opencode/*` from the
template, copies the canonical validator to `.opencode/profile/bin/validate-config.sh`, the
managed launcher and non-LLM profile doctor, and creates `.opencode/profile-lock.json`.
The lock contains the pack version, config-contract version, source revision, ownership, and
SHA-256 of each pack-owned file, plus a logical origin registry for agents, commands, prompts,
instructions, and skills, and a random non-secret install UUID for the external runtime path.
It also stores a canonical path/version/SHA-256 registry for OpenCode, `rg`, the materializer
npm/runtime, the validated shell, and the benchmark/verification Git where they are used by
pack code. The guard invokes `rg` only by locked absolute path; the launcher does not
re-resolve OpenCode through a changed PATH. The lock itself is an installer-owned control
artifact and does not include its own hash in the ownership map.

The installer also generates the pack-controlled `.opencode/profile/models.snapshot.json` and
`.opencode/profile/dependencies.manifest.json`. These are not hand-edited policy: the first
changes only on a model binding transaction, the second only on an exact dependency
materialization transaction; both are hash-locked and committed/visible for review.

Pack-owned are PROFILE_RULES, prompts, commands, skills, the profile guard, the argv/LSP-safe
policies, the launcher, the profile doctor, the generated model/dependency manifests,
`.opencode/package.json`, `package-lock.json`, the validator, and the `opencode.jsonc` created
from scratch.
`.opencode/.gitignore`, `profile/policy.json`, `MANIFEST.md`, `INDEX.md`, `DECISIONS.md`, and
`STATE.md` are seed files: the installer creates missing ones but immediately marks them
user-owned, does not include their hashes in the update ownership, and never overwrites them.
The lock stores their observed hashes and schema/contract versions only for drift detection.
Existing policy/Notebook are preserved and pass strict schema validation. The root `AGENTS.md`,
the adopted root config, and any other files outside the pack-owned map are also user-owned.

Generic pack rules live in `.opencode/PROFILE_RULES.md` and are attached via `instructions` in
`opencode.jsonc`. Therefore the existing `AGENTS.md` is not copied and not overwritten.
Project facts remain in user-owned `AGENTS.md` and/or in `MANIFEST.md`.

Pack command names are reserved. The managed profile does not merge them with host or
unaccounted project commands: the launcher/guard require an exact origin registry and hashes,
and the guard final assignment replaces the effective command map entirely. The same rule
applies to exact agent definitions and all `{file:}` prompt/instruction refs.

### 6.3. Normative installer contract

1. `install-profile.sh <target>` by default performs a dry-run only. Writing is permitted
   only with `--apply`.
2. The target must be a git repository with a clean worktree. Otherwise the installer exits
   without changes; bypassing the check requires a separate future feature, not a hidden flag.
3. The installer first builds a full staging tree and transaction manifest: pre-image hashes,
   paths to be created, paths to be replaced, and the previous lock. No target path changes
   until staging validation and smoke tests succeed.
4. A fresh install creates only missing pack paths. Any match with a user-owned non-seed file
   is a conflict and stops the transaction. `.opencode/.gitignore`, policy, and Notebook seed
   paths are exceptions: existing ones are preserved and validated, missing ones are created
   user-owned from a conservative template. Gitignore must contain the required runtime-artifact
   entry `node_modules/` and must not ignore package/lock/guard or any other pack-owned path;
   fixing this requires an explicit adopted candidate.
5. If exactly one of `opencode.jsonc`/`opencode.json` already exists, dry-run preserves its
   path/format and outputs a merge plan with a candidate in a temporary directory without
   changing the target. The presence of both files is a conflict until an explicit user
   decision. The user passes the final file via `--adopt-config <path> --apply`; the installer
   places it and all remaining runtime files in a single staging tree, checks resolved
   references, and applies in one transaction. The adopted config is written to the lock as
   `ownership: user` with the observed hash and config-contract version.
6. On update the new config-contract is compared with the lock. Pack-owned config is updated
   only when the current hash matches. For an adopted config, a contract change always stops
   the update and creates a new candidate; `--re-adopt-config <path> --apply` validates and
   applies the merged config together with all pack updates in one transaction. If the contract
   did not change, the user config is only validated and its observed hash is updated in the
   lock. A policy-contract change analogously requires a valid `--re-adopt-policy <path>
   --apply`; policy is never rewritten silently. A provider env name is added/removed only via
   explicit `--allow-provider-env <NAME> --apply` / `--remove-provider-env <NAME> --apply`:
   dry-run shows the policy candidate and non-secret lock diff; the value is neither read nor
   stored by the installer. The launcher later copies only the exact listed key and only if the
   runtime value is non-empty; wildcard/prefix passthrough is forbidden. For non-secret
   build/toolchain passthrough, `--allow-project-env`/`--remove-project-env` are used
   symmetrically; the same dangerous-name denylist is mandatory. Changing the canonical pack
   executable path/version/hash requires `--rebind-runtime-tools --apply`, full validation, and
   is not accepted silently by the launcher. The existing root `AGENTS.md` is the only implicit
   user instruction origin: install dry-run shows its hash/size and provider-visible status. Any
   nested `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, or other configured instruction requires
   `--adopt-instruction <relative-path> --apply`; a change requires `--re-adopt-instruction`.
   The source must be an existing canonical regular non-symlink UTF-8 file, pass an aggregate
   prompt budget/secret scan, and land in `policy.instruction_files` + lock. Intersection with
   baseline/project secret/control paths yields an unconditional Fail, not an approval bypass.
   Adoption explicitly means the content will be sent to the provider by the roles to which
   OpenCode injects it.
7. A project-specific skill is added only via
   `--adopt-skill <name>=<source-SKILL.md> --agents <exact-role-list> --apply`. Dry-run shows
   the staged copy and the targeted `policy.project_skills` candidate. The source must be a
   single regular non-symlink UTF-8 Markdown file ≤ 32 KiB, have matching strict frontmatter,
   not intersect reserved names/plugin/tool/command paths, and contain no secrets. Resources/
   scripts are not supported in V1 project-skill adoption: the skill must be self-contained.
   Apply atomically copies the skill, updates the exact role skill maps, policy, and lock origin
   registry. A change requires `--re-adopt-skill` with the same checks; collision or drift
   stops the whole transaction. On uninstall an adopted skill is by default preserved as a
   user-owned project skill; the uninstall report warns that ordinary OpenCode may continue
   auto-discovery. Deleting its files requires a separate exact `--remove-adopted-skill <name>
   --apply` and a dependency audit.
8. Other updates replace only the pack-owned file whose current hash equals the hash in the
   lock. Modified, missing, and colliding paths yield a conflict report; partial update is
   forbidden.
9. `--uninstall` first builds a full retained-reference closure. If an adopted, user-owned, or
   modified root config/instruction still references the pack plugin, prompts, commands, skills,
   or other deletable paths, the operation completes without changes as a conflict. The installer
   emits a de-adoption candidate; the user explicitly passes a verified result via
   `--adopt-uninstall-config <path> --apply`. The candidate, deletions, and lock enter a single
   rollback-able transaction and are checked against a sanitized post-uninstall tree before the
   first write. An unchanged pack-owned root config is deleted; a retained config is permitted
   only if a dependency audit proves the absence of pack refs and reserved profile stanzas. Then
   only unchanged pack-owned files are deleted. Seed, modified, and user-owned files are
   preserved and listed. Policy is not deleted automatically. After a successful deletion a valid
   unmodified installer lock is deleted as the last control artifact; a modified or malformed
   lock stops uninstall before deleting any paths and is preserved with a conflict report.
10. After writing, final hashes are reconciled and validation/smoke tests are repeated on a
    minimal sanitized reconstruction from the transaction manifest, config refs, and a synthetic
    fixture, not on a copy of the whole target. Baseline/policy secret paths, unrelated
    ignored/untracked data, and remaining project files are not copied. On error, rollback
    restores all pre-images, deletes every path created by this transaction, deletes any
    directories that became empty, and restores or deletes the lock. Targets come only from the
    transaction manifest; broad recursive delete is forbidden. A fresh-install rollback fixture
    must confirm a byte-for-byte original tree.
11. The installer does not modify global config and does not install OpenCode or providers.
    Temporary roots are created with mode `0700`, known secrets are excluded, cleanup runs on
    success/error/signal, and logs contain no copied content. Git remains an additional recovery
    mechanism but does not replace transactional rollback.

Before any OpenCode invocation, the installer and, before each managed launch, the launcher
perform a non-executing static preflight of all project, host, system-managed, and
isolated-auth config sources. The core profile rejects any external plugin specs except the
pack guard, auto-discovered `{plugin,plugins}/*`, remote instructions, auto-discovered
executable `{tool,tools}/*.{js,ts}`, any non-empty effective `mcp` entry — local or remote,
`skills.paths`, `skills.urls`, foreign/duplicate agent, skill (except the attested denied
built-in exception) and command origins, `lsp.*.command`, `formatter.*.command`, and other
process integrations, as well as absolute, `~/`, and copied-root-escaping `{file:...}` refs.
Reserved commands and all permitted skills/prompts must have a canonical origin and SHA-256
matching the lock; foreign commands are not permitted in core at all. Any real system-managed
config, macOS MDM plist, stored `wellknown` auth, or active account/org remote config also
yields Fail; the checker reads only schema/type/origin metadata and never logs credential
values.

Preflight separately reproduces the V1.17.9 auto-instruction discovery for root/nested
`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, and configured `instructions`. Only the pack
`PROFILE_RULES.md`, the observed root `AGENTS.md`, and exact adopted origins are permitted;
each path is canonical/regular/non-symlink, hash/size matches, and the aggregate context
budget passes. A secret/control overlap blocks launch before reading content. These files are
intentionally provider-visible system context and are not protected by `read` permission.
Permitted relative file refs are first canonicalized, checked for containment, and copied into
the same disposable tree. Only a sanitized plugin-free global copy plus a hash-verified pack
guard are admitted to `opencode debug config`; foreign JavaScript is never imported for
"verification".

After static preflight, OpenCode commands inside the installer/validator and production
OpenCode inside the launcher run in an isolated process: separate `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `OPENCODE_TEST_HOME`, and a sanitized
config tree. The installer/validator use temporary roots and minimal reconstruction; the
launcher uses persistent owner-only roots outside the worktree to preserve sessions/cache/auth
without reading host OpenCode state. The inherited environment is not inherited wholesale. The
launcher rebuilds it from a fixed validated OS baseline (`PATH`, canonical `USER`/`LOGNAME`,
locale/terminal/temp, and validated shell), controlled XDG roots, and `HOME` inside the
owner-only managed runtime, exact `OC_MODEL_*`, exact policy `provider_env_names`/
`project_env_names`, and probe keys. Variables with the `OPENCODE_` prefix are first removed
all without exception, after which the launcher sets only the listed controlled
isolation/catalog variables and the optional audited LSP flag. This excludes, in particular,
auto-share, disable-autocompact/prune, DB, model path/URL, config/content/plugin, and
experimental overrides. `OC_MODEL_*` and provider/project keys are not in this namespace, but
an unknown inherited key is not forwarded. Credential values are not logged; a shell-capable
role after explicit command approval remains a residual confidentiality boundary per §5.2.
Shipped JSONC already contains `$schema`. The launcher forcibly sets
`npm_config_ignore_scripts=true`; other inherited npm/Node/Bun loader options fail the
baseline.
Host home dotfiles, credential chains, and `~/.opencode` are therefore invisible to the
process; filesystem-based provider auth requires a separate explicit conditional profile. This
isolates ordinary V1.17.9 config-loader writes, which may create global config, `.gitignore`,
and dependency artifacts. Neither `opencode debug config` nor discovery/smoke commands are run
directly against the real global config or target. XDG/temp isolation is not called a sandbox
for arbitrary plugin code; the only trusted executable code remains the verified pack guard.
Real verification of foreign plugins would require an OS sandbox and is out of core.

The locked plugin dependency is first resolved and checked by the config loader in a
disposable tree. `.opencode/node_modules/` is an ignored runtime artifact and not pack-owned;
package/lock and the generated `dependencies.manifest.json` are pack-owned/hash-controlled.
The materializer in a `0700` staging installs the exact lock with a controlled runtime `HOME`,
empty owner-only `npm_config_userconfig` and `npm_config_globalconfig`,
`npm_config_ignore_scripts=true`, audit/fund/notifier off, and an exact `npm_config_registry`,
without inherited proxy/auth/cafile variables. The core lock permits only HTTPS tarballs of an
exact audited public registry host with integrity; `git`, `file`, workspace, plain HTTP,
redirect to a different host, and arbitrary resolved URL are forbidden. The materializer
forbids symlinks and lifecycle scripts, then fixes a full sorted tree manifest: relative path,
type, mode, size, and SHA-256 of every regular file. Only after verification does it atomically
change the runtime tree, preserving the previous one in quarantine.

Before each OpenCode process the launcher, under cooperative lease, reconciles the absence of
missing/extra/symlink entries and the whole manifest; only then does it admit pre-guard import.
A mismatch or unavailable exact artifact stops launch without OpenCode and suggests the non-LLM
`profile-doctor --materialize-deps --apply`; the version is not substituted, the old tree is not
deleted silently. This is mandatory because V1.17.9, when `node_modules` exists, does not
verify extracted file contents against lock integrity.

The validator performs two resolved-config audits: the clean pack and a negative fixture with a
pre-sanitized hostile global config. The second proves the launcher does not inherit host
agents/permissions/MCP/commands/skills; any foreign executable or origin collision already
yields Fail at static preflight. After installation, a managed launch may create runtime cache
artifacts; the dependency tree remains an exact-manifest runtime artifact and is re-checked at
the next launch.

Paid provider smoke calls are performed only by a separate explicit command, showing the
expected number of calls.

`profiles/models.env.example` — documentation of variables, not an automatically loaded
env-file. The user exports values via shell/direnv or explicitly wires their own wrapper; real
values are not committed. The installer and validator fail if a required binding variable is
missing.

## 7. Long-Term Context

### 7.1. `AGENTS.md`

User-owned root `AGENTS.md` is loaded outside tool permissions and sent to the provider as
system context, so only non-secret project instructions are permitted:

- brief security invariants;
- non-obvious project-wide conventions;
- a reference to canonical `MANIFEST.md` and conditional skills without automatically reading
  all files.

Canonical executable verification allowlists, secret paths, and search roots are stored in
`profile/policy.json`; `MANIFEST.md` gives a human a brief map and a link to them. `AGENTS.md`
does not duplicate these lists.

The target size of `AGENTS.md` is up to 2,000 characters, with a maximum without explicit
waiver of 4,000. Large style guides and references must not be attached via broad instruction
globs. Nested/legacy instruction files without exact adoption are forbidden; a change to the
adopted hash requires re-adoption before managed launch.

### 7.2. Notebook

The Notebook is a compact project state, not a session archive.

`MANIFEST.md` contains:

- project goal and boundaries;
- stack and structure;
- the purpose of canonical commands/protected paths from `profile/policy.json`;
- key terms.

`INDEX.md` contains:

- a module map and key entry points;
- routing keywords;
- references to relevant Decisions sections;
- the date or revision of the last check.

`DECISIONS.md` stores ADRs with the following fields:

- ID and date;
- status `proposed | accepted | superseded | rejected`;
- context;
- decision;
- consequences and rollback;
- `supersedes` or `superseded_by`;
- evidence/reference.

`STATE.md` stores only current verified state:

- milestone and active task;
- base branch/revision;
- confirmed completed;
- changed files;
- checks performed and their results;
- risks and blockers;
- the concrete next step;
- ID and time of the last checkpoint.

The Notebook forbids transcript, raw tool outputs, secrets, and unconfirmed assumptions.
Completed history remains in git and OpenCode sessions. STATE must stay brief; old decisions are
not deleted silently but marked `superseded`.

## 8. Role Models

Actual provider/model IDs are not part of the architecture. Installation binds the following
capability slots:

| Variable | Purpose | Minimum qualities |
| --- | --- | --- |
| `OC_MODEL_COORDINATOR` | Orchestrator | reliable tool use, instruction following, moderate price |
| `OC_MODEL_EXPLORER` | Explorer | minimal price and latency with reliable read/search tools |
| `OC_MODEL_SCOUT` | Scout | search, reading documentation, long context |
| `OC_MODEL_ARCHITECT` | Architect | strongest reasoning, contracts and trade-offs |
| `OC_MODEL_IMPLEMENTER` | Implementer | strong coding/tool use, precise changes and tests |
| `OC_MODEL_REVIEWER` | Reviewer | independent criticism, defect finding, reasoning |
| `OC_MODEL_COMPACTOR` | `compaction` | faithful summarization, sufficient usable input window, low price |

Several slots may reference one model: these are quality/cost roles, not a requirement to have
seven different providers or subscriptions.

The Reviewer is preferably assigned from a different model family than the Implementer, if this
does not worsen the benchmark. This is a recommendation for error independence, not a provider
requirement.

Each model passes role smoke tests before being enabled. During explicit install/model rebind
an isolated resolver builds `.opencode/profile/models.snapshot.json` only for the seven slots;
dry-run shows provider/model, bundled adapter ID, exact API URL, limits, capabilities, pricing,
and variants without credentials. `--bind-models --apply` or `--rebind-models --apply` accepts
the snapshot, whose SHA and the values of each `OC_MODEL_*` are written to the lock. Core
permits only the bundled providers of OpenCode 1.17.9; non-bundled/custom `api.npm` adapter is
possible only in a separate conditional profile with exact version/integrity/module-manifest
audit.

On every managed launch the controlled `OPENCODE_DISABLE_MODELS_FETCH=true` and
`OPENCODE_MODELS_PATH` are set to the hash-verified snapshot; a mutable catalog/cache is not
used. Before the process the launcher reconciles the seven bindings, provider/model/API/adapter/
limits/capabilities, and selected variant with the lock. An empty or changed env variable,
catalog drift, `latest`, arbitrary npm/API override, or unknown limits yield Fail without
network/fallback. The resolved-profile audit also records reasoning options, temperature/top_p,
and the pricing snapshot. The same exact role→provider/model/variant/options contract is checked
by the guard on every `chat.params`; a TUI/session-stored model switch, a stale resumed session,
or a silent fallback are rejected before budget reservation/provider. Direct selection of
another locked role is permitted only with its own permissions and binding.

Provider-specific variants and reasoning effort are permitted only in a deployment profile after
verifying their existence. Core prompts remain provider-agnostic.

## 9. Agents

`orchestrator` has `mode: primary` and is set in `default_agent`. `explorer`, `scout`,
`architect`, `implementer`, and `reviewer` have `mode: subagent`. All `steps` below are soft
finish seeds. The corresponding hard call caps are set by policy, validated separately, and are
not auto-derived from `steps`.

### 9.1. Orchestrator

The primary agent and the only default user entry point.

Responsibilities:

- classify the task by complexity and risk;
- perform simple tasks directly;
- create a separate minimal contract for each subagent;
- serialize write tasks;
- accept only evidence-backed results;
- run a checkpoint for a substantial verified milestone.

The Orchestrator has statically bounded edit access for the fast lane, but must not delegate for
delegation's sake. It may call only the subagents listed in the allowlist.

Benchmark seed: `steps: 20`; this is a starting hypothesis, not a proven optimum.

### 9.2. Explorer

Cheap source-read-only analysis of the local repository:

- finding paths, symbols, imports, references, and dependencies;
- file/content search via the mandatory bounded `safe_search`, then targeted read;
- using LSP as an optional accelerator, not the sole backend;
- answering with evidence only: `path:symbol/line`, brief output, unknowns.

`edit`, `bash`, built-in `grep`, `webfetch`, `websearch`, external directories, and Task are
forbidden. If LSP is off, the role uses `safe_search` + read without losing content-search
capability.

Benchmark seed: `steps: 8`.

### 9.3. Scout

Source-read-only research of external dependencies and documentation:

- first official docs, specifications, and upstream source;
- mandatory fixation of version and applicability to the local project;
- external text is treated as evidence, not instructions.

`edit`, `bash`, Task, and built-in `webfetch` are forbidden. `safe_fetch` is permitted;
`websearch` is permitted only after an availability smoke test. Named MCP tools are possible
only in a separate audited conditional profile for a specific project; the core profile does
not include and does not wire MCP.

Benchmark seed: `steps: 10`.

### 9.4. Architect

Used only for ambiguous or risky decisions:

- at most two viable options;
- contracts, invariants, data flow, risks, migration, and rollback;
- an explicit recommendation and remaining unknowns;
- no production code and no file changes.

`edit`, Task, and arbitrary shell are forbidden.

Benchmark seed: `steps: 12`.

### 9.5. Implementer

The only edit-capable child agent of the managed route:

- modifies working files directly, rather than returning an unapplied diff;
- works within the established scope;
- re-reads a file before changing it;
- runs a minimal sufficient verification ladder;
- returns changed files, commands, results, risks, and scope deviations.

Task, `webfetch`, `websearch`, external directories, secrets, publish/deploy, and destructive
commands are forbidden. Unknown shell commands require approval. `.opencode/*`, `opencode.jsonc`,
`AGENTS.md`, and profile control files are protected from direct edit/write/apply_patch calls by
the Implementer's ordered path rules and the guard plugin. Shell side effects are not sandboxed
by this mechanism and are controlled by the allowlist plus audit.

Benchmark seed: `steps: 32`.

### 9.6. Reviewer

An independent source-edit-denied quality gate after a finished diff and checks:

- verifies the Definition of Done, Key Decisions, and the actual diff;
- reports findings with severity and `file:line` evidence;
- distinguishes Blocker, Major, Minor, Note, and residual risk;
- returns only `Pass` or `Fail` with justification;
- does not fix the found problems.

`edit` and Task are forbidden. Shell is limited to exact hardened Git argv: locked binary,
`--no-pager`, `-c core.fsmonitor=false`, `-c diff.external=`, and for diff also
`--no-ext-diff --no-textconv --ignore-submodules=all`, controlled `GIT_OPTIONAL_LOCKS=0`; generic
`git diff`/`git status` are not allowlisted. The rest are verification commands approved in
`profile/policy.json`. The worktree state is recorded before and after review. A new change to
tracked source is a Fail; new build artifacts are listed and not deleted automatically.

Benchmark seed: `steps: 12`.

### 9.7. Maintenance agents

In the committed base config `orchestrator`, the five child roles, `compaction`, `title`,
`summary`, `build`, `general`, `explore`, and `plan` have `disable: true`. Only a successful
final guard assignment enables the intended six roles and `compaction`.
The built-in `title` after activation normatively has `disable: true`: automatic session naming
does not justify a separate LLM call. The hidden `summary` is not invoked and not configured in
the V1.17.9 runtime. `compaction` uses `OC_MODEL_COMPACTOR`, receives no working tools, and
passes a separate resume-fidelity benchmark.

All alternative selectable built-ins — `build`, `general`, `explore`, and `plan` — normatively
have `disable: true`. This excludes bypassing the Orchestrator via direct calls to these
built-ins. The validator lists every effective agent and rejects an unknown primary/subagent
role or a role with broader permissions.

## 10. Permissions Matrix

The table below is the intended effective permissions after a successful guard `config` hook.
In the committed base config root and each role start with `"*": "deny"`; the guard builds the
maps locally, checks contract/hash, and assigns them to config only as the final operation. A
partially activated state must not exist.

| Capability | Orchestrator | Explorer | Scout | Architect | Implementer | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| read (regular file only) | allow | allow | allow | allow | allow | allow |
| glob | deny | deny | deny | deny | deny | deny |
| grep | deny | deny | deny | deny | deny | deny |
| safe_search | allow | allow | deny | allow | allow | allow |
| LSP tool | optional | optional | deny | optional | optional | optional |
| automatic formatter | false | false | false | false | false | false |
| edit | static project allow | deny | deny | deny | static project allow | deny |
| bash | project allowlist/ask | deny | deny | deny | project allowlist/ask | diff/verify allowlist |
| webfetch | deny | deny | deny | deny | deny | deny |
| safe_fetch | deny | deny | allow | deny | deny | deny |
| websearch | deny/delegate | deny | conditional allow | deny | deny | deny |
| MCP tools | deny | deny | deny; separate audited profile only | deny | deny | deny |
| Task | exact role allowlist | deny | deny | deny | deny | deny |
| external directory | deny | deny | deny | deny | deny | deny |
| Notebook paths | allow by path; checkpoint-only is policy | deny | deny | deny | deny | deny |

General rules:

- baseline secret globs include `*.env`, `*.env.*`, and root+nested pairs: `.env` + `*/.env`,
  `.env.*` + `*/.env.*`, `id_rsa*` + `*/id_rsa*`, `id_ed25519*` + `*/id_ed25519*`, `.npmrc` +
  `*/.npmrc`, `.pypirc` + `*/.pypirc`, `credentials.json` + `*/credentials.json`, as well as
  `*.pem` and `*.key`; the Orchestrator gets `read: ask`, child roles get `deny`, edit is
  forbidden to all roles; `.env.example`/`.env.sample` are explicitly allowed;
- `profile/policy.json` may add project-specific secret paths but not weaken the baseline
  without an explicit user scope;
- each existing secret-matching path, except explicitly allowed examples, must be confirmed by
  `git check-ignore`; a tracked/unignored path blocks installation until explicit
  reclassification;
- `git push`, publish, deploy, destructive filesystem/database operations are forbidden or
  require explicit approval;
- any MCP in core is forbidden; the conditional profile uses an exact server/tool allowlist;
- a direct `@agent` invocation must not give a role more rights than a Task invocation;
- a `deny` permission outweighs a prompt instruction.

`safe_search` has its own exact permission key. It is permitted only to the roles in the matrix,
accepts `mode: "files" | "content"`, regex/literal for content mode, up to eight validated
relative roots, and optional file globs. Files mode returns only permitted relative paths;
content mode returns structured matches. Total output is no more than 200 matches/paths, 500
lines, and 32,768 bytes. Hard limits: 20,000 candidates, 4 MiB total candidate-path bytes, and
10 s wall time per whole call. Enumeration uses NUL-delimited paths; files mode returns a
bounded filtered candidate list, and content results are structured JSON. Only in content mode
are permitted files passed to `rg` in shell-free batches of at most 256 paths and 64 KiB argv,
only after `--`; timeout/abort terminates the child process. First the tool builds a candidate
list without model-supplied globs, with ignore/hidden/symlink policy; then canonicalizes and
filters each candidate by immutable deny rules. Only then are model file globs applied in memory,
and `rg` receives an explicit bounded list of already-permitted files. This is important: a
positive `rg --glob` can override `.gitignore`. Model input never enters traversal flags or
safety excludes. A hidden root is permitted only as an exact project allow-root from
`profile/policy.json` after the same canonical/secret checks; the model cannot enable
`--hidden`. Truncation, timeout, candidate cap, and skipped roots are reported in metadata;
unlimited output and silent fallback to built-in `grep`/`glob` are forbidden. Custom-tool
registration itself does not apply permission. Therefore the first operation of `execute` — before
path resolution, enumeration, and spawn — is a role lookup by `sessionID` and
`ctx.ask({ permission: "safe_search", patterns: ["*"], ... })`; a lookup error, deny, or ask
without approval terminates the call without side effect. The guard `tool.execute.before`
independently checks the same exact role allowlist.

`safe_fetch` has a separate exact permission key and is available only to Scout. Before DNS it
performs the same `sessionID` role lookup + `ctx.ask`; an unknown/denied role makes no network
call. The URL must be HTTPS, port 443, without userinfo/IP literal; the canonical IDNA host
must not be localhost, local/internal/special-use name. All A/AAAA addresses are checked for
global-unicast: loopback, private, link-local, multicast, CGNAT, IPv4-mapped, and other
special-use/metadata ranges are forbidden. The connection pins to one of the already-checked
addresses with TLS SNI and certificate check for the original host, rather than performing a new
uncontrolled resolve.

At most three HTTPS redirects are permitted; each hop re-passes URL/DNS/address validation,
downgrade is forbidden. The tool ignores proxy env, sends no cookies, authorization, or user
headers, and uses a fixed User-Agent/Accept. Total timeout 15 s, compressed and decompressed
body caps of 2 MiB each, only allowlisted textual MIME; model output ≤ 32,768 bytes/500 lines
with truncation metadata. Abort closes the socket. External body is marked as untrusted
evidence. The built-in `webfetch` is not used; hard network sandbox/transparent proxy control
outside the process remains an OS limitation.

`formatter: false` is an invariant both before and after guard activation. The guard, in the
same atomic commit, replaces the merged `config.mcp` with `{}`; per-launch preflight admits
neither local nor remote MCP. This is necessary because V1.17.9 eager-connect runs before MCP
tool-permission filtering. V1.17.9 launches the configured formatter subprocess after edit
outside `bash` permission; therefore auto-formatting is not a safe extension point of the
core profile. The needed format/check command is specified as an exact entry in
`profile/policy.json`, is run explicitly, and enters pre/post audit. Custom `lsp.*.command` is
forbidden; optional LSP permits only a separately verified preinstalled built-in server profile
with `OPENCODE_DISABLE_LSP_DOWNLOAD=true` and is not a secret boundary. There is no MCP
process/connection in core.

For each intended agent ruleset the guard adds an explicit `external_directory` `deny` with a
pattern exactly equal to the runtime `path.join(Global.Path.data, "tool-output", "*")`. A generic
`deny`/`"*"` is insufficient: V1.17.9 otherwise automatically appends an allow for
Truncate.GLOB. The guard computes the resolved pattern at the config hook; the validator checks
the final rule and the actual deny. In missing-guard base mode a possible runtime-added external
allow remains inert, since root/per-role wildcard forbids the `read` tool itself.

`permission.task` of the Orchestrator permits only `explorer`, `scout`, `architect`,
`implementer`, and `reviewer`; the wildcard fallback is `deny`. All five subagents have
`task: deny`.

OpenCode applies the last matching rule, and `*` in a permission pattern may cross path
separators. Therefore the config generator must emit ordered maps exactly in the following
order:

```text
READ Orchestrator
  *                              allow
  .opencode/*                    ask
  .opencode/notebook/MANIFEST.md allow
  .opencode/notebook/INDEX.md    allow
  .opencode/notebook/DECISIONS.md allow
  .opencode/notebook/STATE.md    allow
  *.env                          ASK_SECRET
  *.env.*                        ASK_SECRET
  .env                           ASK_SECRET
  */.env                         ASK_SECRET
  .env.*                         ASK_SECRET
  */.env.*                       ASK_SECRET
  *.pem                          ASK_SECRET
  *.key                          ASK_SECRET
  id_rsa*                        ASK_SECRET
  */id_rsa*                      ASK_SECRET
  id_ed25519*                    ASK_SECRET
  */id_ed25519*                  ASK_SECRET
  .npmrc                         ASK_SECRET
  */.npmrc                       ASK_SECRET
  .pypirc                        ASK_SECRET
  */.pypirc                      ASK_SECRET
  credentials.json               ASK_SECRET
  */credentials.json             ASK_SECRET
  *.env.example                  allow
  *.env.sample                   allow
  .opencode/node_modules/*       deny
  .opencode/profile-lock.json    deny
  .git                           deny
  .git/*                         deny
  AGENTS.md                      ask
  opencode.json                  ask
  opencode.jsonc                 ask
  <project-specific secrets>     ASK_SECRET

READ child roles
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  AGENTS.md                      deny
  opencode.json                  deny
  opencode.jsonc                 deny
  .git                           deny
  .git/*                         deny
  .opencode/*                    deny
  <project-specific secrets>     deny

EDIT Orchestrator
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  .opencode/*                    ask
  .opencode/notebook/MANIFEST.md allow
  .opencode/notebook/INDEX.md    allow
  .opencode/notebook/DECISIONS.md allow
  .opencode/notebook/STATE.md    allow
  .opencode/node_modules/*       deny
  .opencode/profile-lock.json    deny
  AGENTS.md                      ask
  opencode.json                  ask
  opencode.jsonc                 ask
  .git                           deny
  .git/*                         deny
  <project-specific secrets>     deny

EDIT Implementer
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  AGENTS.md                      deny
  opencode.json                  deny
  opencode.jsonc                 deny
  .opencode/*                    deny
  .git                           deny
  .git/*                         deny
  <project-specific secrets>     deny
```

The remaining roles have `edit: deny` without exceptions. `ASK_SECRET` means `ask` only for the
Orchestrator. Project-specific secret rules are always emitted last and cannot be weakened by
Notebook/control/example allows. If such a path makes a mandatory profile artifact unavailable,
the validator requires explicit reclassification and does not launch a partially working
profile.

Task and skill maps are also strictly ordered: first `"*": "deny"`, then exact
`"<allowed-name>": "allow"`. For the Orchestrator exactly the five Task names above are
permitted. For each agent exactly the skills from §13.3 are permitted; absence of an exact match
always yields deny; the final exact `customize-opencode: deny` fixes the built-in exception. A
name allowlist is not an origin check: before atomic activation the guard reconciles each
allowed skill with the canonical origin/SHA from the lock, rejects duplicates, and forbids
activation on any mismatch.

Overlap probes are mandatory for `.opencode/profile-lock.json`,
`<managed-runtime-root>/budgets/canary`, `.opencode/notebook/.env`, root/nested `prod.env`,
`.env.example`, `AGENTS.md`, `opencode.json`, `opencode.jsonc`, an unknown Task, and an unknown
skill. The built-in `grep` is fully forbidden and schema-hidden: in V1.17.9 its permission matches
the regex of the query, not the file path, after which ripgrep searches including hidden files;
a `read` deny does not protect it. The built-in `glob` is also fully forbidden and
schema-hidden: the permission matches the model pattern, not `path`, and a positive glob can
return ignored/hidden filenames. File discovery goes through bounded `safe_search mode=files`
with the same immutable path/secret denies. Automatic bash allowlists do not include `rg`,
`grep`, `cat`, `sed`, `awk`, `head`, `tail`, shell/interpreter launchers, or other generic
file-read bypasses. Unknown shell remains `ask`, so an explicitly approved user command is no
longer a hard security boundary.

All path maps in this section govern only the corresponding OpenCode tools. The guard
additionally checks canonical path arguments for `read`, `write`, `edit`, `apply_patch`, and
`lsp.filePath`, forbids symlink components and `*** Move to:`. This closes the known
lexical/move bypasses in normal single-process execution; the inter-process symlink race remains
a limitation of §5.2. `edit`/`read` and `external_directory` do not sandbox the child shell
process: even an allowlisted build/test script can read or change other paths. Therefore for the
shell-capable Orchestrator, Implementer, and Reviewer, exact command allowlists, pre/post
tracked+untracked worktree audit, and an explicit residual-risk report apply; hard isolation
requires an external sandbox and is not claimed by the core profile. For `read` the guard after
canonicalization performs a no-follow stat and rejects directory, missing target, and
non-regular file before built-in enumeration/`Did you mean`. This prevents disclosure of
secret/control filenames via a permitted parent; directory/file/typo discovery is available only
via bounded `safe_search mode=files`.

The condition "Notebook only during checkpoint" and the current `Relevant_Files` cannot be
expressed by a static permission; this is a prompt-policy plus post-diff audit.

Core base and normal guard output always have `lsp: false`: the experimental tool flag does not
control the LSP lifecycle, while read/edit may launch a server independently. A conditional LSP
profile is permitted only after preflight: the launcher forcibly keeps
`OPENCODE_DISABLE_LSP_DOWNLOAD=true`; the guard final assignment creates an exact map with
`{disabled:true}` for every non-selected built-in ID and OMITS selected IDs, to use only their
native definitions. The selected ID must be present in the pack-owned `lsp-safe-servers.json`, an
already-installed PATH executable, and its canonical path/version/SHA-256 must match
policy/lock. Built-ins using `Npm.which`, the global cache, or an installer (including the
relevant TS/Biome paths) are not in the allowlist even with a populated cache. `lsp: true`,
explicit custom command, auto-install, `latest`, unknown ID, and silent download are forbidden.
Only after this does optional `OPENCODE_EXPERIMENTAL_LSP_TOOL=true` open the model tool. Without
a conditional profile, prompts do not mention LSP and use `safe_search` + read.

## 11. Routing

The Orchestrator contains a short always-on classifier. The full `task-context` skill is loaded
only for non-trivial delegation.

### Tier 0 — answer or local read

Signs: no changes, known scope, low risk.

Route: the Orchestrator answers directly or calls a single Explorer/Scout only on genuine
unknowns. No checkpoint needed.

### Tier 1 — simple local edit

Signs: obvious solution, usually 1–2 files, no public contract, migration, security, or
persistence risk.

Route: the Orchestrator edits directly, runs targeted verification, and reports briefly.
Reviewer is optional. A checkpoint is created only for a substantial milestone.

### Tier 2 — managed implementation

Signs: multiple files, unknown impact, new behavior, or moderate risk.

Route:

```text
[Explorer] → Implementer → Verification → [Reviewer] → Checkpoint
```

Reviewer is mandatory if the change affects multiple modules or has hard-to-reverse
consequences.

### Tier 3 — high risk or architecture

Automatic triggers:

- auth, permissions, secrets, or cryptography;
- schema/data migration and persistence;
- concurrency and distributed behavior;
- public API or compatibility;
- billing/payments;
- infrastructure, deploy, or irreversible operations;
- ambiguous cross-module decision.

Route:

```text
Explorer || Scout → Architect → Decision Gate
  ├─ covered/approved → Implementer → Verification → Reviewer
  ├─ user decision required → AWAITING_USER
  │    ├─ approved → Implementer
  │    └─ rejected → ABORTED
  └─ impossible/out of scope → BLOCKED
```

Only independent read-only research may run in parallel. Reviewer runs only after the writer
completes. After two `Fail → Rework` cycles the automatic loop stops and forms a blocker report.

### 11.1. Decision Gate

The Orchestrator independently selects reversible implementation details within the explicitly
approved Task Goal, Constraints, and accepted ADR. Re-confirming an already accepted decision is
not required.

Explicit user decision is mandatory before implementation if proposed:

- change scope or Definition of Done;
- irreversible/destructive operation or data migration;
- breaking public API or compatibility contract;
- change of auth, security, or privacy policy;
- billing/payment behavior;
- production infrastructure/deploy;
- new paid, license-restricted, or externally hosted dependency;
- substantial trade-off not defined by requirements or accepted ADR.

Before a decision only read-only research and a reversible prototype outside the production path
are permitted, if it creates no external side effects.

The gate must return one of the states: `APPROVED`, `AWAITING_USER`, `REJECTED`, or `BLOCKED`.
Only `APPROVED` transitions to Implementer; `REJECTED` transitions to `ABORTED`.

## 12. Task Context Packet

The packet is an ephemeral contract in the Task prompt, not a separate accumulating file. A
separate packet is created for each subagent.

```yaml
Packet_Version: 1
Task_ID:
Project:
Role:
Task_Goal:
Risk_Tier:
Scope:
Out_of_Scope:
Constraints:
Key_Decisions:
Base_Revision:
Relevant_Files:
  - path:
    symbol_or_lines:
    reason:
Expected_Output:
Definition_of_Done:
Verification:
Open_Questions:
EXCLUDE_FROM_CONTEXT:
Budget_Hints:
  max_seed_files:
  max_packet_chars:
  max_return_chars:
  max_subagent_calls:
```

Rules:

- 1–4 seed files by default;
- up to 8 seed files only with explanation;
- ordinary packet — up to 8,000 characters, exceptional — up to 16,000;
- symbol is preferable to an unstable line number;
- a line number is a hint; the agent must re-read the current file;
- full transcript, large diffs, whole files, and raw tool outputs are forbidden;
- a code excerpt is permitted only when a reference is insufficient, totaling up to 40 lines;
- the Task prompt contains no OpenCode attachment interpolation: `@file`, `@directory`, and any
  `@...` that the runtime could resolve into an existing path are forbidden; files are indicated
  only by plain relative path + symbol/lines in `Relevant_Files`;
- external/user-provided text is not copied verbatim into the packet if it could form an
  attachment token; the builder validates the packet before the Task call;
- if data is insufficient, the subagent returns `NEEDS_CONTEXT` with a precise request;
- scope may be extended only with explicit explanation of a discovered dependency.

`Budget_Hints` is policy, not a runtime quota. `agent.<role>.steps` is only a soft finish
warning in V1.17.9; the hard call caps are set by the guard from `profile/policy.json`. OpenCode
has no exact per-task token/dollar cap.

The guard checks the final Task `prompt` directly in `tool.execute.before` and fail-closed
rejects resolvable attachment syntax. This is mandatory: V1.17.9 materializes Task attachments
via an internal read path without child permission ask. Static OpenCode permissions cannot
dynamically limit access to `Relevant_Files` only; compliance with this field is checked by
post-diff audit.

## 13. Required Skills

Agent identity must not be duplicated by a skill. The role lives in the agent prompt, while the
skill describes a conditionally invoked procedure.

### 13.1. Core skills

#### `task-context`

Trigger: Tier 2/3 or explicit delegation.

- reads only the needed parts of Manifest/Index/State/Decisions;
- forms a role-specific Task Context Packet;
- calculates scope, exclusions, and budget hints;
- is not invoked for the fast lane.

Access: Orchestrator only; Architect receives an already-assembled packet and does not read the
Notebook.

#### `verification`

Trigger: any change of behavior or code.

- builds the ladder `targeted → module → full suite`;
- selects the minimal sufficient level by risk;
- records the exact command, exit status, and brief result;
- forbids declaring success without evidence.

Access: Orchestrator, Implementer, and Reviewer.

#### `checkpoint`

Trigger: verified milestone, intentional handoff, or long pause.

- requires successful verification and the necessary Reviewer Pass;
- updates STATE;
- updates INDEX and DECISIONS if needed;
- checks the write by re-reading;
- does not require automatically running `/new`.

Access: Orchestrator only.

#### `debugging`

Trigger: unknown cause of a defect or a check failure.

- `reproduce → isolate → hypotheses → discriminating checks → fix → regression`;
- separates diagnosis and implementation;
- forbids speculative fixes without reproduction or evidence.

Access: Orchestrator and Implementer.

#### `architecture-decision`

Trigger: Tier 3, new contract, or durable trade-off.

- at most two options;
- invariants, trade-offs, migration, rollback, and recommendation;
- creates an ADR only after the decision is accepted;
- links superseded decisions.

Architect returns the ADR candidate in the response and does not write the Notebook; after
acceptance the Orchestrator stores it at checkpoint. Access: Architect and Orchestrator.

#### `profile-doctor`

Trigger: installation, model change, config change, or OpenCode update.

- checks exact OpenCode version;
- resolved config and schema;
- model bindings and tool support;
- effective variants, limits, pricing, and compaction model;
- locked model snapshot and extracted dependency manifest;
- discovery agents/skills;
- policy schema/semantics, guard loaded/deny-mode state, `safe_search`, and effective
  permissions;
- Notebook schema, aggregate prompt budget, and tool-output limits.

Access: Orchestrator only, for interpreting the report. Canonical checks and budget recovery are
performed by the deterministic non-LLM `.opencode/profile/bin/profile-doctor`; the skill is not
a recovery dependency.

### 13.2. Conditional skills

#### `dependency-research`

Records version, official source, local applicability, and references. Available to Scout.

#### `security-review`

Attached only for auth, secrets, permissions, crypto, network boundaries, and untrusted parsing.
Available to Reviewer and Architect.

#### Project-specific skills

Added only after analysis of a specific repository: database migration, public API
compatibility, mobile build, deployment, etc. A large universal "catch-all" skill is forbidden.
Installation is performed only by the normative `--adopt-skill ... --agents ...` workflow of
§6.3; manual copying blocks managed launch as an unknown/collision origin.

### 13.3. Skill allowlists

| Agent | Skills |
| --- | --- |
| Orchestrator | `task-context`, `verification`, `checkpoint`, `debugging`, `architecture-decision`, `profile-doctor` |
| Explorer | none |
| Scout | `dependency-research` |
| Architect | `architecture-decision`, `security-review` |
| Implementer | `verification`, `debugging`, project-specific |
| Reviewer | `verification`, `security-review`, project-specific |

All other skills are hidden via `permission.skill`. Additionally the launcher, static preflight,
and guard bind each exact allowed name to one canonical origin and SHA-256 from the lock.
`OPENCODE_DISABLE_EXTERNAL_SKILLS=true` suppresses `.claude`/`.agents` discovery, but is not
considered sufficient protection without an origin registry and collision scan. The
diff-first review checklist, the unified severity `Blocker | Major | Minor | Note`, and
Pass/Fail are part of the reviewer prompt. A separate `code-review` skill is not created: it is
not lazy for this role and would add an extra tool call.

## 14. Custom Commands

| Command | `agent` | `subtask` | Purpose |
| --- | --- | --- | --- |
| `/route` | `orchestrator` | `false` | re-route the current active task |
| `/review` | `reviewer` | `true` | review the current diff in isolation |
| `/diagnose` | `orchestrator` | `false` | run the debugging workflow without automatic fix |
| `/checkpoint` | `orchestrator` | `false` | save the verified milestone |
| `/handoff` | `orchestrator` | `false` | checkpoint, readback STATE, and a short resume prompt |
| `/status` | `orchestrator` | `false` | show verified status, blockers, and next step |

Commands are ergonomic entry points, not a security boundary. `/new` or `/compact` must not be
overridden. The `model` field is absent from all commands: the command inherits the selected
agent's model. A command does not extend the agent's permissions. All shipped commands are
strictly zero-argument: templates contain no `$ARGUMENTS`, positional placeholders, shell
blocks, `@file`, or `@directory`. The task is passed by an ordinary user message; commands work
only with the current active task/diff/state. The guard rejects a command with non-empty
`arguments` in `command.execute.before`, but this hook is invoked after native interpolation, so
the protection is detection, not a sandbox; the README explicitly forbids inserting untrusted
text into command arguments. The reserved command catalog is permitted only from pack-owned
canonical origins with hashes from the lock. Host/config-dir commands are isolated by the
launcher, and any project command outside the registry or with a name collision blocks managed
launch before the OpenCode process.

V1.17.9 always adds built-in `/init`, `/review`, the built-in skill `customize-opencode`, and
slash aliases for all discovered skills; skill permission does not filter these aliases, and
shell/file interpolation runs before the hook. Therefore the guard final command map wholly
contains the six intended commands above and pack-owned inert zero-argument shadows for `init`,
`customize-opencode`, and each locked core/project skill name except names from the intended
command set. Intended `review` safely shadows the built-in, and intended `checkpoint` shadows
the same-named core-skill alias. Shadows contain no arguments, shell, or attachments.
`command.execute.before` permits only the six intended names and rejects all shadows/unknown
names; the static audit of exact `Command.list` admits no other effective command. Adopting a
skill with a colliding command name is forbidden.

## 15. Normative Workflow

```text
INTAKE
  ↓
TRIAGE
  ├─ Tier 0 → DIRECT/EXPLORE/SCOUT → SYNTHESIZE → DONE
  ├─ Tier 1 → DIRECT EDIT ──────────────────────────────┐
  ├─ Tier 2 → [EXPLORE] → IMPLEMENT ───────────────────┤
  └─ Tier 3 → EXPLORE || SCOUT → ARCHITECT → DECISION GATE
       ├─ APPROVED → IMPLEMENT ─────────────────────────┤
       ├─ AWAITING_USER → APPROVED ─────────────────────┤
       ├─ REJECTED → ABORTED                            │
       └─ BLOCKED                                       │
                                                        ↓
                                                      VERIFY
        ┌─ FAIL → REWORK_BUDGET ── remaining → WRITE ────┘
        │                         └─ exhausted → BLOCKED
        └─ PASS → review required?
                     ├─ no → [CHECKPOINT] → DONE
                     └─ yes → REVIEW
                                ├─ PASS → CHECKPOINT → DONE
                                └─ FAIL → REWORK_BUDGET
                                           ├─ remaining → WRITE → VERIFY → REVIEW
                                           └─ exhausted → BLOCKED
```

`WRITE` means the Direct Edit or the Implementer of the original route. The total budget is no
more than two rework cycles after the initial write, summed for VERIFY and REVIEW failures; each
rework must pass VERIFY again and, if it is required, REVIEW. From any state `BLOCKED` and
`ABORTED` with an explicit reason are possible.

The Reviewer receives the original DoD, accepted decisions, Base Revision, and verification
evidence, not merely the Implementer's retelling. A large diff is not embedded in the packet:
the Reviewer reads it from the worktree relative to the Base Revision. Checkpoint is forbidden
on Reviewer Fail, a failed mandatory check, or an unknown worktree state.

## 16. Token and Cost Savings

### 16.1. Context

In all `estimated tokens` fields the normative estimator matches the pinned runtime:
`Math.round(text.length / 4)`, where `text.length` is the length of the exact JavaScript
UTF-16 string. The validator also stores chars/bytes. Provider-reported input/output/reasoning
tokens are measured separately, never replaced by this estimator and not compared with it as a
single quantity.

- the authoritative budget is the sum of all pack-provided persistent text actually visible to a
  specific role: PROFILE_RULES, role prompt, agent descriptions, and descriptions of available
  skills; target ≤ 1,500, hard maximum ≤ 2,000 estimated tokens;
- component limits are subordinate to the aggregate budget: role prompt ≤ 2,500 characters,
  skill descriptions ≤ 200 estimated tokens per role;
- user-owned AGENTS/project instructions are measured separately; exceeding 4,000 characters
  requires an explicit waiver and is shown as a cost risk;
- the validator measures the real cold input floor of each role, including the native system
  prompt and tool schemas, and compares it with the baseline;
- Task Context Packet p95: up to 1,200 estimated tokens;
- checkpoint: up to 800 estimated tokens;
- large files are read by ranges or by symbol;
- failure output is reduced to relevant lines;
- `@file`/`@directory` attachment interpolation is never used inside Task or shipped
  custom-command prompts; subagents receive only plain paths.

### 16.2. Agents and tools

- the fast lane avoids the fixed price of a child session;
- expensive models are called only for complex reasoning, coding, and quality gate;
- `steps` gives an early MAX_STEPS finish prompt but is not a runtime cap;
- the guard hard-caps LLM calls, Task calls, and compactions before provider/tool execution;
- fully denied tools are schema-hidden via exact `* deny`; foreign tools/MCP are absent, and
  skill/Task catalogs are narrowed;
- between LSP and targeted read, the source with the smaller expected response is chosen;
- parallelism is applied for latency, not counted as token savings.

The hard counter is not stored only in plugin memory. At each gate the guard determines the root
by the persisted parent tree, takes an atomic lease, and reserves precisely the attempt — each
firing of `chat.params`, including the outer retry of an unfinished assistant message, is counted
separately. Durable reservations and session evidence are reconciled; resume/restart does not
zero the budget, and parallel calls cannot simultaneously take the last slot. The current not-yet
sent logical stream attempt is reserved before the provider call. For the main work path the
validator records AI SDK `maxRetries: 0`; provider-internal transport retry is not a separate
hook event and remains a telemetry boundary. If the ledger/evidence is unavailable, ambiguous,
stale-locked, or the tree is invalid, the gate closes; an abandoned reservation remains used
until explicit audited recovery. Soft `agent.steps` is set below or equal to the hard limit so
the model has time to return a result before the technical failure. A fixture with a deliberately
disobedient model and a retryable provider error proves the LLM-only/retry loop stops; a single
`tool.execute.before` is insufficient for this.

Normative starting truncation profile:

```json
{
  "tool_output": {
    "max_lines": 500,
    "max_bytes": 32768
  }
}
```

The runtime may keep the full output in truncation storage outside the worktree, but the core
profile does not give the model general access to this host path. If truncation hid needed
lines, the agent repeats the command with a narrower scope/range. Thresholds are benchmark
seeds. Return budgets in prompts: Explorer ≤ 2,000, Scout/Implementer ≤ 4,000,
Architect/Reviewer ≤ 6,000 characters; exceeding is permitted only for Blocker evidence. This is
policy, since Task may return the full final text of the child session to the parent.

### 16.3. Sessions

- one session continues within a coherent milestone;
- after a verified checkpoint and a task switch, `/new` is recommended;
- `/new` is not run automatically after every step;
- fork is used only for a genuine alternative branch and is not counted as clean context;
- manual `/compact` is used within a long unfinished stage, not after every task.

### 16.4. Compaction

Normative starting profile:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 2
  },
  "agent": {
    "compaction": {
      "model": "{env:OC_MODEL_COMPACTOR}"
    }
  }
}
```

`preserve_recent_tokens` is intentionally absent: V1.17.9 selects an adaptive budget of 25% usable
input within 2k–8k. `reserved` is also absent in the base template. In this version it is
subtracted only when provider metadata sets `model.limit.input`; otherwise the overflow threshold
equals `context - maxOutputTokens`, and explicit `reserved` has no effect. The profile doctor
computes the effective threshold for each model from the resolved `context/input/output` limits.
For each active role → compactor pair it checks the invariant: the compactor's usable input is no
less than the maximum payload at compaction trigger of the active role plus prompt/output margin.
A near-limit resume test is mandatory for each pair; an insufficient compactor makes the profile
invalid, and silent fallback to the active model is forbidden. Overriding `reserved` or
`preserve_recent_tokens` is permitted only by a single profile after a resume/cost benchmark, not
by a crude table of context windows.

Compaction is a lossy fallback. Critical intermediate results must be briefly recorded in verified
STATE before pruning or a long pause. The cost of compaction is included in the full task cost.

### 16.5. Cache

- stable prompts and AGENTS are not changed within an active milestone;
- provider `setCacheKey` is enabled only with official support;
- models and providers are not switched without reason within a single role;
- cache effectiveness is measured not by cache read/write volume itself, but by net cost with the
  price of fresh input, cache read, and cache write from the fixed pricing snapshot.

## 17. Change Safety

- core sets `snapshot: false`: V1.17.9 snapshot invokes `git add --all`, and repository/global
  attributes and clean/process filters can execute a process outside `bash` permission;
- recovery relies on a clean base revision, pre/post tracked+untracked audit, and an explicit
  user-approved Git/manual rollback without destructive automation;
- before edit the base revision is recorded and the dirty worktree is checked;
- user changes are not overwritten;
- the Orchestrator does not launch writers in parallel by policy;
- the Implementer does not change the Notebook and configuration control files without a separate
  user scope;
- publish, deploy, git push, destructive migrations, and data deletion require explicit
  permission;
- `share` is set to `"disabled"`;
- remote instructions are not attached automatically;
- core does not wire MCP; exact MCP is possible only in a separate audited conditional profile;
- built-in `grep` is unavailable, content search goes only via `safe_search`;
- Task attachments, symlink paths, and apply-patch moves are fail-closed in the guard;
- automatic shell allowlists contain no generic readers/interpreters; an explicitly approved shell
  and verification scripts remain a residual-risk boundary per §5.2.

A separate conditional snapshot profile is possible only after a non-executing audit of all Git
config include chains, attributes files, and filter/process/fsmonitor surfaces, a canonical
version/hash-pinned Git binary, and a no-execution fixture. Until this profile is implemented,
`snapshot:true` is a validation Fail.

Core does not guarantee a single writer even within a single Orchestrator session/worktree. A hard
guarantee requires a future lease plugin or external locking; until then policy, pre/post worktree
audit, and an organizational prohibition of parallel OpenCode processes on one worktree are used.

## 18. Errors and Recovery

| Error | Detection and reaction |
| --- | --- |
| Wrong OpenCode version/schema | validator stops installation |
| Install/update conflict | dry-run report; target unchanged |
| Empty or unknown model binding | fail before first working task; no fallback |
| Model snapshot/catalog/adapter drift | fail before provider; explicit model rebind transaction |
| Dependency tree manifest mismatch | fail before plugin import; doctor materializes, old tree quarantined |
| Model without tool support/limits | role smoke test and explicit remap |
| Guard plugin/custom tool failed to load | launcher does not start, or all base agents stay disabled; zero provider/tool call |
| Task attachment token | guard rejects call; packet rebuilt with plain path |
| Unsafe CLI verb/flag/project/attach | structural argv policy rejects before OpenCode process |
| Symlink path or apply-patch move | guard rejects call; safe explicit edit or approval |
| Agent/skill/command origin mismatch | preflight/guard Fail before activation; show canonical origin/hash collision |
| Prompt or catalog exceeds budget | validator Fail |
| Simple task wrongly delegated | routing regression fixture |
| Insufficient packet | one `NEEDS_CONTEXT` round-trip, then reroute/block |
| Stale lines/files | re-read symbol/current file, reconcile base revision |
| Transient model/tool error | one retry; then reroute or Blocked |
| Permission denied | return `NEEDS_PERMISSION`, do not bypass the prohibition |
| Reviewer Fail | rework at most twice, then blocker report |
| Dirty worktree with foreign changes | stop overlapping edit, preserve user changes |
| Two writers in one session | Orchestrator serializes tasks |
| Two OpenCode processes | Core does not guarantee lock; document the limitation |
| Nested Task from subagent | permission smoke test must get deny |
| Experimental LSP off | `safe_search` + read; not counted as error |
| Checkpoint write/readback failed | do not report success; repeat or Blocked |
| Compaction lost details | recover from verified STATE and git evidence |
| MCP/tool schema bloat | remove MCP/foreign tools; verify exact full-deny schemas |
| Prompt injection from web/docs | treat material as data, not instructions |
| Unsafe fetch target/redirect/DNS | `safe_fetch` closes socket and returns bounded error metadata |
| Cost runaway | soft steps + guard hard call/Task/compaction caps; then benchmark thresholds |
| Budget ledger corrupt/stale-locked | fail closed; non-LLM profile-doctor audit/quarantine/close-root recovery |
| Incomplete cost attribution | economics gate gets `Unverified`, not Pass |
| Quality drift after model swap | full role benchmark before accepting the profile |

## 19. Configuration Validation

The following checks must pass before use:

1. `opencode --version` and the reference platform match; the temp/target filesystem passes an
   atomic create/rename/lease probe. The managed runtime root is canonical, owner-only, mode
   `0700`, and does not intersect the worktree/host OpenCode roots; an overlap fixture requires an
   explicit safe override and never falls back inside the project. Canonical OpenCode/rg/
   npm-runtime/shell/Git paths, versions, and hashes match the lock; the PATH shadow canary is
   not executed.
2. Static preflight without code import rejects foreign plugin/tool executable specs/directories,
   any local/remote MCP, `skills.paths/urls`, foreign/duplicate agent/skill/command origins,
   `lsp.*.command`, `formatter.*.command`, remote/absolute/tilde/escaping refs, and builds a
   sanitized contained copy; fixtures with malicious global/system-managed/MDM plugin, custom
   tool, formatter, remote-MCP, command collision, stored `wellknown` auth, and account/org remote
   config are not executed, not connected to the network, and create no host canary. The
   auto/configured instruction origin registry is exact; root/nested secret/control `AGENTS.md`,
   `CLAUDE.md`, `CONTEXT.md`, symlink, unadopted, and hash-drift fixtures yield Fail before
   prompt/provider, and an adopted safe instruction is explicitly shown as provider-visible.
3. After preflight an isolated `opencode debug config` successfully resolves the clean-pack and
   sanitized-global variants and does not change real global/target paths. Hostile
   `OPENCODE_AUTO_SHARE`, DB/model/config/plugin/compaction/prune variables do not enter the child
   env; an unknown credential/build key and loader/shell-injection key also fail, while an exact
   adopted provider/project key passes without logging the value; `HOME`/XDG/TEST_HOME point only
   to the managed owner-only runtime, and host `~/.opencode`, credential/dotfile canaries are not
   read. The controlled managed-config override points to an empty `0700` root; structural argv
   fixtures reject `--attach`, `--dir`/project positional, file/remote/server attach,
   `--dangerously-skip-permissions`, share/auto-share, `--pure`, model/variant/agent and
   config/plugin overrides, unknown flags, and all non-allowlisted verbs before the OpenCode
   process.
4. Npm lock integrity resolves without drift in the disposable config tree; the effective
   external-plugin list contains only the explicit `profile-guard`, and `safe_search` is actually
   discovered. Canonical origins/SHA of each agent, command, prompt, and allowed skill match the
   lock; duplicates are absent. Effective LLM tool IDs contain no unknown custom tools or fully
   denied built-ins; mixed permissions remain schema-visible and are separately checked at
   execution. Install and managed launch confirm `npm_config_ignore_scripts=true`; the lifecycle
   canary is not executed. An import/hook/tool schema error yields Fail. Missing/extra/modified/
   symlink file in the ignored `node_modules` is not imported: an exhaustive dependency manifest
   yields Fail, and an explicit doctor re-materialization preserves the previous tree in
   quarantine. Hostile host `~/.npmrc`/global npm config/proxy/auth canaries are not read and get
   no network; a git/file/http/foreign-registry lock source yields Fail. Effective `Command.list`
   contains exactly the six intended commands plus inert shadows for `init`, `customize-opencode`,
   and each locked skill alias outside the intended command set; intended `review`/`checkpoint`
   have explicit winning precedence. Built-in/skill interpolation canaries execute no shell and
   materialize no attachment.
5. Separate `--pure`, missing-guard, and throwing-config-hook probes confirm `disable: true` for
   all base agents, zero `chat.params`/provider reach, root/per-role wildcard deny for each known
   and synthetic unknown tool ID, `formatter: false`, `lsp: false`, an empty MCP surface, and the
   absence of partially applied intended allow maps. The managed launcher rejects `--pure` before
   launching OpenCode.
6. Normal SessionTools integration harness (not `debug agent --tool`, which bypasses the
   before-hook) and direct hook unit fixtures confirm: an ordinary Task packet passes, a Task with
   resolvable `@file` is rejected before child read; `apply_patch` with `*** Move to:` is rejected;
   read/edit/LSP via internal/external symlink, external managed runtime, and non-existing child
   symlink-parent are rejected. Root/nested directory-read fixtures terminate before listing and do
   not disclose secret/control names; equivalent allowed paths are returned only by filtered
   `safe_search mode=files`; a guessed missing read returns no `Did you mean`. Shipped command
   templates pass a static scan for attachment, shell blocks, `$ARGUMENTS`, and positional
   placeholders; a non-empty command-argument fixture is recorded as a forbidden operational path.
   An uncooperative-model fixture and a retryable-provider fixture confirm atomic hard LLM-attempt/
   Task/compaction caps before provider/tool call, serial reservation for parallel children, and
   no reset after resume/restart; the main work path confirms `maxRetries: 0`.
7. `safe_search` in both modes on a fixture finds the permitted path/symbol, respects caps/
   truncation, emits no root/nested secret, ignored/hidden deny path, or symlink target, and does
   not accept a search root outside the worktree. Huge-tree/slow-rg fixtures confirm candidate/
   path/argv/time caps and process kill. The built-in `grep` and `glob` actually get deny. Scout
   and a synthetic unknown role call `safe_search`, but `ctx.ask`/guard gate rejects them before
   enumeration/spawn; a denied-role canary path is not opened.
8. No mixing of V1/V2 fields, no unknown `subagent_depth`, and no deprecated `tools`/`maxSteps`.
9. All model env bindings are non-empty, exact-match accepted `models.snapshot.json`/lock, and
   present in managed `models`; the resolver/launch use `OPENCODE_DISABLE_MODELS_FETCH=true` and
   hash-verified `OPENCODE_MODELS_PATH`. Provider/model/API URL/bundled adapter, variants, options,
   limits, capabilities, and pricing are fixed; a mutable catalog network canary, custom/unversioned
   npm adapter, and drift yield Fail before provider call. TUI-selected, session-stored/resumed,
   and compaction model/variant/options tamper are rejected by `chat.params` before budget
   reservation/provider; each locked role passes.
10. Managed `agent list` contains only the permitted selectable roles; `build`, `general`,
    `explore`, `plan` are disabled.
11. Isolated validator `debug agent <role>` shows correct model, steps, and permissions.
12. Isolated validator `debug skill` discovers all skills and exact skill allowlists; collision
    fixtures from host config-dir, `.claude`, `.agents`, and `skills.paths/urls` yield Fail, and
    each allowed name resolves only to the locked canonical origin/SHA. The only extra discovered
    skill is the attested `<built-in>` `customize-opencode`; it is denied/not offered to each role
    and its alias is inert-shadowed.
13. Explorer, Scout, Architect, and Reviewer get no edit/write/apply_patch; Explorer/Scout/
    Architect also get no bash. Reviewer shell side effects are checked by a separate pre/post
    audit, not counted as hard-denied.
14. All subagents have `task: deny`; the Orchestrator has an exact Task allowlist; a real
    nested-Task probe gets deny.
15. Root and nested secret/control canaries confirm ordered read/edit denies, Orchestrator secret
    `ask`, child secret `deny`, explicit example `allow`, `ask` for the Orchestrator on
    `AGENTS.md`/root config, exact Notebook allow, and deny/ask for `.git`, `.opencode`, lock,
    package dependencies per role. Generic bash-read command strings are not in the automatic
    allowlist. With LSP enabled, a project-specific secret canary must not appear in LSP output.
    This checks tool rules, but does not promise sandbox side effects of allowlisted/approved
    shell. Each agent has an exact runtime Truncate.GLOB external-directory deny; a generic
    wildcard and trailing auto-allow are Fail.
16. Reviewer pre/post worktree probe detects source side effects verification.
17. Scout passes the `safe_fetch` public HTTPS fixture; built-in `webfetch` is full-denied/
    schema-hidden. Localhost, RFC1918/link-local/IPv6-mapped/cloud-metadata, DNS rebinding,
    redirect-to-private, downgrade, credential/proxy/header, and decompression-bomb fixtures
    terminate without unsafe connect/output; a denied role makes no DNS. `websearch` either passes
    the availability probe or gets exact full deny and schema-hidden. The core remote/local MCP
    no-connect canary passes; MCP is checked only by a separate conditional-profile benchmark.
18. Core/base resolved config has `lsp: false` and `OPENCODE_DISABLE_LSP_DOWNLOAD=true`; a
    read/edit fixture launches/downloads no server. Conditional LSP is discovered only with the
    feature flag: every non-selected ID has `{disabled:true}`, the selected safe ID is omitted and
    matches the pack allowlist + PATH binary version/hash. `true`, custom command, `latest`,
    Npm/cache/project-first resolver, unknown server, or missing binary yield Fail; an
    empty-cache/no-network canary downloads no code. The `safe_search` fallback passes without LSP.
19. `share: disabled`, `snapshot: false`, `autoupdate: false`, `title.disable: true`,
    `formatter: false`; compaction auto/prune, tail settings, and `OC_MODEL_COMPACTOR` resolved.
    A malicious Git clean/process filter fixture is not executed; core rejects `snapshot:true`.
20. For all models the effective overflow threshold is computed; each active role→compactor pair
    passes the usable-input invariant and near-limit resume test.
21. Aggregate persistent-text budget, cold input floor, packet/return fixtures, and `tool_output`
    thresholds pass limits; all auto-instruction origins are included in the aggregate and origin
    report.
22. Installer fixtures cover dry-run, adopted config/policy, contract re-adoption, adopt/re-adopt/
    remove/preserve project skill, user-owned gitignore/policy/Notebook seeds, model bind/rebind
    snapshot, dependency materialize/tamper recovery, instruction adopt/re-adopt, provider/project
    env-name adoption/removal, conflict, update, fresh/upgrade rollback, and uninstall/de-adoption;
    a retained-reference fixture does not permit deleting a pack dependency, and special lock
    lifecycle, ownership, required/forbidden ignore behavior, and absence of partial writes are
    confirmed. The non-LLM budget doctor distinguishes live/stale/corrupt ledger, preserves
    quarantine, closes the old root without reset cap, and permits only a new root session.
23. Benchmark ledger fixture forbids fork/new/background, awaits quiescence, and does not double
    the session rollup at reconciliation. Run/db/export/stats pass within one managed launcher/
    runtime scope, and the manifest records launcher version, install UUID, and runtime-scope ID;
    the baseline arm accepts only the embedded locked manifest, includes one Task-denied agent with
    the same isolation/safety/accounting controls and an equal aggregate call ceiling. Arbitrary
    baseline config and direct host `opencode` fixtures get Fail.

## 20. Benchmark and Readiness Criteria

### 20.1. Benchmark design

The baseline and the new profile are compared on one git snapshot and identical tasks. The unit
of experiment is one scenario attempt in a separate root session.

- at least 30 pre-closed holdout scenarios: 10 Tier 0/1, 10 Tier 2, 10 Tier 3; tuning scenarios
  are stored separately and do not enter the acceptance gate;
- at least three repetitions of each scenario for each profile; a power analysis may require more
  repetitions;
- baseline: a separate pack-owned/hash-locked monolithic OpenCode agent on the same
  implementation-quality model as `OC_MODEL_IMPLEMENTER`;
- OpenCode version, role-model mapping, provider settings, and revision are fixed;
- at least two model-role profiles are tuned only on the tuning set; the holdout is not used to
  pick a winner;
- each attempt starts from one clean git snapshot; the order of baseline/profile is randomized in
  paired blocks;
- cold-cache and warm-cache cohorts are run, published, and pass the production gate
  independently; post-hoc selection of a favorable cohort and mixing results are forbidden;
- an attempt may be excluded only for a pre-defined external contamination, symmetrically for both
  profiles and before viewing the outcome. An error/violation by the agent itself is not
  contamination;
- deterministic checks are run automatically, and a human/reviewer rubric is evaluated blind
  without profile and model name;
- within an attempt `/new`, fork, and background subagents are forbidden. Detection of them makes
  the attempt rejected: all associated spend remains in the CPAT numerator, the accepted
  denominator is not increased; all Task calls must complete;
- the bootstrap unit for quality is a scenario cluster with all repeats and both profiles. If the
  95% interval is too wide, increase first the number of independent scenarios, not declare victory
  by point estimate.

The baseline is not a user config override. The release contains an immutable
`benchmark/profiles/baseline/{opencode.jsonc,baseline-manifest.json}`; the benchmark harness
accepts only the exact embedded manifest hash and builds a separate sanitized staging tree. The
same guard implementation is activated in an explicitly compiled `baseline` contract mode: one
agent, `task: deny`, title/share/MCP/foreign origins disabled, the same safe file/search
boundary, verification policy, XDG/system/auth/env isolation, output accounting, and provider
telemetry. Its hard logical-attempt cap equals the maximum aggregate LLM-attempt budget of the
profile arm, so the safety ceiling does not give one side a hidden advantage. Arbitrary
manifest/path flag is forbidden.

Formal quality rubric: `DoD correctness`, `behavioral correctness`, `scope discipline`,
`safety/backward compatibility`, `maintainability/evidence` are scored `0 | 1 | 2`. The result is
accepted only if the mandatory deterministic checks passed, there is no `Blocker`/`Major`, no
category equals `0`, and the sum is at least `8/10`.

Quality metrics:

- human accept/reject;
- deterministic build/lint/typecheck/test pass;
- first-pass completion rate;
- Blocker/Major/Minor/Note findings of independent blind review;
- defects after acceptance;
- success of continuation after checkpoint/compaction.

Economics metrics:

- provider-billed CPAT and OpenCode-estimated CPAT;
- `fresh_input`, output, reasoning, cache read/write, and `total_prompt`;
- steps and number of subagent calls;
- number of retries, rework, and compactions;
- rejected spend, mean, p50, p95, and max task-tree cost;
- latency as a secondary metric.

In V1.17.9 `tokens.input` is treated as `fresh_input`; `total_prompt` equals
`fresh_input + cache.read + cache.write`. OpenCode `cost` is usually an estimate from token usage
and model pricing metadata, so the pricing snapshot is stored alongside the result and is not
called an invoice.

### 20.2. Usage and Cost Attribution by Telemetry Level

Benchmark harness:

1. runs all operations only through the pack-owned production `opencode-profile` for the profile
   arm, or the pack-owned benchmark entrypoint with embedded baseline-manifest hash for the
   baseline arm; a direct binary is permitted only as an internal `exec` already after the common
   launcher scrub/preflight. The harness records launcher version, install UUID, and one chosen
   external runtime/provider scope for all operations of the attempt;
2. extracts the intended root session ID from managed `run --format json`;
3. via managed read-only `db --format json` and a recursive CTE collects the root and all
   descendants by `session.parent_id`;
4. in the isolated benchmark worktree/provider scope finds all sessions created between
   `started_at` and the final `cutoff_at`. A new unlinked root marks the attempt as rejected, but
   it and all descendants are included in attributable spend;
5. after the intended root returns, repeats traversal of all discovered roots until the set of
   session IDs, their `time_updated`, tokens, and cost are stable across two consecutive polls.
   Background execution is forbidden; a late descendant before quiescence marks the attempt
   rejected and is counted. `cutoff_at` is fixed only after quiescence;
6. sums the session aggregate columns of each ID exactly once, including the Orchestrator, Task
   children, compaction, retries, and rework. Message exports and `step-finish` are only
   reconciliation channels and are not added to the rollup;
7. limits recursive traversal depth, detects cycles, and requires a parent for every non-root;
8. links all repeated and rejected attempts with scenario ID in the benchmark manifest;
9. reconciles the session tree via managed `export <sessionID>`; managed
   `stats --days <N> --models 20 --project ""` is used only for aggregate reconciliation, not for
   attribution of a specific task.

The manifest of each attempt contains `attempt_uuid`, scenario/profile/repetition, cache cohort,
intended root session ID, all attributed session IDs, disposition and reason, `started_at`,
`root_returned_at`, `cutoff_at`, git SHA, OpenCode version, launcher version, install UUID,
runtime-scope ID, price-snapshot hash, and provider scope; the baseline arm additionally contains
the baseline-manifest hash. Production and benchmark configs disable `title`, so there is no
non-persisted title LLM call.

Primary metric for cohort/profile:

```text
CPAT = provider-billed cost of all attempts in cohort / number of accepted results
```

The numerator includes successful, rejected, blocked attempts, agent-caused protocol violations,
retries, rework, service calls, cache writes, and compaction. With zero accepted results CPAT
equals infinity. Only pre-declared external contamination per the rule above is excluded. For
distribution, the full OpenCode-estimated cost of each attributed session forest and rejected
spend are additionally published; provider-billed forest cost is available only at Level A.

The source of truth for money is the provider billing/usage API or invoice. Two independent
quantities are distinguished: `billing coverage` — the share of the provider bill inside the
isolated benchmark scope, and `attribution granularity` — the share of the bill matched to an
attempt or `paired block × profile arm`. For an economics Pass both must be at least 95% at the
required level.

| Telemetry level | Available assertion |
| --- | --- |
| A: request-level billed records + stable request IDs | per-attempt billed cost, p95, and scenario-cluster bootstrap |
| B: a separate closed bill for each `paired block × profile arm` | cohort CPAT-ratio CI via paired resampling of independently billed arm subtotals |
| C: one isolated cohort invoice total | point CPAT only; billed CI/p95 = `N/A` |
| D: OpenCode session rollups + pinned prices | per-attempt estimated distribution, not provider-billed |
| E: managed `stats` only | aggregate sanity check, not attribution |

Level A keeps request IDs and joins to attempt. Level B gets two independently billed subtotals
within each paired block — separately for baseline and profile — via independent provider
projects/keys or non-overlapping closed billing windows; then arm totals are combined only in
paired contrast for the bootstrap. A single common bill for both arms is Level C, not Level B.
One may not distribute the cohort invoice proportionally to OpenCode estimates and then bootstrap
an artificial variance. At Levels C–E the economics gate gets `Unverified`; quality and token
gates are published separately. Unavailable cache/reasoning breakdowns get `N/A`, not zero.

The normative bootstrap unit for both Level A/B is the paired scenario cluster: one
pre-fixed scenario with all repeats of one cache cohort and both arms. Level B bills each
`cluster × arm` separately. In each bootstrap replicate paired clusters are drawn with
replacement; then for each arm `CPAT* = Σ billed_cost / Σ accepted` is recomputed, after which
`R* = 1 - CPAT*_profile / CPAT*_baseline`. Averaging per-block ratios is forbidden. A zero
aggregate accepted denominator for the profile means Fail (`CPAT = infinity`); a zero baseline
denominator or `infinity/infinity` makes the contrast undefined and the economics gate
`Unverified`. The point estimate is also always a ratio of sums.

### 20.3. Production acceptance gate

- no regression on security/data-loss scenarios;
- cold-cache and warm-cache cohorts independently satisfy all applicable quality, token, and
  economics thresholds below;
- deterministic gates pass for all accepted tasks;
- for the contrast `success_profile - success_baseline` the lower one-sided 95% bound is strictly
  greater than `-0.05`;
- economics telemetry is Level A or B, and billing coverage and attribution granularity are at
  least 95%;
- for the contrast `1 - CPAT_profile / CPAT_baseline` the lower one-sided 95% bound is at least
  `0.20`. At Level A and B the same paired scenario-cluster bootstrap algorithm above is applied;
  Level B uses two independently billed arm subtotals for each cluster;
- fresh input per accepted result and total prompt are published separately; reduction of fresh
  input is at least 20% without growth of total prompt cost;
- at Level A billed p95 task-tree cost is no higher than baseline by more than 10%; at Level B the
  same limit applies to the distribution of block CPAT, and billed task p95 = `N/A`;
- at least 90% of simple fixtures run without subagent;
- simple-task cost does not exceed baseline by more than 10%;
- the medium route uses no more than three subagent calls without retry;
- the high-risk route includes Architect and Reviewer;
- after the total budget of two rework cycles the automatic loop stops;
- resume from checkpoint successfully restores 9 of 10 control tasks.

Optimization target after the first tuning cycle:

- provider-billed CPAT below baseline by at least 30%;
- fresh input per accepted result below by at least 40%;
- simple-task cost below by at least 50%;
- the share of forced escalation from a cheap model to an expensive one below 20%.

If the production gate is not reached, the configuration pack is not called ready.

## 21. Delivery Stages

1. Approve this specification and permit creation of runtime artifacts.
2. Create the configuration scaffold, guard/search plugin, prompts, skills, and Notebook
   templates.
3. Implement the validator and role smoke tests.
4. Verify permissions and failure fixtures.
5. Fix the baseline and run the benchmark.
6. Tune routing, budgets, steps, and role profiles from the data.
7. Conduct an independent review and release the README/install guide.

Until explicit approval of this document, only its editing, review, and analysis are permitted.
After approval the user separately permits creation of runtime files.

## 22. Accepted Architectural Decisions

- the product is an OpenCode configuration pack, not a separate system;
- production target is OpenCode `1.17.9` V1;
- the Router is implemented as a policy primary Orchestrator, not an external service;
- simple tasks use a fast lane without a mandatory Router skill/subagent;
- models and providers are interchangeable and bound via capability roles;
- task-specific subagent context consists of the Task packet and on-demand file reading; in
  addition OpenCode adds the system prompt, role prompt, project instructions, tool schemas, and
  the permitted skill catalog;
- full transcript is not copied into the child task;
- the Packet is an ephemeral contract;
- core uses one mandatory fail-closed project-local guard/search plugin;
- the recursion guard is implemented by `permission.task`, not a missing `subagent_depth`;
- alternative selectable built-in agents are disabled;
- installation is a transactional installer-managed overlay with hash ownership;
- compaction uses a separate capability-model, the title LLM call is disabled;
- Reviewer is mandatory by risk, not for every minor edit;
- checkpoint is milestone-based and does not require automatic `/new`;
- quality and savings are confirmed by a paired benchmark with full session-tree usage/
  estimated-cost attribution and fail-closed provider-billing telemetry levels.

## 23. Open Questions

### Approval gate

- Explicit user approval to move from specification to creation of runtime configuration.

Draft 0.4 is recorded as a review checkpoint. Runtime artifact implementation has not started;
user comments will enter the next revision before the approval gate.

### Non-blockers, resolved at installation or benchmark

- specific provider/model IDs for capability slots;
- provider-specific variants and cache options;
- exact project verification commands;
- need for an optional lease or telemetry plugin;
- final tuning of steps and budgets after measurement.

## 24. Official Sources

- OpenCode Config: <https://opencode.ai/docs/config/>
- OpenCode Agents: <https://opencode.ai/docs/agents/>
- OpenCode Permissions: <https://opencode.ai/docs/permissions/>
- OpenCode Skills: <https://opencode.ai/docs/skills/>
- OpenCode Rules: <https://opencode.ai/docs/rules/>
- OpenCode Commands: <https://opencode.ai/docs/commands/>
- OpenCode Models: <https://opencode.ai/docs/models/>
- OpenCode CLI: <https://opencode.ai/docs/cli/>
- OpenCode MCP: <https://opencode.ai/docs/mcp-servers/>
- OpenCode Plugins: <https://opencode.ai/docs/plugins/>
- OpenCode Custom Tools: <https://opencode.ai/docs/custom-tools/>
- OpenCode V2 status: <https://opencode.ai/v2/docs>
- V1 to V2 migration: <https://opencode.ai/v2/docs/migrate-v1>
- Pinned V1.17.9 config schema: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/v1/config/config.ts>
- Pinned config merge/auth behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/config/config.ts>
- Pinned system-managed config paths: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/config/managed.ts>
- Pinned sharing override behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/share/session.ts>
- Pinned snapshot subprocess behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/snapshot/index.ts>
- Pinned Task child-session behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/task.ts>
- Pinned grep permission behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/grep.ts>
- Pinned glob permission behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/glob.ts>
- Pinned LSP path behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/lsp.ts>
- Pinned MCP lifecycle: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/mcp/index.ts>
- Pinned skill discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/skill/index.ts>
- Pinned plugin hooks: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/plugin/src/index.ts>
- Pinned plugin bootstrap: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/project/bootstrap.ts>
- Pinned prompt attachment behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/prompt.ts>
- Pinned auto-instruction behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/instruction.ts>
- Pinned command discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/command/index.ts>
- Pinned CLI run/project overrides: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/cli/cmd/run.ts>
- Pinned TUI project override: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/cli/cmd/tui.ts>
- Pinned V1 step-loop behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/prompt.ts>
- Pinned MAX_STEPS prompt: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/session/runner/max-steps.ts>
- Pinned apply-patch behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/apply_patch.ts>
- Pinned read directory/typo behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/read.ts>
- Pinned webfetch behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/webfetch.ts>
- Pinned tool discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/registry.ts>
- Pinned LLM tool schema filtering: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/llm/request.ts>
- Pinned formatter behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/format/index.ts>
- Pinned truncation permissions: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/agent/agent.ts>
- Pinned npm loader: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/npm.ts>
- Pinned mutable model catalog: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/models-dev.ts>
- Pinned provider adapter resolution: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/provider/provider.ts>
- Pinned compaction behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/compaction.ts>
- Pinned usage/cost calculation: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/session.ts>
