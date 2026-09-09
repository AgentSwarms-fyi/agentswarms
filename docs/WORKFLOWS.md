# Workflows

> Part of the [AgentSwarms docs](../README.md#documentation).

One graph over work that used to keep four separate clocks. Open
**Data & BI → Workflows** (`/workflows`).

A workflow's steps are things the platform can already run — an ETL pipeline,
a SQL model build, an ML schedule, a notebook — and its arrows mean _after_.
A step starts when everything it waits for has succeeded, steps that nothing
orders run at the same time, and a step whose dependency failed is not run at
all. Nothing new executes here: a workflow only decides **when**, and records
what happened as one run instead of four unrelated ones.

## Why a chain was not enough

A pipeline could already name SQL models and ML schedules to start when it
succeeds (`etl_pipelines.chain_sql_models`, `chain_ml_schedules`; see
[ETL pipelines](./ETL_PIPELINES.md)). That still works, and for a line it is
the simpler thing.

But a chain **is** a line. It cannot fan out to three things that run at once,
and — the part that actually bites — it cannot fan **in**. "Retrain only after
both the orders pipeline and the customers model have finished" is not
expressible as a chain, so the workaround is to stagger cron times and hope the
first is done before the second starts. That hope is what a workflow removes.

## The four kinds of step

| Kind          | What it starts                                   | Poll target                                                      |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `pipeline`    | `startEtlRun(pipeline, "chain")`                 | `etl_runs.status`                                                |
| `sql_models`  | `buildSqlModels({ selected, trigger: "chain" })` | `sql_model_runs.status`                                          |
| `ml_schedule` | `runMlSchedule(schedule, "workflow")`            | `ml_training_jobs` or `ml_predictions`, by the schedule's `kind` |
| `notebook`    | `startSession({ kind: "batch" })`                | `notebook_runtime_sessions.status`                               |

`sql_models` carries model **names**, and an empty list means every active
model — the same three-state convention a pipeline's chain already uses,
because "build everything" is the common case and a graph should not have to
list models it did not write.

### One vocabulary, four dialects

The subsystems do not agree on words. An ETL run is
`succeeded | failed | cancelled`; a SQL model build is
`success | partial | error`; a notebook sandbox is
`succeeded | error | stopped`. `src/utils/workflows/adapters.server.ts`
normalises all of it in one place, next to the reasons:

- **A `partial` model build is a FAILURE.** Partial means at least one model
  failed and everything downstream of it was skipped, so the tables the next
  step is about to train on are stale. Calling that green is exactly the silent
  staleness a workflow exists to prevent.
- **A run row that has vanished is a failure**, not "still running". Treating a
  missing row as pending is how a workflow waits forever on something that was
  deleted under it.
- **An ML schedule's id is polymorphic** — a training job for a retrain, a
  prediction for a batch predict — so the kind travels with the id
  (`retrain:<id>` / `batch_predict:<id>`) and the poller never has to re-read a
  schedule row that may be gone.

## Files

| File                                      | What it holds                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflows.ts`                    | The pure model: `topoOrder`, `levels`, `readyNodes`, `skippableNodes`, `runOutcome`, `validateWorkflow`, `autoLayout`. No React, no database. |
| `src/utils/workflows/adapters.server.ts`  | Start and poll one step, per kind, with the status vocabularies normalised.                                                                   |
| `src/utils/workflows/run.server.ts`       | `startWorkflowRun`, `advanceWorkflowRun`, `cancelWorkflowRun`, and the two sweep halves.                                                      |
| `src/utils/workflows.functions.ts`        | Owner-scoped server functions over `workflows`, `workflow_runs`, `workflow_node_runs`.                                                        |
| `src/routes/_authenticated/workflows.tsx` | The canvas, the step editor and the run view.                                                                                                 |

## How a run advances

`advanceWorkflowRun` does four things, in this order, and the order is the
design:

1. ask each running step whether its work has finished,
2. mark the steps that can now never run as **skipped**,
3. start the steps whose dependencies are satisfied,
4. if nothing is left, write the run's outcome.

Polling rather than callbacks, deliberately. Each subsystem already finalises
its own run row from its own path, and hooking a fifth thing into each of those
is four places to forget. Reading the row the subsystem already wrote is one
place, and it also covers the case those callbacks cannot: a run whose sandbox
died without ever calling back.

**Every step start is claimed** with a conditional update
(`… .eq("state", "pending")`), the same idiom the pipeline sweep uses, so
several app replicas can take this pass at once without starting a step twice.
The scheduler claim is the clock advance, exactly as elsewhere.

### `skipped` is not a failure

A step that never ran because its dependency failed tells you nothing about
itself, and folding the two together makes a run report say four things broke
when one did. The whole branch below a failure is skipped, transitively —
skipping only the direct children would leave their children pending forever,
and a run that never ends is worse than one that reports honestly.

**Carry on if this step fails** (`continueOnFailure`) reverses that for one
step: its children run anyway. For the step that refreshes a dashboard, not the
one that loads the data. A step that was itself _skipped_ never satisfies its
children whatever its flag says — it did not run.

### The run's own outcome

A run with any failure is failed, even when later steps succeeded around it.
Calling it green because the last step it reached was fine is how a broken
nightly load goes unnoticed for a week. A skip alone is not a failure.

## Guarantees and limits

- **One run at a time per workflow.** Two runs of the same graph would start
  the same pipeline twice and race each other's tables, and the second would
  report a failure caused by the first.
- **The graph is pinned onto the run.** A workflow can be edited while a run is
  in flight; a run whose steps no longer match what ran is evidence of nothing.
  Same reason an ETL run pins its source code.
- **Cycles are refused at save**, and at the moment the arrow is drawn — a
  cycle is the one graph the runner could never finish.
- **Cancel** stops anything that has not started. Work already in flight keeps
  its own life: the pipeline or training job it started is not killed.
- **Owner-only.** `workflows` carries RLS on `auth.uid() = user_id`, run tables
  are SELECT-only for the owner (the server writes them), and every server
  function re-resolves the caller. A graph that could start work its viewer
  cannot see would be a way around every grant the platform has, so sharing one
  is a larger change than adding a policy.
- **Audited**: `audit_row_change('workflow')` on name, graph, schedule and
  active.

## Scheduling

Workflows ride the one platform sweep (`runCronPass`, every 60 s), in two
halves — `processDueWorkflows` starts what is due, `advanceLiveWorkflowRuns`
moves what is already running. Both are counted in the pass result
(`workflow_runs`, `workflow_steps`). Opening a live run also advances it, so a
manual run visibly moves while somebody watches rather than appearing frozen
for up to a minute.

| Setting                         | Default | What it does                                                                                                                                                                                                           |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_STEP_TIMEOUT_MINUTES` | 240     | How long a step may stay running before the workflow gives up on it. A backstop for a sandbox that vanished without reporting, not a cap on the work — the pipeline, training job and notebook each enforce their own. |
| `WORKFLOW_RUNS_PER_SWEEP`       | 20      | How many due workflows are started, and how many live runs advanced, per sweep.                                                                                                                                        |

## Tables

| Table                | Holds                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `workflows`          | The graph, the schedule, active, and the last run's status.                                     |
| `workflow_runs`      | One run: state, trigger, the pinned graph, timings.                                             |
| `workflow_node_runs` | One step of one run: state, the id of the run it started in the other subsystem, and its error. |

`workflow_node_runs.node_id` is the node's id inside the pinned graph, not a
foreign key: the workflow's own nodes may be renamed or deleted afterwards and
this row still has to describe what ran. `target_run_id` is what makes a red
step link to the log that explains it rather than just saying "failed".
