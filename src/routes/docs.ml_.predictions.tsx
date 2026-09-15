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
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/ml_/predictions")({
  head: () => ({
    meta: [
      { title: "ML Models · Predictions — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Scoring rows on demand and in batch, letting agents and the AI Analyst predict, the public API, forecasts on dashboards, and feature views that serve a model's features by key.",
      },
      { property: "og:title", content: "ML Models · Predictions — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Score rows, let agents predict, call the API, serve features by key.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml/predictions" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml/predictions" }],
  }),
  component: MlPredictionsPage,
});

function MlPredictionsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models · Predictions"
        description="Scoring rows on demand and in batch, letting agents and the AI Analyst predict, the public API, forecasts on dashboards, and feature views that serve a model's features by key."
      />
      <P>
        Part of the <DocLink to="/docs/ml">ML Models</DocLink> guide. This page is about using a
        model that exists — on demand, in batch, from an agent or the AI Analyst, over the API and
        by key; <DocLink to="/docs/ml/trust">Trust</DocLink> covers whether its numbers can be
        believed.
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
      <P>
        <strong>Which models the agent may use</strong> is a picker under the tool: every model you
        can use — your own and those shared with you — with its task, and whether it has a
        production version yet. Leave it untouched and the agent may predict with all of them, which
        is what every agent did before the picker existed. Select some and the agent is restricted
        to exactly those: <C>ml_list_models</C> shows nothing else, and <C>ml_predict</C> refuses
        anything else by name, even a model it was told about in an earlier turn. The same picker
        sits on an agent node on the swarm canvas, and importing an agent into a node carries its
        selection across — including an empty one, which means <em>no models</em> and must not turn
        into <em>all of them</em> on the way.
      </P>
      <P>
        <strong>The model&apos;s health travels with it.</strong> The platform already notices a
        model&apos;s rows drifting from what it learned on (a PSI on every prediction run, an alert
        past <C>ML_DRIFT_ALERT_PSI</C>) and its accuracy decaying against outcomes that arrived
        later (an evaluation with a verdict) — and told the owner. Now every place a model is
        offered carries the latest reading of each as one sentence: <C>ml_list_models</C> returns a{" "}
        <C>health</C> block per model and, when an alert is open, a note telling the agent to say so
        beside any prediction it reports; <C>ml_predict</C> appends the alerts to its notes, so a
        prediction never arrives without them; the AI Analyst&apos;s planner sees the health beside
        each scorable model and a scored step&apos;s badge and disclosure carry it; the
        Playground&apos;s model list marks an alert. Below the threshold and stable, it still says
        what was measured and when — &quot;no alert&quot; and &quot;never measured&quot; are
        different facts.
      </P>
      <Callout title="There is no key to paste">
        Until this picker existed, enabling the tool showed an API key field: a password box, for a
        tool that needs no key, with &quot;paste here&quot; in it. It accepted a credential and did
        nothing with it. It is gone.
      </Callout>
      <P>
        <strong>Scoring by key.</strong> A model bound to a feature view (Automation → Input on the
        model page) can be scored by naming the row instead of describing it: <C>ml_predict</C>{" "}
        takes <C>keys</C> — <C>{'[{"order_id": 1000}]'}</C> — and the platform reads the features
        from the same table training read, through the online store when the view is served from
        one. <C>ml_list_models</C> marks such models with their <C>feature_view</C> and key columns,
        and the tool&apos;s own description tells the agent to prefer keys for them: an agent that
        types twenty feature values from a conversation is the training–serving skew feature views
        exist to remove. The answer carries the key column(s) on every prediction,{" "}
        <C>keys_not_found</C> for any key that matched nothing (never a row of nulls scored
        quietly), and <C>features_served_from</C> (<C>online</C>, <C>mixed</C> or <C>lakehouse</C>).
        Rows and keys are never accepted together; more than fifty keys is refused rather than
        trimmed, because a key dropped silently is an entity reported as scored.
      </P>
      <P>
        <strong>On the canvas without an LLM.</strong> A swarm&apos;s <C>tool</C> node offers{" "}
        <strong>Score with model</strong> (<C>ml_predict</C>): pick the model, give <C>keys</C> — a
        JSON array such as <C>{'[{"order_id": {{input}}}]'}</C>, templated from flow state like any
        tool argument — or <C>rows</C> with the feature values, and the node writes the same JSON
        the agent tool returns to its output variable. No model decides whether to score, which is
        the point: when every run should score the same rows the same way, a model choosing to is
        cost and variance. It runs the same code as the agent tool (one implementation,{" "}
        <C>runMlPredict</C>), honours the node&apos;s model list, and in a deployed or scheduled run
        scores as the swarm&apos;s owner. Any error — an unknown model, keys and rows together, a
        list that is not valid JSON, a key set that matches nothing at all — fails the node rather
        than flowing downstream as if it were a result. A key that matches nothing{" "}
        <em>among others</em> is not an error: the rows that matched are scored and it comes back
        named in <C>keys_not_found</C> beside them.
      </P>
      <P>
        <strong>What the Playground shows.</strong> The inspector&apos;s Tool Calls panel shows a
        prediction as a table — key columns first, then the prediction and its probabilities — with
        the model and version above it and, beside it, how many rows were scored, where the features
        came from and which keys were not found; <C>ml_list_models</C> shows the models with their
        task, version, headline metric and key columns. The table is built on the server from the
        tool&apos;s full result (the panel&apos;s generic preview is a 400-character slice, which
        for a prediction ends mid-probability), and an error is shown as the error.
      </P>
      <P>
        <strong>In the AI Analyst.</strong> A plan may score a step&apos;s rows with a model in
        scope (<C>{'"score": { "model": "<name>" }'}</C>): the step&apos;s SQL selects the entities,
        the model adds the prediction columns, and the step carries a <strong>scored</strong> badge
        with the model, version, headline metric, rows scored and where the features came from. The
        write-up reports predictions as the model&apos;s estimates, never as observed values. A
        forecast model is offered as a <strong>forecast step</strong> (
        <C>{'"forecast": { "model": "<name>", "horizon": N }'}</C>) — no SQL, the model&apos;s
        projected periods with their interval — and a plan may <strong>rank</strong> the scored rows
        by a model output (<C>{'"rank": { "by": "anomaly_score", "desc": true, "limit": 10 }'}</C>
        ), the only way to ask for the most anomalous or most likely rows, because a model&apos;s
        columns exist in no table. Which models an analyst may use is its own setting, beside its
        reasoning model and its data, with the same rule as an agent&apos;s ML tool — any, exactly
        these, or none — enforced when a step scores. Details under{" "}
        <DocLink to="/docs/bi">Business Intelligence → AI Analyst</DocLink>.
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

      <H3 id="online-store">Serving them in milliseconds</H3>
      <P>
        A feature lookup reads the lakehouse, and the lakehouse is an analytics engine. Measured
        across 300 audited statements on a laptop deployment,{" "}
        <strong>none finished in under 127 ms</strong> and the median was 336 ms — before reading a
        single row. The cost is not the scan; it is the access check in front of every statement,
        which is a round trip to the application database, and it is paid whether the query touches
        eight hundred rows or eight million. Fair for a dashboard. Poor for a prediction asking for
        one customer&apos;s six numbers, which pays it every time.
      </P>
      <P>
        The <strong>online feature store</strong> keeps a view&apos;s latest row per key one hop
        away. Turn it on per view with <strong>Serve online</strong>, then <strong>Refresh</strong>{" "}
        to fill it — the refresh reads the table through the same governed path as everything else,
        so the owner&apos;s access, the row-level policies and the audit row all still apply.
      </P>
      <Table
        headers={["The lookup itself", "Measured"]}
        rows={[
          ["Lakehouse lookup", "127 ms at best, 336 ms median"],
          ["Online store, one key", "2 ms"],
          ["Online store, 200 keys", "5 ms, in one call"],
        ]}
      />
      <P>
        End to end, the same <strong>Look up</strong> against the same key went from{" "}
        <strong>439 ms to 252 ms</strong>. The lookup is the part that collapses; the remainder is
        the request&apos;s own work — checking who is calling, loading the view — which this does
        not touch and which is now the larger half. Quoting the 2 ms as the whole request would be a
        measurement of the component sold as a measurement of the system.
      </P>
      <Callout title="Nothing in it is a source of truth">
        A missing key, a stale store, a server that does not answer, a view edited since its last
        refresh — every one of them falls back to reading the lakehouse and answers exactly as it
        did before the store existed. Slower, never different. That is also why there is no volume
        and no restore path: everything in it is a copy of rows the lake already holds, and a cache
        restored to a state the lake never had would be worse than an empty one.
      </Callout>
      <UL>
        <li>
          <strong>It refuses a view whose key is not unique.</strong> A view with no timestamp
          column declares its key unique. If the refresh finds two rows sharing one it stops and
          names the key, rather than storing whichever it happened to see first.
        </li>
        <li>
          <strong>It refuses rows from a view that changed.</strong> The store records the
          view&apos;s table, keys, features and timestamp column, and compares them on every read.
          Edit the view and its stored rows are the old shape, so they are ignored until a refresh
          replaces them.
        </li>
        <li>
          <strong>It says what it actually holds.</strong> A store bounded by{" "}
          <C>FEATURE_STORE_MAX_KEYS</C> or by its own memory holds part of a view, which is correct
          — the rest is read from the lakehouse — and the panel says how much.
        </li>
        <li>
          <strong>Staleness is a setting.</strong> <C>FEATURE_STORE_STALE_MINUTES</C> (60 by
          default, overridable per view) is how old the rows may be before lookups stop trusting
          them. A table rebuilt nightly and one rebuilt every five minutes do not want the same
          number.
        </li>
      </UL>
      <P>
        The panel reports where lookups are <strong>actually</strong> answered from rather than what
        the switch is set to: a view that is on but stale is being served from the lakehouse, and
        that is the moment the difference matters. Start one with <C>docker compose up -d</C> and
        point <C>FEATURE_STORE_URL</C> at it. It is valkey rather than Redis for a licensing reason
        — Redis moved to RSALv2/SSPL, which this project cannot ship in its own stack — and the
        protocol is the same, so that variable may name a Redis you already run.
      </P>

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

      <NextPrev current="/docs/ml/predictions" />
    </>
  );
}
