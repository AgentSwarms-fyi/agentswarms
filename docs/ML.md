# Machine learning: registry, training, predictions, forecasting

> Part of the [AgentSwarms docs](../README.md#documentation).

Train a model on a lakehouse table without writing code, keep every version
with its metrics and the snapshot it learned from, score rows back into the
lakehouse, let agents predict with it, and draw its forecasts on a dashboard.
Everything runs on your infrastructure: training and inference execute in the
notebook runtime's batch sandboxes, artifacts live in your object storage, and
a model is governed like every other resource — owner-only, shareable through
IAM, audited by trigger, with a decision id and a passport.

## What it is

- **Registry** — `ML Models` under **Data & BI**: every model you own or were
  granted, its production version's headline metric, what it predicts from,
  and whether something is training right now.
- **Training** — a four-step wizard (data, goal, options, review) drives a
  batch sandbox that profiles the table, tries several algorithms under a
  time budget and keeps the best one with its metrics, leaderboard and
  feature importance.
- **Versions and stages** — each training run is a version: `candidate`,
  `staging`, `production` or `archived`. The first successful version is
  promoted automatically; later ones are promoted by hand. Production is
  exclusive per model and is what agents and dashboards use.
- **Predictions** — a try-it form for one row, a batch run that scores a
  whole lakehouse table into a new table you own, and an `ml_predict` tool
  for agents.
- **Forecasting** — time-series models whose projected periods can be drawn
  on a BI line chart and watched by a forecast-basis alert.

## Tasks

| Task              | What it needs                                    | Candidates tried                                                                                          | Primary metric |
| ----------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------- |
| Classification    | category, boolean, small-domain target           | logistic regression, random forest, histogram gradient boosting, LightGBM                                 | F1 (macro)     |
| Regression        | number target                                    | ridge, random forest, histogram gradient boosting, LightGBM                                               | RMSE           |
| Forecast          | number target over a date column, a period       | last value, moving average, seasonal naive, Holt-Winters (statsmodels), gradient boosting on lag features | RMSE           |
| Clustering        | feature columns only                             | k-means for two to ten groups (or a fixed k), kept by silhouette                                          | Silhouette     |
| Anomaly detection | feature columns only                             | isolation forest (200 trees); 2% flagged unless a share is given                                          | Anomaly rate   |
| Recommendation    | a user column, an item column, optional strength | item-item cosine similarity on the interaction matrix; popularity for cold starts                         | Hit rate @10   |

The first three predict a chosen column. Clustering and anomaly detection
have no target: they describe the rows from the selected features and report
a profile of every group or a score per row. Recommendation learns from
interactions — one row per user and item, optionally weighted by a rating, a
quantity or an amount — and is scored by hit rate on one held-out interaction
per user. Free-text columns (average length twenty characters or more) become
TF-IDF features (words and bigrams, a thousand terms at most) for every task
instead of being dropped; clustering and anomaly detection compress them to
twenty dense components so a text column cannot swamp the numbers.

The wizard suggests a task from a real profile of the table (`SUMMARIZE` plus
a sample): a float column is never mistaken for an identifier because its
values are unique, an integer column named `customer_id` is, and a constant
column cannot be a target at all.

## Prepare a training set

The wizard's **Prepare the data** panel filters rows and fills, scales and
encodes columns for one model. For the wrangling that comes before that —
joins across tables, dedupe, split and replace, pivots, derived columns,
aggregation — use **BI → Data preparation** with lakehouse tables: link the
tables, build the steps with a per-step preview, and **Save as → lakehouse
table**. The result is an ordinary lakehouse table in a schema you own,
rebuilt on the flow's schedule, and it appears in the wizard's table picker
at once. See [BUSINESS_INTELLIGENCE.md](./BUSINESS_INTELLIGENCE.md).

## Train a model

1. **Data** — pick a lakehouse table you own or that was shared with you. The
   profile shows each column's kind, distinct count, nulls and samples.
2. **Goal** — _predict a column_ (the task follows from the column; a
   forecast additionally takes a time column, the **period** - hourly,
   daily, weekly, monthly, quarterly, or automatic from the dates - the
   periods ahead and how rows in one period combine), _find groups_ (a fixed number, or the best of two
   to ten by silhouette), _find anomalies_ (the share you expect, 2%
   unless told otherwise), or _recommend items_ (a user column, an item
   column and an optional strength such as a rating or an amount).
3. **Options** — name, description, features (identifier-like and constant
   columns are off by default), and **Prepare the data**:
   - a **row filter** (SQL `WHERE`) or, for joins and derived columns, a
     **custom `SELECT`** — **Check** runs it through the lakehouse guard as
     you, before any sandbox starts, and reports how many rows match;
   - how missing numbers and categories are filled, whether numbers are
     standardised, one-hot or ordinal encoding, balanced class weights for
     classification, winsorised targets for regression;
   - **hyperparameter tuning**: none, a quick search (six random trials,
     three-fold, on the two best candidates) or a thorough one (twenty
     trials, five-fold) — run while at least 40% of the budget remains, and
     kept only when the tuned model beats the untuned one on the holdout;
   - the time budget and the row limit (larger tables are reservoir-sampled,
     and the version says so).
4. **Review** and **Train**. The model page shows the job's streamed logs
   while it runs, and metrics the moment it finishes.

Training happens in an isolated sandbox that reads the table as of the
current lakehouse snapshot. The version records that snapshot and a decision
id, so what the model learned from can be shown later, and the run is
audited (`ml.train.start`, `ml.train.succeeded` / `ml.train.failed`,
`ml.version.promote`). The serialised pipeline is written to
`ml-artifacts/<model>/v<n>/model.joblib` in the lake bucket — outside the
DuckLake data path, so orphan-file cleanup can never delete a model — and
its SHA-256 is recorded; inference refuses an artifact whose bytes do not
hash to it.

### A search across several sandboxes

A training job tries several algorithms and then tunes the best of them, and by
default it does all of that inside **one** container, one candidate after
another. Set **Search workers** under **Admin → Developer runtime** (or
`ML_TRAIN_WORKERS`) above 1 and the search is dealt out instead: worker _w_ of
_n_ takes candidates _w_, _w+n_, _w+2n_…, trains and tunes only those, and the
job keeps whichever worker's model scored best.

**A single model still trains in one container.** Nothing here splits one fit
across machines — that needs a distributed framework and a cluster, and a model
that does not fit in one sandbox's memory still does not fit. What this buys is
wall-clock on the search, which is where the wizard's time actually goes.

Three things bound it, and the job takes the smallest:

- **Only classification and regression have a search to split.** Clustering
  picks its `k` values from the row count and forecasting picks its methods
  from the shape of the series, both at runtime inside the sandbox, so the
  server cannot hand a worker "its" candidates. Those tasks run in one
  container, as they always did.
- **Never more workers than candidates.** Four algorithms and eight workers
  means four workers; an idle sandbox still costs a container start.
- **Never more than the runtime lets one person hold.** Sessions per user
  (3 by default) is the ceiling that actually bites, and it counts the
  notebooks that person has open too. A job takes fewer workers rather than
  failing to start the extras.

Each worker uploads its own artifact and the job keeps the winner's. Ties break
on the lowest worker number, so re-running the same job on the same data picks
the same model.

**A split search is not the same search.** Tuning runs per worker, on that
worker's own best candidates, so four workers tune more models than one
container would have — and a distributed job can land on a different winner
than a single-container job on identical data. That is usually a better search
rather than a worse one, but it means the two are not comparable runs, and a
model whose exact reproduction matters should be trained with the same worker
count every time.

**A worker that dies does not lose the job.** Three of four finishing still
produces a model — the leaderboard is merged from every worker that reported,
each row keeps the worker that ran it, and the version's warnings say plainly
how many workers did not come back and what the ones that failed said. A job is
only failed when _every_ worker failed.

## Read the results

- **Metric tiles** — the primary metric first (F1 macro, RMSE), then
  accuracy, ROC AUC, log loss, MAE, R², MAPE as the task allows.
- **What the model relies on** — permutation importance on the holdout set:
  how much the score drops when a column is shuffled. It names the columns a
  person recognises, not one-hot fragments.
- **Groups** (clustering) — every group's size and share with its typical
  row: the mean of each number, the most common category.
- **Confusion matrix** (classification), **forecast chart** with history,
  projection and a residual-based band (forecast).
- **Leaderboard** — every candidate tried, scored on the same holdout, with
  fit time and status; tuned candidates appear with their trial counts.
- **Lineage** — algorithm, rows (and whether sampled), lakehouse snapshot,
  decision id, artifact digest, warnings such as dropped columns.
- **Model card** — one Markdown document assembled from the registry rows
  (intended use, training data and snapshot, preparation, features and
  dropped columns, metrics and leaderboard, importance, groups, warnings,
  governance, how to call it), copied or downloaded from the model page; it
  cannot drift from what shipped because nobody types it.

### What the trainer warns about

A score can be right and still mislead. The trainer checks for the usual
ways and writes what it found on the version: the Versions tab counts them
as **notes** on every version and opens them in place, the compare view
lists them side by side, and the model card, the agent's prediction tool
and the public API's model listing repeat them:

- **Possible leakage** — a single feature that predicts the target almost
  perfectly on its own (98% balanced accuracy, or 98% of a numeric target's
  variation) is usually the target in disguise: a code for it, a column
  filled in after the fact, a key the model memorises. The warning names the
  column; if it is derived from the target or unknown at prediction time,
  leave it out of the features and train again.
- **The do-nothing baseline** — when nine rows in ten share one class, that
  share is the accuracy of predicting it every time. The warning says so and
  points at F1 (macro), the primary metric, and the confusion matrix.
- **No signal** — a regression whose R² is at or below 0.05 explains about
  as much as the mean would; the features carry little for that target.
- **Columns that decide a distance on their own** — clustering and anomaly
  detection compare rows by distance, so a column with more than 20
  categories groups rows by its value rather than describing them, and a
  time column groups them by when they happened: the "segments" become
  customers, the "anomalies" the earliest and latest dates. Both are left
  out when the features were chosen automatically, and kept with a warning
  when you picked them yourself.
- **The anomaly rate is a setting** — the detector ranks rows by how easily
  they are isolated and flags the top 2% (or the contamination you set), on
  clean data as much as dirty. Read the score, and set the share you expect.
- **Strength is not sentiment** — a recommendation's strength column adds
  up, so a 1-star rating still counts as a weak like. If low values mean
  dislike, filter those rows out first.
- **Forecast history** — a first or last period the data only partly covers
  is left out; an empty period of a total counts as 0 (an empty period of an
  average is interpolated); the holdout is at least three periods once there
  are twelve, because one point cannot tell a flat line from a trend; and a
  projection of a series that never goes below zero is floored at zero.
- **A random holdout is not a time split** — classification and regression
  hold out rows at random. If your rows are events over time, the score is
  an estimate for rows like the ones you have, not for next quarter's; train
  on a prep flow that stops at a date to see how the model ages.

## How the winner is chosen

Training tries several algorithms and keeps the best. The question this section
answers is what "best" was measured against — because for a long time the
answer here was wrong in a way that flattered every model the platform
produced.

### The mistake, and what it cost

Every candidate used to be fitted on the training rows and scored on the
**holdout**. The best of those scores picked the winner, the tuner then
searched against the same holdout, and that very number was published as the
version's metric.

Taking the maximum of a dozen noisy estimates and publishing the maximum is the
winner's curse: the number is biased upward by exactly as much noise as the
search could exploit. Run over thirty seeds on data where the candidates were
genuinely equivalent — so any gap is selection noise and nothing else — the
published F1 came out **0.046 too high on average**. Against a decay alert that
fires at a ten per cent drop, most of the alert budget was spent before the
model had scored a single real row.

### What happens now

Selection happens **inside the training rows**, and the holdout is read once,
at the end, by code that is only reporting.

| Scheme                    | When                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| **Stratified folds**      | Classification with a small holdout. Each fold keeps the class mix. |
| **Cross-validated folds** | Regression with a small holdout.                                    |
| **Time-ordered folds**    | Any model given a time column. Always, whatever the holdout size.   |
| **One inner split**       | A holdout already large enough that folds would buy almost nothing. |

Which one a version used, and why, is written on the version and shown under
the metric tiles. So is the spread between folds, which is the part that makes
the headline number readable: it is how much the score moves when the same
model meets different rows, and therefore the scale below which a difference
between two versions is noise.

Folds cost k fits per candidate, so they are not always worth paying for. What
decides is the **size of the holdout**, not the size of the training set — a
few thousand held-out rows already pin the score to well under a point, while a
few dozen pin nothing at all. The line sits at
`ML_CV_MIN_HOLDOUT_ROWS` (2000), also editable under
**Admin → Developer runtime**. Above it, one inner split; below it, folds. A class
with fewer examples than folds lowers the fold count, and a class with a single
example turns folds off altogether — no set of folds can each contain one.

The winner is refitted on every training row before it is saved. The folds
existed to measure; the model that ships should have seen all the data
selection was entitled to use.

### The holdout is read once

Two numbers therefore appear on a version, and they are not the same number:

- **Across the folds** — what chose the winner.
- **On the held-back rows** — what nothing was allowed to optimise against.
  This is what the version reports, and what a decay alert compares production
  against.

Shown side by side on purpose. When they disagree the disagreement is
information: a winner that looked good on the folds and did not repeat itself
on untouched rows is telling you something a single number would have hidden.

**Calibration is decided the same way.** Keeping or discarding a probability
calibration is also a choice, so it is made on a slice of the training rows,
and only then are the Brier score and calibration error measured again on the
holdout for reporting.

### Rows that are ordered in time

A table with a time column must not be split at random. Shuffling rows that
have an order puts next month in the training set and last month in the
holdout, and the score that comes back is the score for predicting the past
from the future — reliably flattering, and reliably wrong the first time the
model runs for real.

Name a **time column** and three things change: rows are sorted by it, the most
recent slice is what gets held back, and the folds become `TimeSeriesSplit` —
every fold trains strictly before the rows it scores, on an expanding window of
history. Time order wins over every other consideration, including a holdout
large enough that a random split would otherwise have been used.

If the column turns out to hold no readable dates the run falls back to a
random split and **says so in the run log**. Quietly shuffling rows after being
told they are ordered is the version of this bug nobody would ever find.

## Versions

**Versions** lists every version with its stage, algorithm, primary metric,
rows and snapshot. Tick two or more trained versions to **compare** them
side by side: every metric they share, rows, tuning and training time, with
the best value in each row marked. **Promote** makes a ready version the production one (the
previous production version is archived); **Archive** withdraws a version
without deleting its metrics or passport; **Restore** returns it to the
candidates. **Train new version** re-reads the table as of the current
snapshot with the model's saved data preparation, and takes its own budget,
row limit and tuning mode.

## Experiments

Versions record what you **shipped**. Experiments record what you **tried**:
the twenty runs behind the one version worth keeping, which otherwise live in
a notebook's output cells until somebody re-runs it. Then "why is this the
learning rate" has no answer a month later, and a colleague cannot see that
the obvious idea was tried and did not work.

An **experiment** is a named question; a **run** is one attempt at it, with
the parameters it used and the metrics it got. Anything that can reach the
platform can log one. From a notebook the client is already injected:

```python
import agentswarms

with agentswarms.start_run("churn-v2", params={"lr": 0.01, "depth": 6}) as run:
    for epoch in range(10):
        run.log_metric("loss", loss, step=epoch)
    run.log_metrics({"auc": 0.91, "accuracy": 0.88})
    run.finish(artifact_uri=uri, artifact_sha256=digest)
```

`start_run` **raises** if it cannot start — a run you believe is recording and
is not is worse than one that never began. Every later call **warns and
continues**: losing an epoch's metrics is not worth losing the epoch. As a
context manager it closes the run whichever way the cell ends, recording the
traceback as the failure when training raises.

`log_metric(key, value, step=n)` keeps the point as `key@n` **and** updates the
bare `key` to the latest value, so the curve survives and "what did this run
score" still has one answer. **ML Models → Experiments** draws those points as
a sparkline beside the metric, and marks in the parameter list which parameters
actually differed between the runs shown — in a list of twenty, the ones held
constant are noise and the one that moved is the experiment.

A script outside the platform logs the same way with a user token:

```bash
curl <origin>/api/ml/experiments \
  -H "Authorization: Bearer <supabase access token>" \
  -H "Content-Type: application/json" \
  -d '{"op": "start", "experiment": "churn-v2", "params": {"lr": 0.01}}'
```

`{"op": "log", "run_id": …}` merges params or metrics into the run;
`{"op": "finish", "run_id": …}` closes it. A finished run refuses further
writes (409) — it is a record of what happened, and a straggler from a process
that outlived its own `finish` would rewrite it.

### From a run to a version

A run that recorded **both** `artifact_uri` and `artifact_sha256` can be
registered from its row as a model version. Both, because a version whose
artifact nobody can verify is not a version: registration goes through the same
path an [external registration](#bring-your-own-model) takes, so the digest is
checked before inference ever loads it, the audit trail is the same, and the
artifact must follow the same contract.

It arrives as a **candidate**, never as production. Promoting it is a separate,
deliberate step on the model's Versions tab — the seam between trying things
and shipping one should be something a person crosses on purpose.

### Saving the model from the notebook

Producing that artifact used to be the author's problem: write a joblib file in
the registry's contract, get it into the lake bucket **without the bucket's
credentials** (a kernel does not hold them, on purpose), hash it, and only then
call `finish`. So notebook-authored models stayed in notebooks. Two calls now
close that gap:

```python
with agentswarms.start_run("churn-v2", params={"lr": 0.01}) as run:
    pipe.fit(X, y)
    run.log_metrics({"auc": 0.91, "accuracy": 0.88})
    run.save_model(pipe, features=list(X.columns), task="classification",
                   classes=list(pipe.classes_))
    run.register("churn", task="classification",
                 source={"schema": "analytics", "table": "customers"},
                 target_column="churned")
```

`save_model` dumps the pipeline in the [external
contract](#bring-your-own-model), sends the bytes to the platform, and the app
writes them beside the artifacts its own trainer produces. **The digest
recorded is the one the app computes from the bytes that arrived** — a digest
the caller reported would be a digest nobody verified, and this one is what
inference checks before loading the file. A `sha256` the client sends is
compared against it and a mismatch is refused as a corrupted upload.

Unlike the logging calls, `save_model` **raises**: a save you believe happened
and did not is the same lie as a run that never started, and the caller still
holds the fitted model to retry with. `features` is the input columns **in
order**, because that is what the pipeline is handed at serving time.

`register` turns the run into a version of a model — by id, or by name. A name
nothing owns yet **creates the model**, which then needs `task` and
`source` (the lakehouse table the training data came from, checked as you);
`target_column` too, for classification and regression.

The version arrives as a **candidate**, with one exception that is the
registry's existing rule everywhere: when the model has no production version
at all — which is always true of a model this call just created — the first
version is promoted, because a model with nothing serving is no use. Pass
`promote=True` to promote deliberately on a model that already serves
something.

Both work from outside the platform with a user token, on the same two
endpoints: `POST /api/ml/experiments/artifact?run_id=…&name=…&sha256=…` with
the bytes as the body, then `POST /api/ml/experiments/register`.

### What is recorded, and what is audited

Runs are data, not configuration. Creating or renaming an **experiment** writes
an audit row; a metric does not, or a training loop logging per epoch would
write more audit rows than the audit log is for. **Promoting** a run into the
registry is audited as `ml.experiment.promote`, because that is the moment
something becomes servable.

Everything is owner-only, in the database as well as in the API: RLS on both
tables, and every write re-checked against the caller's own id. A run id is a
uuid, not a capability.

Limits: 5,000 runs per experiment, and 2,000 named params or metrics per run —
`log_metric(step=)` writes a key per step, which is the point, but a loop over
100k steps would put 100k keys in one column and a row nothing can render is
not a record of anything.

### Who signs off a promotion

Promotion is audited but ungated by default: anyone with write access can put a
version in front of customers on their own, and the record says so afterwards.
Where that is not enough — model-risk policy usually asks for a second
signature **before** the change, from somebody who did not make it — name the
approvers under **Versions → Who signs off a promotion**.

With approvers named, **Promote** stops promoting and starts asking. The
version keeps serving whatever it serves until one of them agrees, and the
request appears under **Pending approvals** in the header, beside the swarm
approvals — the same table, the same inbox. There is no second approvals
system.

**Nobody may approve their own promotion.** Naming only yourself is refused at
save; the requester is removed from the approver list when a request is raised;
and the check runs again when the approval is applied, because reaching that
line means somebody edited the row. A self-signed approval is worse than no
gate at all, since it produces an audit trail saying a review happened.

**Only production is gated.** Moving a version to staging or archiving it
changes nothing a customer meets.

**The button says what it will do.** With a gate on, the confirmation asks
whether to _request_ the promotion and says the version keeps serving what it
serves now — the dialog is where a gate is first visible, and promising an
immediate switch there would be a lie told at the moment somebody decides
whether to press.

The audit names both people: `ml.version.promote.requested` when it is asked
for, and `ml.version.promote` with `approved_by` when it happens. Turning the
gate on and off is itself recorded.

## Predictions

**Try it** — a form generated from the feature schema (medians and category
lists filled in). Without a warm endpoint one row is scored in a sandbox, so
allow half a minute; with one it comes back immediately. The
result shows the predicted class with its confidence and the per-class
probabilities, or the predicted number.

**Batch prediction** — pick an input lakehouse table with the same columns,
an optional filter, and an output schema you own plus a table name. Every
row is written back with `prediction`, `probability`, one `proba_<class>`
column per class, `_model_version` and `_predicted_at`. A clustering writes
the group as `prediction` and the `distance` to its centre; an anomaly
detector writes `prediction` (1 = anomaly) and `anomaly_score`; a
recommendation reads the user column and writes each user's top items as
`prediction` with their `scores` and a `cold_start` flag. The table is an
ordinary lakehouse table: agents, the SQL workbench and dashboards query it
like any other. The operator's `ML_PREDICT_MAX_ROWS` is checked before a
sandbox starts.

Every prediction run carries its own decision id (`ml_prediction`) — unless
it serves an agent's turn, in which case it adopts that turn's decision — and
success is audited as a data read (`ml.predict_query`) with a digest over the
prediction column and the row cap, so a replay can tell "same model, same
rows, same answers" from drift.

### Agents

Enable **ML Predictions** in an agent's tools. The agent gets
`ml_list_models` (name, task, target, feature columns with categories and
ranges) and `ml_predict` (rows in, predictions out, fifty rows shown to the
model). Both are offered only when the caller can use at least one model with
a production version; on headless runs (deployed swarms, schedules) grants
are re-derived from the run's owner. Forecast models return their projected
periods.

## Automation

The model page's **Automation** tab schedules two kinds of work, each
running as you, in the same sweep, under the same cron lease and with the
same reaper as ETL pipelines and materialized views:

- **Retrain** — a new version from the current table every hour, day, week
  or on a cron expression, with its own budget and tuning mode. When
  **promote when better** is on, the new version becomes production the
  moment it is ready if its primary metric beats the incumbent; you are told
  either way. A schedule that cannot start (a limit reached, a missing
  table) records the reason and notifies you.
- **Batch prediction** — score a lakehouse table (optionally filtered) into
  a table you own with the production version, so a scored table stays
  fresh for dashboards and agents without anyone clicking.

**Run now** starts a schedule immediately; **pause** keeps it without
running it; resuming schedules from now, never from the missed past. Every
start is audited (`ml.schedule.run` / `ml.schedule.failed`), and the
schedule rows themselves are audited by trigger (`ml_schedule.*`).

## Drift

Training records the distribution of every feature — decile bins for
numbers, the top categories for categoricals. Every batch prediction (and
any direct prediction of ten rows or more) bins the new rows the same way
and reports a **population stability index** per feature; the run's
**Drift** badge shows the highest one: below 0.1 stable, 0.1–0.25
moderate, above 0.25 the population has moved. A run above
`ML_DRIFT_ALERT_PSI` (0.25 by default, edited under Admin → Developer
runtime) is audited as `ml.drift.alert` and notifies the model's owner
with the three most drifted features — the cue to retrain, or to schedule
retraining. The public API returns the same numbers in
`/api/ml/predict/status`.

## Why this row got this answer

The model page shows what the model relies on **overall** — permutation
importance over the raw input columns, measured once when the version trained.
That answers "what does this model key on". It does not answer "why was this
customer declined", which is the question a person asks when the answer is
about them, and in credit, insurance or hiring it is a question you may be
obliged to answer.

Tick **Explain this answer** under **Try it** on the Predictions tab. Each
feature comes back with how far the answer moved when its value was replaced
with the one a typical training row carried — bars to the right pushed the
answer up, bars to the left pushed it down, measured in probability for a
classification and in the target's own units for a regression.

### What this is, exactly

**It is an ablation against a typical row, and it is not SHAP.** Nothing in the
product calls it that, because a Shapley value has properties this does not:
these contributions are not additive and they do not sum to the prediction.
What they are is the **local twin of the permutation importance** already shown
for the model as a whole — that shuffles a column across every row, this
replaces one cell in one row — which is why the two can be read side by side
and mean compatible things.

The typical row comes from the same feature distribution drift already records
inside the artifact: the middle quantile for a number, the commonest value for
a category. A feature whose distribution was never recorded is ablated to
missing instead, and the pipeline imputes it exactly as it imputes any absent
value.

**It works on any model**, including one registered from a notebook, because it
only ever calls `predict`. The one case it declines is a classifier with no
`predict_proba`: without probabilities the only measurable move is that the
label flipped, which is a yes/no rather than a contribution, so it returns
nothing rather than dressing a coin flip as a number.

### Reason codes on every scored row

The explanation above answers for one row you are looking at. A batch answers
for all of them: tick **Write reason codes beside every row** on the batch
prediction dialog and the scored table gains

| Column                                | What it holds                                                    |
| ------------------------------------- | ---------------------------------------------------------------- |
| `reason_1` … `reason_3`               | The features that moved this row's answer most, strongest first. |
| `reason_1_effect` … `reason_3_effect` | How far each moved it, signed.                                   |

Flat columns rather than a JSON blob, because the point is that
`WHERE reason_1 = 'support_tickets'` works in plain SQL and a dashboard can
group by it. The value that drove the answer is not repeated: it is already in
the row, in the column the reason names. A row with fewer features that moved
anything than there are slots gets nulls, not blanks.

**They are the same measurement as the single-row explanation**, run over every
row instead of one — the same ablation against the same typical row. That is
deliberate and it is the expensive choice: a cheaper approximation for batches
would be a second answer to the same question wearing the same name, free to
disagree with what the row's own page shows. A reason code that contradicts the
explanation is worse than no reason code.

### What reason codes cost, and what happens when it is too much

One extra prediction per feature per row, the same as explaining a single row —
so a hundred thousand rows with twenty features is two million predictions. The
work is done in chunks so memory stays flat however large the batch is, but the
time does not.

So there is a ceiling, `ML_EXPLAIN_BATCH_MAX_ROWS` (50,000), and a batch above
it is **refused before the sandbox starts** — the row count is already known
from the check that enforces the prediction limit, so the answer names the real
number and what to do about it. It is refused rather than truncated on purpose:
a scored table where the first fifty thousand rows carry reasons and the rest
are null looks complete and is not, and nothing downstream would know.

Narrow the rows with a filter, score without reason codes, or raise the
ceiling. `ML_EXPLAIN_BATCH_TOP_K` (3) sets how many reasons are written, and
each one costs two columns.

### What it costs

One extra prediction per feature per row, so it is opt-in and bounded:
`ML_EXPLAIN_MAX_ROWS` (20) rows per request and `ML_EXPLAIN_TOP_K` (8) features
back for each. An explained call also **takes the sandbox path even when a warm
endpoint is up** — the endpoint's serving program would need its own copy of
the ablation to answer, and a second implementation of "what moved this answer"
is a second definition of it.

An explanation that fails never costs you the prediction: the answer is
returned with a warning attached, because the answer is the product and the
explanation is commentary on it.

## Was it right?

Drift and this are different questions, and treating the first as an answer to
the second is the most common way a model quietly stops working. **Drift** says
the rows arriving now do not look like the rows the model trained on. Inputs
can shift while accuracy holds; inputs can sit perfectly still while the world
changes underneath the label. The only way to know whether a model is still
right is to wait for the real answer and compare.

So a model may name an **outcome source**: the table where the real answers
land, and the key that lets a scored row find its own.

**Accuracy** on the model page, then **Set an outcome source**:

| Field          | What it is                                                            |
| -------------- | --------------------------------------------------------------------- |
| Schema / table | Where outcomes land. Any lakehouse table you can read.                |
| Key columns    | 1 to 8, present in both that table and the scored table, same values. |
| Outcome column | What actually happened. Rows where it is still null are skipped.      |

An evaluation joins one prediction run's output table to that table and
recomputes **the model's own primary metric** — `f1_macro` for a
classification, `rmse` for a regression or forecast — on the rows that have an
answer, then compares it to what the same metric was on the validation split
when that version trained. A run more than `ML_DECAY_ALERT_RATIO` worse (0.10
by default — ten per cent) is audited as `ml.decay.alert` and notifies the
model's owner.

The number is a ratio rather than a metric value so it reads the same way for a
metric that should go up and one that should go down: an f1 of 0.72 against a
baseline of 0.80 and an RMSE of 11 against a baseline of 10 are both "ten per
cent worse".

**It runs on the platform clock.** Answers arrive over hours or weeks, so one
measurement is never the last word: each successful batch run is re-measured
once a day while it is less than a month old, and `ML_EVALUATIONS_PER_SWEEP`
(20) bounds how many one pass does. **Measure now** does one immediately.

### Three things it deliberately does not do

**It does not count a missing answer as a wrong one.** The join is an INNER
join. A prediction whose outcome has not arrived is not a mistake, and treating
it as one would make every model look worse the fresher its predictions are.

**It does not report a metric without its coverage.** Every evaluation carries
how many rows it matched out of how many were scored, and the panel shows both.
An f1 of 0.9 over 6% of the rows is not the model's f1 — it is the f1 of
whoever answered first, and they are rarely a random sample. A join that
matches **nothing** is reported as an error naming the key columns to check,
rather than recorded as a score of zero.

**It does not celebrate an improvement.** A model scoring markedly BETTER than
its own validation score is usually the outcome column leaking into the
features, or a join matching the wrong rows. That verdict reads "Better than
training" in a neutral badge, not a green tick.

### What it compares against

The metric is recomputed exactly as scikit-learn computes it — macro F1 with
`zero_division=0`, averaged over the union of predicted and actual classes —
because the baseline it is compared against came out of that same call at
training time. Two defensible definitions of one metric would fire a decay
alert the first time every model was measured, which teaches everyone to ignore
decay alerts. The agreement is pinned by
[`tests/unit/mlEvaluation.test.ts`](../tests/unit/mlEvaluation.test.ts) against
fixtures generated by scikit-learn itself.

Evaluating costs no sandbox: a confusion matrix and five sums are a `GROUP BY`,
so one statement runs through the governed lakehouse chokepoint — as the
model's **owner**, so the same schema grants apply — and the arithmetic happens
in the app.

## Is 0.8 really 80%?

Every classification here carries a probability, and the interface has always
printed it beside the word **confidence**. For a tree ensemble that number is
usually a _rank_ rather than a frequency: a forest that votes 9 trees to 1
reports 0.9 whatever the real rate turns out to be. Good enough for sorting a
queue, wrong for a rule that says "auto-approve above 80%".

So the trainer measures it, and the model page shows the measurement.

### The reliability curve

The holdout rows are binned by what the model said, and each bin reports what
actually happened. A point on the diagonal means the model's 70% really was
70%; above it the model is under-selling itself, below it over-selling. Bins
are drawn in proportion to how many rows they hold, because four rows landing
far off the line is noise and four hundred is a problem.

Two figures summarise the curve:

| Figure                | What it means                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Calibration error** | The average gap between what was said and what happened. 0.04 is "typically within four points".                                            |
| **Brier score**       | Mean squared error of the probabilities themselves. Lower is better; it moves when a model is confidently wrong, which accuracy never sees. |

The page bands the calibration error rather than leaving a bare decimal: at or
under 0.05 it is safe to write a rule against, under 0.15 it is fine for
ranking and loose for a rule, and above that the numbers should be read as
ranks.

### What the trainer does about it

After the algorithm search picks a winner and **before** any metric is
recorded, classification models get a calibration pass —
`CalibratedClassifierCV`, isotonic regression on 1000 training rows or more and
Platt scaling below that, since isotonic needs data to fit its step function
and overfits badly without it.

**It is then checked, and discarded if it did not help.** The calibrated model
is scored on the same holdout, and it is kept only when **both** the Brier
score and the calibration error improve. Requiring both is not belt and braces:
Brier is calibration and sharpness added together, so a model can win on Brier
by growing more confident while drifting further from the truth. A 90-row probe
did exactly that — Brier 0.1701 → 0.1572 while the calibration error went
0.1917 → 0.2220 — and on the Brier test alone it would have shipped.

When the pass is discarded the run log says so and the page says "left
uncalibrated". That is not a failure: a model that was already well calibrated
lands there, and so does one whose holdout was too small to fit a reliable
mapping. Because metrics are recorded after this step, every number on the
version describes the model that was actually saved.

Versions trained before this shipped have no curve. They read as _not
measured_, which is the truth — retrain to get one.

## Where the line is drawn

A classifier decides by `argmax`, which is a threshold of 0.5 that nobody
chose. It is the right default and the wrong one for most real decisions:
declining a good customer and missing a fraudulent order do not cost the same,
and the person who knows the ratio is the operator, not the trainer.

So the trainer **measures every operating point** and the model page lets you
pick one. For a two-class model the holdout is scored at thresholds from 0.05
to 0.95 in steps of 0.05, and each row of the table is a real measurement:

| Column             | What it is                                        |
| ------------------ | ------------------------------------------------- |
| Line at            | The probability at or above which the model acts. |
| Rows acted on      | How many holdout rows it would have acted on.     |
| Right when it acts | Precision at that line.                           |
| Caught             | Recall at that line.                              |

The sweep is always expressed from one side — the second class, named on the
page — and that loses nothing: with two classes the probabilities sum to one,
so a line at 0.70 on `retained` is the same rule as a line at 0.30 on
`churned`. Every operating point either class could have is already in the
table, read from one end.

The best-F1 row is marked **balanced** and is offered as a starting position,
not a recommendation — F1 weights the two mistakes equally, which is the exact
assumption this screen exists to let you reject.

Choosing a row shows what would change against the line currently in use, and
saving it asks first. The picker only offers thresholds the trainer actually
measured: interpolating to 0.437 would present a number the platform never
checked with the same authority as one it did.

### It is a setting, not a retrain

The threshold lives on the **version**, not inside the artifact. Prediction
reads it at run time, so moving the line takes effect on the next prediction
and the model is untouched. Every change is audited as `ml.threshold.set` with
the old and new values, because "who decided to approve 12% more applications,
and when" is a question that gets asked.

Two more consequences worth knowing:

- **The probability shown is the probability of the answer given.** A row
  declined at 0.45 reports 0.55 against the class it was actually assigned, not
  0.55 confidence in a decision nobody made.
- **Scored tables record the line that produced them.** A batch run with a
  threshold set writes `threshold_applied` on every row, so six months later
  "why was this one declined" is answerable from the row rather than from
  whatever the setting happens to be by then.

### A retrain does not carry the line forward

Because the threshold lives on the version, a new version arrives without one
and decides by `argmax` again. That is deliberate: a line only means the same
thing across two versions whose probabilities mean the same thing, and copying
it forward silently would be the platform making a business decision on your
behalf.

It is also the sort of change nobody notices until approval volume shifts, so
it is not left silent either. When the production version has no line and an
earlier version of the same model did, the panel says so — naming the version
and the value, with a button to draw it there again. Scheduled retraining with
**promote when better** is exactly the case this is for.

Multiclass models get no threshold and no sweep: there is no single line to
draw, so each prediction is simply whichever class scores highest. Regression
and forecasting have none either.

## How groups are treated

Two questions, and each hides the other.

**Selection rate** asks how often each group gets the favourable answer. It
needs no outcomes at all — only the scored table — so it can be checked the
moment a batch runs, and it is the one employment and lending law is written
about.

**Error rates** ask whether the model is _wrong_ more often for one group. That
needs the real answers, so it rides on the same join an
[evaluation](#was-it-right) makes. A model can have near-identical selection
rates and still be far worse at one group, which is why both are reported and
neither is shown without room for the other.

**Accuracy** on the model page, then **How groups are treated**:

| Field                 | What it is                                           |
| --------------------- | ---------------------------------------------------- |
| Compare groups by     | Up to 8 columns present in the scored table.         |
| The favourable answer | The predicted label that counts as the good outcome. |

Each column is compared separately and recorded as its own check — two columns
are two comparisons, and averaging them would hide the one that matters. The
result gives a **selection-rate ratio** (the lowest group's rate over the
highest's) and, where outcomes are known, the **largest true-positive-rate
gap** between groups.

### The lines it will not cross

**The favourable answer is named by you, never inferred.** Which label is the
good one is a fact about the world — "approved" is favourable, "fraud" is not,
and "churn" depends on who is asking — and a platform that guessed would put
its guess in a compliance report.

**The verdict is "worth a review", never "unfair".** Nothing computable decides
whether a model is fair; that is a judgement about a context this platform
cannot see. What a ratio can say is that the groups came out far enough apart
to deserve a person's attention.

**Four fifths is a default, not a law.** `ML_FAIRNESS_MIN_RATIO` defaults to
0.8 because that is the threshold the US EEOC's Uniform Guidelines use as prima
facie evidence of adverse impact. It is a rule of thumb with no statistical
claim behind it, it is not the standard everywhere, and a deployment may hold
itself to more.

**A group too small to judge is still shown.** Groups under 30 rows are
reported and greyed but never drive the verdict: a rate over five people swings
20% when one of them changes, so judging on that produces alarms out of
arithmetic — and one false alarm is enough for somebody to switch the check
off. Hiding the group instead is how a real problem stays invisible for a
quarter. A value nobody recorded becomes its own group, **(not recorded)**,
for the same reason.

### Where the agent layer helps, and where it does not

This is the first place in the platform where a language model touches a number
somebody may have to defend, so the boundary is explicit and tested:

> **The platform measures. The model proposes and narrates. A number never
> comes from the language model.**

**Suggesting what to compare by.** The hard part of a fairness check is not the
arithmetic, it is knowing that `postcode` stands in for ethnicity and
`first_name` stands in for gender. Proxies are where careful people miss
things. **Suggest columns** asks the assistant to nominate candidates — both
directly sensitive attributes and proxies, each with a reason you can disagree
with — and you tick what applies. Nothing is enabled by the suggestion itself.

**Only column names, types and cardinalities are sent.** Never values. A column
of ethnicities is sensitive data, and posting a sample of it to an inference
endpoint to ask whether it is sensitive would answer its own question. The
suggestion path never queries the lake at all, and a test enforces that. Any
column the model names that is not in the schema is dropped rather than shown.

**Reading a result back in words.** _Explain this in words_ passes the already
computed figures to the assistant and asks for two or three sentences. The
prompt forbids it from computing, estimating, rounding differently or
introducing any figure it was not given, and the narration is stored **beside**
the numbers rather than instead of them — so one that drifts is visibly
contradicted by the table above it.

Both calls go through the same governed door as every other model call
(`internalChatText`), so IAM model rules, budgets and audit apply, and both are
audited as `ml.fairness.suggest` and `ml.fairness.narrate`. The assistant model
is `ML_ASSIST_MODEL`.

A check is recorded as `ml.fairness.check`, or `ml.fairness.review` when the
ratio falls below the line, which also notifies the model's owner.

## Public API

A model can be published as an API. **Publish as API** on the model page
mints a key that looks like `mlk_…`, shown once and stored hashed, scoped to
that one model with any of `predict` (score rows, start batch runs), `train`
(train a version, register an external one) and `read` (list the model,
poll jobs and runs). Every call runs on the same service the app uses — the
same limits, the same lakehouse guard, the same audit trail — and is
attributed to its key; a denied call (unknown, revoked, expired, wrong
scope, rate-limited) is audited as `ml.api_key.denied` with the caller's
address.

| Endpoint                       | Scope   | Body                                                                                              | Answer                                                              |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/ml/models`          | read    | —                                                                                                 | the model, its features and versions                                |
| `POST /api/ml/train`           | train   | `time_budget_minutes`, `max_rows`, `tuning`, `prep`, `feature_columns`                            | 202 with `job_id` and `version_id`                                  |
| `POST /api/ml/train/status`    | read    | `job_id`                                                                                          | status, the version's metrics when ready, the log tail              |
| `POST /api/ml/predict`         | predict | `rows` (up to 200), `version_id`, `wait_seconds`                                                  | 200 with columns and rows, or 202 with a `prediction_id` to poll    |
| `POST /api/ml/predict/batch`   | predict | `input {schema, table, where}`, `output {schema, table}`, `version_id`                            | 202 with a `prediction_id`; the output is a lakehouse table you own |
| `POST /api/ml/predict/status`  | read    | `prediction_id`                                                                                   | status, row count, columns, a sample, the result digest             |
| `POST /api/ml/models/register` | train   | `artifact_uri`, `artifact_sha256`, `algorithm`, `metrics`, `feature_schema`, `classes`, `promote` | 201 with the new version                                            |

```bash
curl -X POST https://your-instance/api/ml/predict \
  -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" \
  -d '{"rows":[{"region":"EMEA","net_usd":480,"payment_rows":1}]}'
```

Answers use ordinary status codes: `401` for a missing, unknown, revoked or
expired key, `403` for a missing scope, `404` for a job or run of another
model (never 403, so a key learns nothing about what it cannot see), `409`
when the service refuses (no trained version, a limit reached, a schema you
do not own) and `429` above the per-key rate limit, `ML_API_RATE_LIMIT_PER_MIN`
calls a minute (sixty by default, edited like every other limit).

### Bring your own model

A model trained elsewhere — a notebook, a laptop, another platform — can
serve through the same registry. Write the artifact into the lake bucket as
a joblib dictionary with `task`, `pipeline` (any object with `predict`, plus
`predict_proba` for a classifier), `features` (the input columns, in order)
and, for a classifier, `classes`, then register it with its SHA-256;
inference verifies the digest before loading it, hands the pipeline the raw
feature columns, and returns the same columns a trained version would.
Classification, regression, clustering and anomaly models accept external
versions; the first one is promoted when the model has no production
version.

```python
import hashlib, io, joblib, s3fs
payload = {"task": "classification", "pipeline": fitted_sklearn_pipeline,
           "features": ["region", "net_usd", "payment_rows"], "classes": ["free", "pro", "enterprise"]}
buf = io.BytesIO(); joblib.dump(payload, buf, compress=3); blob = buf.getvalue()
uri = "s3://lakehouse/ml-artifacts/external/plan-v7.joblib"
with s3fs.S3FileSystem().open(uri, "wb") as f: f.write(blob)
# POST /api/ml/models/register with artifact_uri=uri, artifact_sha256=hashlib.sha256(blob).hexdigest()
```

## Feature views

A model trained on a table whose columns were built by SQL — `orders_30d`,
`days_since_signup`, whatever — is normally scored by POSTing those same column
NAMES with values the caller computed itself, in its own code, months later.
Nothing checks that its arithmetic matches the training set's. The model
receives numbers of the right shape and the wrong meaning, and answers
confidently. That is training-serving skew, and it is quiet.

A **feature view** removes the caller's arithmetic. It names a table, the
column or columns that identify a row, and which columns are features. Serving
then takes a **key** and reads the feature values from the same table training
read:

```bash
curl <origin>/api/ml/predict \
  -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" \
  -d '{"keys": [{"customer_id": "c-1"}, {"customer_id": "c-2"}]}'
```

```json
{
  "prediction_id": "…",
  "served": "warm",
  "feature_view": "customer_features",
  "keys_not_found": [],
  "columns": ["customer_id", "orders_30d", "prediction", "probability"],
  "rows": [["c-1", 4, "pro", 0.98]]
}
```

Find them under **ML Models → Feature views**, and attach one to a model under
**Automation → Input** on the model page. Without one, nothing changes: the
caller keeps sending whole rows and keeps owning them.

### Point-in-time training sets

Serving asks what an entity's features are **now**. Training has to ask a
harder question — what were they **at the moment this label was true** — and
the difference between the two is the most expensive mistake in applied ML.

Join a label from February to the feature table's latest row and the model
learns from June's numbers. It scores beautifully in the notebook, because the
answer was in the features, and then it fails in production, where June has not
happened yet. Nothing about that failure looks like a bug: the code ran, the
metric was high, and the leak is invisible unless somebody thought about time.

**Training set** on a feature view builds the honest version. Give it the table
holding your labels, the column that says when each label was true, and which
of its columns maps to each key column of the view:

| You give it     | What it means                                                          |
| --------------- | ---------------------------------------------------------------------- |
| Label table     | One row per thing you want to predict, in a schema you own             |
| As of           | The column saying when that label was true                             |
| Key mapping     | The label column matching each of the view's key columns               |
| Max feature age | Optional. A feature older than this is not joined; the row keeps nulls |
| Write to        | A new lakehouse table, yours, replaced whole on each build             |

Each label row then keeps the feature values with the greatest feature
timestamp **at or before its own** — an `ASOF LEFT JOIN`, which is exactly this
question and is resolved by the engine rather than by a window function you
have to get right. `LEFT` on purpose: a key whose features start later is a
real part of the training set, and dropping it silently changes what the model
trained on.

The build reports **how many rows would have differed** under the join people
write by hand. That number is the whole feature expressed as a measurement: on
the sample data below it is two of five, and those two rows carry a feature
from four months after the label.

The view's timestamp column is never joined in as a feature. A model that
trains on the feature clock learns the shape of your ETL schedule, not
anything about the entity.

A view with **no** timestamp column cannot build one at all, and says so rather
than joining the latest row and calling the result a training set.

The table is written with one `CREATE OR REPLACE TABLE … AS`, so a reader sees
the old rows or the new ones and never a half-built set. Nothing schedules it:
a training set is a snapshot of what was true, and one that changes under a
model is not a record of anything.

### What it does not do

**It materialises nothing.** The table is whatever built it, and a
[SQL model](./SQL_MODELS.md) is the natural author: the model's name IS its
table, its schedule keeps the table fresh, its `unique` test can assert the
key, and its lineage is already recorded. A second scheduler and a second copy
of the data here would duplicate all of that, badly.

**It does not guess.** Rows come back in the order the keys were asked for,
matched by key rather than by result order, because a feature attributed to
the wrong key is the worst failure this component has. A key that matches
nothing is named in `keys_not_found` rather than filled with nulls — a row of
nulls scores perfectly happily and means nothing.

**It refuses an ambiguous key.** If a key matches two rows and the view has no
timestamp column, the call fails and says so. Give the view a **latest row
wins** column and the newest is used. Picking one of two arbitrarily is how a
feature store starts lying.

### Rules

|               |                                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| Key columns   | 1 to 8, composite supported. A key column may not also be a feature.                |
| Features      | Named explicitly, or empty for every column that is not a key.                      |
| Keys per call | 200, the same cap as rows.                                                          |
| Reads         | Through the governed lakehouse chokepoint, as the model's owner, uncached, audited. |

A column list is always sent explicitly rather than `SELECT *`, so a column
added to the table later cannot silently become a feature the model never
trained on. The view is checked against its table when you save it, because a
missing column otherwise surfaces behind a live prediction.

## Warm endpoints

By default a prediction starts a container, boots Python, imports the ML
stack, downloads and digest-checks the artifact, scores, posts the answer back
and exits. Measured on an idle machine with the image already pulled, that is
about **twenty seconds before any scoring happens**. It is the right shape for
a batch job over a million rows and the wrong one entirely for scoring a row
behind a web request.

A **deployment** holds one version in memory and answers over HTTP instead.
Find it on the model page under **Automation → Warm endpoint**.

**The scoring is identical.** The sandbox loads the same program the batch path
runs and calls the same `_predict`, so the same fitted pipeline scores the same
digest-verified artifact. Only the waiting is different. A second scoring
implementation would agree today and diverge quietly later, which is the one
failure this feature could plausibly have introduced.

**It pins a version.** A deployment names the version it loaded, not "whatever
is in production". Promoting a new version marks the endpoint **stale** and
leaves it serving what it was serving, because an endpoint that silently
changed its answers is the opposite of what pinning is for. Redeploy when you
mean to.

**A missing endpoint is slower, never wrong.** If the deployment is down,
loading, or serving a different version, the prediction falls back to the
sandbox and takes the usual twenty seconds. Nothing fails, and nothing answers
from a model you did not ask for. Every reply says which path served it:

```json
{ "prediction_id": "…", "version": 3, "served": "warm", "elapsed_seconds": 0.045 }
```

**What it actually costs.** Measured end to end on a laptop against a remote
managed Postgres, one row through `/api/ml/predict`:

|                            | Warm   | Cold  |
| -------------------------- | ------ | ----- |
| Whole API call             | ~1.3 s | ~27 s |
| Scoring inside the sandbox | 45 ms  | 45 ms |

The scoring is the same 45 ms either way — that is the model, and it never
changed. What a warm endpoint removes is the twenty-odd seconds of container
start around it.

The ~1.2 s left over is **not** the model: it is the platform's own
book-keeping, and on this setup almost all of it is round trips to a database
in another datacentre. Authenticating the key, checking its rate limit,
loading the model row, picking the version, finding the endpoint, writing the
prediction row and auditing it are seven or eight round trips. Co-locate the
database and the same code path is a small fraction of that; the endpoint
itself answers in about 90 ms including HTTP.

**It is recorded exactly like a cold prediction.** The same `ml_predictions`
row, the same drift check, the same `ml.predict_query` audit event. Faster, not
less accountable.

**It costs memory while it is up.** A held-open scorer holds the ML stack and a
fitted pipeline resident whether or not anyone is scoring, so:

- it is **off by default**, per model;
- an idle one is **stopped** after `idle_ttl_minutes` (15 by default), unless
  **Keep warm** is on, which is for the endpoints where the first slow request
  is the one that matters;
- the instance caps how many may be open at once.

Forecast models have no endpoint: a forecast is answered from the stored series
with no model in the loop at all.

### More than one copy

One sandbox is one Python process scoring one request at a time, so the second
caller waits for the first — and at that point the twenty seconds a warm
endpoint saved are being spent again in the queue, somewhere less visible.

An endpoint can therefore hold several **copies** of the model, each in its own
sandbox. Set the range on the deployment panel: the first number is how many
are held even with no traffic, the second the ceiling.

**Both default to 1, so nothing changes until you raise the second.** Every
copy is a container holding the ML stack and a fitted pipeline resident on your
machine; starting more of them because a feature shipped would be spending your
memory without asking.

Requests go to the copy that has gone longest without one. That is the same
rule the scaler uses to choose what to stop, deliberately — two notions of
"quietest" would have the two disagreeing about the same endpoint.

### When copies are added and removed

The platform clock measures the endpoint's request rate — the change in its
counter between two readings, not a sample — and compares it with
`ML_SERVE_TARGET_RPM_PER_REPLICA` (120), the load one copy is sized for.

**Adding is immediate.** A queue is the thing a warm endpoint exists to
prevent, so there is no cooldown before relieving one. One copy is added per
pass however far behind the endpoint is: the next pass is a minute away and
will add another if it is still needed, by which time the first has loaded, so
the decision is made knowing what it bought. Starting four at once on a burst
is how a machine runs out of memory serving a spike that ended before they
loaded.

**Removing is reluctant**, and needs three things at once:

- the load clear of what the smaller number could carry, not merely at it —
  otherwise the next pass adds the copy straight back and the endpoint flaps,
  paying a cold start every time it changes its mind;
- `ML_SERVE_SCALE_COOLDOWN_SECONDS` (180) since the last change either way;
- a copy that has actually been idle that long, because stopping a container
  takes any request still inside it.

Every decision is recorded on the endpoint in plain words — the panel shows the
last one — and every change is audited as `ml.scale` with the rate that caused
it.

### What a copy actually is, and how far it gets you

A copy is a sandbox, started the same way every other sandbox is — so what it
lands on depends entirely on the runtime backend:

| Backend    | A copy is                                                   |
| ---------- | ----------------------------------------------------------- |
| Docker     | Another container on this machine.                          |
| Kubernetes | Another **Pod**, which the scheduler may place on any node. |

Nothing in the scaling code mentions either. It asks the orchestrator for a
scoring sandbox and gets back an address.

**On Kubernetes these are bare Pods the app creates, not a Deployment.** There
is no ReplicaSet and no Service in front of them: the app holds each Pod's
address and picks between them itself. That means the **HorizontalPodAutoscaler
is not involved** — the platform clock is the control loop — and it also means
copies genuinely spread across nodes, so an endpoint can outlive one of them.

**On a single machine the benefit is real but bounded, and worth being blunt
about.** The scorer is a threading HTTP server, so one copy already accepts
concurrent requests; but scoring is CPU-bound Python and the GIL serialises
most of it, with only the numpy and BLAS parts overlapping. A second copy is a
second OS process, which is genuine parallelism. So:

- copies help up to roughly the machine's core count;
- past that they contend for the same CPU and each holds the ML stack and a
  fitted pipeline in memory, so more copies make things worse;
- and two copies on one box die with the box. There is no fault tolerance in
  raising the number on a single host.

That is why the maximum defaults to 1. Raise it when you have cores spare or
nodes to spread across, not by default.

Either way the warm-container limits still apply, and they count copies rather
than endpoints, because the thing being bounded is resident memory.

### Trying a version on real traffic

A new version is normally adopted by **switching** to it. Which means the
first evidence that it behaves differently from the old one is production
behaving differently — noticed, if it is noticed, by whoever the difference
landed on.

**Shadowing asks the question first.** Pick a version on the deployment panel
and the endpoint starts a second copy holding it. From then on, every request
the endpoint answers is mirrored to that candidate, its answer is compared
against the one that was actually served, and then thrown away.

The load-bearing promise is one sentence:

> **A candidate never answers a caller.**

The scorer asks for copies marked `primary` and never sees the candidate at
all, so there is no ordering, no flag and no race by which an unapproved
version could end up on the wire. That is what makes it safe to point live
traffic at a model nobody has approved.

Two smaller promises follow from it:

- **Nobody waits for it.** The mirror is fired after the served answer is in
  hand and is not awaited, so the caller's latency is the primary's latency.
  A mirror that is still running when the answer goes back is simply still
  running.
- **A mirror that fails cannot reach the caller.** It is caught and counted.
  A candidate that cannot load, cannot score, or has been deleted shows up as
  an error rate on the report, not as a failed request for somebody else.

#### What "agree" means

It is not the same question for every model, and pretending it is would make
the number meaningless:

| Task           | Agreement is                                                 |
| -------------- | ------------------------------------------------------------ |
| Classification | The same label. A proportion that reads exactly as it looks. |
| Regression     | Within **1%**, relative, with an absolute floor near zero.   |

Counting exact float matches on a regression would report 0% agreement on two
models that are indistinguishable in practice, so the comparison is a
tolerance and the headline figure is the typical gap.

**Clustering, anomaly detection and recommendation are not compared**, and the
mirror does not run for them. Their labels are arbitrary between fits: cluster
3 of one model has nothing to do with cluster 3 of another, so a comparison
would report total disagreement between two identical models.

#### What is kept, and what is deliberately not

Four running totals on the endpoint — requests, rows, rows agreed, errors —
plus the **answers** from the fifty most recent rows the two disagreed on.

**The mirrored input is never stored.** A mirrored request carries whatever
the caller sent, which on a live endpoint is live personal data; keeping it
would put that data in a debugging table nobody thinks of as a data store.
The disagreement sample holds the two answers and the time, and nothing else.

Totals rather than a row per request, because an endpoint at a couple of
requests a second would write a hundred and fifty thousand rows a day to
answer a question that is four numbers.

#### The verdict, not the percentage

The panel leads with a sentence rather than a figure, and below a hundred
compared rows it refuses to give one at all — it says how many more it needs.
A percentage on forty rows invites a decision nobody has evidence for, which
is the opposite of what shadowing is for.

| It says             | When                                                            |
| ------------------- | --------------------------------------------------------------- |
| Watching            | Fewer than 100 rows compared so far.                            |
| Answers the same    | 90% of rows or more agreed.                                     |
| Answers differently | Below that — with recent disagreeing answers listed underneath. |
| Failing             | The candidate failed on 5% or more of mirrored calls.           |

#### What it costs, and how it ends

A candidate is a copy, so it is a container, and it counts against the same
warm-container limits as any other. **One candidate at a time**: choosing
another retires the first, and the totals reset — figures gathered against a
different candidate answer a question nobody asked.

Stopping it takes the copy down and leaves nothing behind. Adopting it is the
ordinary **Redeploy** to that version; shadowing does not promote anything by
itself, and never will. It measures. A person switches.

Both starting and stopping are audited, as `ml.shadow.start` and
`ml.shadow.stop`.

## Forecasting in BI

Line charts on a BI dashboard project ahead with the platform's shared
forecaster: seasonal exponential smoothing when the history shows a season
that beats a straight line, a linear trend otherwise, with a residual band
that widens with distance. The AI Analyst and the alert engine use the same
module, so a chart, its write-up and its alert cannot disagree.

### What a forecast period is

A forecast is a series of one value per period: the total (or average) of
the target over every hour, day, week, month or quarter, as you chose in the
wizard. **Automatic** infers the period from the gaps between timestamps,
which turns a table of dated orders into a _daily_ series - fine for a
month of data, surprising when you expected months. Pick the period you
will read the answer in. The last period the data only partly covers (the
week the extract stopped in) is left out and the version says so, because a
partial total misleads every candidate.

Five candidates compete on a holdout of the most recent periods: last value
(every future period repeats the last one), moving average (the mean of the
recent periods), seasonal naive, Holt-Winters and gradient boosting on lags.
The one with the lowest RMSE serves, so a flat line means the flat
baselines beat the rest on your series - a noisy daily series often says
exactly that. The model page, the agent tool and the API all state the
period, the aggregation, the last observed period and the method, so a
number is never read at the wrong granularity.

A forecast model from the registry can be attached instead: in the widget's
time-series options choose it as the **Source** beside the period count, and
the chart draws the model's projected periods. An alert's **basis** can be
the forecast — "notify me when the projected total for the next three months
falls below target" — evaluated at each scheduled refresh against the
model's current projection, as the dashboard's owner.

## Sharing and governance

Share a model from **Admin → IAM → Access** as **ML model**. A grantee can
predict with it — try-it, batch, and through agents — and read its metrics;
training, promotion, renaming and deletion stay with the owner, who gets the
same "not found" a stranger would when a grantee tries. Batch outputs are
written to a schema the caller owns, never to a shared or mounted one.

Creation, renaming, promotion and deletion are audited by a database trigger
(`ml_model.create`, `ml_model.update`, `ml_model.delete`), so no code path can
do them silently; training and prediction events are audited by the server
with the decision id.

## Limits

Every limit resolves **settings row → environment variable → default** and
is edited under **Admin → Developer runtime**; nothing in the code caps
them. A large VM or a Kubernetes node pool is allowed to use itself.

| Setting                                | Default   | What it bounds                                         |
| -------------------------------------- | --------- | ------------------------------------------------------ |
| `ML_TRAIN_MAX_ROWS`                    | 2,000,000 | Rows one training run reads; larger tables are sampled |
| `ML_TRAIN_TIME_BUDGET_MINUTES`         | 30        | Default wall-clock budget per run                      |
| `ML_TRAIN_MEM_LIMIT_MB`                | 8192      | Memory ceiling of a training sandbox                   |
| `ML_MAX_CONCURRENT_TRAININGS_PER_USER` | 2         | Training jobs one user may have live at once           |
| `ML_PREDICT_MAX_ROWS`                  | 5,000,000 | Rows one batch prediction may score                    |
| `ML_API_RATE_LIMIT_PER_MIN`            | 60        | Calls a minute one ML API key may make                 |
| `ML_TRAIN_GPUS`                        | 0         | GPUs requested per training sandbox                    |
| `ML_DRIFT_ALERT_PSI`                   | 0.25      | PSI above which a prediction run raises a drift alert  |
| `ML_ARTIFACT_MAX_MB`                   | 512       | Largest model a notebook run may save through the app  |
| `ML_MAX_DEPLOYMENTS_PER_USER`          | 2         | Warm endpoints one person may hold open                |
| `ML_MAX_DEPLOYMENTS_TOTAL`             | 10        | Warm endpoints this instance may hold open             |

See [SCALE_AND_LIMITS.md](./SCALE_AND_LIMITS.md#machine-learning--srcutilsnotebookruntimeconfigserverts).

## Operations

- Training and inference need the notebook runtime services:
  `docker compose --profile notebooks up -d`. The runtime image bakes the ML
  stack (scikit-learn, LightGBM, statsmodels, DuckDB, pyarrow, s3fs); an
  older image installs it at job start.
- The sandbox reads Parquet through the egress proxy. The proxy's allow-list
  is brought up to date with the lake endpoint automatically before a job
  starts, so a lakehouse configured after the last runtime-settings save
  still works.
- Artifacts live under `ml-artifacts/` in the lake bucket. `npm run backup`
  mirrors the lake data path; add the artifacts prefix to your object-store
  backup as well.
- **On Kubernetes** training and prediction are batch Jobs in the notebook
  namespace, bounded by its `ResourceQuota` and `LimitRange` and scaled by
  adding nodes; the egress ConfigMap must admit the object store. The
  deployment guide's
  [ML platform on Kubernetes](./DEPLOYMENT.md#the-ml-platform-on-kubernetes)
  section has the three settings that matter.
- **GPUs.** `ML_TRAIN_GPUS` (or the Admin setting) requests that many GPUs
  for every training sandbox: a Docker device request on a single host, an
  `nvidia.com/gpu` limit on Kubernetes. The baked runtime image is CPU-only
  (scikit-learn, LightGBM); point `NOTEBOOK_RUNTIME_IMAGE` at a CUDA-capable
  build of it when the trainer's candidates or your own notebooks need one.

## How this compares

Where AgentSwarms stands against Databricks ML and SageMaker, honestly:

| Capability                 | AgentSwarms                                                                                                                                                                                                                                                                   | Databricks / SageMaker                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No-code AutoML             | Six tasks incl. clustering, anomaly, recommendation; tuning; data prep in the wizard                                                                                                                                                                                          | AutoML / Canvas: similar tasks, larger search spaces                 |
| Registry, stages, lineage  | Versions, stages, snapshot + decision id per version, artifact digests                                                                                                                                                                                                        | MLflow registry / Model Registry                                     |
| Batch scoring              | Into lakehouse tables, scheduled, with drift per run                                                                                                                                                                                                                          | Jobs / Batch Transform                                               |
| Real-time inference        | Warm endpoints hold one version in memory: 45 ms of scoring instead of a ~25 s container start; several copies per endpoint, scaled on measured load                                                                                                                          | Serving endpoints with autoscaling                                   |
| Serving at scale           | Several copies per endpoint, added on measured request rate and removed only when idle and clear of the line; on Kubernetes each copy is a Pod the scheduler may place anywhere. Shadow traffic: a candidate version scored on every real request, compared, and never served | Autoscaling across hosts, canary and shadow traffic                  |
| Drift monitoring           | PSI per feature on every batch, threshold alerts                                                                                                                                                                                                                              | Lakehouse Monitoring / Model Monitor (more statistics)               |
| Ground-truth monitoring    | Outcome source per model; the training metric recomputed on matched rows, with coverage; decay alerts on the platform clock                                                                                                                                                   | Model-quality monitoring jobs                                        |
| Model selection            | Candidates scored by cross-validation inside the training rows; the holdout is read once, for reporting. Fold spread on every version; TimeSeriesSplit for ordered data                                                                                                       | Cross-validation in AutoML / Autopilot                               |
| Calibration and thresholds | Reliability curve and Brier/ECE per version; calibration kept only when both improve; measured threshold sweep, set per version without retraining                                                                                                                            | Calibration in SageMaker Clarify; thresholds set in application code |
| Reason codes in batch      | Top-3 drivers and their effects as columns on the scored table, the same ablation as the single-row explanation; refused above a row ceiling rather than truncated                                                                                                            | Clarify batch explainability jobs                                    |
| Explainability             | Global permutation importance at training, plus per-row contributions by ablation against a typical row. Not Shapley values                                                                                                                                                   | SHAP per prediction, Clarify                                         |
| Fairness                   | Selection-rate ratio and error-rate gaps per group, per column; assistant suggests columns and proxies; four-fifths default                                                                                                                                                   | Clarify / bias reports                                               |
| Promotion approval         | Named approvers per model, in the same inbox as swarm approvals; a requester can never approve their own                                                                                                                                                                      | Approval workflows                                                   |
| Scheduled retraining       | Cron/cadence, promote-when-better, one platform clock                                                                                                                                                                                                                         | Workflows / Pipelines                                                |
| Public API                 | Per-model scoped keys, rate limits, audited denials, BYO registration                                                                                                                                                                                                         | Yes, IAM-based                                                       |
| Bring your own model       | Any joblib pipeline under a small contract                                                                                                                                                                                                                                    | Any framework, containers                                            |
| Feature store              | Feature views: score by key, read from the table training read; describes rather than materialises                                                                                                                                                                            | Yes                                                                  |
| Distributed / GPU training | The algorithm search spreads across several sandboxes; one model still trains in one container; GPUs requestable                                                                                                                                                              | Clusters, distributed frameworks, GPU instances                      |
| Experiment tracking        | Runs logged from a notebook or a script with params, metrics and curves; a run promotes into the registry                                                                                                                                                                     | MLflow / Experiments                                                 |
| Model cards                | Generated from the registry                                                                                                                                                                                                                                                   | SageMaker Model Cards                                                |
| Governance                 | IAM shares, trigger audit, decision ids, result digests, one statement guard for all data                                                                                                                                                                                     | Unity Catalog / IAM                                                  |
| Agents and BI              | Models are agent tools; forecasts and drift live in the BI layer                                                                                                                                                                                                              | Separate products                                                    |
| Cost and residency         | Self-hosted, your infrastructure, no per-call charges                                                                                                                                                                                                                         | Managed, metered                                                     |

Everything in the left column is shipped and tested. What is left, in the
order it is usually asked for:

- **Training one model across machines.** The algorithm search spreads over
  sandboxes, but a single fit still happens in one container, so a model too
  large for one box does not train here.
- **Canary traffic.** A candidate can be shadowed — scored on every real
  request and compared — but it cannot yet be given a share of real traffic to
  answer. Adoption is still a switch, taken once the shadow report justifies
  it.
- **Serving across machines.** On Docker every copy is a container on this
  machine, so the host is the ceiling. On Kubernetes copies do spread across
  nodes, but nothing grows the cluster itself when they run out of room.

## Use cases

### Which plan will a customer end up on?

1. Train a classification on `analytics.revenue_facts` with `plan` as the
   target. Identifiers (`order_id`, `customer_id`) are off by default; the
   constant `status` column cannot be chosen.
2. Read the confusion matrix and the importance chart: `region` and
   `net_usd` carry the signal.
3. Score the table in a batch run into `analytics.revenue_facts_plan_predictions`
   and give an agent the table as a source: "which customers are predicted to
   move to enterprise?" is now a query.

### How much is this order worth?

1. Train a regression with `net_usd` as the target and a two-minute budget;
   four candidates are tried and the best kept.
2. If the holdout error is high, add a row filter (`region = 'EMEA'`) or a
   custom `SELECT` with derived columns in **Prepare the data**, and train a
   new version with a quick tuning search.
3. Enable **ML Predictions** on an agent and ask it to estimate an order it
   describes.

### Next quarter's revenue, on the dashboard

1. Train a forecast on the dated `net_usd` totals, twelve periods ahead.
2. In the BI builder, attach the model as the line chart's forecast
   **Source**; the chart draws the projection and its band.
3. Add an alert with the forecast basis: projected total for the next three
   periods below target → notification. It re-evaluates against the model's
   current projection at every scheduled refresh.

## Started by a pipeline

A retrain or batch-predict schedule can be started by an ETL pipeline when
one of its runs succeeds, from the pipeline's Settings ("After it succeeds,
also…"). The schedule runs exactly as its own clock would start it — the
same version choice, the same promotion rule — and records the run on the
model's Operations tab with the trigger `chain`. The pipeline's owner must
own the schedule. See
[ETL pipelines → Beyond pipelines](./ETL_PIPELINES.md#beyond-pipelines-one-graph-from-ingest-to-model).

## Troubleshooting

| Symptom                                             | Cause and fix                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach the Docker socket-proxy"              | Read the rest of the message: "start the runtime services" means the proxy is down (`docker compose --profile notebooks up -d`); "did not answer" means the Docker daemon is busy or the proxy wedged — retry, then restart `notebook-docker-proxy`. |
| "egress proxy refused the lake endpoint (HTTP 403)" | The allow-list is re-applied at job start; if it persists, save the runtime settings under Admin → Developer runtime and check the egress config mount is writable.                                                                                  |
| "You already have a model called …"                 | Names are unique per user; the wizard defaults to `<table> · <target>`.                                                                                                                                                                              |
| A target is greyed out                              | Identifiers, free text and constant columns cannot be predicted; pick another column or prepare the data.                                                                                                                                            |
| "Every candidate failed"                            | Open the job's logs on the Jobs tab; the first candidate's error is quoted.                                                                                                                                                                          |
| "Recommendation needs at least 5 users and 3 items" | The user and item columns are swapped or too coarse; each row must be one interaction. Aggregate first with a custom `SELECT` if the table is wider than that.                                                                                       |
| "Clustering needs at least 20 rows"                 | Loosen the row filter; a group profile over a handful of rows says nothing.                                                                                                                                                                          |
| "Possible leakage: … on its own predicts …"         | A feature is the target in disguise or a key the model memorised. Drop it from the features and train a new version; the score will fall to something real.                                                                                          |
| Every group is one customer / every anomaly a date  | A many-valued category or a time column was selected explicitly and decided the distance. Let the trainer choose the features, or leave that column out.                                                                                             |
| "Projected values below 0 were floored at 0"        | The winning method extrapolated a decline past zero; the floor is the honest answer for a total. A longer history or a coarser period usually steadies the trend.                                                                                    |
