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

This architecture supports both sequential `fallback` pools and `select` pools
where healthy candidates compete by deterministic suitability ranking.

## Evaluation storage

Empirical model evaluations are stored in a user-local runtime state file,
not in the repository or the static model configuration:

```text
~/.local/share/nla/model-evaluations.json
```

The initial format is JSON because it is easy to inspect, back up, and migrate.
The file contains a schema version and one record per exact model identity:

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

Writes must be atomic, using a temporary file followed by rename. Concurrent
writers require a lock. If evaluation history or write concurrency outgrows
the JSON implementation, the storage layer may migrate to SQLite without
changing the router's evaluation interface.

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
