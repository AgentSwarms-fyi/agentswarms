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

## The fifteen kinds of step

Nine of them start work the platform already knows how to do. Two reach
outside it. Four are control flow, which every orchestrator has to own itself
because it is about the graph rather than about any one system.

### Work

| Kind                | What it starts                                       | How it is watched                                                      |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `pipeline`          | `startEtlRun(pipeline, "chain", params)`             | polls `etl_runs.status`                                                |
| `sql_models`        | `buildSqlModels({ selected, trigger: "chain" })`     | polls `sql_model_runs.status`                                          |
| `sql`               | `runLakehouseStatement(userId, sql)`                 | detached; settles its own step                                         |
| `prep_flow`         | `refreshPrepFlowServer(flowId)`                      | detached                                                               |
| `ml_schedule`       | `runMlSchedule(schedule, "workflow")`                | polls `ml_training_jobs` or `ml_predictions`, by the schedule's `kind` |
| `notebook`          | `startSession({ kind: "batch" })`                    | polls `notebook_runtime_sessions.status`                               |
| `swarm`             | `executeSwarmServer(...)` on the **published** graph | detached                                                               |
| `dashboard_refresh` | `refreshDashboardServer(dashboardId)`                | detached                                                               |
| `data_monitor`      | `runDataMonitor(monitor, "pipeline")`                | detached                                                               |

### Reaching outside

| Kind     | What it does                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `http`   | One request through `safeFetch`, with SSRF guards and `{{secret:NAME}}` resolved server-side. Any 2xx is success unless you name the statuses. |
| `notify` | An in-app notification, mirrored to whatever notification integrations are connected.                                                          |

### Control flow

| Kind           | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `condition`    | Evaluates one comparison and takes the `true` or `false` arrow out of it. |
| `wait`         | Pauses for a fixed number of seconds, up to a day.                        |
| `approval`     | Raises a request in the approvals inbox and waits for a person.           |
| `sub_workflow` | Runs another workflow whole, and waits for it.                            |

### Three shapes of work, and why the difference matters

- **Polled** — the subsystem records its own run row, so the step stores that
  id and reads it back.
- **Immediate** — the work is over before the call returns (a condition, a
  notification, an HTTP request).
- **Detached** — the call resolves only when the whole job is done, which can
  be minutes. The step is started without awaiting and settles itself. If the
  process holding that promise dies, nothing will ever settle it, which is
  exactly what the timeouts below are for.

### One vocabulary, several dialects

The subsystems do not agree on words. An ETL run is
`succeeded | failed | cancelled`; a SQL model build is
`success | partial | error`; a notebook sandbox is
`succeeded | error | stopped`; a swarm is `success | error | suspended`.
`src/utils/workflows/adapters.server.ts` normalises all of it in one place,
next to the reasons:

- **A `partial` model build is a FAILURE.** Partial means at least one model
  failed and everything downstream of it was skipped, so the tables the next
  step is about to train on are stale.
- **A data monitor's ALERT is a failure.** That is the point of putting one in
  a graph: it stops what comes after it when the data is wrong.
- **A run row that has vanished is a failure**, not "still running". Treating a
  missing row as pending is how a workflow waits forever on something deleted
  under it.
- **A swarm that parks at an approval is a failure.** An unattended run has
  nobody to ask.
- **A dashboard refresh with a broken widget is a SUCCESS**, and deliberately
  the opposite of the partial model build above. The dashboard did update, and
  nothing downstream reads a widget the way a model reads a table — but the
  failures are recorded in the step's output rather than swallowed, so the run
  view shows which tiles did not come back.
- **An ML schedule's id is polymorphic** — a training job for a retrain, a
  prediction for a batch predict — so the kind travels with the id
  (`retrain:<id>` / `batch_predict:<id>`).

## Trigger rules — when a step is allowed to start

Airflow's names, deliberately: an operator who knows one orchestrator should
not have to learn a second vocabulary for the same three ideas.

| Rule                    | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `all_success` (default) | Every parent succeeded.                                                                    |
| `all_done`              | Every parent finished, however it finished. The rule for a cleanup or a notification step. |
| `one_success`           | Any one parent succeeded. Starts as soon as the first lands.                               |

An `all_done` step is never skipped for an upstream failure — waiting for
everything to finish is the whole point of it. A `one_success` step is skipped
only once **every** parent has finished without one succeeding.

## Branching

A `condition` step evaluates one comparison and takes one arrow out of it. The
first arrow you draw from it is the `true` branch and the second the `false`
one; the canvas colours them green and red and labels them.

**You do not write the comparison; you assemble it.** The step editor gives
three controls — _this_, a test, _that_ — where each side is either one of the
workflow's declared parameters or a value you type, and the test is said in
words (`is`, `is not`, `is more than`, `is at least`, …) rather than in
symbols. There is no syntax to get right and no notation to learn.

