---
name: writing-acceptance-tests
description: Use when independent tests must be derived from a specification, public interface, or acceptance criteria before implementation, without writing or relying on production code.
---

# Writing Acceptance Tests

Produce executable tests and test-only fixtures from the contract. Do not implement, repair, or refactor production code.

## Authoritative Inputs

Base tests only on supplied requirements, user stories, issue descriptions, acceptance criteria, and public interfaces such as APIs, CLI commands, protocols, schemas, headers, or documented state transitions. If expected behavior is ambiguous, report the ambiguity; do not infer private implementation details.

Existing source may be read only to discover public entry points, repository test conventions, build commands, and test boundaries. It must not redefine the requested behavior.

## Behavioral Boundary

- Test observable behavior through public APIs, public methods, message contracts, CLI commands, or documented state assertions.
- Do not assert private fields, private methods, incidental call order, internal storage layout, or implementation-specific algorithms unless the specification explicitly makes them contractual.
- Write only tests and test-owned fixtures, stubs, mocks, harnesses, and data.
- Do not change production code, production configuration, migrations, or public contracts.
- Mock external systems at their documented boundary. Prefer real behavior inside the system under test over mocks of internal collaborators.

## Coverage

Cover only behavior justified by the contract, including where applicable:

- the principal successful path;
- boundary values such as empty inputs, zero values, nullability, and documented limits;
- invalid input and specified error behavior;
- timeout, cancellation, retry, or failure behavior when it is part of the contract;
- persistence, idempotency, concurrency, or restart behavior when required by acceptance criteria.

Map every test to one or more acceptance criteria. Identify uncovered criteria instead of inventing expected behavior.

## Isolation and Readability

Tests must be deterministic and independent of execution order. Isolate network services, databases, clocks, randomness, and external processes with explicit test fixtures or boundary doubles. Do not use unexplained sleeps when an observable readiness condition is available.

Name tests as behavioral specifications. Use Arrange-Act-Assert or Given-When-Then consistently with repository conventions.

## RED Validation

Run the narrowest relevant test command and confirm each new test:

1. compiles or loads successfully;
2. reaches its behavioral assertion;
3. fails because the requested behavior is absent or incorrect;
4. does not fail because of syntax errors, broken fixtures, missing imports, accidental environment dependencies, or an unhandled setup exception.

If a test passes immediately, determine whether the behavior already exists or the assertion is ineffective. Do not weaken or distort the contract merely to force RED. If RED cannot be demonstrated safely because required infrastructure or authorization is unavailable, report `NOT_RUN` with the exact prerequisite rather than claiming a valid failing test.

## Output Contract

Return:

```json
{
  "test_files": [],
  "fixture_files": [],
  "criteria_coverage": [
    { "criterion": "string", "tests": [] }
  ],
  "commands_run": [],
  "red_evidence": [
    { "test": "string", "status": "RED | NOT_RUN", "reason": "string" }
  ],
  "uncovered_criteria": [],
  "implementation_handoff": []
}
```

Include concise human-readable notes when needed. The handoff may describe observable behavior the Implementer must satisfy, but it must not prescribe or contain production implementation.

## Stop Conditions

Stop and report rather than modifying production code when the public interface is missing, the specification is contradictory, the permitted test paths are unknown, or valid RED evidence would require an unauthorized external or destructive action.
