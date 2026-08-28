# Next Level Agent

> A skill-driven multi-agent development system for OpenCode that can take a task from the first idea to verified completion.

## Philosophy

> A useful agent should not merely produce code. It should understand the task, choose the right amount of process, finish the work, verify the result, and remember where it was.

NLA is built around a simple idea: skills can change the operating system of an agent. The underlying model remains a general-purpose model, but the workflow around it gives the model roles, checkpoints, independent review, recovery paths, and memory. The result behaves much closer to a real multi-agent system than a single chat with a long prompt.

The priorities are:

1. Correctness and evidence before claims.
2. The smallest workflow that is safe for the task.
3. Fresh, bounded context for specialized agents.
4. Recovery from provider and context failures.
5. Observable behavior instead of invisible orchestration.

## Why NLA

**NLA is a managed multi-agent system with one accountable coordinator, specialized roles, independent decision and review gates, role-specific model pools, and durable state recovery. It is not a collection of prompts.** Prompts define role behavior, while the NLA plugin controls delegation, model failover, session relationships, workflow memory, compaction, restoration, and telemetry.

- **One accountable coordinator.** NLA owns the user conversation, goal, approvals, sequencing, memory, and final acceptance.
- **End-to-end delivery.** The workflow continues from clarification and design through implementation, verification, review, and completion.
- **Risk-based routing.** Simple tasks stay direct, while complex or high-risk work receives the additional roles and gates it needs.
- **Specialized roles.** Explorer, Scout, Architect, Implementer, Reviewer, Supervisor, and Compactor work in focused child sessions.
- **Architecture before implementation.** Tier 3 work cannot proceed to planning until Architect has evaluated the design and the user has approved it.
- **Independent quality control.** Reviewer checks the result, while Supervisor checks workflow alignment, evidence, blockers, loops, and completion state.
- **Model pools with failover.** Each role can move from a failed or unavailable preferred model to a bounded fallback without losing the child session.
- **Fresh bounded context.** Subagents receive focused task packets instead of the complete conversation, reducing distraction and duplicated context.
- **Durable memory.** A private session ledger and Assistant Notebook preserve verified decisions, milestones, blockers, and exact next steps.
- **Safe context recovery.** Controlled compaction audits state, creates a checkpoint, runs native summarization, restores the ledger, and continues the same session.
- **Observable execution.** Structured telemetry records sessions, models, failover, context usage, tools, compaction, and restoration without copying the conversation.
- **A disciplined development pipeline.** Superpowers skills provide brainstorming, planning, TDD, debugging, worktrees, review, verification, and branch completion.

## Install

> [!WARNING]
> NLA is currently developed and tested specifically for OpenCode. Support for any other coding-agent CLI is not guaranteed. If you need another CLI, you are welcome to complete and test the corresponding integration yourself.

Ask your OpenCode or Codex agent to clone this repository, read [`AGENTS.md`](AGENTS.md), and follow [`INSTALL.md`](INSTALL.md). Codex may assist with installation, but the complete NLA runtime currently runs in OpenCode.

Use this prompt:

```text
Clone https://github.com/pickleshell/next-level-agent.git, read AGENTS.md completely, and follow INSTALL.md to install and verify NLA for OpenCode. Preserve my existing configuration and credentials. Do not claim success without showing the resolved plugin, default agent, skills path, model pools, and smoke-test evidence.
```

## What NLA Is For

NLA is for software-development tasks that should be carried from request to accepted result rather than stopped after code generation.

It is especially useful when:

- a task needs exploration, design, implementation, tests, and review;
- architectural choices should be challenged before code is written;
- free, experimental, or unreliable model endpoints need automatic failover;
- a long OpenCode session risks exhausting its context window;
- decisions and project knowledge must survive compaction and future sessions;
- you want to inspect which model and session performed each part of the work.

Small tasks stay small. NLA answers or edits directly when delegation would cost more than it adds. Larger and riskier work expands into a structured team.

## What Makes It Different

### Risk-based workflow tiers

Every task is routed by risk and uncertainty, not merely by prompt length.

| Tier | Typical work | Workflow |
| --- | --- | --- |
| 0 | Answer or focused read-only inspection | NLA works directly |
| 1 | Small bounded change | Direct edit and targeted verification |
| 2 | Non-trivial implementation | Explore, implement, verify, review, checkpoint |
| 3 | Architecture or high-risk change | Clarify, explore, architect, approve design, plan, implement, verify, review, checkpoint |

