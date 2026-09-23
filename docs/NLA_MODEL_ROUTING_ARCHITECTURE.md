# NLA Model Routing and Empirical Capability Architecture

## Decision

NLA must not rely on public model rankings as evidence of capability. Model
selection uses two distinct data layers:

1. Operator-supplied facts in the model configuration.
2. NLA's own empirical capability and runtime database.

The router may use public benchmarks as context or hints, but never as an
authoritative score for routing.

## Operator-supplied model facts

The static configuration contains only properties that can be verified without
evaluating model quality:

- provider and model identifier;
- context-window size;
- input and output cost;
- availability and schedule;

These facts are hard constraints or cost inputs. They are not subjective
quality ratings.

## Empirical model record

NLA accumulates separate, role-relevant measurements for each exact model
identity and deployment:

- `coding`;
- `reasoning`;
- `tool_use`;
- `reliability`;
- `latency`.

The first evaluation initializes each score. Later evaluations update it with
an exponential moving average using a coefficient of 0.5:

```text
new_score = (old_score + current_score) / 2
```

The MVP stores only the current scores. Detailed evidence from a review may be
used to produce the current scores, but samples, defect statistics, confidence
and raw evaluation history are intentionally deferred.

## Runtime evaluation

The MVP records only evidence that the current lifecycle can attribute safely:

- strict structured Reviewer results for `coding`, `reasoning`, and `tool_use`;
- successful requests and transient provider execution failures for
  `reliability`;
- the elapsed request interval as `latency`.

Health state is a selection filter, not a subjective quality score. New or
unevaluated models remain eligible; select-mode ranking uses the available
static facts and scores, while unknown score dimensions are omitted from the
weighted denominator. Synthetic capability benchmarks are deferred.

## Re-evaluation policy

An evaluated model is not benchmarked again by default. Re-evaluation is
triggered by an inference configuration change, provider or endpoint change,
material result drift, expired freshness policy, new task categories, or an
explicit operator request.

The router must distinguish static facts from dynamic state such as current
health, cooldown, load, latency, and recent error rate. Routing combines hard
constraints with role-specific empirical scores and current runtime state.

## Router behavior

For each task, the router first filters models by availability, context,
required tools/modalities, output constraints, privacy, and budget. It then
scores the remaining candidates using the task's role and requirements. The
choice should be explainable and record the contributing facts, empirical
scores, and runtime state.

Operator model status is an exact-binding control, separate from provider
availability and temporary health. `status: disabled` in registered model facts
excludes that binding from new `fallback` and `select` dispatches without
erasing evaluations or removing pool membership. Missing status defaults to
`enabled`. The private SQLite registry owns the durable operator override;
`nla_models_registry` action `status_set` updates one model at a time. A pool
file may seed `model_facts.<binding>.status`, but later operator status changes
remain authoritative. There is no provider-wide enable/disable switch.
This gate applies to NLA role-pool dispatch; the OpenCode coordinator's own
session model is selected by OpenCode and is not switched by registry status.

This architecture supports both sequential `fallback` pools and `select` pools
where healthy candidates compete by deterministic suitability ranking.

Select ranking has three operator-visible policies. `quality` maximizes the
weighted empirical score. `balanced` combines that score with a pool-relative
normalized cost score using `cost_weight`. `cost` excludes models below
`minimum_score`, then minimizes declared input-plus-output cost. Unknown costs
never beat known costs in the cost-first policy. Policy is independent from
pool mode and may be overridden for one task or changed in the in-memory pool
snapshot by the primary NLA orchestrator.

The production default makes both modes explicit for every role and contains
only `opencode-go/*` bindings. Architect, Explorer, Implementer, and Reviewer
are bounded `select` examples. Architect and Reviewer prefer `quality`; Explorer
and Implementer use `balanced` with a `0.25` cost weight. Deterministic orchestration and utility roles
remain `fallback` pools.

## Evaluation and system storage

NLA keeps runtime relational state in a private user-local SQLite database:

```text
~/.local/share/nla/system.sqlite
```

Versioned migrations create `system_settings`, `model_evaluations`,
`model_registry`, `model_notes`, `model_health`, `session_ledgers`,
`restore_blocks`, and `database_catalog`. This database is the runtime source
of truth for selector scores, model metadata, persistent health, workflow
checkpoints, and fail-closed restore state. The repository configuration remains
portable and does not contain local observations.

On first use, NLA imports a pre-existing
`~/.local/share/nla/model-evaluations.json` if present; otherwise it imports
the versioned production seed at `config/model-evaluations.json`. The import is
one-time: repository updates never overwrite empirical observations. The seed
may initialize provider-independent capability estimates, while
environment-dependent reliability and latency remain `0` until measured.

The seed still uses an inspectable JSON schema with one record per exact model
identity:

```json
{
  "version": 1,
  "models": {
    "fixture/model": {
      "scores": {
        "coding": 0,
        "reasoning": 0,
        "tool_use": 0,
        "reliability": 0,
        "latency": 0
      }
    }
  }
}
```

Records are keyed by model binding. NLA does not run a synthetic benchmark for
an already evaluated model by default, but safely attributable runtime
observations and Reviewer results may update the current scores.

