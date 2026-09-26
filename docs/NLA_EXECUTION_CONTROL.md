# Durable execution control

NLA uses a small programmatic Execution Monitor, the existing Supervisor and
Reviewer, and the account's private SQLite system database. There is no new
always-running observer model, no MySQL dependency, and no subagent lifetime
or inactivity timeout. This is an Alpha implementation, not a sandbox or a
proof of semantic correctness.

## Storage and restart

Schema version 5 adds:

| Table | Responsibility |
| --- | --- |
| `task_runs` | Task ID, owner/root/child sessions, role, orchestra, directory, bounded criteria, report, revision and outcome |
| `task_attempts` | Exact model binding, attempt order, start/end and reason |
| `task_events` | Cursor-ordered, deduplicated task/tool/recovery/review metadata |
| `task_reviews` | Independent verdict, score attribution outcome and revision; one receipt per target |
| `runtime_events` | Redacted lifecycle/routing/usage/failure log |

Existing model evaluations, registry, usage, orchestras and workflow ledgers
remain in their existing tables. SQL lives behind internal storage functions;
agent tools do not execute arbitrary SQL. This seam permits a future backend
change but does not claim MySQL compatibility today.

Writes occur at state transitions, not only at shutdown. Startup marks tasks
left active by a previous process `recovery_required`; it never silently
replays tools. Directory-scoped plugin instances share a process epoch, so
opening a child in another worktree does not interrupt its parent. The supported
deployment remains one NLA process per Linux account/state directory.
Before upgrading an existing older schema, startup creates a private consistent
SQLite backup `system.sqlite.before-v5` if that backup does not already exist.
Migration is transactional; downgrading the plugin requires a compatible
database/backup, not blindly opening schema v5 with older code.

Historical observations and scores survive new sessions. Automatic review
association is scoped to the original owner session and directory; a new root
can inspect history but does not silently adopt another workflow's task.
A storage failure during managed tool observation aborts the attempt and blocks
automatic failover. Failed terminal persistence is logged rather than represented
as a successful database write. A later startup reconciles abandoned records.

SQLite is authoritative. Set `NLA_LEGACY_RUN_LOG=1` before launch only if an old
consumer still needs `.opencode/agent-run.log` as a compatibility mirror. It is
off by default; normal operation does not write each event twice. New task events
need no file mirror. Database logging failures use private `emergency.log` under the NLA
memory directory. Old file logs are not automatically imported or deleted.

## Task review before dispatch

Every public `nla_task` call, including Explorer, Scout, Architect, Implementer,
Reviewer, Router, Compactor, Browser and a user-requested Supervisor task, first
passes a tool-free Supervisor review. It checks the goal, required inputs,
workspace, scope, constraints, dependencies and verifiable acceptance criteria.
Simple read-only tasks are judged proportionally; no unnecessary design or
human-approval ceremony is required. Criteria can be inline or supplied through
`acceptance_criteria`; separate criteria are now delivered to the worker too,
without truncating or rewriting the original prompt.

The Supervisor returns strict JSON with `verdict` (`approve`, `revise`,
`blocked`), the exact `packet_hash`, `reason` and `issues`. Only approval with
no unresolved issues permits dispatch. NLA corrects an incomplete packet and
submits it again; genuinely missing authority/information requires escalation.
Invalid replies, cancellation, unavailable Supervisor or failed decision
persistence cannot launch a worker. A changed task or orchestra invalidates a
pending approval. The dispatched task keeps its approved pool snapshot.
Model failover for the same task retains that packet and its approval.

`runtime_events` stores `task_admission` requests/decisions; the worker's
`task_events` stores the `task_admitted` receipt linking its hash and Supervisor
task ID. No raw prompt is added to these logs. Inspect admission history with
`nla_status action=log` (and `history=true` for earlier sessions). No new schema
is required. A pending review is not approval, including after a restart;
resubmission receives a fresh check rather than reusing a saved permission.

