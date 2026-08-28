# Next Level Agent

> A skill-driven multi-agent system for OpenCode that takes a task from the first idea to verified completion.

## Philosophy

> A useful agent should not merely produce code. It should understand the task, choose the right amount of process, finish the work, verify the result, and remember where it was.

NLA is built around a simple idea: skills can change how a general-purpose model works. Roles, gates, independent review, memory, and recovery turn an ordinary coding agent into a small engineering team.

The priorities are correctness, evidence, minimal necessary process, bounded context, recovery, and observable execution.

## Why NLA

**NLA is a managed multi-agent system with one accountable coordinator, specialized roles, independent decision and review gates, role-specific model pools, and durable state recovery. It is not a collection of prompts.**

- **One coordinator.** NLA owns the goal, user conversation, approvals, sequencing, memory, and final acceptance.
- **End-to-end delivery.** Work continues from clarification and design through implementation, verification, review, and completion.
- **Risk-based routing.** Simple tasks stay direct. Complex and high-risk tasks receive the roles and gates they need.
- **Specialized agents.** Explorer, Scout, Architect, Implementer, Reviewer, Supervisor, and Compactor work in focused child sessions.
- **Independent gates.** Architect evaluates important designs, Reviewer checks the result, and Supervisor audits workflow state and evidence.
- **Model resilience.** Role-specific pools provide bounded failover when a preferred model is unavailable or fails.
- **Bounded context.** Subagents receive focused task packets instead of the full conversation.
- **Durable memory and recovery.** A private ledger, Assistant Notebook, controlled compaction, and restoration preserve verified state and exact next steps.
- **Observable execution.** Telemetry records sessions, models, failover, context usage, compaction, and restoration without copying the conversation.
- **A proven development discipline.** Superpowers skills provide brainstorming, planning, TDD, debugging, worktrees, review, verification, and branch completion.

Prompts define role behavior. The NLA plugin controls delegation, model failover, child-session relationships, workflow memory, compaction, restoration, and telemetry.

## Install

> [!WARNING]
> NLA is currently developed and tested specifically for OpenCode. Support for other coding-agent CLIs is not guaranteed. If you need another CLI, you are welcome to complete and test the integration.

Ask your OpenCode or Codex agent to clone this repository, read [`AGENTS.md`](AGENTS.md), and follow [`INSTALL.md`](INSTALL.md). Codex may assist with installation, but the complete NLA runtime currently runs in OpenCode.

```text
Clone https://github.com/pickleshell/next-level-agent.git, read AGENTS.md completely, and follow INSTALL.md to install and verify NLA for OpenCode. Preserve my existing configuration and credentials. Do not claim success without showing the resolved plugin, default agent, skills path, model pools, and smoke-test evidence.
```

## Architecture and Roles

Primary NLA is the only user-facing coordinator and the exclusive owner of shared memory. Specialized roles receive bounded assignments, work in child sessions, and return evidence to NLA.

```text
User
  ↓
NLA: coordinator, memory owner, acceptance owner
  ├─ Router: optional Tier classification
  ├─ Explorer: repository discovery
  ├─ Scout: external research
  ├─ Architect: design gate
  ├─ Implementer: scoped code changes
  ├─ Reviewer: independent quality gate
  ├─ Supervisor: workflow and evidence audit
  └─ Compactor: recovery checkpoint
       ↓
Role model pool: preferred model → bounded fallback
```

| Role | Responsibility | Typical use |
| --- | --- | --- |
| **NLA** | Coordinates the complete task, talks to the user, owns memory, accepts the result, and handles direct Tier 0/1 work | Every task |
| **Router** | Suggests a Tier, route, required roles, gates, and budgets | Optional routing assistance |
| **Explorer** | Finds relevant files, symbols, dependencies, facts, and local risks | Tier 2/3 discovery |
| **Scout** | Researches official documentation, versions, and external dependencies | When local evidence is insufficient |
| **Architect** | Compares designs and defines boundaries, interfaces, failure handling, risks, and tests | Tier 3 design gate |
| **Implementer** | Performs a bounded code change and returns verification evidence | Approved Tier 2/3 implementation |
| **Reviewer** | Independently checks the scope, change, evidence, and quality | Risk-based review gate |
| **Supervisor** | Audits alignment, approvals, blockers, loops, context pressure, and completion evidence | Tier 3 gates, anomalies, compaction, completion |
| **Compactor** | Creates a faithful recovery checkpoint from structured state | Before controlled compaction |