SQLite transactions provide atomic model-score updates. The router continues to
receive the same versioned evaluation object, so storage does not change its
selection interface. Primary NLA may inspect or import registry records with
`nla_models_registry`; the import may be supplied directly as JSON or as a
JSON file within the current project. It never changes pool membership.

`nla_system` provides bounded system administration: read/write non-secret JSON
settings and create named local operator databases and typed tables. It does
not expose arbitrary SQL, credentials, or prompt/response content. Additional
databases are catalogued by `system.sqlite` but remain separate from NLA's
architectural tables. The current tool does not provide row-level CRUD for
those operator tables.

The pool file defines role membership, mode, and initial model facts. SQLite
owns model facts after first registration, so operator imports affect the
selector and are not overwritten by pool reload. Scores and health are also
persistent. `routing.selection_policy.<select-role>` is a typed, persistent
default policy (`quality`, `balanced`, or `cost`); `nla_model_policy` remains
runtime-only. Task-level preferences may override the default, while mandatory
high-risk quality constraints still apply. `operator_databases.enabled` is a
typed switch for creating extra operator databases/tables; `operator.*` is
non-secret metadata, and unsupported operational settings are rejected.

`nla_system` action `schema` exposes the logical table map to the primary NLA.
NLA must use this API rather than rely on hard-coded SQL or table names. Session
ledger and restore-block reads first consult SQLite and lazily migrate their
legacy files only when no DB record exists. Browser recovery is intentionally
not moved: its durable witness, lock and independently verified evidence live
in a filesystem security boundary and remain authoritative for Browser work.

The other `nla_system` actions are `status`, `setting_list`, `setting_get`,
`setting_set`, `database_create`, `database_list`, `table_create`, and
`table_list`. The separate `nla_models_registry` tool supports `list`, `show`,
and `import`. A project-local import file must resolve within the current
project even through symlinks. Existing empirical scores are preserved unless
the operator explicitly requests `overwrite_scores=true`. A malformed legacy
evaluation file fails initial migration before the repository seed can mask it.

## MVP pool selection contract

Each role pool accepts an optional `selection_mode`:

```json
{
  "selection_mode": "fallback",
  "models": ["fixture/first", "fixture/second"]
}
```

The default is `fallback`. It preserves the existing ordered behavior. In
`select` mode NLA removes models that are unavailable, cooling, quarantined, or
already attempted, then ranks the remaining candidates. A failure can select
the next remaining candidate; attempts are bounded by the length of the pool.
There is no separate failover-count setting.

Role weights are explicit 0..10 requirements, with conservative built-in
defaults per role. A pool may override them with `selection_weights`:

```json
{
  "selection_mode": "select",
  "selection_weights": {
    "coding": 10,
    "reasoning": 7,
    "tool_use": 9,
    "reliability": 9,
    "latency": 7
  },
  "models": ["fixture/first", "fixture/second"],
  "model_facts": {
    "fixture/first": {
      "id": "fixture/first",
      "context_window": 131072,
      "input_cost": 0,
      "output_cost": 0,
      "availability": "always"
    }
  }
}
```

Model facts are operator-supplied and are not quality claims. Scores use the
same 0..10 scale, where zero means unevaluated. Unknown dimensions are omitted
from the weighted denominator. The ranking tie-break is higher reliability,
lower known static cost, higher latency score, then original pool order.

The reviewer API accepts only a strict payload with `verdict` and the three
review dimensions `coding`, `reasoning`, and `tool_use`, each from 1 to 10.
Runtime observations update only `reliability` and `latency`. A score is
initialized by the first observation and later updated as:

```text
new_score = (old_score + current_score) / 2
```

The current plugin can prove runtime attribution for a model request because
the selected binding and elapsed request interval are known. It records those
two runtime scores in the local evaluation store. For a Reviewer `nla_task`,
the caller may provide `review_target_session_id`. NLA accepts the strict
structured verdict only when that ID is a completed Implementer child in the
current parent session and the internal registry has its exact producing
binding. A successfully attributed target is consumed, so it cannot be scored
repeatedly or supplied by an arbitrary session. Missing targets and malformed
verdicts leave target scores unchanged; normal Reviewer output is still
returned. NLA never infers attribution from prose.

The selector is used both by direct `nla_task` dispatch and by event-driven
child-session failover. The latter uses the observed child model when OpenCode
provides it, tracks every attempted binding, and never retries a binding that
has already been dispatched even if its cooldown expires. If OpenCode does not
provide the initial model, NLA avoids attributing runtime quality to that
unknown binding and still excludes the configured current binding from a
select-mode retry.

`nla_task` may provide strict JSON `selection_weights` containing only the five
score dimensions, each from 0 to 10. These task weights override role defaults
for that dispatch; absent weights use the role defaults. An explicit positive
`context_window` requirement is a hard filter: a model without declared
`model_facts.<binding>.context_window` is rejected. Declared availability
windows are also validated and enforced.

Runtime reliability is recorded only for successful requests or transient
provider execution failures. Caller cancellation, permission/application
errors, child-stop failures, browser verification blocks, and provider
configuration/authentication failures do not lower a model's reliability.
