import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/ml")({
  head: () => ({
    meta: [
      { title: "ML Models — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Train classification, regression and forecasting models on lakehouse tables without code; a governed registry with versions, predictions written back to the lakehouse, an agent tool and forecasts on dashboards.",
      },
      { property: "og:title", content: "ML Models — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "No-code machine learning on your lakehouse, governed like everything else.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml" }],
  }),
  component: MlDocsPage,
});

function MlDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models"
        description="Train a model on a lakehouse table without writing code, keep every version with its metrics and the snapshot it learned from, score rows back into the lakehouse, let agents predict with it, and draw its forecasts on a dashboard — all on your own infrastructure."
      />

      <H2 id="what">What it is</H2>
      <UL>
        <li>
          <strong>Registry</strong> — <strong>Data &amp; BI → ML Models</strong>: every model you
          own or were granted, its production version&apos;s headline metric, what it predicts from,
          and whether something is training right now.
        </li>
        <li>
          <strong>Training</strong> — a four-step wizard drives a batch sandbox of the notebook
          runtime that profiles the table, tries several algorithms under a time budget and keeps
          the best one with its metrics, leaderboard and feature importance.
        </li>
        <li>
          <strong>Versions and stages</strong> — each run is a version: candidate, staging,
          production or archived. The first successful version is promoted automatically; later ones
          by hand. Production is exclusive per model and is what agents and dashboards use.
        </li>
        <li>
          <strong>Predictions</strong> — a try-it form for one row, a batch run that scores a whole
          lakehouse table into a new table you own, and the <C>ml_predict</C> tool for agents.
        </li>
        <li>
          <strong>Forecasting</strong> — time-series models whose projected periods a BI line chart
          can draw and a forecast-basis alert can watch.
        </li>
      </UL>
      <P>
        A model is governed like every other resource: owner-only, shareable read-only through IAM,
        audited by a database trigger, and every training run and prediction run carries a decision
        id and a passport.
      </P>

      <H2 id="tasks">Tasks</H2>
      <Table
        headers={["Task", "What it needs", "Candidates tried", "Primary metric"]}
        rows={[
          [
            "Classification",
            "category, boolean, small domain",
            "logistic regression, random forest, histogram gradient boosting, LightGBM",
            "F1 (macro)",
          ],
          [
            "Regression",
            "number",
            "ridge, random forest, histogram gradient boosting, LightGBM",
            "RMSE",
          ],
          [
            "Forecast",
            "number over a date column",
            "last value, seasonal naive, Holt-Winters, gradient boosting on lag features",
            "RMSE",
          ],
          [
            "Clustering",
            "feature columns only",
            "k-means for two to ten groups (or a fixed k), kept by silhouette",
            "Silhouette",
          ],
          [
            "Anomaly detection",
            "feature columns only",
            "isolation forest (200 trees); 2% flagged unless a share is given",
            "Anomaly rate",
          ],
          [
            "Recommendation",
            "a user column, an item column, optional strength",
            "item-item cosine similarity on the interaction matrix; popularity for cold starts",
            "Hit rate @10",
          ],
        ]}
      />
      <P>
        The first three predict a chosen column. Clustering and anomaly detection have no target:
        they describe the rows from the selected features and report a{" "}
        <strong>profile of every group</strong> or a <strong>score per row</strong>. Recommendation
        learns from interactions — one row per user and item, optionally weighted by a rating, a
        quantity or an amount — and is scored on a held-out interaction per user. Free-text columns
        (average length twenty characters or more) become <strong>TF-IDF features</strong> for every
        task instead of being dropped; clustering and anomaly detection compress them to twenty
        dense components so a text column cannot swamp the numbers.
      </P>
      <P>
        The wizard suggests a task from a real profile of the table (<C>SUMMARIZE</C> plus a
        sample). A float column is never mistaken for an identifier because its values are unique;
        an integer column named like an id is; a constant column cannot be a target at all.
      </P>

      <H2 id="prepare">Prepare a training set</H2>
      <P>
        The wizard&apos;s <strong>Prepare the data</strong> panel filters rows and fills, scales and
        encodes columns for one model. For the wrangling that comes before that — joins across
        tables, dedupe, split and replace, pivots, derived columns, aggregation — use{" "}
        <DocLink to="/docs/data-prep#lakehouse">Data preparation</DocLink> with lakehouse tables:
        link the tables, build the steps with a per-step preview, and{" "}
        <strong>Save as → lakehouse table</strong>. The result is an ordinary lakehouse table in a
        schema you own, rebuilt on the flow&apos;s schedule, and it appears in the wizard&apos;s
        table picker at once.
      </P>

      <H2 id="train">Train a model</H2>
      <Steps
        items={[
          {
            title: "Data",
            body: "Pick a lakehouse table you own or that was shared with you. The profile shows each column's kind, distinct count, nulls and samples.",
          },
          {
            title: "Goal",
            body: "Predict a column (the task follows from the column; a forecast also takes a time column, the periods ahead and how rows in one period combine), find groups (a fixed number or the best by silhouette), find anomalies (the share you expect, 2% unless told otherwise), or recommend items (a user column, an item column and an optional strength).",
          },
          {
            title: "Options",
            body: (
              <>
                Name, description, features (identifier-like and constant columns are off by
                default) and <strong>Prepare the data</strong>: a row filter (SQL <C>WHERE</C>) or a
                custom <C>SELECT</C> for joins and derived columns — <strong>Check</strong> runs it
                through the lakehouse guard as you and reports how many rows match — how missing
                values are filled, standardisation, one-hot or ordinal encoding, balanced class
                weights, winsorised targets; <strong>hyperparameter tuning</strong> (none, quick or
                thorough, run on the two best candidates while at least 40% of the budget remains
                and kept only when it beats the untuned model on the holdout); the time budget and
                the row limit.
              </>
            ),
          },
          {
            title: "Review and Train",
            body: "The model page streams the job's logs while it runs and shows metrics the moment it finishes.",
          },
        ]}
      />
      <Callout kind="info" title="What a version records">
        The lakehouse snapshot current when training began, a decision id, the algorithm, the
        holdout metrics, the leaderboard, permutation importance on the raw columns, dropped columns
        and why, and the SHA-256 of the serialised pipeline, stored under <C>ml-artifacts/</C> in
        the lake bucket — outside the DuckLake data path, so orphan-file cleanup can never delete a
        model. Inference refuses an artifact whose bytes do not hash to the digest.
      </Callout>

      <H2 id="results">Read the results</H2>
      <UL>
        <li>
          <strong>Metric tiles</strong> — the primary metric first, then accuracy, ROC AUC, log
          loss, MAE, R², MAPE as the task allows.
        </li>
        <li>
          <strong>What the model relies on</strong> — permutation importance on the holdout set: how
          much the score drops when a column is shuffled. It names the columns a person recognises,
          not one-hot fragments.
        </li>
        <li>
          <strong>Groups</strong> for clustering: every group's size and share with its typical row
          — the mean of each number, the most common category.
        </li>
        <li>
          <strong>Confusion matrix</strong> for classification; a <strong>forecast chart</strong>{" "}
          with history, projection and a residual-based band for forecasts.
        </li>
        <li>
          <strong>Leaderboard</strong> — every candidate tried, scored on the same holdout, with fit
          time, status and tuning trials.
        </li>
        <li>
          <strong>Lineage</strong> — rows (and whether sampled), snapshot, decision id, artifact
          digest, warnings.
        </li>
      </UL>

      <H2 id="versions">Versions</H2>
      <P>
        The Versions tab lists every version with its stage, algorithm, primary metric, rows and
        snapshot. <strong>Promote</strong> makes a ready version the production one and archives the
        previous; <strong>Archive</strong> withdraws a version without deleting its metrics or
        passport; <strong>Restore</strong> returns it to the candidates.{" "}
        <strong>Train new version</strong> re-reads the table as of the current snapshot with the
        model&apos;s saved data preparation, and takes its own budget, row limit and tuning mode.
      </P>

      <H2 id="predictions">Predictions</H2>
      <H3 id="try-it">Try it</H3>
      <P>
        A form generated from the feature schema, medians and category lists filled in. One row is
        scored in a sandbox, so allow half a minute; the result shows the predicted class with its
        confidence and the per-class probabilities, or the predicted number.
      </P>
      <H3 id="batch">Batch prediction</H3>
      <P>
        Pick an input lakehouse table with the same columns, an optional filter, and an output
        schema you own plus a table name. Every row is written back with <C>prediction</C>,{" "}
        <C>probability</C>, one <C>proba_&lt;class&gt;</C> column per class, <C>_model_version</C>{" "}
        and <C>_predicted_at</C>. The result is an ordinary lakehouse table: agents, the SQL
        workbench and dashboards query it like any other. The operator&apos;s{" "}
        <C>ML_PREDICT_MAX_ROWS</C> is checked before a sandbox starts.
      </P>
      <P>
        Every prediction run carries its own decision id unless it serves an agent&apos;s turn, in
        which case it adopts that turn&apos;s; success is audited as a data read (
        <C>ml.predict_query</C>) with a digest over the prediction column and the row cap, so a
        replay can tell &ldquo;same model, same rows, same answers&rdquo; from drift.
      </P>
      <H3 id="agents">Agents</H3>
      <P>
        Enable <strong>ML Predictions</strong> in an agent&apos;s tools. The agent gets{" "}
        <C>ml_list_models</C> (name, task, target, feature columns with categories and ranges) and{" "}
        <C>ml_predict</C> (rows in, predictions out). Both are offered only when the caller can use
        at least one model with a production version; on headless runs grants are re-derived from
        the run&apos;s owner. Forecast models return their projected periods.
      </P>

      <H2 id="api">Public API</H2>
      <P>
        A model can be published as an API. <strong>Publish as API</strong> on the model page mints
        a key that looks like <C>mlk_…</C>, shown once and stored hashed, scoped to that one model
        with any of <C>predict</C> (score rows, start batch runs), <C>train</C> (train a version,
        register an external one) and <C>read</C> (list the model, poll jobs and runs). Every call
        runs on the same service the app uses — the same limits, the same lakehouse guard, the same
        audit trail — and is attributed to its key; a denied call (unknown, revoked, expired, wrong
        scope, rate-limited) is audited as <C>ml.api_key.denied</C> with the caller&apos;s address.
      </P>
      <Table
        headers={["Endpoint", "Scope", "Body", "Answer"]}
        rows={[
          [<C key="a">POST /api/ml/models</C>, "read", "—", "the model, its features and versions"],
          [
            <C key="b">POST /api/ml/train</C>,
            "train",
            "time_budget_minutes, max_rows, tuning, prep, feature_columns (all optional)",
            "202 with job_id and version_id",
          ],
          [
            <C key="c">POST /api/ml/train/status</C>,
            "read",
            "job_id",
            "status, the version's metrics when ready, the log tail",
          ],
          [
            <C key="d">POST /api/ml/predict</C>,
            "predict",
            "rows (up to 200), version_id, wait_seconds",
            "200 with columns and rows, or 202 with a prediction_id to poll",
          ],
          [
            <C key="e">POST /api/ml/predict/batch</C>,
            "predict",
            "input {schema, table, where}, output {schema, table}, version_id",
            "202 with a prediction_id; the output is a lakehouse table you own",
          ],
          [
            <C key="f">POST /api/ml/predict/status</C>,
            "read",
            "prediction_id",
            "status, row count, columns, a sample, the result digest",
          ],
          [
            <C key="g">POST /api/ml/models/register</C>,
            "train",
            "artifact_uri, artifact_sha256, algorithm, metrics, feature_schema, classes, promote",
            "201 with the new version",
          ],
        ]}
      />
      <Code lang="bash">{`curl -X POST https://your-instance/api/ml/predict \\
  -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" \\
  -d '{"rows":[{"region":"EMEA","net_usd":480,"payment_rows":1}]}'
# → {"prediction_id":"…","columns":["region","net_usd","payment_rows","prediction","probability",…],"rows":[[…]]}

curl -X POST https://your-instance/api/ml/predict/batch \\
  -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" \\
  -d '{"input":{"schema":"analytics","table":"revenue_facts"},"output":{"schema":"analytics","table":"revenue_scored"}}'
# → 202 {"accepted":true,"prediction_id":"…","output":"analytics.revenue_scored"}`}</Code>
      <P>
        Answers use ordinary status codes: <C>401</C> for a missing, unknown, revoked or expired
        key, <C>403</C> for a missing scope, <C>404</C> for a job or run of another model (never
        403, so a key learns nothing about what it cannot see), <C>409</C> when the service refuses
        (no trained version, a limit reached, a schema you do not own) and <C>429</C> above the
        per-key rate limit, <C>ML_API_RATE_LIMIT_PER_MIN</C> calls a minute (sixty by default,
        edited like every other limit).
      </P>
      <H3 id="external-models">Bring your own model</H3>
      <P>
        A model trained elsewhere — a notebook, a laptop, another platform — can serve through the
        same registry. Write the artifact into the lake bucket as a joblib dictionary with{" "}
        <C>task</C>, <C>pipeline</C> (any object with <C>predict</C>, plus <C>predict_proba</C> for
        a classifier), <C>features</C> (the input columns, in order) and, for a classifier,{" "}
        <C>classes</C>, then register it with its SHA-256; inference verifies the digest before
        loading it, hands the pipeline the raw feature columns, and returns the same columns a
        trained version would. Classification, regression, clustering and anomaly models accept
        external versions; the first one is promoted when the model has no production version.
      </P>

      <H2 id="forecasting">Forecasting in BI</H2>
      <P>
        Line charts on a dashboard project ahead with the platform&apos;s shared forecaster:
        seasonal exponential smoothing when the history shows a season that beats a straight line, a
        linear trend otherwise, with a residual band that widens with distance. The AI Analyst and
        the alert engine use the same module, so a chart, its write-up and its alert cannot
        disagree.
      </P>
      <P>
        A forecast model from the registry can be attached instead: in the widget&apos;s time-series
        options choose it as the <strong>Source</strong> beside the period count, and the chart
        draws the model&apos;s projected periods. An alert&apos;s <strong>basis</strong> can be the
        forecast — the aggregate over the next N projected periods — evaluated at each scheduled
        refresh against the model&apos;s current projection, as the dashboard&apos;s owner.
      </P>

      <H2 id="sharing">Sharing and governance</H2>
      <P>
        Share a model from <strong>Admin → IAM → Access</strong> as <strong>ML model</strong>. A
        grantee can predict with it — try-it, batch, and through agents — and read its metrics;
        training, promotion, renaming and deletion stay with the owner. Batch outputs are written to
        a schema the caller owns, never to a shared or mounted one. Creation, renaming, promotion
        and deletion are audited by a database trigger (<C>ml_model.create</C>,{" "}
        <C>ml_model.update</C>, <C>ml_model.delete</C>); training and prediction events are audited
        by the server with the decision id (<C>ml.train.start</C>, <C>ml.train.succeeded</C>,{" "}
        <C>ml.version.promote</C>, <C>ml.predict_query</C>).
      </P>

      <H2 id="limits">Limits</H2>
      <P>
        Every limit resolves settings row → environment variable → default and is edited under{" "}
        <strong>Admin → Developer runtime</strong>; nothing in the code caps them. A large VM or a
        Kubernetes node pool is allowed to use itself.
      </P>
      <Table
        headers={["Setting", "Default", "What it bounds"]}
        rows={[
          [
            <C key="a">ML_TRAIN_MAX_ROWS</C>,
            "2,000,000",
            "Rows one training run reads; larger tables are reservoir-sampled",
          ],
          [<C key="b">ML_TRAIN_TIME_BUDGET_MINUTES</C>, "30", "Default wall-clock budget per run"],
          [<C key="c">ML_TRAIN_MEM_LIMIT_MB</C>, "8192", "Memory ceiling of a training sandbox"],
          [
            <C key="d">ML_MAX_CONCURRENT_TRAININGS_PER_USER</C>,
            "2",
            "Training jobs one user may have live at once",
          ],
          [<C key="e">ML_PREDICT_MAX_ROWS</C>, "5,000,000", "Rows one batch prediction may score"],
          [
            <C key="f">ML_API_RATE_LIMIT_PER_MIN</C>,
            "60",
            "Calls a minute one ML API key may make",
          ],
        ]}
      />

      <H2 id="operations">Operations</H2>
      <UL>
        <li>
          Training and inference need the notebook runtime services:{" "}
          <C>docker compose --profile notebooks up -d</C>. The runtime image bakes scikit-learn,
          LightGBM, statsmodels, DuckDB, pyarrow and s3fs; an older image installs them at job
          start.
        </li>
        <li>
          The sandbox reads Parquet through the egress proxy; its allow-list is brought up to date
          with the lake endpoint automatically before a job starts.
        </li>
        <li>
          Artifacts live under <C>ml-artifacts/</C> in the lake bucket. <C>npm run backup</C>{" "}
          mirrors the lake data path; add the artifacts prefix to your object-store backup as well.
        </li>
      </UL>

      <H2 id="use-cases">Use cases</H2>
      <H3 id="use-case-plan">Which plan will a customer end up on?</H3>
      <Steps
        items={[
          {
            title: "Train a classification with plan as the target",
            body: "Identifiers are off by default and the constant status column cannot be chosen. Read the confusion matrix and the importance chart.",
          },
          {
            title: "Score the table in a batch run and hand the output table to an agent",
            body: "Which customers are predicted to move to enterprise? is now a query over your own lakehouse table.",
          },
        ]}
      />
      <H3 id="use-case-order">How much is this order worth?</H3>
      <Steps
        items={[
          {
            title: "Train a regression on net_usd with a two-minute budget",
            body: "Four candidates are tried and the best kept.",
          },
          {
            title: "If the holdout error is high, prepare the data",
            body: "Add a row filter or a custom SELECT with derived columns, and train a new version with a quick tuning search.",
          },
          {
            title: "Enable ML Predictions on an agent",
            body: "Ask it to estimate an order it describes; the tool reads the feature columns from ml_list_models.",
          },
        ]}
      />
      <H3 id="use-case-forecast">Next quarter&apos;s revenue, on the dashboard</H3>
      <Steps
        items={[
          {
            title: "Train a forecast on the dated totals, twelve periods ahead",
          },
          {
            title: "Attach it to a line chart as the forecast Source",
            body: "The chart draws the projection and its band.",
          },
          {
            title: "Add an alert with the forecast basis",
            body: "Projected total for the next three periods below target → notification, re-evaluated at every scheduled refresh.",
          },
        ]}
      />

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "Cannot reach the Docker socket-proxy",
            "The runtime services are down: docker compose --profile notebooks up -d.",
          ],
          [
            "egress proxy refused the lake endpoint (HTTP 403)",
            "The allow-list is re-applied at job start; if it persists, save the runtime settings under Admin → Developer runtime and check the egress config mount is writable.",
          ],
          [
            "You already have a model called …",
            "Names are unique per user; the wizard defaults to <table> · <target>.",
          ],
          [
            "A target is greyed out",
            "Identifiers, free text and constant columns cannot be predicted; pick another column or prepare the data.",
          ],
          [
            "Every candidate failed",
            "Open the job's logs on the Jobs tab; the first candidate's error is quoted.",
          ],
        ]}
      />

      <NextPrev current="/docs/ml" />
    </>
  );
}