Supervisor does not become a second coordinator. Architect does not take over the user conversation. Subagents cannot use shared Notebook memory.

The table describes the intended NLA role contracts. Some least-privilege boundaries are still enforced through role instructions rather than the complete hard permission matrix proposed in Draft 0.4. See the [implementation status audit](docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md) for the exact boundary.

## Workflow

| Tier | Typical work | Route |
| --- | --- | --- |
| 0 | Answer or focused read-only inspection | NLA works directly |
| 1 | Small bounded change | Direct edit and targeted verification |
| 2 | Non-trivial implementation | Explore, implement, verify, review when required, checkpoint |
| 3 | Architecture or high-risk change | Clarify, explore, architect, approve, plan, implement, verify, review, checkpoint |

Tier 3 design and execution:

```text
NLA clarification
→ Explorer and optional Scout
→ Architect
→ user approval
→ implementation plan
→ Implementer
→ verification
→ Reviewer
→ Supervisor completion audit
→ checkpoint and acceptance
```

Controlled context recovery:

```text
NLA saves the ledger
→ Supervisor audit
→ Compactor checkpoint
→ OpenCode summarization
→ ledger restoration
→ the same primary session continues
```

Small tasks do not pay for the full workflow. NLA adds agents and gates only when risk and uncertainty justify them.

## Status

**Current maturity: Alpha, active development.** The core workflow, model failover, memory, controlled compaction, restoration, and telemetry have passed real end-to-end tests.

Current limitations include incomplete hard role permissions, no strict Task Context Packet validator, no hard token or monetary budgets, and no transactional installer or resolved-config validator. Controlled compaction requires a persistent OpenCode TUI or server.

Read [Project Status and Usage](docs/PROJECT_STATUS_AND_USAGE.md) for the supported environment, installation model, known limitations, data locations, telemetry, evidence, and focused roadmap.

## Documentation

- [Installation](INSTALL.md): supported Alpha setup for OpenCode.
- [Project Status and Usage](docs/PROJECT_STATUS_AND_USAGE.md): status, limitations, telemetry, storage, evidence, and roadmap.
- [Installation and Testing](docs/NLA_INSTALL_AND_TEST.md): detailed runtime behavior and verification.
- [Original Draft 0.4](TECHNICAL_SPECIFICATION.md): the original product and architecture specification.
- [Draft 0.4 Implementation Status](docs/DRAFT_0_4_IMPLEMENTATION_STATUS.md): what is implemented, partial, absent, or intentionally deferred.
- [NLA Modifications](NLA_MODIFICATIONS.md): the boundary between Superpowers and NLA additions.
- [Superpowers](https://github.com/obra/superpowers): the upstream skills-first development methodology.
- [Assistant Notebook](https://github.com/pickleshell/skills/tree/main/assistant-notebook): the durable fast-memory skill used by NLA.

## History

NLA began as the independent [Next-Level OpenCode Profile Draft 0.4](TECHNICAL_SPECIFICATION.md), a plan for native OpenCode orchestration, risk routing, specialized roles, bounded context, verification, memory, safety, and cost measurement.

While reviewing that plan, I asked Grok to find similar systems. Superpowers was one of several alternatives and the closest ideological match. It showed in practice that skills could turn a general coding agent into a disciplined development pipeline. I installed it, tested it on a simple task, liked the result, and chose it as a practical quick start rather than rebuilding every workflow skill from zero.

Superpowers is the implementation foundation, not the origin of the NLA plan. NLA adds the architecture I wanted for OpenCode: risk tiers, explicit architecture, supervision, model pools, durable memory, controlled compaction, and operational telemetry.

I am now working on multi-agent systems at a different scale. Having a miniature version on my own machine that genuinely completes useful tasks feels like owning a toy robot that actually helps around the house.

## Credits and License

Next Level Agent is built by [PickleShell](https://github.com/pickleshell).

The implementation is based on [Superpowers](https://github.com/obra/superpowers), created by [Jesse Vincent](https://blog.fsck.com) and Prime Radiant. This fork began from Superpowers commit `b36e082`. Attribution and the upstream license are preserved.

Assistant Notebook comes from [pickleshell/skills](https://github.com/pickleshell/skills).

MIT. See [`LICENSE`](LICENSE).
