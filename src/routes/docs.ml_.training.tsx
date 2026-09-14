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

export const Route = createFileRoute("/docs/ml_/training")({
  head: () => ({
    meta: [
      { title: "ML Models · Training — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "From a lakehouse table to a versioned model: preparing the training set, the trainer's search, reading the results and its warnings, how the winner is chosen, versions, and experiments run from a notebook.",
      },
      { property: "og:title", content: "ML Models · Training — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Prepare, train, read the results, and keep every version.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml/training" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml/training" }],
  }),
  component: MlTrainingPage,
});

function MlTrainingPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models · Training"
        description="From a lakehouse table to a versioned model: preparing the training set, the trainer's search, reading the results and its warnings, how the winner is chosen, versions, and experiments run from a notebook."
      />
      <P>
        Part of the <DocLink to="/docs/ml">ML Models</DocLink> guide. This page follows a model from
        a lakehouse table to a versioned, promoted model;{" "}
        <DocLink to="/docs/ml/predictions">Predictions</DocLink> is what happens once it exists.
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
        <DocLink to="/docs/ml/predictions" hash="external-models">
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
        <DocLink to="/docs/ml/predictions" hash="external-models">
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

      <NextPrev current="/docs/ml/training" />
    </>
  );
}