What is stored is still one small string (`{{ params.rows }} >= 100`), because
a string is what a run record can carry and what a diff can show.
`formatCondition` and `parseCondition` in `src/lib/workflows.ts` move between
the two without loss, and both they and the evaluator split the expression with
**one** shared function — a step that displayed one comparison and ran another
would make every guarantee the builder offers worthless.

The comparison is split **before** parameters are filled in, and quoted values
are respected. Splitting afterwards meant a parameter whose value happened to
contain `>` or `==` silently rewrote the comparison it was supposed to be an
operand of.

It is not a language, and that is the point. An orchestrator that lets a branch
run arbitrary code has handed the graph the ability to do anything; anything
more complicated belongs in a SQL step or a notebook, where it is visible as
work.

Everything on the branch that was not taken is marked **skipped**, transitively.
A step downstream of both branches usually wants `one_success`.

## Parameters

A workflow declares parameters with defaults; a run may override any of them,
and the resolved set is **pinned onto the run** so what it used stays readable
after the defaults change.

`{{ params.name }}` is filled into a SQL statement, an HTTP URL, header or
body, a condition, a notification and a swarm's input. Nobody types that
spelling: every field that accepts a parameter carries a **Parameter** button
that inserts one at the cursor, and a condition picks parameters from a list. An unknown name is left
**as written** rather than replaced with an empty string — a SQL statement that
silently loses its date filter and scans all history is worse than one that
fails with the placeholder still visible in the error.

Parameters are also handed to an ETL pipeline step, so a pipeline that takes a
date window gets the run's window rather than its own default.

## Nothing in the editor asks for a notation

A step is configured by making choices. Three things used to be small
languages, and each is now a control that can only produce something valid:

| Was                                                | Is                                             |
| -------------------------------------------------- | ---------------------------------------------- |
| A condition typed as `{{ params.x }} == true`      | Two side pickers and a test said in words      |
| Headers typed as `Name: value` lines, one per line | A row per header, each with a name and a value |
| Models typed as a comma-separated list             | The active models, ticked                      |

The header value is where this matters most. It used to invite somebody to
type `{{secret:CI_TOKEN}}` from memory; now the row offers **A value I type**
or any secret **by name**. Only names ever reach the browser — the value is
resolved server-side at run time, and the secret list is `select("name")`.

A model that is selected but has since been deleted still appears in the list,
ticked and flagged, rather than vanishing from the step that depends on it.

What stays free text is text that really is text: a SQL statement, a
notification, a question for a person, a JSON body.

## Retries and timeouts

Each step carries `retries` (attempts after the first, up to 10) and
`retryBackoffSeconds` (doubling each attempt, capped at an hour). A retry
**reuses the same row**, incrementing `attempt`, so a step stays one line in the
run view however many times it was tried — one logical step, one place to look.

Three ceilings, each for a different failure:

| Ceiling                          | Default                               | Catches                                                            |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| A step's own `timeoutMinutes`    | `WORKFLOW_STEP_TIMEOUT_MINUTES` (240) | A sandbox that vanished, or a detached promise whose process died. |
| The workflow's `timeout_minutes` | 720                                   | A graph that is somehow still open with nothing moving.            |
| The subsystem's own limit        | its own                               | The work itself running long.                                      |

## Starting a run from outside

`POST /api/workflows/run` with a bearer token minted per workflow:

```bash
curl -X POST "$APP_ORIGIN/api/workflows/run" \
  -H "Authorization: Bearer wfk_…" \
  -H "Content-Type: application/json" \
  -d '{"workflow_id":"…","params":{"day":"2026-01-01"}}'
```

The token is stored as a SHA-256 hash and the plaintext is shown once, exactly
as an ETL pipeline's trigger token is. "No such workflow", "no token minted"
and "wrong token" all answer one undifferentiated **404**, so a caller holding a
valid token for one workflow cannot enumerate the ids of the others. Rate
limited by `WORKFLOW_TRIGGER_PER_MIN` (default 6), globally rather than per
process so the ceiling holds across replicas.

## Who may run it, and what gets recorded

### Ownership

A workflow belongs to one person. Every server function resolves the caller
from their access token and scopes the query by `user_id`, and there is no
`workflow` grant type in `iam_resource_grants` — orchestration is not shared,
the same way an ETL pipeline is not.

**A step can only point at something you own.** `missingTargets` re-checks
every `targetId` in the graph against the owning table on save, and the
adapters check ownership _again_ at run time through `owned()`. Two checks
rather than one, because a pipeline can be deleted or transferred between
saving a workflow and running it, and a graph that keeps executing against
something that is no longer yours is the failure worth preventing.

The named SQL models get the same treatment: `a workflow can only build models
you own`.

### The audit trail

Two writers, and the split is deliberate.

**The database writes the row changes.** `audit_workflows` is a trigger on the
`workflows` table, so a create, a delete or a change to the shape of a workflow
is recorded even by a write that never went through the app:

| Action            | Written when                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `workflow.create` | A workflow row is inserted                                                  |
| `workflow.update` | `name`, `graph`, `schedule`, `is_active`, `cron_expr` or `timezone` changes |
| `workflow.delete` | The row is deleted                                                          |

`cron_expr` and `timezone` were added to that list in
`20260896000000_workflow_audit_columns.sql`. Without them, moving a workflow
from "07:00 on weekdays" to "every minute" — or from `Europe/London` to `UTC`,
which shifts every run by an hour — changed when work ran across the platform
and left no audit row at all, because `schedule` read `cron` on both sides.

**The app writes what the database cannot see.** A run is not a row change on
`workflows`, and neither is a refused bearer token:

| Action                          | Written when                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow.run`                  | A run **starts**, with `trigger` (`manual`, `schedule`, `api`, `rerun`, `workflow`), the parameter names, and the parent run or the run it re-runs |
| `workflow.run.finished`         | A run closes, with its outcome and error                                                                                                           |
| `workflow.run.cancel`           | Somebody cancels a live run                                                                                                                        |
| `workflow.trigger_token.rotate` | A bearer token is minted — the trigger does not watch `trigger_token_hash`                                                                         |
| `workflow.trigger_token.revoke` | One is revoked                                                                                                                                     |
| `workflow.trigger.denied`       | A bearer token was **refused** against a workflow that exists                                                                                      |

Two decisions worth knowing:

- **The run event is written inside `startWorkflowRun`, not at each caller.**
  A run started by the scheduler, by the API, or by a parent workflow is
  recorded on exactly the same terms as one somebody clicked. `trigger` is the
  column that tells them apart, and `trigger: "api"` means a bearer token was
  accepted.
- **A refused trigger is audited to the workflow's owner**, the same class of
  signal as an embed or swarm API-key denial, and styled as such in the audit
  log. Nothing is written when the workflow does not exist — there is no owner
  to tell, and the caller learns nothing either way because the answer is the
  same undifferentiated 404. The presented token is never recorded; only the
  reason (`wrong token` / `no token minted`). The write does not block the
  refusal, so both paths take the same time.

**The handlers do not re-emit the three trigger actions.** Doing so produced
two rows per save with the same action name and different detail shapes, which
is worse for an auditor than either alone.

### Logs

A workflow step is a remote control, not the machine. When a model build
fails, the reason is in the build's own log — so each step in the run view
carries a link to where its work keeps its logs, plus the first eight
characters of the run id to correlate against.

| Step           | Goes to                                                    |
| -------------- | ---------------------------------------------------------- |
| `swarm`        | `/analytics/observability/<run id>` — a real per-run trace |
| `pipeline`     | `/etl`                                                     |
| `sql_models`   | `/sql-models`                                              |
| `ml_schedule`  | `/ml`                                                      |
| `notebook`     | `/notebooks`                                               |
| `sub_workflow` | `/workflows`                                               |

Only a swarm run has a page of its own today; the rest link to the page that
owns the run rather than to a route that would 404. Detached work (a SQL
statement, a prep flow, a dashboard refresh, a data monitor) never had a run
row to point at, so those steps show their output inline instead.

## Files

| File                                           | What it holds                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflows.ts`                         | The pure model: `topoOrder`, `levels`, `readyNodes`, `skippableNodes`, `runOutcome`, `validateWorkflow`, `autoLayout`. No React, no database. |
| `src/utils/workflows/adapters.server.ts`       | Start and poll one step, per kind, with the status vocabularies normalised.                                                                   |
| `src/utils/workflows/run.server.ts`            | `startWorkflowRun`, `advanceWorkflowRun`, `cancelWorkflowRun`, and the two sweep halves.                                                      |
| `src/utils/workflows.functions.ts`             | Owner-scoped server functions over `workflows`, `workflow_runs`, `workflow_node_runs`.                                                        |
| `src/routes/_authenticated/workflows.tsx`      | The canvas, the toolbar, the settings and the run view.                                                                                       |
| `src/components/workflows/WorkflowPalette.tsx` | The grouped step palette down the left.                                                                                                       |
| `src/components/workflows/StepInspector.tsx`   | Per-kind configuration, and the retry/trigger settings every kind shares.                                                                     |
| `src/components/workflows/inspectorFields.tsx` | The condition builder, the header rows, the model ticks, and the parameter-inserting text fields.                                             |
| `src/components/workflows/nodeStyles.ts`       | One colour and icon per kind, shared by the canvas, the palette and the run list.                                                             |
| `src/routes/api/workflows.run.ts`              | The external trigger.                                                                                                                         |

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

A workflow runs **manually**, on one of four coarse schedules (hourly, daily,
weekly), on a **cron expression with a timezone** (`0 7 * * 1-5` in
`Europe/London`), or from the API above. An expression that stops parsing does
not wedge the sweep for everyone else — that workflow simply stops being
scheduled, which its `next_run_at` makes visible.

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