Internal Supervisor admission, incident, recovery and compaction checks use a
private service path to prevent recursive self-review. There is no public
skip flag, including for legacy result contracts. Browser resource allocation
and utility model requests happen only after admission; Browser's validated
runtime session/permission envelope is appended afterwards by code.

This costs one additional Supervisor assessment per delegation. It is not a
proof that the task is correct, a replacement for result review, or authority
to bypass permissions. It covers `nla_task`, not native OpenCode delegation or
direct coordinator tools. Reviewer scoring currently remains Implementer-only.
Simultaneous admission checks share a short service queue per database to avoid
competing for the same Supervisor binding; admitted workers are not serialized.

## Progress monitoring

The bundled `nla-supervisor-diagnostics` skill defines incident triage and safe
recovery decisions. Primary NLA prepares a bounded packet from `nla_status` and
relevant routing metadata. Runtime injects the skill body into Supervisor's
child contract. Normal Supervisor tasks may independently use `nla_status`,
`nla_models` and project `read`/`grep`/`glob`. The role has no shell, write,
delegation, notebook or settings-mutation tools. Account history is available
through `nla_status(history=true)`; model inspection uses the loaded snapshot,
not an inventory refresh or live model test. Only a live managed Supervisor with
the corresponding capability can call these NLA readers. Raw role impersonation
does not grant access. Automatic progress, argument-repair and pre-compaction
checks remain tool-free with their specialized response formats. Native file
reads retain OpenCode/project permissions; this is not a filesystem sandbox.

The monitor observes tool starts and terminal outcomes. It keeps bounded
in-memory fingerprints of tool arguments/results; raw arguments, tool output,
reasoning and transcripts are not written to the event tables.

- Three identical calls/results produce corrective guidance.
- Six identical calls/results request a confirmed worker stop and a bounded
  tool-free Supervisor assessment. Supervisor may authorize one continuation
  of the same model, switching to another eligible candidate, or blocking.
- At most one such assessment is performed for a task. Continued ambiguity
  returns `recovery_required` to NLA rather than restarting the pool forever.
- The earlier unavailable-tool guard still switches after three distinct
  protocol errors, only after confirmed stop.
- Ordinary test/file errors are not themselves a reason to fail over. Slow
  inference and long tools do not trigger elapsed-time termination.
- Pending/failed tools with possible side effects prevent automatic replay.
  Supervisor/coordinator must reconcile their outcome. Browser's existing
  permission and side-effect checks remain in force.

These are conservative heuristics. Repetition is not proof of failure and a
different tool result is not proof of useful progress. The monitor does not
read hidden model reasoning or continuously inspect all repository files.
Supervisor uses its own configured role pool; a worker's `free`/`local` policy
does not silently reconfigure another role. Worker failover still honors its
original eligibility and policy boundaries.

## Step reports and deviation gates

Managed Scout, Explorer, Architect, Implementer and Reviewer receive `nla_report`
as a control channel in addition to their optimized work-tool shortlist.
Supervisor, Browser, Router, Compactor, raw OpenCode tasks and utility calls do
not receive it. Explicitly tool-free steps also omit this channel. The final
task-result contract remains separate.

```json
{
  "report_id": "step-2-start",
  "kind": "start",
  "step": "Validate durable recovery",
  "summary": "Starting the approved recovery tests",
  "evidence": []
}
```

Kinds are `start`, `completed`, `issue`, `plan_change` and `handoff`. IDs must
remain stable when retrying the same report; a changed claim needs a new ID.
Summaries are bounded to 300 characters, step labels to 100, evidence to ten
tool call IDs. No transcripts, raw output or secrets. Reports are explicitly
`reported_only`, not acceptance or proof that referenced tests passed.

