---
name: planning-parallel-work
description: Use when a substantial software task needs decomposition into dependency-aware, independently verifiable work items and safe parallel execution groups before implementation begins.
---

# Planning Parallel Work

Create an executable task graph from approved requirements and architecture. Plan only; do not edit production code, tests, configuration, or repository state.

## Inputs

Use the available objective, requirements, acceptance criteria, architecture decisions, repository evidence, constraints, and current Git state. Distinguish verified facts from assumptions. If a missing decision changes public contracts, data ownership, security boundaries, or irreversible behavior, expose it as a blocker rather than inventing it.

## Decomposition

Each task must produce one independently reviewable result and include:

- a stable task ID and concise objective;
- exact acceptance criteria covered;
- files or components expected to change;
- interfaces consumed and produced;
- dependencies on other task IDs;
- verification commands and expected evidence;
- risks, unknowns, and explicit non-goals.

Do not create artificial tasks for setup, documentation, or scaffolding when those changes belong to a functional deliverable. Do not combine work that could be independently rejected by a reviewer.

## Parallelism

Mark tasks parallel only when independence is supported by evidence. Parallel tasks must not:

- write the same files or generated artifacts;
- mutate the same database, service, migration sequence, lock, or external resource;
- depend on an interface or decision produced by one another;
- require ordering to preserve compatibility;
- share an exclusive test environment.

Read-only investigation may run in parallel more freely. If independence is uncertain, preserve the dependency and schedule sequentially. Never claim that a parallel group itself authorizes concurrent writes: the coordinator remains responsible for isolated workspaces, dispatch, integration order, and conflict handling.

## Plan Contract

Return a concise plan followed by this machine-readable object:

```json
{
  "goal": "string",
  "assumptions": [],
  "blockers": [],
  "tasks": [
    {
      "id": "T1",
      "objective": "string",
      "acceptance_criteria": [],
      "scope": { "read": [], "write": [] },
      "interfaces": { "consumes": [], "produces": [] },
      "depends_on": [],
      "verification": [],
      "risks": [],
      "non_goals": []
    }
  ],
  "parallel_groups": [["T1", "T2"]],
  "integration_order": [],
  "final_verification": []
}
```

Use an empty `parallel_groups` array when safe concurrency cannot be demonstrated. Every acceptance criterion must map to at least one task and final verification step. Report uncovered criteria explicitly.

## Handoff

The planner proposes the graph; it does not dispatch agents, approve architecture, modify files, or accept the final result. Return the plan to the coordinator for validation and execution.
