# Next Level Agent

> A skill-driven multi-agent development system for OpenCode that can take a task from the first idea to verified completion.

Next Level Agent (NLA) turns an ordinary coding agent into a small engineering team. It keeps one primary coordinator in the conversation, brings in specialized agents only when the task justifies their cost, survives model failures and context compaction, and leaves evidence you can inspect afterward.

NLA is based on [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent and Prime Radiant. Superpowers supplies the development discipline; NLA adds OpenCode-native orchestration, role-based model pools, architectural and supervisory gates, durable working memory, controlled compaction, and session telemetry.

## Philosophy

> A useful agent should not merely produce code. It should understand the task, choose the right amount of process, finish the work, verify the result, and remember where it was.

NLA is built around a simple idea: skills can change the operating system of an agent. The underlying model remains a general-purpose model, but the workflow around it gives the model roles, checkpoints, independent review, recovery paths, and memory. The result behaves much closer to a real multi-agent system than a single chat with a long prompt.

The priorities are:

1. Correctness and evidence before claims.
2. The smallest workflow that is safe for the task.
3. Fresh, bounded context for specialized agents.
4. Recovery from provider and context failures.
5. Observable behavior instead of invisible orchestration.

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

## How It Works

```text
User
  ↓
NLA — primary coordinator, ledger owner, acceptance owner
  ├─ Explorer — repository and problem discovery
  ├─ Architect — design alternatives and architecture gate
  ├─ Implementer — bounded code changes
  ├─ Reviewer — independent specification and quality review
  ├─ Supervisor — workflow and evidence audit
  └─ Compactor — faithful recovery checkpoint
       ↓
Model pool — preferred model → bounded fallback
```

NLA keeps the user-facing conversation coherent. Specialized roles return reports to NLA rather than taking over the session. The coordinator remains responsible for approvals, sequencing, acceptance criteria, and the final claim of completion.

## Quick Start

NLA currently targets OpenCode and expects provider authentication to be configured in the user's OpenCode profile.

```bash
git clone https://github.com/pickleshell/next-level-agent.git
cd next-level-agent
opencode
```

A healthy session shows the `nla` agent and automatically loads the `next-level-agent` bootstrap skill.

The checked-in [`opencode.json`](opencode.json) is the source of truth for agents, models, compaction, plugins, and skills. Configure role pools in [`config/model-pools.json`](config/model-pools.json).

For installation details, runtime behavior, tests, and log events, read [`docs/NLA_INSTALL_AND_TEST.md`](docs/NLA_INSTALL_AND_TEST.md).

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

- [Original technical specification](TECHNICAL_SPECIFICATION.md) — the initial product brief and architectural requirements.
- [Installation and testing](docs/NLA_INSTALL_AND_TEST.md) — current OpenCode setup and operational behavior.
- [NLA modifications](NLA_MODIFICATIONS.md) — boundary between the Superpowers base and NLA additions.
- [Superpowers](https://github.com/obra/superpowers) — the upstream project and original methodology.
- [Assistant Notebook](https://github.com/pickleshell/skills/tree/main/assistant-notebook) — the durable fast-memory skill used by NLA.

## History

I originally wanted to build this idea at the skill layer myself. Superpowers matched the ideology I was looking for, and I was pleasantly surprised by how far it had already advanced specifically as a software-development pipeline.

I installed it quickly, gave it a simple task, and was generally satisfied with the result. That led to a practical conclusion: why not use it as the starting point? It was already a strong foundation, and it demonstrated something important — skills really can lift an apparently ordinary agent into a genuine multi-agent workflow. That is impressive.

NLA grew from that experiment. The Superpowers discipline remains the base, while NLA adds the pieces I wanted for daily OpenCode work: risk tiers, explicit architecture, supervision, model resilience, durable memory, safe compaction, and enough telemetry to understand what the system actually did.

The original direction is preserved in the [technical specification](TECHNICAL_SPECIFICATION.md). The implementation has evolved through real tasks and failure cases, so the current runtime documentation is authoritative where later behavior differs from that first draft.

I am now working on multi-agent systems at a different scale. Having a miniature version of such a system on my own machine — and seeing it genuinely complete useful tasks from beginning to end — feels like owning a toy robot that actually helps around the house.

## Credits

Next Level Agent is built by [PickleShell](https://github.com/pickleshell).

The foundation is [Superpowers](https://github.com/obra/superpowers), created by [Jesse Vincent](https://blog.fsck.com) and Prime Radiant. NLA began from Superpowers commit `b36e082`; attribution and the upstream license are preserved.

The Assistant Notebook skill comes from [pickleshell/skills](https://github.com/pickleshell/skills).

## License

MIT. See [`LICENSE`](LICENSE).
