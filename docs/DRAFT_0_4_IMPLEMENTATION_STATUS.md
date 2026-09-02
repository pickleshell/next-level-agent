# Draft 0.4 Implementation Status

This document compares the original [Next-Level OpenCode Profile Draft 0.4](../TECHNICAL_SPECIFICATION.md) with the current Next Level Agent implementation.

## Executive Summary

The useful core of NLA is already working. Draft 0.4, however, describes a substantially heavier product: an enterprise-style managed OpenCode profile with its own transactional installer, launcher, mandatory security guard, validator, drift detection, immutable model and dependency snapshots, hard budget enforcement, and an economic benchmark harness.

An important correction to the project history is that the installer did not appear only during runtime implementation. Draft 0.4 already made the installer a mandatory first-version component and devoted a large normative section to its lifecycle. The scope expansion therefore began during architecture design, before runtime implementation. The original NLA idea had already grown from a useful multi-agent profile into a secure OpenCode distribution and governance system.

Measured against the practical user goal, NLA is a working alpha/MVP. Measured literally against every requirement in Draft 0.4, approximately 40–50% is implemented, because a large part of the draft concerns distribution, isolation, enforcement, and benchmarking infrastructure rather than the agent workflow itself.

## What Has Been Implemented

| Draft 0.4 area | Current status |
| --- | --- |
| Repository-local OpenCode profile | Implemented through `opencode.json` and a local plugin |
| Primary coordinator | Implemented as the `nla` agent |
| Tier 0–3 routing | Implemented in the primary prompt and bootstrap skill |
| Direct-first fast lane | Implemented for Tier 0 and Tier 1 work |
| Explorer | Implemented |
| Scout | Configured, although its planned hardened web-research boundary is not implemented |
| Architect | Implemented and integrated into Tier 3 brainstorming |
| User approval gate | Implemented before planning and implementation on the architectural path |
| Implementer | Implemented |
| Independent Reviewer | Implemented |
| Compactor | Implemented |
| Supervisor | Added beyond the original role set |
| Role-specific models | Implemented |
| Model pools | Implemented |
| Two execution classes | Implemented: OpenCode agent runtime and bounded utility-model runtime |
| Automatic bounded failover | Implemented and tested against a real HTTP 410 model rejection |
| Bounded child sessions | Implemented through `nla_task` |
| Skills-first development workflow | Implemented through the Superpowers foundation |
| Durable session state | Implemented as a private structured ledger |
| Assistant Notebook | Implemented as fast durable memory owned by primary NLA |
| Checkpoint before compaction | Implemented |
| Controlled compaction | Implemented as Supervisor → Compactor → native summarize → restore |
| Emergency native compaction | Enabled with automatic compaction, pruning, and a 32,000-token reserve |
| Soft and hard context thresholds | Implemented |
| Context restoration | Verified in a real persistent OpenCode session |
| Session telemetry | Implemented |
| Model telemetry | Implemented |
| Context telemetry | Implemented |
| Parent/root session graph | Implemented |
| Tests and runtime evidence | Unit tests and real end-to-end checks exist |
| Installation documentation | A simple working repository-local launch path is documented |

The central product hypothesis has therefore been demonstrated in practice: an ordinary OpenCode agent can be lifted by skills and a small plugin layer into a useful miniature multi-agent system. It can classify work, bring in specialized roles, survive a failed model endpoint, preserve workflow state, compact its context, and continue from the correct next step.

## What Is Partially Implemented

### Task Context Packet

Draft 0.4 defines a strict `Packet_Version: 1` contract containing scope, exclusions, Definition of Done, relevant files, base revision, verification, open questions, and budget hints. It also defines packet-size limits and forbids OpenCode attachment interpolation such as `@file`.

The current NLA sends bounded prompts through `nla_task`, but it does not have a strict packet schema validator. Packet completeness, size, scope, and attachment safety are still primarily behavioral instructions rather than technical enforcement.

### Least Privilege

Roles are logically separated and have distinct prompts, but the strict permission matrix from Draft 0.4 is not implemented.

In particular:

- there is no complete per-role `permission` allowlist and denylist;
- Explorer and Reviewer are constrained mainly by instructions;
- there is no canonical path-containment enforcement;
- nested Task delegation is not proven to be denied at the permission layer;
- alternative `build` and `plan` agents remain selectable;
- the skill catalog is not restricted independently for every role.

### Verification and Review Gates

The workflow requires verification and independent review, but not every transition is enforced by a hard state machine. A model can still violate the intended sequence if it ignores the skill instructions. Supervisor provides an audit layer, but it is not a technical workflow engine.

### Notebook and Long-Term State

The purpose of the Draft 0.4 Notebook has been implemented, but the storage shape is different.

The draft proposed project-local files:

- `MANIFEST.md`;
- `INDEX.md`;
- `DECISIONS.md`;
- `STATE.md`.

The current implementation uses:

- a private per-session structured ledger;
- Assistant Notebook pages for durable reusable knowledge;
- explicit pre-compaction checkpoints and restore packets.

This may be more practical for the present NLA, but it is not a literal implementation of the original document layout and ADR lifecycle.

### Model Binding

Role-specific models exist, but the following Draft 0.4 mechanisms do not:

- `OC_MODEL_*` binding variables;
- an immutable model catalog snapshot;
- adapter, endpoint, capability, limit, price, and variant reconciliation;
- hash locking;
- model-drift detection;
- mandatory role smoke tests before activation.

Draft 0.4 also specified fail-closed behavior without silent fallback. The current NLA deliberately implements bounded model failover instead. This is a tested and useful architectural change, but it is a deviation from the draft.

The implementation also now distinguishes two execution classes. Roles needing
multi-step reasoning, tools, repository navigation, or workflow participation
run as OpenCode agents. Bounded single-shot transformations or analysis may use
the utility-model runtime when orchestration supplies the complete packet and
data. This is a deliberate architecture for local, small, cheap, or specialized
models, not a one-model workaround. Compactor is its first proven consumer;
Explorer may use it only for supplied-data work. The claim does not extend to
Router. The utility adapter supports native Ollama and generic
OpenAI-compatible endpoints with bounded timeout, output, and optional
reasoning controls; provider availability remains external and deterministic
fallback remains required.

The current architecture also broadens Compactor's responsibility
beyond recovery checkpoints. Before model invocation it owns bounded prompt
shaping and tool-schema pruning/shortlisting. Router remains limited to task and
model routing; NLA does not add a Selector role. The `nla_task` runtime now
implements tool-schema pruning through OpenCode's per-prompt tool map while
preserving the bounded prompt verbatim. Its fallback uses a conservative
deterministic role/step subset rather than silently exposing the full tool
catalog, and fails closed when no safe sufficient subset is known. General
prompt rewriting and child invocations outside `nla_task` remain unimplemented.
Stable role capability profiles are cached by NLA/config signatures and hashes
of the relevant resolved OpenCode schemas. Cache hits reuse the bounded role
profile; corruption or drift causes a deterministic rebuild from the role
ceiling, never a full-catalog fallback.

This boundary reflects a practical design lesson: success on a narrow direct
Ollama task does not predict success in a full OpenCode agent loop, whose
instructions, tools, repository context, and workflow impose additional
overhead. Sanitized development-workstation evidence includes a direct native
Ollama `qwen3:4b` Compactor lifecycle followed by same-session restoration;
native Ollama diagnostics were much faster than the OpenAI-compatible path.

### Compaction

Controlled compaction works, but the current design differs from Draft 0.4:

- the draft relied primarily on a separate native compaction model;
- NLA adds a Supervisor audit and an explicit structured checkpoint;
- Compactor output is validated, with the deterministic ledger retained as the
  fallback for unavailable models, errors, timeouts, or invalid output;
- Supervisor remains on the OpenCode agent runtime and fails closed before
  compaction on an error or block;
- the draft rejected a fixed `reserved` value without benchmark evidence;
- the current configuration intentionally uses `reserved: 32000` after a real OpenCode context failure.

This is an evidence-driven evolution rather than merely unfinished work.

## What Has Not Been Implemented

### Mandatory Security Guard

There is no complete `profile-guard` implementing:

- bounded `safe_search`;
- hardened `safe_fetch`;
- canonical worktree path containment;
- symlink traversal protection;
- `apply_patch` move-destination protection;
- rejection of Task attachment syntax;
- SSRF, DNS, port, and redirect protection;
- active-role enforcement;
- fail-closed agent activation;
- origin and hash validation for plugins, commands, prompts, and skills.

This is the largest missing runtime block from Draft 0.4.

### Hard Budgets

The current implementation does not provide:

- durable logical LLM-call counters;
- hard Task-call limits;
- hard compaction-call limits;
- a root-session budget ledger;
- corruption and stale-lock recovery for that ledger;
- exact token or monetary limits.

Telemetry and bounded model failover exist, but budget enforcement does not.

### Configuration Validator and Profile Doctor

There is no deterministic validator covering:

- the exact OpenCode version and schema;
- resolved configuration;
- effective role permissions;
- model capabilities and bindings;
- plugin and guard activation;
- prompt and catalog budgets;
- canonical origins and collisions;
- secret-path rules;
- runtime and dependency drift.

### Installer, Launcher, and Transactional Lifecycle

The following Draft 0.4 infrastructure is not implemented:

- staging-tree installation;
- `--adopt-config` and controlled adoption workflows;
- manifest-lock ownership;
- hash-based update reconciliation;
- transactional update and rollback;
- safe uninstall;
- isolated XDG and runtime roots;
- inherited-environment scrubbing;
- structural CLI argv policy;
- dependency-tree quarantine;
- managed runtime drift checks.

For a personal NLA installation on a controlled machine, most of this is not required to make the multi-agent system useful.

### Custom Commands

The planned commands are not implemented:

- `/route`;
- `/review`;
- `/diagnose`;
- `/checkpoint`;
- `/handoff`;
- `/status`.

Their underlying operations are mostly available through natural-language interaction and NLA tools, so this is an ergonomics gap rather than a blocker.

### Formal Economic Benchmark

The paired benchmark from Draft 0.4 does not exist. There is no formal system for:

- baseline-versus-NLA paired scenarios;
- cold-cache and warm-cache cohorts;
- cost per accepted task;
- at least 95% billed-cost coverage and attribution;
- bootstrap confidence bounds;
- quality non-inferiority;
- p95 task-tree cost;
- mandatory economics improvements;
- a ten-task resume-fidelity gate.

The new telemetry is a useful foundation, but the benchmark harness and production acceptance gate have not been built.

### Complete Safety Fixtures

The complete Draft 0.4 failure matrix has not been exercised. Missing formal fixtures include:

- hostile global configuration;
- missing or throwing guard hooks;
- symlink and path races;
- unsafe redirects and DNS resolution;
- unknown skill, command, and plugin origins;
- nested Task attempts;
- PATH shadowing;
- dirty-worktree conflicts;
- multiple concurrent OpenCode processes;
- package-lock drift;
- model-catalog drift.

### Transactional Project Memory

There is no literal `MANIFEST/INDEX/DECISIONS/STATE` implementation with ADR lifecycle, supersession tracking, and checkpoint readback verification. Assistant Notebook covers the main user need but not the full formal contract.

## Where Draft 0.4 Expanded Beyond the Core Product

The useful original core can be summarized as:

```text
OpenCode configuration
→ risk-based routing
→ specialized agents
→ bounded delegation
→ verification and review
→ memory and compaction
→ measured execution
```

Draft 0.4 added a second product around it:

```text
transactional installer
→ managed launcher
→ isolated XDG environment
→ dependency and model snapshots
→ hash ownership
→ drift detection
→ custom safe filesystem and network tools
→ hard budget accounting
→ complete benchmark laboratory
```

That second system is not merely Next Level Agent. It is a secure deployment and governance layer for OpenCode.

Such a layer may be justified when distributing NLA to different users, running against untrusted repositories, or deploying in a corporate environment. It is not necessary for a useful personal NLA running on a controlled machine.

## What Still Matters for a Practical NLA

Draft 0.4 should not be implemented literally as the current roadmap. A focused practical roadmap is smaller.

### 1. Enforce Role Permissions

Explorer, Architect, Reviewer, Supervisor, and Compactor should be technically read-only or tool-less where intended. Nested delegation should be denied through configuration rather than prompt policy alone.

### 2. Formalize the Task Context Packet

Add a small validator directly to `nla_task` with required fields, size limits, attachment-syntax rejection, bounded return size, and an exact `NEEDS_CONTEXT` response contract.

### 3. Prevent Bypassing NLA

If this profile is intended specifically for NLA, disable selectable `build` and `plan` agents so they cannot bypass coordinator routing and acceptance gates.

### 4. Enforce Workflow Ledger Transitions

The ledger does not need to become a large workflow engine, but critical transitions should be machine-checked:

- implementation requires the necessary approval;
- checkpoint requires successful verification;
- completion is forbidden with an open blocker or review failure.

### 5. Exercise Supervisor Gates

Run several real Tier 2 and Tier 3 tasks and verify that Supervisor is invoked at the intended design, execution, anomaly, compaction, and completion boundaries without creating unnecessary loops.

### 6. Run a Small Practical Benchmark

Instead of building the Draft 0.4 statistical laboratory, run five to ten representative tasks and record:

- whether the task completed from beginning to end;
- how many subagents were used;
- whether unnecessary loops occurred;
- whether failover was required and succeeded;
- whether context survived compaction;
- how much user intervention was necessary.

### 7. Keep Public Model Defaults Healthy

The public Architect default is now a model that passed the documented smoke
tests. Provider rejection and failover remain covered by deterministic fixtures
instead of a deliberately failing live default. Installation still must verify
current provider availability.

## Current Scope

NLA Core is the project: a skills-driven multi-agent OpenCode workflow. Current
work focuses on validated task packets, enforced role boundaries,
machine-checked gates, and evidence from real end-to-end tasks. Unimplemented
Draft 0.4 deployment concepts are historical design material, not a current
product or roadmap commitment.