This matters because multi-agent ceremony is not automatically better. NLA spends it where independent context and judgment improve the outcome.

### A real Architect gate

Tier 3 brainstorming includes an Architect after requirements and repository exploration are available. Architect compares viable approaches, defines boundaries and interfaces, maps failure handling and tests, and returns a decision packet to NLA. The primary coordinator discusses that design with the user; implementation planning cannot begin until the design is approved.

This prevents a common failure mode: producing an excellent implementation of an architecture nobody deliberately chose.

### Supervisor throughout the lifecycle

Supervisor is an independent auditor, not a competing coordinator. It can inspect Tier 3 design and execution gates, material milestones, anomalies, pre-compaction state, and final completion. Tier 2 invokes it only when risk signals justify the extra pass.

The separation matters: NLA owns the task, while Supervisor checks that NLA has not silently drifted from the goal, evidence, approvals, or Definition of Done.

### Model pools with bounded failover

Each specialized role has an ordered model pool. If the preferred endpoint returns an early rejection, rate limit, provider error, network failure, or role timeout, the same child session moves to the next configured model. Attempts and fallbacks are recorded in the run log.

Pools are bounded to prevent retry loops and uncontrolled spending. The visible primary NLA session does not silently jump models behind the user's back.

This is particularly valuable with free and experimental endpoints: model availability becomes a recoverable runtime condition instead of a failed task.

### Specialized agents with bounded context

NLA can dispatch Explorer, Architect, Implementer, Reviewer, Supervisor, and Compactor roles. Each child receives a focused task packet instead of the entire conversation. Child sessions are linked to the primary through `parent_session_id` and `root_session_id`.

Fresh context reduces distraction and makes independent review genuinely independent.

### Durable fast memory

The primary coordinator owns two forms of local memory:

- a structured per-session ledger containing the goal, tier, stage, acceptance criteria, approved decisions, completed and active work, changed files, verification, blockers, pending gates, and exact next step;
- an [Assistant Notebook](https://github.com/pickleshell/skills/tree/main/assistant-notebook) for compact, reusable project knowledge.

Notebook ownership is deliberately exclusive to primary NLA. Subagents receive only bounded packets and cannot pollute shared memory with unverified claims. State is stored outside the repository with private filesystem permissions and atomic replacement.

### Controlled context compaction

NLA monitors effective context usage and prepares a safe handoff before the session becomes unusable. At a safe idle boundary it runs:

```text
Supervisor audit
→ Compactor checkpoint
→ native OpenCode summarize
→ restore the structured ledger
→ continue in the same primary session
```

OpenCode native automatic compaction remains enabled as an emergency fallback with pruning and a 32,000-token reserve. NLA's controlled path adds something native summarization alone cannot guarantee: workflow state, approvals, evidence, and the exact next action are explicitly restored.

### Session and context telemetry

NLA writes structured JSONL events to `.opencode/agent-run.log`. The log identifies:

- newly created and already observed sessions;
- primary and child session relationships;
- the effective provider and model;
- model attempts, failures, and fallbacks;
- effective context usage;
- compaction start, completion, restoration, and post-compaction usage;
- skill and NLA tool lifecycle events.

Prompts, model replies, and tool output are not copied into this telemetry. The purpose is operational analysis: you can tell whether NLA continued in the same session, created a subagent, restarted as a new root, or completed a normal compaction.

### The Superpowers development pipeline

NLA retains the core Superpowers workflow: brainstorming, worktree isolation, explicit implementation plans, test-driven development, systematic debugging, subagent-driven development, code review, verification before completion, and branch finishing.

These are mandatory behavioral skills rather than a list of optional suggestions. They are what allows a general coding model to carry a task through a repeatable engineering process.

## Architecture and Roles

NLA is a supervised multi-agent system with one user-facing coordinator. It is not a prompt pack or a loose collection of agents talking to one another. Primary NLA owns the goal, conversation, routing, approvals, durable memory, sequencing, and final acceptance. Specialized roles receive bounded assignments, work in child sessions, and return evidence to NLA through controlled gates.

This structure provides four practical advantages:

1. **Clear ownership.** One coordinator remains accountable for the complete task.
2. **Independent judgment.** Architecture, implementation, review, and workflow audit can use separate contexts and models.
3. **Controlled cost.** Simple work stays with NLA, while expensive delegation is reserved for tasks that benefit from it.
4. **Operational resilience.** Model failover, durable state, compaction recovery, and telemetry prevent one provider or context failure from silently destroying the workflow.

### System map

```text
User
  ↓
NLA: primary coordinator, memory owner, acceptance owner
  ├─ Router: optional Tier classification
  ├─ Explorer: repository and problem discovery
  ├─ Scout: external documentation and dependency research
  ├─ Architect: design alternatives and architecture gate
  ├─ Implementer: bounded code changes and verification
  ├─ Reviewer: independent specification and quality review
  ├─ Supervisor: workflow, evidence, budget, and drift audit
  └─ Compactor: faithful recovery checkpoint
       ↓
Role model pool: preferred model → bounded fallback
```

Child sessions carry both `parent_session_id` and `root_session_id`. This makes the full task tree observable without confusing a specialized child with a restarted primary session.

### Role catalog

| Role | Type | Responsibility | Typical use | Writes project files | Shared memory access |
| --- | --- | --- | --- | --- | --- |
| **NLA** | Primary | User dialogue, Tier selection, delegation, approvals, sequencing, acceptance, and direct Tier 0/1 work | Every task | Tier 1 direct edits | Exclusive owner |
| **Router** | Internal subagent | Returns a bounded Tier, route, required roles, gate state, and budget recommendation | Optional routing assistance | No | No |
| **Explorer** | Subagent | Finds relevant files, symbols, dependencies, facts, and local risks | Tier 2/3 discovery | No | No |
| **Scout** | Subagent | Researches official documentation, versions, and external dependencies | When local evidence is insufficient | No | No |
| **Architect** | Subagent | Compares viable designs and defines boundaries, interfaces, data flow, failure handling, risks, and tests | Tier 3 design gate | No | No |
| **Implementer** | Subagent | Performs a scoped change and returns verification evidence | Approved Tier 2/3 implementation | Yes | No |
| **Reviewer** | Subagent | Independently checks the requested scope, actual change, evidence, and quality | Risk-based review gate | No | No |
| **Supervisor** | Subagent | Audits goal alignment, approvals, blockers, repeated loops, context pressure, and completion evidence | Tier 3 gates, anomalies, compaction, completion | No | No |
| **Compactor** | Subagent | Converts the current structured state into a faithful recovery checkpoint | Before controlled compaction | No | No |

The table describes each role's NLA contract. Some least-privilege boundaries are still enforced behaviorally by role prompts rather than by the complete hard permission matrix proposed in Draft 0.4. See the [implementation status audit](docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md) for the exact current boundary.

Router is available as an internal role, but NLA can classify straightforward requests directly. Supervisor does not become a second coordinator. It returns a verdict, while NLA remains responsible for acting on it. Only primary NLA may read or update Assistant Notebook and the shared session ledger.

### Tier 2 execution

```text
User request
→ NLA classification
→ Explorer
→ Implementer
→ Verification
→ Reviewer when required
→ Checkpoint
→ NLA acceptance
```

Tier 2 is intended for non-trivial implementation with moderate risk. Each specialized role receives only the context needed for its job.

### Tier 3 execution

```text
User request
→ NLA clarification
→ Explorer and optional Scout
→ Architect
→ NLA discusses the design with the user
→ Explicit user approval
→ Implementation plan
→ Implementer
→ Verification
→ Reviewer
→ Supervisor completion audit
→ Checkpoint
→ NLA acceptance
```

Architect does not take over the user conversation and does not implement code. It gives NLA a decision packet. NLA cannot proceed to implementation planning until the design is approved.

### Controlled compaction

```text
NLA saves the complete ledger
→ Supervisor audits workflow continuity
→ Compactor creates a recovery checkpoint
→ OpenCode performs native summarization
→ NLA restores the structured ledger
→ the same primary session continues from the exact next step
```

This is one of the main differences between NLA and ordinary context summarization. The system restores not only a prose summary, but also the task goal, acceptance criteria, approvals, evidence, blockers, changed files, and next action.

## Configuration

Model pools are ordered and role-specific:

```json
{
  "architect": {
    "enabled": true,
    "models": [
      "preferred/provider-model",
      "fallback/provider-model"
    ],
    "idle_timeout_ms": 300000,
    "max_failovers": 1
  }
}
```

The current Architect primary is intentionally useful as a live failover probe: if NVIDIA reports the configured Qwen endpoint as retired, NLA records the failure and continues with the fallback in the same child session. Replace test endpoints with the models appropriate for your installation.

Context thresholds can be overridden without editing the plugin:

```bash
export NLA_CONTEXT_SOFT_TOKENS=50000
export NLA_CONTEXT_HARD_TOKENS=70000
export ASSISTANT_NOTEBOOK_DIR=/private/path/to/notebook
```

## Verification

Run the focused NLA checks:

```bash
python3 -m pytest tests/test_compact_checkpoint.py tests/test_model_pools.py tests/test_nla_integration.py tests/test_restore.py
node tests/opencode/test-nla-memory.mjs
```

The repository also contains the inherited Superpowers harness tests. See [`docs/testing.md`](docs/testing.md) and the known fork-specific notes in [`docs/NLA_INSTALL_AND_TEST.md`](docs/NLA_INSTALL_AND_TEST.md).

Real end-to-end checks have covered model rejection and fallback, persistent ledger restoration, Supervisor and Compactor child sessions, native OpenCode compaction, continuation under the same primary session ID, and recovery of the correct next step without rereading the source file.

## Documentation

- [Original technical specification](TECHNICAL_SPECIFICATION.md): the initial product brief and architectural requirements.
- [Installation](INSTALL.md): supported Alpha setup for running NLA against an OpenCode project.
- [Draft 0.4 implementation status](docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md): what NLA has achieved, what remains partial or absent, and the recommended practical scope.
- [Project status and usage](docs/PROJECT_STATUS_AND_USAGE.md): supported environment, external-project launch, limitations, telemetry, model pools, roadmap, and contributions.
- [Installation and testing](docs/NLA_INSTALL_AND_TEST.md): current OpenCode setup and operational behavior.
- [NLA modifications](NLA_MODIFICATIONS.md): boundary between the Superpowers base and NLA additions.
- [Superpowers](https://github.com/obra/superpowers): the upstream project and original methodology.
- [Assistant Notebook](https://github.com/pickleshell/skills/tree/main/assistant-notebook): the durable fast-memory skill used by NLA.

## History

NLA did not begin as a Superpowers fork. I first designed the [Next-Level OpenCode Profile](TECHNICAL_SPECIFICATION.md) as a repository-local configuration pack for OpenCode. Draft 0.4 already described native-first orchestration, Tier 0–3 risk routing, bounded child context, specialized capability roles, least privilege, evidence gates, durable state, compaction, safety controls, and cost measurement. At that point it was a plan under architecture review, not an implementation.

While reviewing the plan, I asked Grok whether similar systems already existed. It returned several alternatives, including Superpowers. Superpowers was not a ready-made implementation of the full NLA specification, but its ideology immediately matched an important part of mine: a great deal of agent behavior can be built at the skill layer. More importantly, it demonstrated that claim in practice through a development pipeline that had already progressed much further than I expected.

I installed Superpowers, ran it on a simple task, and liked the result. That made it a compelling quick start: rather than implement every workflow skill from zero, I could use a compatible and proven skills-first pipeline as the implementation base, then evolve it toward the existing NLA design. Superpowers is therefore best understood as the closest ideological alternative I found and the practical foundation of this implementation, not the origin of the NLA plan.

The current NLA combines both lines: Superpowers contributes the core development discipline, while the original profile contributes risk tiers, explicit architecture, supervision, model resilience, durable memory, controlled compaction, and operational telemetry. The [technical specification](TECHNICAL_SPECIFICATION.md) preserves the original direction; the implementation has since evolved through real tasks and failure cases, so current runtime documentation is authoritative where later behavior differs from Draft 0.4.

I am now working on multi-agent systems at a different scale. Having a miniature version of such a system on my own machine, and seeing it genuinely complete useful tasks from beginning to end, feels like owning a toy robot that actually helps around the house.

## Credits

Next Level Agent is built by [PickleShell](https://github.com/pickleshell).

The implementation foundation is [Superpowers](https://github.com/obra/superpowers), created by [Jesse Vincent](https://blog.fsck.com) and Prime Radiant. This implementation fork began from Superpowers commit `b36e082`; attribution and the upstream license are preserved. The NLA product plan and Draft 0.4 specification predate the decision to use Superpowers as that foundation.

The Assistant Notebook skill comes from [pickleshell/skills](https://github.com/pickleshell/skills).

## License

MIT. See [`LICENSE`](LICENSE).
