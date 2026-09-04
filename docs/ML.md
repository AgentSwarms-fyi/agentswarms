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
- **Training** — a four-step wizard (data, target, options, review) drives a
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

| Task              | What it needs                                    | Candidates tried                                                                          | Primary metric |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| Classification    | category, boolean, small-domain target           | logistic regression, random forest, histogram gradient boosting, LightGBM                 | F1 (macro)     |
| Regression        | number target                                    | ridge, random forest, histogram gradient boosting, LightGBM                               | RMSE           |
| Forecast          | number target over a date column                 | last value, seasonal naive, Holt-Winters (statsmodels), gradient boosting on lag features | RMSE           |
| Clustering        | feature columns only                             | k-means for two to ten groups (or a fixed k), kept by silhouette                          | Silhouette     |
| Anomaly detection | feature columns only                             | isolation forest (200 trees); 2% flagged unless a share is given                          | Anomaly rate   |
| Recommendation    | a user column, an item column, optional strength | item-item cosine similarity on the interaction matrix; popularity for cold starts         | Hit rate @10   |

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

## Train a model

1. **Data** — pick a lakehouse table you own or that was shared with you. The
   profile shows each column's kind, distinct count, nulls and samples.
2. **Goal** — _predict a column_ (the task follows from the column; a
   forecast additionally takes a time column, the periods ahead and how rows
   in one period combine), _find groups_ (a fixed number, or the best of two
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

## Versions

**Versions** lists every version with its stage, algorithm, primary metric,
rows and snapshot. **Promote** makes a ready version the production one (the
previous production version is archived); **Archive** withdraws a version
without deleting its metrics or passport; **Restore** returns it to the
candidates. **Train new version** re-reads the table as of the current
snapshot with the model's saved data preparation, and takes its own budget,
row limit and tuning mode.

## Predictions

**Try it** — a form generated from the feature schema (medians and category
lists filled in). One row is scored in a sandbox, so allow half a minute; the
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

## Forecasting in BI

Line charts on a BI dashboard project ahead with the platform's shared
forecaster: seasonal exponential smoothing when the history shows a season
that beats a straight line, a linear trend otherwise, with a residual band
that widens with distance. The AI Analyst and the alert engine use the same
module, so a chart, its write-up and its alert cannot disagree.

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

## Troubleshooting

| Symptom                                             | Cause and fix                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach the Docker socket-proxy"              | The runtime services are down: `docker compose --profile notebooks up -d`.                                                                                          |
| "egress proxy refused the lake endpoint (HTTP 403)" | The allow-list is re-applied at job start; if it persists, save the runtime settings under Admin → Developer runtime and check the egress config mount is writable. |
| "You already have a model called …"                 | Names are unique per user; the wizard defaults to `<table> · <target>`.                                                                                             |
| A target is greyed out                              | Identifiers, free text and constant columns cannot be predicted; pick another column or prepare the data.                                                           |
| "Every candidate failed"                            | Open the job's logs on the Jobs tab; the first candidate's error is quoted.                                                                                         |
| "Recommendation needs at least 5 users and 3 items" | The user and item columns are swapped or too coarse; each row must be one interaction. Aggregate first with a custom `SELECT` if the table is wider than that.      |
| "Clustering needs at least 20 rows"                 | Loosen the row filter; a group profile over a handful of rows says nothing.                                                                                         |
