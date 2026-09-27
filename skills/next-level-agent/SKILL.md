---
name: next-level-agent
description: Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action** — including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to use it.

**Before entering plan mode:** if you haven't already brainstormed, invoke the brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills (frontend-design, etc.) carry it out. Brainstorming and systematic-debugging are common NLA process skills, but the rule holds for any of them.

- "Let's build X" → brainstorming first, then implementation skills.
- "Fix this bug" → systematic-debugging first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |

## Platform Adaptation

If your harness appears here, read its reference file for special instructions:

- Codex: `references/codex-tools.md`
- Pi: `references/pi-tools.md`
- Antigravity: `references/antigravity-tools.md`
- Hermes Agent: `references/hermes-tools.md`

## NLA Coordination State

These rules apply only to the primary `nla` agent. Subagents must not read or
write the shared notebook.

### Fast durable memory

For substantive work, invoke `assistant-notebook` and use `nla_notebook` once
at session entry, project switch, or after context restoration. Read Contents
and only the relevant subject page. Reuse the recovered context; do not reread
the notebook on every turn. Current user instructions and verified artifacts
override notebook notes. Update only durable verified decisions, preferences,
milestones, blockers, artifact references, and next steps. Never store secrets,
transcripts, large logs, or speculative reasoning.

### Session ledger

Use `nla_state` to replace the complete private workflow ledger after
classification, user approval, a material decision, each milestone, a blocker,
verification, and before completion. Preserve goal, Tier, workflow stage,
acceptance criteria, approved decisions, completed and active work, changed
files, verification evidence, blockers, pending gate, and exact next step.

### Supervisor gates

Supervisor audits a bounded ledger and never edits files, dispatches agents, or
accesses the notebook.

- Tier 3: invoke Supervisor through `nla_task` at the design gate, execution
  gate, material milestones or anomalies, before compaction, and before
  completion.
- Tier 2: invoke Supervisor only after repeated failure, `BLOCKED`, repeated
  `NEEDS_CONTEXT`, scope drift, context pressure, compaction, or a long-running
  milestone.
- Tier 0 and Tier 1: do not invoke Supervisor.

NLA executes the verdict. Supervisor does not control the session directly.

### Context compaction

When the plugin reports context pressure or continuity is at risk, stop
starting large subagent tasks, save a complete ledger, and call `nla_compact`.
Do not emulate `/compact`. The tool saves the ledger immediately, then at the
next safe idle boundary performs a Supervisor audit, creates a Compactor
checkpoint through the model pool, calls native OpenCode session summarization,
and restores the validated checkpoint. This post-response lifecycle requires a
persistent OpenCode TUI/server; one-shot `opencode run` may exit first.
After restoration, continue from `next_step`; consult the notebook only if
durable context is actually missing.

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
