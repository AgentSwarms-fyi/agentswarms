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
            body: "Predict a column (the task follows from the column; a forecast also takes a time column, the period - hourly to quarterly, or automatic from the dates - the periods ahead and how rows in one period combine), find groups (a fixed number or the best by silhouette), find anomalies (the share you expect, 2% unless told otherwise), or recommend items (a user column, an item column and an optional strength).",
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

      <H3 id="search-workers">A search across several sandboxes</H3>
      <P>
        A training job tries several algorithms and then tunes the best of them, and by default it
        does all of that inside <strong>one</strong> container, one candidate after another. Set{" "}
        <strong>Search workers</strong> under <strong>Admin → Developer runtime</strong> (or{" "}
        <C>ML_TRAIN_WORKERS</C>) above 1 and the search is dealt out instead: worker <em>w</em> of{" "}
        <em>n</em> takes candidates <em>w</em>, <em>w+n</em>, <em>w+2n</em>… and the job keeps
        whichever worker&apos;s model scored best.
      </P>
      <Callout title="A single model still trains in one container">
        Nothing here splits one fit across machines — that needs a distributed framework and a
        cluster, and a model that does not fit in one sandbox&apos;s memory still does not fit. What
        this buys is wall-clock on the search, which is where the wizard&apos;s time goes.
      </Callout>
      <UL>
        <li>
          <strong>Only classification and regression have a search to split.</strong> Clustering
          picks its <C>k</C> from the row count and forecasting its methods from the shape of the
          series, both inside the sandbox, so the server cannot deal out their candidates.
        </li>
        <li>
          <strong>Never more workers than candidates, or than the runtime allows.</strong> Sessions
          per user (3 by default) is the ceiling that actually bites, and it counts open notebooks
          too. A job takes fewer workers rather than failing to start the extras.
        </li>
        <li>
          <strong>A worker that dies does not lose the job.</strong> Three of four finishing still
          produces a model; the leaderboard is merged from everyone who reported, each row keeps the
          worker that ran it, and the version&apos;s warnings say how many did not come back. Only
          an all-workers-failed search fails.
        </li>
        <li>
          <strong>Ties break on the lowest worker number</strong>, so re-running the same job on the
          same data picks the same model.
        </li>
        <li>
          <strong>A split search is not the same search.</strong> Tuning runs per worker, on that
          worker&apos;s own best candidates, so several workers tune more models than one container
          would have and can land on a different winner from identical data. Usually a better search
          — but the two are not comparable runs, so train with the same worker count each time when
          exact reproduction matters.
        </li>
      </UL>

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

      <H3 id="warnings">What the trainer warns about</H3>
      <P>
        A score can be right and still mislead. The trainer checks for the usual ways and writes
        what it found on the version: the Versions tab counts them as <strong>notes</strong> on
        every version and opens them in place, the compare view lists them side by side, and the
        model card, the agent&apos;s prediction tool and the public API&apos;s model listing repeat
        them.
      </P>
      <UL>
        <li>
          <strong>Possible leakage</strong> — a single feature that predicts the target almost
          perfectly on its own (98% balanced accuracy, or 98% of a numeric target&apos;s variation)
          is usually the target in disguise: a code for it, a column filled in after the fact, a key
          the model memorises. The warning names the column; if it is derived from the target or
          unknown at prediction time, leave it out and train again.
        </li>
        <li>
          <strong>The do-nothing baseline</strong> — when nine rows in ten share one class, that
          share is the accuracy of predicting it every time. The warning says so and points at F1
          (macro), the primary metric, and the confusion matrix.
        </li>
        <li>
          <strong>No signal</strong> — a regression whose R² is at or below 0.05 explains about as
          much as the mean would.
        </li>
        <li>
          <strong>Columns that decide a distance on their own</strong> — clustering and anomaly
          detection compare rows by distance, so a column with more than 20 categories groups rows
          by its value rather than describing them, and a time column groups them by when they
          happened: the &quot;segments&quot; become customers, the &quot;anomalies&quot; the
          earliest and latest dates. Both are left out when the features were chosen automatically,
          and kept with a warning when you picked them yourself.
        </li>
        <li>
          <strong>The anomaly rate is a setting</strong> — the detector flags the top 2% (or the
          contamination you set) on clean data as much as dirty. Read the score, and set the share
          you expect.
        </li>
        <li>
          <strong>Strength is not sentiment</strong> — a recommendation&apos;s strength column adds
          up, so a 1-star rating still counts as a weak like. If low values mean dislike, filter
          those rows out first.
        </li>
        <li>
          <strong>Forecast history</strong> — a first or last period the data only partly covers is
          left out; an empty period of a total counts as 0 (an empty period of an average is
          interpolated); the holdout is at least three periods once there are twelve; a projection
          of a series that never goes below zero is floored at zero.
        </li>
        <li>
          <strong>A random holdout is not a time split</strong> — classification and regression hold
          out rows at random. If your rows are events over time, the score describes rows like the
          ones you have, not next quarter&apos;s; train on a prep flow that stops at a date to see
          how the model ages.
        </li>
      </UL>

      <H2 id="selection">How the winner is chosen</H2>
      <P>
        Training tries several algorithms and keeps the best. What &ldquo;best&rdquo; is measured
        against is the question this section answers — because for a long time the answer was wrong
        here, in a way that flattered every model the platform produced.
      </P>
      <H3 id="selection-mistake">The mistake, and what it cost</H3>
      <P>
        Every candidate used to be fitted on the training rows and scored on the{" "}
        <strong>holdout</strong>. The best of those scores picked the winner, the tuner then
        searched against the same holdout, and that very number was published as the version&apos;s
        metric.
      </P>
      <Callout kind="warn" title="Publishing a maximum publishes a bias">
        Taking the best of a dozen noisy estimates and printing it is the winner&apos;s curse: the
        number is too high by as much noise as the search could exploit. Measured over thirty seeds
        on data where the candidates were genuinely equivalent, the published F1 came out{" "}
        <strong>0.046 too high on average</strong>. Against a decay alert that fires at a ten per
        cent drop, most of the alert budget was gone before the model scored a single real row.
      </Callout>
      <H3 id="selection-now">What happens now</H3>
      <P>
        Selection happens <strong>inside the training rows</strong>, and the holdout is read once,
        at the end, by code that is only reporting.
      </P>
      <Table
        headers={["Scheme", "When"]}
        rows={[
          [
            <strong key="s">Stratified folds</strong>,
            "Classification with a small holdout. Each fold keeps the class mix.",
          ],
          [<strong key="k">Cross-validated folds</strong>, "Regression with a small holdout."],
          [
            <strong key="t">Time-ordered folds</strong>,
            "Any model given a time column. Always, whatever the holdout size.",
          ],
          [
            <strong key="i">One inner split</strong>,
            "A holdout already large enough that folds would buy almost nothing.",
          ],
        ]}
      />
      <P>
        Which scheme a version used, and why, is written on the version and shown under the metric
        tiles — together with the spread between folds, which is what makes the headline number
        readable. The spread is how much the score moves when the same model meets different rows,
        and therefore the scale below which a difference between two versions is noise.
      </P>
      <P>
        Folds cost k fits per candidate, so they are not always worth paying for. What decides is
        the <strong>size of the holdout</strong>, not the size of the training set: a few thousand
        held-out rows already pin the score to well under a point, while a few dozen pin nothing at
        all. The line sits at <C>ML_CV_MIN_HOLDOUT_ROWS</C> (2000), also editable under{" "}
        <strong>Admin → Developer runtime</strong>. A class with fewer examples than folds lowers
        the fold count; a class with a single example turns folds off altogether, because no set of
        folds can each contain one.
      </P>
      <P>
        The winner is refitted on every training row before it is saved. The folds existed to
        measure; the model that ships should have seen all the data selection was entitled to use.
      </P>
      <H3 id="selection-holdout">The holdout is read once</H3>
      <P>
        Two numbers therefore appear on a version, and they are not the same number:{" "}
        <strong>across the folds</strong>, which chose the winner, and{" "}
        <strong>on the held-back rows</strong>, which nothing was allowed to optimise against. The
        second is what the version reports and what a decay alert compares production against.
      </P>
      <P>
        They are shown side by side on purpose. When they disagree the disagreement is information:
        a winner that looked good on the folds and did not repeat itself on untouched rows is
        telling you something a single number would have hidden.{" "}
        <strong>Calibration is decided the same way</strong> — keeping or discarding it is also a
        choice, so it is made on a slice of the training rows, and only then are the Brier score and
        calibration error measured again on the holdout for reporting.
      </P>
      <H3 id="selection-time">Rows that are ordered in time</H3>
      <P>
        A table with a time column must not be split at random. Shuffling rows that have an order
        puts next month in the training set and last month in the holdout, and the score that comes
        back is the score for predicting the past from the future — reliably flattering, and
        reliably wrong the first time the model runs for real.
      </P>
      <P>
        Name a <strong>time column</strong> and three things change: rows are sorted by it, the most
        recent slice is what gets held back, and the folds become <C>TimeSeriesSplit</C> — every
        fold trains strictly before the rows it scores, on an expanding window of history. Time
        order wins over every other consideration, including a holdout large enough that a random
        split would otherwise have been used.
      </P>
      <P>
        If the column turns out to hold no readable dates, the run falls back to a random split and{" "}
        <strong>says so in the run log</strong>. Quietly shuffling rows after being told they are
        ordered is the version of this bug nobody would ever find.
      </P>

      <H2 id="versions">Versions</H2>
      <P>
        Tick two or more trained versions on the <strong>Versions</strong> tab to{" "}
        <strong>compare</strong> them side by side: every metric they share, rows, tuning and
        training time, with the best value in each row marked. The <strong>Model card</strong>{" "}
        button assembles one Markdown document from the registry rows — intended use, training data
        and snapshot, preparation, features and dropped columns, metrics and leaderboard,
        importance, groups, warnings, governance, how to call it — copied or downloaded; nobody
        types it, so it cannot drift from what shipped. The Versions tab lists every version with
        its stage, algorithm, primary metric, rows and snapshot. <strong>Promote</strong> makes a
        ready version the production one and archives the previous; <strong>Archive</strong>{" "}
        withdraws a version without deleting its metrics or passport; <strong>Restore</strong>{" "}
        returns it to the candidates. <strong>Train new version</strong> re-reads the table as of
        the current snapshot with the model&apos;s saved data preparation, and takes its own budget,
        row limit and tuning mode.
      </P>

      <H2 id="experiments">Experiments</H2>
      <P>
        Versions record what you <strong>shipped</strong>. Experiments record what you{" "}
        <strong>tried</strong>: the twenty runs behind the one version worth keeping, which
        otherwise live in a notebook&apos;s output cells until somebody re-runs it. Then &quot;why
        is this the learning rate&quot; has no answer a month later, and a colleague cannot see that
        the obvious idea was tried and did not work.
      </P>
      <P>
        An <strong>experiment</strong> is a named question; a <strong>run</strong> is one attempt at
        it, with the parameters it used and the metrics it got. Anything that can reach the platform
        can log one — a notebook with its session token, a script with a user token. From a notebook
        the client is already injected:
      </P>
      <Code>{`import agentswarms

with agentswarms.start_run("churn-v2", params={"lr": 0.01, "depth": 6}) as run:
    for epoch in range(10):
        run.log_metric("loss", loss, step=epoch)
    run.log_metrics({"auc": 0.91, "accuracy": 0.88})
    run.finish(artifact_uri=uri, artifact_sha256=digest)`}</Code>
      <UL>
        <li>
          <strong>It fails in the right direction.</strong> <C>start_run</C> raises if it cannot
          start — a run you believe is recording and is not is worse than one that never began.
          Every later call warns and continues: losing an epoch&apos;s metrics is not worth losing
          the epoch.
        </li>
        <li>
          <strong>The curve survives, and so does the score.</strong>{" "}
          <C>log_metric(key, value, step=n)</C> keeps the point as <C>key@n</C> and updates the bare{" "}
          <C>key</C> to the latest value. The panel draws those points as a sparkline beside the
          metric.
        </li>
        <li>
          <strong>It shows what actually varied.</strong> In a list of twenty runs the parameters
          held constant are noise; the ones that moved are marked, because that is the experiment.
        </li>
        <li>
          <strong>A finished run is finished.</strong> Later writes are refused, so a straggler from
          a process that outlived its own <C>finish</C> cannot rewrite the record.
        </li>
      </UL>
      <P>
        Find them under <strong>ML Models → Experiments</strong>. Nothing is created there: the
        first <C>start_run()</C> call creates its own experiment.
      </P>

      <H3 id="experiment-promote">From a run to a version</H3>
      <P>
        A run that recorded <strong>both</strong> <C>artifact_uri</C> and <C>artifact_sha256</C> can
        be registered from its row as a model version — both, because a version whose artifact
        nobody can verify is not a version. It goes through the same path a{" "}
        <DocLink to="/docs/ml" hash="external-models">
          registered external version
        </DocLink>{" "}
        takes, so the digest is checked before inference loads it and the artifact follows the same
        contract. It arrives as a <strong>candidate</strong>: promoting it is a separate, deliberate
        step on the Versions tab.
      </P>
      <H3 id="experiment-save">Saving the model from the notebook</H3>
      <P>
        Producing that artifact used to be the author&apos;s problem: write a joblib file in the
        registry&apos;s contract, get it into the lake bucket{" "}
        <strong>without the bucket&apos;s credentials</strong> (a kernel does not hold them, on
        purpose), hash it, and only then call <C>finish</C>. So notebook-authored models stayed in
        notebooks. Two calls close that gap:{" "}
        <C>run.save_model(pipe, features=list(X.columns), task=&quot;classification&quot;)</C> dumps
        the pipeline in the{" "}
        <DocLink to="/docs/ml" hash="external-models">
          external contract
        </DocLink>
        , sends the bytes to the platform, and the app writes them beside the artifacts its own
        trainer produces.{" "}
        <strong>The digest recorded is the one the app computes from the bytes that arrived</strong>{" "}
        — a digest the caller reported would be a digest nobody verified, and this one is what
        inference checks before loading. Unlike the logging calls this one raises: a save you
        believe happened and did not is the same lie as a run that never started.
      </P>
      <P>
        <C>run.register(&quot;churn&quot;, task=…, source=…, target_column=…)</C> then turns the run
        into a version — of a model by id or by name, and a name nothing owns yet{" "}
        <strong>creates the model</strong> from the lakehouse table the training data came from,
        checked as you. It arrives as a <strong>candidate</strong>, except on a model with nothing
        in production yet — always true of one this call just created — where the registry promotes
        the first version, as it does everywhere else. Both work from outside the platform with a
        user token, on <C>/api/ml/experiments/artifact</C> and <C>/api/ml/experiments/register</C>.
        One upload is bounded by <C>ML_ARTIFACT_MAX_MB</C> (512 MB), editable under{" "}
        <strong>Admin → Developer runtime → Machine learning</strong>.
      </P>
      <Callout title="Runs are data, not configuration">
        Creating an experiment writes an audit row; a metric does not, or a training loop logging
        per epoch would write more audit rows than the audit log is for. Promoting a run into the
        registry is audited as <C>ml.experiment.promote</C>, because that is the moment something
        becomes servable. Both tables are owner-only under RLS, and every write is re-checked
        against the caller&apos;s own id — a run id is a uuid, not a capability.
      </Callout>

      <H3 id="promotion-approval">Who signs off a promotion</H3>
      <P>
        Promotion is audited but ungated by default: anyone with write access can put a version in
        front of customers on their own. Where that is not enough — model-risk policy usually asks
        for a second signature <em>before</em> the change, from somebody who did not make it — name
        the approvers under <strong>Versions → Who signs off a promotion</strong>. With approvers
        named, <strong>Promote</strong> stops promoting and starts asking: the version keeps serving
        whatever it serves until one of them agrees, and the request appears under{" "}
        <strong>Pending approvals</strong> in the header, beside the swarm approvals. The same
        table, the same inbox — there is no second approvals system.
      </P>
      <Callout kind="warn" title="Nobody may approve their own promotion">
        Naming only yourself is refused at save; the requester is removed from the approver list
        when a request is raised; and the check runs again when the approval is applied, because
        reaching that line means somebody edited the row. A self-signed approval is worse than no
        gate at all — it produces an audit trail saying a review happened.
      </Callout>
      <P>
        <strong>Only production is gated</strong> — moving a version to staging or archiving it
        changes nothing a customer meets. <strong>The button says what it will do</strong>: with a
        gate on, the confirmation asks whether to <em>request</em> the promotion and says the
        version keeps serving what it serves now, because the dialog is where a gate is first
        visible and promising an immediate switch there would be a lie told at the moment somebody
        decides whether to press. The audit names both people — <C>ml.version.promote.requested</C>{" "}
        when it is asked for, and <C>ml.version.promote</C> with <C>approved_by</C> when it happens.
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

      <H2 id="automation">Automation</H2>
      <P>
        The model page&apos;s <strong>Automation</strong> tab schedules two kinds of work, each
        running as you, in the same sweep, under the same cron lease and with the same reaper as ETL
        pipelines and materialized views.
      </P>
      <UL>
        <li>
          <strong>Retrain</strong> — a new version from the current table every hour, day, week or
          on a cron expression, with its own budget and tuning mode. With{" "}
          <strong>promote when better</strong> on, the new version becomes production the moment it
          is ready if its primary metric beats the incumbent; you are told either way.
        </li>
        <li>
          <strong>Batch prediction</strong> — score a lakehouse table (optionally filtered) into a
          table you own with the production version, so a scored table stays fresh for dashboards
          and agents without anyone clicking.
        </li>
      </UL>
      <P>
        <strong>Run now</strong> starts a schedule immediately; <strong>pause</strong> keeps it
        without running it; resuming schedules from now, never from the missed past. Every start is
        audited (<C>ml.schedule.run</C> / <C>ml.schedule.failed</C>) and the schedule rows are
        audited by trigger.
      </P>

      <H2 id="drift">Drift</H2>
      <P>
        Training records the distribution of every feature — decile bins for numbers, the top
        categories for categoricals. Every batch prediction (and any direct prediction of ten rows
        or more) bins the new rows the same way and reports a{" "}
        <strong>population stability index</strong> per feature; the run&apos;s{" "}
        <strong>Drift</strong> badge shows the highest one: below 0.1 stable, 0.1–0.25 moderate,
        above 0.25 the population has moved. A run above <C>ML_DRIFT_ALERT_PSI</C> (0.25 by default)
        is audited as <C>ml.drift.alert</C> and notifies the model&apos;s owner with the three most
        drifted features — the cue to retrain, or to schedule retraining. The public API returns the
        same numbers in <C>/api/ml/predict/status</C>.
      </P>

      <H2 id="explain">Why this row got this answer</H2>
      <P>
        The model page shows what a model relies on <em>overall</em> — permutation importance over
        the raw input columns, measured once when the version trained. That answers &ldquo;what does
        this model key on&rdquo;. It does not answer &ldquo;why was this customer declined&rdquo;,
        which is the question a person asks when the answer is about them, and in credit, insurance
        or hiring it is one you may be obliged to answer.
      </P>
      <P>
        Tick <strong>Explain this answer</strong> under <strong>Try it</strong> on the Predictions
        tab. Each feature comes back with how far the answer moved when its value was replaced with
        the one a typical training row carried: bars to the right pushed the answer up, bars to the
        left pushed it down, in probability for a classification and in the target&apos;s own units
        for a regression.
      </P>
      <Callout kind="why" title="This is an ablation, and it is not SHAP">
        Nothing in the product calls it that, because a Shapley value has properties this does not:
        these contributions are not additive and they do not sum to the prediction. What they are is
        the <strong>local twin of the permutation importance</strong> already shown for the whole
        model — that shuffles a column across every row, this replaces one cell in one row — which
        is why the two can be read side by side and mean compatible things. The typical row comes
        from the same feature distribution drift already records inside the artifact: the middle
        quantile for a number, the commonest value for a category.
      </Callout>
      <P>
        It works on <strong>any</strong> model, including one registered from a notebook, because it
        only ever calls <C>predict</C>. The one case it declines is a classifier with no{" "}
        <C>predict_proba</C>: without probabilities the only measurable move is that the label
        flipped, which is a yes/no rather than a contribution, so it returns nothing rather than
        dressing a coin flip as a number.
      </P>
      <P>
        It costs one extra prediction per feature per row, so it is opt-in and bounded —{" "}
        <C>ML_EXPLAIN_MAX_ROWS</C> rows per request, <C>ML_EXPLAIN_TOP_K</C> features back for each
        — and an explained call{" "}
        <strong>takes the sandbox path even when a warm endpoint is up</strong>, because the
        endpoint&apos;s serving program would need its own copy of the ablation and a second
        implementation of &ldquo;what moved this answer&rdquo; is a second definition of it. An
        explanation that fails never costs you the prediction: the answer comes back with a warning
        attached.
      </P>

      <H3 id="reason-codes">Reason codes on every scored row</H3>
      <P>
        The explanation above answers for one row you are looking at. A batch answers for all of
        them: tick <strong>Write reason codes beside every row</strong> on the batch prediction
        dialog and the scored table gains the drivers as columns.
      </P>
      <Table
        headers={["Column", "What it holds"]}
        rows={[
          [
            <C key="r">reason_1 … reason_3</C>,
            "The features that moved this row's answer most, strongest first.",
          ],
          [<C key="e">reason_1_effect … reason_3_effect</C>, "How far each moved it, signed."],
        ]}
      />
      <P>
        Flat columns rather than a JSON blob, because the point is that{" "}
        <C>WHERE reason_1 = &apos;support_tickets&apos;</C> works in plain SQL and a dashboard can
        group by it. The value that drove the answer is not repeated — it is already in the row, in
        the column the reason names. A row with fewer features that moved anything than there are
        slots gets nulls, not blanks.
      </P>
      <Callout kind="info" title="The same measurement, not a cheaper twin">
        Reason codes are the same ablation against the same typical row as the single-row
        explanation, run over every row instead of one. That is the expensive choice and it is
        deliberate: an approximation used only for batches would be a second answer to the same
        question wearing the same name, free to disagree with what the row&apos;s own page shows. A
        reason code that contradicts the explanation is worse than no reason code.
      </Callout>
      <P>
        They cost one extra prediction per feature per row, so a hundred thousand rows with twenty
        features is two million predictions. The work is chunked so memory stays flat however large
        the batch is, but the time does not. A batch above <C>ML_EXPLAIN_BATCH_MAX_ROWS</C> (50,000)
        is therefore <strong>refused before the sandbox starts</strong> — the row count is already
        known from the check that enforces the prediction limit, so the answer names the real number
        and the way out.
      </P>
      <P>
        Refused rather than truncated, on purpose: a scored table where the first fifty thousand
        rows carry reasons and the rest are null looks complete and is not, and nothing downstream
        would know. Narrow the rows with a filter, score without reason codes, or raise the ceiling.{" "}
        <C>ML_EXPLAIN_BATCH_TOP_K</C> (3) sets how many are written, and each one costs two columns.
      </P>

      <H2 id="ground-truth">Was it right?</H2>
      <P>
        Drift and this are different questions, and treating the first as an answer to the second is
        the most common way a model quietly stops working. Drift says the rows arriving now do not{" "}
        <em>look like</em> the rows the model trained on. Inputs can shift while accuracy holds, and
        inputs can sit perfectly still while the world changes underneath the label. The only way to
        know whether a model is still right is to wait for the real answer and compare.
      </P>
      <P>
        So a model may name an <strong>outcome source</strong> — the table where the real answers
        land, and the key that lets a scored row find its own. Set it on the model page under{" "}
        <strong>Accuracy</strong>: a schema and table, one to eight key columns present in both that
        table and the scored one, and the column holding what actually happened. Rows where that
        column is still null are skipped.
      </P>
      <P>
        An evaluation joins one prediction run&apos;s output table to it and recomputes{" "}
        <strong>the model&apos;s own primary metric</strong> — <C>f1_macro</C> for a classification,{" "}
        <C>rmse</C> for a regression or forecast — on the rows that have an answer, then compares it
        to the same metric on the validation split when that version trained. A run more than{" "}
        <C>ML_DECAY_ALERT_RATIO</C> worse (0.10, ten per cent) is audited as <C>ml.decay.alert</C>{" "}
        and notifies the owner. A ratio rather than a metric value, so it reads the same way for a
        metric that should rise and one that should fall.
      </P>
      <P>
        It runs on the platform clock: answers arrive over hours or weeks, so each successful batch
        run is re-measured once a day while it is less than a month old (
        <C>ML_EVALUATIONS_PER_SWEEP</C> bounds one pass). <strong>Measure now</strong> does one
        immediately.
      </P>
      <Callout kind="why" title="Three things it deliberately does not do">
        <strong>A missing answer is not a wrong one.</strong> The join is an INNER join — counting a
        prediction whose outcome has not arrived as a mistake would make every model look worse the
        fresher its predictions are. <strong>A metric never appears without its coverage</strong>:
        every evaluation carries how many rows it matched out of how many were scored, because an f1
        of 0.9 over 6% of the rows belongs to whoever answered first, and they are rarely a random
        sample — and a join matching nothing is an error naming the key columns to check, not a
        score of zero. <strong>An improvement is not celebrated</strong>: a model scoring markedly
        better than its own validation score is usually the outcome column leaking into the
        features, so that verdict reads &ldquo;Better than training&rdquo; in a neutral badge.
      </Callout>
      <P>
        The metric is recomputed exactly as scikit-learn computes it, because the baseline came out
        of that same call at training time — two defensible definitions of one metric would fire a
        decay alert the first time every model was measured, which teaches everyone to ignore decay
        alerts. Evaluating costs no sandbox: a confusion matrix and five sums are a <C>GROUP BY</C>,
        so one statement runs through the governed lakehouse chokepoint as the model&apos;s owner
        and the arithmetic happens in the app.
      </P>

      <H2 id="calibration">Is 0.8 really 80%?</H2>
      <P>
        Every classification carries a probability, and this interface has always printed it beside
        the word <strong>confidence</strong>. For a tree ensemble that number is usually a{" "}
        <em>rank</em> rather than a frequency: a forest that votes 9 trees to 1 reports 0.9 whatever
        the real rate turns out to be. Good enough for sorting a queue, wrong for a rule that says
        &ldquo;auto-approve above 80%&rdquo;.
      </P>
      <P>
        So the trainer measures it, and the model page shows the measurement under{" "}
        <strong>Accuracy → Confidence and the decision line</strong>.
      </P>
      <H3 id="reliability">The reliability curve</H3>
      <P>
        Holdout rows are binned by what the model said, and each bin reports what actually happened.
        A point on the diagonal means the model&apos;s 70% really was 70%; above it the model is
        under-selling itself, below it over-selling. Bins are drawn in proportion to how many rows
        they hold, because four rows landing far off the line is noise and four hundred is a
        problem.
      </P>
      <Table
        headers={["Figure", "What it means"]}
        rows={[
          [
            <strong key="e">Calibration error</strong>,
            "The average gap between what was said and what happened. 0.04 is “typically within four points”.",
          ],
          [
            <strong key="b">Brier score</strong>,
            "Mean squared error of the probabilities themselves. Lower is better; it moves when a model is confidently wrong, which accuracy never sees.",
          ],
        ]}
      />
      <P>
        The page bands the calibration error rather than leaving a bare decimal: at or under 0.05 it
        is safe to write a rule against, under 0.15 it is fine for ranking and loose for a rule, and
        above that the numbers should be read as ranks.
      </P>
      <H3 id="calibration-trainer">What the trainer does about it</H3>
      <P>
        After the algorithm search picks a winner and <strong>before</strong> any metric is
        recorded, classification models get a calibration pass — <C>CalibratedClassifierCV</C>,
        isotonic regression on 1000 training rows or more and Platt scaling below that, since
        isotonic needs data to fit its step function and overfits badly without it.
      </P>
      <Callout kind="info" title="It is checked, and discarded if it did not help">
        The calibrated model is scored on the same holdout and kept only when <strong>both</strong>{" "}
        the Brier score and the calibration error improve. Requiring both is not belt and braces:
        Brier is calibration and sharpness added together, so a model can win on Brier by growing
        more confident while drifting further from the truth. A 90-row probe did exactly that —
        Brier 0.1701 → 0.1572 while the calibration error went 0.1917 → 0.2220 — and on the Brier
        test alone it would have shipped.
      </Callout>
      <P>
        When the pass is discarded the run log says so and the page says <em>left uncalibrated</em>.
        That is not a failure: a model already well calibrated lands there, and so does one whose
        holdout was too small to fit a reliable mapping. Because metrics are recorded after this
        step, every number on the version describes the model that was actually saved. Versions
        trained before this shipped have no curve and read as <em>not measured</em>, which is the
        truth — retrain to get one.
      </P>

      <H2 id="threshold">Where the line is drawn</H2>
      <P>
        A classifier decides by <C>argmax</C>, which is a threshold of 0.5 that nobody chose. It is
        the right default and the wrong one for most real decisions: declining a good customer and
        missing a fraudulent order do not cost the same, and the person who knows the ratio is the
        operator, not the trainer.
      </P>
      <P>
        So the trainer <strong>measures every operating point</strong> and the model page lets you
        pick one. For a two-class model the holdout is scored at thresholds from 0.05 to 0.95 in
        steps of 0.05, and every row of the table is a real measurement:
      </P>
      <Table
        headers={["Column", "What it is"]}
        rows={[
          ["Line at", "The probability at or above which the model acts."],
          ["Rows acted on", "How many holdout rows it would have acted on."],
          ["Right when it acts", "Precision at that line."],
          ["Caught", "Recall at that line."],
        ]}
      />
      <P>
        The sweep is always expressed from one side — the second class, named on the page — and that
        loses nothing: with two classes the probabilities sum to one, so a line at 0.70 on{" "}
        <C>retained</C> is the same rule as a line at 0.30 on <C>churned</C>. Every operating point
        either class could have is already in the table, read from one end.
      </P>
      <P>
        The best-F1 row is marked <strong>balanced</strong> and offered as a starting position, not
        a recommendation — F1 weights the two mistakes equally, which is the exact assumption this
        screen exists to let you reject. Choosing a row shows what would change against the line
        currently in use, and saving it asks first. The picker only offers thresholds the trainer
        actually measured: interpolating to 0.437 would present a number the platform never checked
        with the same authority as one it did.
      </P>
      <H3 id="threshold-setting">A setting, not a retrain</H3>
      <P>
        The threshold lives on the <strong>version</strong>, not inside the artifact. Prediction
        reads it at run time, so moving the line takes effect on the next prediction and the model
        is untouched. Every change is audited as <C>ml.threshold.set</C> with the value, because
        &ldquo;who decided to approve 12% more applications, and when&rdquo; is a question that gets
        asked.
      </P>
      <UL>
        <li>
          <strong>The probability shown is the probability of the answer given.</strong> A row
          declined at 0.45 reports 0.55 against the class it was actually assigned, not 0.55
          confidence in a decision nobody made.
        </li>
        <li>
          <strong>Scored tables record the line that produced them.</strong> A batch run with a
          threshold set writes <C>threshold_applied</C> on every row, so six months later &ldquo;why
          was this one declined&rdquo; is answerable from the row rather than from whatever the
          setting happens to be by then.
        </li>
      </UL>
      <H3 id="threshold-retrain">A retrain does not carry the line forward</H3>
      <P>
        Because the threshold lives on the version, a new version arrives without one and decides by{" "}
        <C>argmax</C> again. That is deliberate: a line only means the same thing across two
        versions whose probabilities mean the same thing, and copying it forward silently would be
        the platform making a business decision on your behalf.
      </P>
      <P>
        It is also the sort of change nobody notices until approval volume shifts, so it is not left
        silent either. When the production version has no line and an earlier version of the same
        model did, the panel says so — naming the version and the value, with a button to draw it
        there again. Scheduled retraining with <strong>promote when better</strong> is exactly the
        case this is for.
      </P>
      <P>
        Multiclass models get no threshold and no sweep: there is no single line to draw, so each
        prediction is simply whichever class scores highest. Regression and forecasting have none
        either.
      </P>

      <H2 id="fairness">How groups are treated</H2>
      <P>
        Two questions, and each hides the other. <strong>Selection rate</strong> asks how often each
        group gets the favourable answer — it needs no outcomes at all, so it can be checked the
        moment a batch runs, and it is the one employment and lending law is written about.{" "}
        <strong>Error rates</strong> ask whether the model is <em>wrong</em> more often for one
        group, which needs the real answers and so rides on the same join an evaluation makes. A
        model can have near-identical selection rates and still be far worse at one group, which is
        why both are reported.
      </P>
      <P>
        Set it on the model page under <strong>Accuracy → How groups are treated</strong>: up to
        eight columns present in the scored table, and the predicted label that counts as the good
        outcome. Each column is compared separately and recorded as its own check — two columns are
        two comparisons, and averaging them would hide the one that matters.
      </P>
      <Callout kind="why" title="The lines it will not cross">
        <strong>The favourable answer is named by you, never inferred</strong> — which label is the
        good one is a fact about the world, and a guess would end up in a compliance report.{" "}
        <strong>The verdict is &ldquo;worth a review&rdquo;, never &ldquo;unfair&rdquo;</strong>:
        nothing computable decides whether a model is fair, so what a ratio can say is that groups
        came out far enough apart to deserve attention. <strong>Four fifths is a default</strong> (
        <C>ML_FAIRNESS_MIN_RATIO</C>) taken from the US EEOC&apos;s Uniform Guidelines — a rule of
        thumb with no statistical claim behind it, not the standard everywhere.{" "}
        <strong>A group too small to judge is still shown</strong>: under 30 rows it is greyed and
        excluded from the verdict, because a rate over five people swings 20% when one changes — but
        hiding it is how a real problem stays invisible for a quarter. A value nobody recorded
        becomes its own group.
      </Callout>

      <H3 id="fairness-agent">Where the agent layer helps, and where it does not</H3>
      <P>
        This is the first place in the platform where a language model touches a number somebody may
        have to defend, so the boundary is explicit and tested:{" "}
        <strong>
          the platform measures, the model proposes and narrates, and a number never comes from the
          language model.
        </strong>
      </P>
      <P>
        <strong>Suggest columns</strong> asks the assistant to nominate what to compare by — both
        directly sensitive attributes and <em>proxies</em>, the columns that are not themselves
        sensitive but stand in for one: a postcode for ethnicity, a first name for gender, a school
        for class. Proxies are the valuable half, because they are what careful people miss. Each
        suggestion comes with a reason you can disagree with, and you tick what applies; nothing is
        enabled by the suggestion itself, because which attributes are protected is a legal question
        about your context rather than one this platform can answer.
      </P>
      <P>
        <strong>Only column names, types and cardinalities are sent.</strong> Never values — a
        column of ethnicities is sensitive data, and posting a sample of it to an inference endpoint
        to ask whether it is sensitive would answer its own question. The suggestion path never
        queries the lake at all, and a test enforces that. Any column the assistant names that is
        not in the schema is dropped rather than shown.
      </P>
      <P>
        <strong>Explain this in words</strong> passes the already computed figures to the assistant
        and asks for two or three sentences. The prompt forbids it from computing, estimating,
        rounding differently or introducing any figure it was not given, and the narration is stored{" "}
        <em>beside</em> the numbers rather than instead of them — so one that drifts is visibly
        contradicted by the table above it.
      </P>
      <P>
        Both calls go through the same governed door as every other model call, so IAM model rules,
        budgets and audit apply; they are recorded as <C>ml.fairness.suggest</C> and{" "}
        <C>ml.fairness.narrate</C>, and the assistant model is <C>ML_ASSIST_MODEL</C>. A check is
        audited as <C>ml.fairness.check</C>, or <C>ml.fairness.review</C> when the ratio falls below
        the line, which also notifies the model&apos;s owner.
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

      <H3 id="forecast-period">What a forecast period is</H3>
      <P>
        A forecast is one value per period: the total (or average) of the target over every hour,
        day, week, month or quarter, as chosen in the wizard. <strong>Automatic</strong> infers the
        period from the gaps between timestamps, which turns a table of dated orders into a{" "}
        <em>daily</em> series — fine for a month of data, surprising when you expected months. Pick
        the period you will read the answer in. A last period the data only partly covers is left
        out and the version says so. Five candidates compete on a holdout of the most recent periods
        — last value, moving average, seasonal naive, Holt-Winters, gradient boosting on lags — and
        the lowest RMSE serves, so a flat line means the flat baselines beat the rest on your
        series. The model page, the agent tool and the API all state the period, the aggregation,
        the last observed period and the method.
      </P>

      <H2 id="features">Feature views</H2>
      <P>
        A model trained on a table whose columns were built by SQL is normally scored by POSTing
        those same column names with values the caller computed itself, in its own code, months
        later. Nothing checks that its arithmetic matches the training set&apos;s, so the model
        receives numbers of the right shape and the wrong meaning and answers confidently. That is
        training-serving skew, and it is quiet.
      </P>
      <P>
        A <strong>feature view</strong> removes the caller&apos;s arithmetic. It names a table, the
        column(s) that identify a row, and which columns are features; serving then takes a{" "}
        <strong>key</strong> and reads the values from the same table training read. Under{" "}
        <strong>ML Models → Feature views</strong>, attached to a model under{" "}
        <strong>Automation → Input</strong>.
      </P>
      <Code>{`curl <origin>/api/ml/predict \\
  -H "Authorization: Bearer mlk_…" -H "Content-Type: application/json" \\
  -d '{"keys": [{"customer_id": "c-1"}]}'`}</Code>
      <UL>
        <li>
          <strong>It materialises nothing.</strong> The table is whatever built it — a{" "}
          <DocLink to="/docs/sql-models">SQL model</DocLink> is the natural author, since its
          schedule keeps the table fresh and its <C>unique</C> test can assert the key.
        </li>
        <li>
          <strong>It does not guess.</strong> Rows come back in the order the keys were asked for,
          matched by key rather than by result order. A key matching nothing is named in{" "}
          <C>keys_not_found</C> rather than filled with nulls, because a row of nulls scores happily
          and means nothing.
        </li>
        <li>
          <strong>It refuses an ambiguous key.</strong> A key matching two rows fails unless the
          view names a column for <em>latest row wins</em>. Picking one of two arbitrarily is how a
          feature store starts lying.
        </li>
        <li>
          <strong>Nothing changes without one.</strong> Callers keep sending whole rows, and keep
          owning them.
        </li>
        <li>
          <strong>It builds point-in-time training sets.</strong> See below.
        </li>
      </UL>
      <Callout title="A key may not also be a feature">
        A key is what you look a row up by. Fed back in as a feature it teaches the model to
        memorise identifiers, which scores beautifully in training and predicts nothing.
      </Callout>

      <H3 id="point-in-time">Point-in-time training sets</H3>
      <P>
        Serving asks what an entity&apos;s features are <strong>now</strong>. Training has to ask
        what they were <strong>at the moment the label was true</strong>, and the difference is the
        most expensive mistake in applied ML. Join a February label to the feature table&apos;s
        latest row and the model learns from June&apos;s numbers: it scores beautifully in the
        notebook, because the answer was in the features, then fails in production where June has
        not happened yet.
      </P>
      <P>
        <strong>Training set</strong> on a view builds the honest version. Give it the table of
        labels, the column saying when each was true, and the label column matching each key column;
        every row then keeps the features with the greatest feature timestamp{" "}
        <strong>at or before its own</strong> — an <C>ASOF LEFT JOIN</C>, resolved by the engine
        rather than by a window function you have to get right. Left, because a key whose features
        start later is still part of the training set. An optional <strong>max feature age</strong>{" "}
        refuses to join something stale without dropping the row.
      </P>
      <P>
        The build reports <strong>how many rows would have differed</strong> under the join written
        by hand — the leak, as a number, on your own data. The view&apos;s timestamp is never joined
        in as a feature: a model that trains on the feature clock learns the shape of your ETL
        schedule. A view with no timestamp column cannot build a training set and says so, rather
        than joining the latest row and calling the result one.
      </P>

      <H2 id="warm">Warm endpoints</H2>
      <P>
        By default a prediction starts a container, boots Python, imports the ML stack, downloads
        and digest-checks the artifact, scores, posts the answer back and exits — about{" "}
        <strong>twenty seconds before any scoring happens</strong>. That is the right shape for a
        batch job over a million rows and the wrong one for scoring a row behind a web request. A{" "}
        <strong>deployment</strong> holds one version in memory and answers over HTTP instead, from{" "}
        <strong>Automation → Warm endpoint</strong> on the model page.
      </P>
      <UL>
        <li>
          <strong>The scoring is identical.</strong> The sandbox loads the same program the batch
          path runs and calls the same <C>_predict</C>, so the same fitted pipeline scores the same
          digest-verified artifact. Only the waiting is different.
        </li>
        <li>
          <strong>It pins a version.</strong> Promoting a new one marks the endpoint{" "}
          <strong>stale</strong> and leaves it serving what it was serving. An endpoint that
          silently changed its answers is the opposite of what pinning is for.
        </li>
        <li>
          <strong>A missing endpoint is slower, never wrong.</strong> Down, loading, or serving a
          different version, the prediction falls back to the sandbox. Every reply says which path
          answered, in <C>served</C>.
        </li>
        <li>
          <strong>Measured, one row, end to end:</strong> ~1.3 s warm against ~27 s cold on a laptop
          with a remote database. The scoring itself is <strong>45 ms</strong> either way — that is
          the model, and it does not change. What the endpoint removes is the container start; what
          is left is the platform&apos;s own book-keeping, which on that setup is almost entirely
          round trips to a database in another datacentre.
        </li>
        <li>
          <strong>Recorded exactly like a cold prediction:</strong> the same row, the same drift
          check, the same <C>ml.predict_query</C> audit event. Faster, not less accountable — and
          those writes are part of the number above.
        </li>
        <li>
          <strong>It costs memory while it is up</strong>, so it is off by default, an idle one is
          stopped after its timeout unless <strong>Keep warm</strong> is on, and the instance caps
          how many may be open.
        </li>
      </UL>
      <Callout title="Forecast models have no endpoint">
        A forecast is answered from the stored series with no model in the loop at all, so there is
        nothing to hold warm.
      </Callout>

      <H3 id="replicas">More than one copy</H3>
      <P>
        One sandbox is one Python process scoring one request at a time, so the second caller waits
        for the first — and at that point the twenty seconds a warm endpoint saved are being spent
        again in the queue, somewhere less visible.
      </P>
      <P>
        An endpoint can therefore hold several <strong>copies</strong> of the model, each in its own
        sandbox. Set the range on the deployment panel: the first number is how many are held even
        with no traffic, the second the ceiling. <strong>Both default to 1</strong>, so nothing
        changes until you raise the second — every copy is a container holding the ML stack and a
        fitted pipeline resident on your machine, and starting more because a feature shipped would
        be spending your memory without asking.
      </P>
      <P>
        Requests go to the copy that has gone longest without one. That is the same rule the scaler
        uses to choose what to stop, deliberately: two notions of &ldquo;quietest&rdquo; would have
        the two disagreeing about the same endpoint.
      </P>
      <H3 id="replicas-scaling">When copies are added and removed</H3>
      <P>
        The platform clock measures the endpoint&apos;s request rate — the change in its counter
        between two readings, not a sample — and compares it with{" "}
        <C>ML_SERVE_TARGET_RPM_PER_REPLICA</C> (120), the load one copy is sized for.
      </P>
      <P>
        <strong>Adding is immediate.</strong> A queue is the thing a warm endpoint exists to
        prevent, so there is no cooldown before relieving one. One copy is added per pass however
        far behind the endpoint is: the next pass is a minute away and will add another if it is
        still needed, by which time the first has loaded — so the decision is made knowing what it
        bought. Starting four at once on a burst is how a machine runs out of memory serving a spike
        that ended before they loaded.
      </P>
      <Callout kind="info" title="Removing a copy needs three things at once">
        The load clear of what the smaller number could carry, not merely at it — otherwise the next
        pass adds the copy straight back and the endpoint flaps, paying a cold start every time it
        changes its mind. <C>ML_SERVE_SCALE_COOLDOWN_SECONDS</C> (180) since the last change either
        way. And a copy that has actually been idle that long, because stopping a container takes
        any request still inside it.
      </Callout>
      <P>
        Every decision is recorded on the endpoint in plain words — the panel shows the last one —
        and every change is audited as <C>ml.scale</C> with the rate that caused it.
      </P>
      <H3 id="replicas-limits">What a copy actually is, and how far it gets you</H3>
      <P>
        A copy is a sandbox, started the same way every other sandbox is — so what it lands on
        depends entirely on the runtime backend. Nothing in the scaling code mentions either one: it
        asks the orchestrator for a scoring sandbox and gets back an address.
      </P>
      <Table
        headers={["Backend", "A copy is"]}
        rows={[
          ["Docker", "Another container on this machine."],
          ["Kubernetes", "Another Pod, which the scheduler may place on any node."],
        ]}
      />
      <P>
        <strong>On Kubernetes these are bare Pods the app creates, not a Deployment.</strong> There
        is no ReplicaSet and no Service in front of them: the app holds each Pod&apos;s address and
        picks between them itself. So the HorizontalPodAutoscaler is not involved — the platform
        clock is the control loop — and copies do genuinely spread across nodes, which means an
        endpoint can outlive one of them.
      </P>
      <Callout kind="warn" title="On a single machine the benefit is bounded">
        The scorer is a threading HTTP server, so one copy already accepts concurrent requests — but
        scoring is CPU-bound Python and the GIL serialises most of it, with only the numpy and BLAS
        parts overlapping. A second copy is a second OS process, which is genuine parallelism.
        Copies therefore help up to roughly the machine&apos;s core count; past that they contend
        for the same CPU and each holds the ML stack and a fitted pipeline in memory. And two copies
        on one box die with the box. That is why the maximum defaults to 1.
      </Callout>
      <P>
        Either way the warm-container limits still apply, and they count copies rather than
        endpoints, because the thing being bounded is resident memory.
      </P>

      <H3 id="shadow">Trying a version on real traffic</H3>
      <P>
        A new version is normally adopted by <strong>switching</strong> to it. Which means the first
        evidence that it behaves differently from the old one is production behaving differently —
        noticed, if it is noticed, by whoever the difference landed on.
      </P>
      <P>
        <strong>Shadowing asks the question first.</strong> Pick a version on the deployment panel
        and the endpoint starts a second copy holding it. From then on, every request the endpoint
        answers is mirrored to that candidate, its answer is compared against the one that was
        actually served, and then thrown away.
      </P>
      <Callout kind="info" title="A candidate never answers a caller">
        The scorer asks for copies marked <Code>primary</Code> and never sees the candidate at all,
        so there is no ordering, no flag and no race by which an unapproved version could end up on
        the wire. Two smaller promises follow from it. <strong>Nobody waits for it</strong> — the
        mirror is fired after the served answer is in hand and is not awaited, so the caller&apos;s
        latency is the primary&apos;s latency. And{" "}
        <strong>a mirror that fails cannot reach the caller</strong>: it is caught and counted, so a
        candidate that cannot load shows up as an error rate on the report rather than as a failed
        request for somebody else.
      </Callout>
      <P>
        What <em>agree</em> means is not the same question for every model, and pretending it is
        would make the number meaningless.
      </P>
      <Table
        headers={["Task", "Agreement is"]}
        rows={[
          ["Classification", "The same label. A proportion that reads exactly as it looks."],
          ["Regression", "Within 1%, relative, with an absolute floor near zero."],
        ]}
      />
      <P>
        Counting exact float matches on a regression would report 0% agreement on two models that
        are indistinguishable in practice, so the comparison is a tolerance.{" "}
        <strong>Clustering, anomaly detection and recommendation are not compared</strong> and the
        mirror does not run for them: their labels are arbitrary between fits, so cluster 3 of one
        model has nothing to do with cluster 3 of another, and the comparison would report total
        disagreement between two identical models.
      </P>
      <Callout kind="warn" title="The mirrored input is never stored">
        A mirrored request carries whatever the caller sent, which on a live endpoint is live
        personal data; keeping it would put that data in a debugging table nobody thinks of as a
        data store. What is kept is four running totals on the endpoint — requests, rows, rows
        agreed, errors — plus the two <em>answers</em> from the fifty most recent rows they
        disagreed on. Totals rather than a row per request, because an endpoint at a couple of
        requests a second would write a hundred and fifty thousand rows a day to answer a question
        that is four numbers.
      </Callout>
      <P>
        The panel leads with a sentence rather than a figure, and below a hundred compared rows it
        refuses to give one at all — it says how many more it needs. A percentage on forty rows
        invites a decision nobody has evidence for, which is the opposite of what shadowing is for.
      </P>
      <Table
        headers={["It says", "When"]}
        rows={[
          ["Watching", "Fewer than 100 rows compared so far."],
          ["Answers the same", "90% of rows or more agreed."],
          [
            "Answers differently",
            "Below that — with recent disagreeing answers listed underneath.",
          ],
          ["Failing", "The candidate failed on 5% or more of mirrored calls."],
        ]}
      />
      <P>
        A candidate is a copy, so it is a container, and it counts against the same warm-container
        limits as any other. <strong>One candidate at a time</strong>: choosing another retires the
        first, and the totals reset, because figures gathered against a different candidate answer a
        question nobody asked. Stopping it takes the copy down and leaves nothing behind. Adopting
        it is the ordinary <strong>Redeploy</strong> to that version — shadowing does not promote
        anything by itself, and never will. It measures; a person switches. Both starting and
        stopping are audited, as <Code>ml.shadow.start</Code> and <Code>ml.shadow.stop</Code>.
      </P>

      <H3 id="canary">Giving it a share of real traffic</H3>
      <P>
        Shadowing tells you the candidate answers the same way. It cannot tell you the candidate
        answers <em>at all</em> under real load, on real data, at real concurrency — because nobody
        was ever waiting for one of its answers.
      </P>
      <P>
        A <strong>canary</strong> does. Switch the candidate from <em>Mirror only</em> to{" "}
        <em>Send real traffic</em> and a share of requests are answered by it, for real, and
        returned to whoever asked. The share is a whole number of per cent and the default is 5.
        This is the one place in the platform where a version nobody approved answers a real caller,
        so it is worth being exact about what bounds it.
      </P>
      <Callout kind="info" title="The split is per request, and nobody is refused">
        The roll is taken per request, not per caller: a prediction has no session to be sticky to,
        and a sticky split would let one unlucky caller take every bad answer while the average
        looked fine. A random split lands <em>near</em> the number rather than on it, so the panel
        shows the share actually served next to the share asked for — at 10% on a hundred requests,
        thirteen crossing is ordinary. And if the candidate&apos;s copy is not up when the roll
        picks it, the request goes to production instead: the share slips for a few requests, which
        is a far smaller thing than a failed request.
      </Callout>
      <P>
        A canary <strong>cannot measure agreement</strong>, and no amount of wanting it to will
        help: each row was answered once, by one version, so there is no second answer to compare it
        against. That is what shadowing is for, and why the two are separate steps rather than one
        slider. What a canary measures is failure — on both sides.
      </P>
      <Table
        headers={["", "What is counted"]}
        rows={[
          ["Candidate", "Requests it answered, and how many failed."],
          ["In production", "The same two figures for the version it would replace."],
        ]}
      />
      <P>
        Production&apos;s figures are there because the question is never &ldquo;is the candidate
        failing&rdquo; but &ldquo;is it failing{" "}
        <strong>worse than the thing it would replace</strong>&rdquo;. Without them, a lakehouse
        outage reads as a bad model. And because it measures failure rather than agreement, a canary
        works for <strong>every task</strong> — including clustering, anomaly detection and
        recommendation, where shadowing cannot be offered at all.
      </P>
      <Callout kind="warn" title="It rolls itself back, without being asked">
        Nobody is watching a panel at three in the morning, and this is the one feature where not
        noticing has a cost measured in other people&apos;s answers. The platform takes the
        candidate out of the traffic when all three hold: at least <strong>20 requests</strong> have
        gone through it (every one a real caller, so the number is the smallest that makes a rate
        mean anything); it has failed <strong>10% or more</strong> of them (two in twenty, rather
        than a single transient timeout); and that is at least <strong>5 points worse</strong> than
        production over the same period. The third condition is what stops the canary blaming itself
        for everything — if both sides are failing the endpoint says so and rolls back nothing,
        because reverting to a version failing just as hard fixes nothing. A rollback stops the
        traffic first, then takes the copy down, writes the reason on the endpoint and audits{" "}
        <Code>ml.canary.rollback</Code>. The reason stays after the candidate is gone: somebody
        arriving to find production serving its old version needs to learn why from the endpoint.
      </Callout>
      <P>
        Every prediction records the version that <strong>actually</strong> answered it, not the one
        the endpoint is nominally serving. Under a canary those differ for some share of rows by
        design, and recording the endpoint&apos;s version would attribute a candidate&apos;s
        prediction to production — wrong on the row somebody reads when they ask why, wrong in the
        drift figures, and wrong in exactly the cases anybody is looking into.
      </P>
      <P>
        A candidate already running as a shadow <strong>keeps its warm copy</strong> when it becomes
        a canary: same version, same container, and throwing away a loaded model to change one
        column would cost twenty-five seconds for nothing. The canary figures reset because they
        describe a run and this is a new one; the shadow totals are left alone because they are
        still true. Adopting the candidate is the ordinary <strong>Redeploy</strong> to that version
        — nothing here promotes anything by itself. The only thing the platform does on its own is
        take a failing candidate <em>out</em>.
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
          [<C key="g">ML_TRAIN_GPUS</C>, "0", "GPUs requested per training sandbox"],
          [
            <C key="h">ML_DRIFT_ALERT_PSI</C>,
            "0.25",
            "PSI above which a prediction run raises a drift alert",
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
          <strong>On Kubernetes</strong> training and prediction are batch Jobs in the notebook
          namespace, bounded by its <C>ResourceQuota</C> and <C>LimitRange</C> and scaled by adding
          nodes; the egress ConfigMap must admit the object store. The deployment guide&apos;s{" "}
          <DocLink to="/docs/self-hosting">ML platform on Kubernetes</DocLink> section has the three
          settings that matter.
        </li>
        <li>
          <strong>GPUs:</strong> <C>ML_TRAIN_GPUS</C> (or the Admin setting) requests that many GPUs
          for every training sandbox — a Docker device request on a single host, an{" "}
          <C>nvidia.com/gpu</C> limit on Kubernetes. The baked runtime image is CPU-only; point{" "}
          <C>NOTEBOOK_RUNTIME_IMAGE</C> at a CUDA-capable build when you need one.
        </li>
        <li>
          Artifacts live under <C>ml-artifacts/</C> in the lake bucket. <C>npm run backup</C>{" "}
          mirrors the lake data path; add the artifacts prefix to your object-store backup as well.
        </li>
      </UL>

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
            "Warm endpoints hold one version in memory: 45 ms of scoring instead of a ~25 s container start; several copies per endpoint, scaled on measured load",
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
            "Feature views: score by key, read from the table training read; describes rather than materialises",
            "Yes",
          ],
          [
            "Distributed / GPU training",
            "The algorithm search spreads across several sandboxes; one model still trains in one container; GPUs requestable",
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
        Everything in the left column is shipped and tested. What is left, in the order it is
        usually asked for: <strong>training one model across machines</strong> (the search spreads
        over sandboxes, but a single fit still happens in one container); and{" "}
        <strong>serving across machines</strong> (on Docker every copy is a container on this
        machine, so the host is the ceiling; on Kubernetes copies do spread across nodes, but
        nothing grows the cluster itself when they run out of room).
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

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "Cannot reach the Docker socket-proxy",
            'Read the rest of the message: "start the runtime services" means the proxy is down (docker compose --profile notebooks up -d); "did not answer" means the Docker daemon is busy or the proxy wedged — retry, then restart notebook-docker-proxy.',
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
          [
            "Possible leakage: … on its own predicts …",
            "A feature is the target in disguise or a key the model memorised. Drop it from the features and train a new version; the score will fall to something real.",
          ],
          [
            "Every group is one customer / every anomaly a date",
            "A many-valued category or a time column was selected explicitly and decided the distance. Let the trainer choose the features, or leave that column out.",
          ],
          [
            "Projected values below 0 were floored at 0",
            "The winning method extrapolated a decline past zero; the floor is the honest answer for a total. A longer history or a coarser period usually steadies the trend.",
          ],
        ]}
      />

      <NextPrev current="/docs/ml" />
    </>
  );
}
