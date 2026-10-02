import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  CardGrid,
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
      <H2 id="guide">In this guide</H2>
      <P>
        The guide is five pages, in the order a model is made and used. The rest of this page is the
        overview: the tasks the trainer knows, worked use cases, and where the platform stands
        against the managed services.
      </P>
      <CardGrid
        items={[
          {
            to: "/docs/ml/training",
            title: "Training",
            body: "Prepare, train, read the results, and keep every version.",
          },
          {
            to: "/docs/ml/predictions",
            title: "Predictions",
            body: "Score rows, let agents predict, call the API, serve features by key.",
          },
          {
            to: "/docs/ml/serving",
            title: "Serving",
            body: "Warm endpoints, copies, shadow and canary versions.",
          },
          {
            to: "/docs/ml/trust",
            title: "Trust",
            body: "Drift, explanations, accuracy over time, calibration, thresholds, fairness.",
          },
          {
            to: "/docs/ml/operations",
            title: "Operations",
            body: "Sharing, limits, operations, troubleshooting.",
          },
        ]}
      />

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
            "number over a date column, a period",
            "last value, moving average, seasonal naive, Holt-Winters, gradient boosting on lag features",
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
      <H2 id="how-this-compares">How this compares</H2>
      <P>Where AgentSwarms stands against Databricks ML and SageMaker, honestly:</P>
      <Table
        headers={["Capability", "AgentSwarms", "Databricks / SageMaker"]}
        rows={[
          [
            "No-code AutoML",
            "Six tasks incl. clustering, anomaly, recommendation; tuning; data prep in the wizard",
            "AutoML / Canvas: similar tasks, larger search spaces",
          ],
          [
            "Registry, stages, lineage",
            "Versions, stages, snapshot + decision id per version, artifact digests",
            "MLflow registry / Model Registry",
          ],
          [
            "Batch scoring",
            "Into lakehouse tables, scheduled, with drift per run",
            "Jobs / Batch Transform",
          ],
          [
            "Real-time inference",
            "Warm endpoints hold the served version in memory: 45 ms of scoring instead of a ~25 s container start; several copies per endpoint, scaled on measured load, plus a candidate's copy while one is being tried",
            "Serving endpoints with autoscaling",
          ],
          [
            "Serving at scale",
            "Several copies per endpoint, added on measured request rate and removed only when idle and clear of the line; on Kubernetes each copy is a Pod the scheduler may place anywhere. Shadow traffic (mirrored, compared, never served) and canary traffic (a share of real requests answered by the candidate, rolled back automatically when it fails worse than production)",
            "Autoscaling across hosts, canary and shadow traffic",
          ],
          [
            "Drift monitoring",
            "PSI per feature on every batch, threshold alerts",
            "Lakehouse Monitoring / Model Monitor (more statistics)",
          ],
          [
            "Ground-truth monitoring",
            "Outcome source per model; the training metric recomputed on matched rows, with coverage; decay alerts on the platform clock",
            "Model-quality monitoring jobs",
          ],
          [
            "Model selection",
            "Candidates scored by cross-validation inside the training rows; the holdout is read once, for reporting. Fold spread on every version; TimeSeriesSplit for ordered data",
            "Cross-validation in AutoML / Autopilot",
          ],
          [
            "Calibration and thresholds",
            "Reliability curve and Brier/ECE per version; calibration kept only when both improve; measured threshold sweep, set per version without retraining",
            "Calibration in SageMaker Clarify; thresholds set in application code",
          ],
          [
            "Reason codes in batch",
            "Top-3 drivers and their effects as columns on the scored table, the same ablation as the single-row explanation; refused above a row ceiling rather than truncated",
            "Clarify batch explainability jobs",
          ],
          [
            "Explainability",
            "Global permutation importance at training, plus per-row contributions by ablation against a typical row. Not Shapley values",
            "SHAP per prediction, Clarify",
          ],
          [
            "Fairness",
            "Selection-rate ratio and error-rate gaps per group, per column; assistant suggests columns and proxies; four-fifths default",
            "Clarify / bias reports",
          ],
          [
            "Promotion approval",
            "Named approvers per model, in the same inbox as swarm approvals; a requester can never approve their own",
            "Approval workflows",
          ],
          [
            "Scheduled retraining",
            "Cron/cadence, promote-when-better, one platform clock",
            "Workflows / Pipelines",
          ],
          [
            "Public API",
            "Per-model scoped keys, rate limits, audited denials, BYO registration",
            "Yes, IAM-based",
          ],
          [
            "Bring your own model",
            "Any joblib pipeline under a small contract",
            "Any framework, containers",
          ],
          [
            "Feature store",
            "Feature views: score by key, read from the table training read, with an online store serving the latest row per key in ~2 ms",
            "Yes",
          ],
          [
            "Distributed / GPU training",
            "The algorithm search spreads across several sandboxes, and a dataset too large for one container is refit across several — disjoint hashed slices, averaged into one model, instead of a sample; GPUs requestable",
            "Clusters, distributed frameworks, GPU instances",
          ],
          [
            "Experiment tracking",
            "Runs logged from a notebook or a script with params, metrics and curves; a run promotes into the registry",
            "MLflow / Experiments",
          ],
          ["Model cards", "Generated from the registry", "SageMaker Model Cards"],
          [
            "Governance",
            "IAM shares, trigger audit, decision ids, result digests, one statement guard for all data",
            "Unity Catalog / IAM",
          ],
          [
            "Agents and BI",
            "Models are agent tools; forecasts and drift live in the BI layer",
            "Separate products",
          ],
          [
            "Cost and residency",
            "Self-hosted, your infrastructure, no per-call charges",
            "Managed, metered",
          ],
        ]}
      />
      <P>
        Everything in the left column is shipped and tested. What is left:{" "}
        <strong>growing the cluster itself</strong>. On Kubernetes copies already spread across
        nodes — each is a pod, placed by the scheduler — and a copy that cannot be placed now says
        so rather than timing out. What the platform does not do is add a node: that is a cluster
        autoscaler&apos;s job, and it acts on exactly the pending pod this produces. On Docker every
        copy is a container on one host by design; spreading them further means running an
        orchestrator, which is what the Kubernetes deployment is.
      </P>

      <NextPrev current="/docs/ml" />
    </>
  );
}