Runtime stores `role_report` in existing `task_events` before assessment;
`role_report_decision` records the outcome before further dispatch is allowed.
These events appear in `nla_status(recent)` and the console reader. The latest
report and its decision also appear in `nla_status` task/summary under
`supervision`; `unresolved` means no durable decision exists, not approval.
Identical reports reuse the decision, including concurrent retries; conflicting IDs are
rejected. A report without a durable decision is not an implicit approval.
Restart keeps the journal and marks interrupted work for reconciliation; it
does not replay the report or tool actions automatically.

Start/completed reports receive a runtime acknowledgement with no Supervisor
model call. Deviations invoke the existing Supervisor with bounded runtime facts,
the original task packet and access to its read-only diagnostic tools. The
worker waits; subsequent tool-before hooks wait at an incident barrier. Roles
must submit deviation reports separately, not in a parallel batch with work.
Already-dispatched tools are not retroactively stopped or rolled back. Unknown
effects block replay even if Supervisor would otherwise permit continuation.

Supervisor returns `continue`, corrective `guidance`, `switch`, `blocked`, or
`handoff`. Decisions grant no new scope or permissions. Switching confirms the
old worker stopped, then uses the existing same-role candidate ordering and
policy. Blocking/handoff stop this task and return to NLA; handoff recommends a
role, never creates a second independent dispatcher. NLA reconciles evidence
and delegates any next step through `nla_task`. Reports and guidance survive
model switching in the child contract and SQLite journal.

One active report assessment per worker, at most three deviation audits and
100 distinct reports per task keep costs and loops bounded. These are not time
limits on subagent work. Supervisor cannot recursively use this channel.
Unavailable/invalid Supervisor output, cancellation or persistence failure
never grants approval. The separate repeated-tool monitor remains active when
a role omits reports. This is event-driven supervision, not continuous model
polling, forced reporting before every tool, or a proof of semantic correctness.

## Final result contract

For Explorer, Scout, Architect, Implementer and untargeted Reviewer tasks,
`nla_task` defaults to `result_contract="evidence"`. Supply a bounded prompt,
an explicit `directory` for another worktree, and preferably
`acceptance_criteria` as a JSON array (up to 20 strings). Include those criteria
in the task packet as well. Example result:

```json
{
  "status": "completed",
  "summary": "Implemented the bounded change",
  "artifacts": ["src/example.js"],
  "checks": [{"claim": "Focused tests passed", "tool_call_id": "call_id_if_known"}],
  "remaining": [],
  "blockers": []
}
```

Other statuses are `blocked` and `needs_context`. Completed reports cannot
contain open blockers/remaining work. Artifact paths must resolve to existing
files inside the delegated directory; symlinks escaping it are rejected. The
runtime checks structure, existence and observed tool IDs, not the truth of
every claim. A completed tool call is not proof that a test passed.

Malformed reports receive one report-only repair request with all tools denied.
The original task packet and child journal are preserved. Failed repair can
advance to remaining eligible models after confirmed stop; prior work must be
inspected, not blindly repeated. Explicit `result_contract="legacy"` preserves
older callers but marks their output `report_unverified`, never accepted.
Utility tasks and native OpenCode `task` are outside this structured-agent-report
contract. Supervisor, Router, Compactor and Browser retain their specialized
contracts.

Outcomes distinguish `report_ready`, `report_unverified`, `blocked`, `failed`,
`cancelled`, `recovery_required`, `review_pass`, `review_unverified` and
`needs_changes`. **Report readiness is not task acceptance.** NLA still owns
semantic acceptance and required workflow gates.

## Independent review and evaluations

Reviewer uses an explicit `review_target_session_id`, or runtime associates it
when exactly one unfinished Implementer review target exists for this owner and
directory. More than one candidate requires an explicit target; runtime does
not guess. The Reviewer receives bounded target metadata, criteria and report,
and must inspect independently. For architecture/design or unrelated reviews,
set `review_scope="general"`; those never select an Implementer scoring target.
It returns:

```json
{
  "verdict": "pass",
  "scores": {"coding": 8, "reasoning": 7, "tool_use": 9},
  "evidence": {"tests_passed": true, "acceptance_criteria_met": true}
}
```

Verdicts also allow `fail` and `needs_changes`. Scores remain 1–10, with stored
zero meaning unknown. Update is `(old + new) / 2`, or the new value when old=0.
The verdict receipt and score update are one transaction. Duplicate reviews
cannot apply the score again, including after plugin recreation.

Quality attribution requires a verifiable unchanged Git content fingerprint
and exactly one contributing model binding across attempts. The fingerprint
includes HEAD, index state, tracked/dirty/untracked file content, modes and
symlink targets; known NLA runtime log/cache files are excluded. Unknown or
oversized snapshots (10,000 paths / 32 MiB bound) skip attribution rather than
guessing. Multi-model work keeps the verdict but skips model-quality updates.
Non-Git tasks still work but currently cannot receive revision-bound quality
attribution. A fresh implementation task supplies a new review target.

`review_pass` additionally requires a structured Implementer report, explicit
criteria and the Reviewer's positive criteria verdict. This is an independent
model verdict, not a formal proof of test correctness or a replacement for NLA
acceptance. Detailed `nla_status task` rechecks the fingerprint and displays
`review_stale` if files changed. Summary/history shows recorded state, not a
fresh audit of every repository.

Reliability retains runtime success/transient-failure observations; caller,
configuration, report and progress errors do not penalize it. Whole child
duration is no longer used for latency. Latency updates only from completed,
tool-free assistant requests with usable OpenCode timestamps and exact binding;
unknown timing leaves scores unchanged. Both scores are higher-is-better.
Explorer/Architect quality scoring is not fabricated without a defined review
procedure.

## Observation tools

Primary NLA can call:

```text
nla_status(action="summary")
nla_status(action="task", task_id="...", history=true)
nla_status(action="recent", after=0)
nla_status(action="log", history=true, after=0)
```

All reads are bounded (maximum 200 records) and do not initialize/migrate or
write the database. `history=true` includes prior root sessions in this account.
The `recent` and `log` cursors are separate monotonically increasing sequences.

Console equivalents, run under the NLA account:

```bash
node /path/to/next-level-agent/scripts/nla-events.mjs --follow
node /path/to/next-level-agent/scripts/nla-events.mjs --runtime --follow
node /path/to/next-level-agent/scripts/nla-events.mjs --task TASK_ID --after 120
```

`--database` selects an explicit existing SQLite file; default is
`$NLA_MEMORY_DIR/system.sqlite` or `~/.local/share/nla/system.sqlite`. Ctrl-C
stops only the reader. No provider is invoked. The stream reads persisted events
every 500 ms; it is not a second logger.

## Verification

`test-nla-execution.mjs` covers persistence/restart, privacy, duplicate events,
rollback of scores and verdict, changed revisions, ambiguous contributors,
report-only repair, automatic review association, status and Supervisor resume.
`smoke-nla-child-contract.mjs` uses real isolated OpenCode with deterministic
localhost models and a separate Git fixture. No paid calls or Core mutations.
Transport-only older fixtures explicitly request legacy reports; structured
report behavior has dedicated tests. Re-run the smoke after OpenCode upgrades.

Run `node tests/opencode/smoke-nla-child-contract.mjs --review` for the additional
real OpenCode path: malformed Implementer report → tool-free repair → independent
Reviewer → persisted quality scores → coordinator `nla_status`.

Run it with `--supervisor` for a real read-only Supervisor investigation:
task status → loaded model pools → fixture file read → diagnostic verdict.

Use `--reports` for worker step reports → incident → Supervisor inspection →
guidance → continuation. `--reports-switch` checks confirmed stop and same-role
fallback with the child history preserved. `test-nla-supervision.mjs` additionally
covers duplicate/conflicting reports, blocked/handoff verdicts, cancellation,
unknown effects and a fault-injected SQLite decision write failure.
