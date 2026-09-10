import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/workflows")({
  head: () => ({
    meta: [
      { title: "Workflows — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "One graph over pipelines, models, retrains, notebooks and swarms: branching, retries, approvals, parameters, cron and an API trigger.",
      },
      { property: "og:title", content: "Workflows — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Orchestrate every kind of work on one clock.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/workflows" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/workflows" }],
  }),
  component: WorkflowsDocs,
});

function WorkflowsDocs() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Workflows"
        description="One graph over the pipelines, model builds, retrains, notebooks and swarms you already have — with the branching, retries, approvals and API trigger an orchestrator is expected to have."
      />

      <P>
        Open <strong>Data &amp; BI → Workflows</strong>. A workflow is a graph: each step is
        something the platform can already run, and each arrow means <em>after</em>. A step starts
        when its parents have finished the way its trigger rule requires, steps that nothing orders
        run at the same time, and a step whose branch was not taken is not run at all.
      </P>

      <Callout kind="why" title="Why a chain was not enough">
        A pipeline could already name SQL models and ML schedules to start when it succeeds. But a
        chain is a <em>line</em>. It cannot fan out to three things at once, and — the part that
        actually bites — it cannot fan <em>in</em>. &ldquo;Retrain only after both the orders
        pipeline and the customers model have finished&rdquo; is not expressible as a chain, so the
        workaround is to stagger cron times and hope the first is done before the second starts.
      </Callout>

      <H2 id="steps">The fifteen kinds of step</H2>
      <P>
        Nine start work the platform already does. Two reach outside it. Four are control flow,
        which an orchestrator has to own itself because it is about the graph rather than about any
        one system.
      </P>

      <H3 id="work-steps">Work</H3>
      <FieldList
        items={[
          {
            name: "ETL pipeline",
            body: "Runs one of your pipelines, exactly as its own schedule would. Its overlap guard and concurrency cap still apply, and the run's parameters are handed on to it.",
          },
          {
            name: "SQL models",
            body: "Builds models. Naming them builds those and their ancestors; leaving it blank builds every active model.",
          },
          {
            name: "SQL statement",
            body: "One statement against the lakehouse, under the same rules as the workbench: schema-qualified writes, into schemas you can already write to.",
          },
          {
            name: "Data prep flow",
            body: "Refreshes a prep flow's output table.",
          },
          {
            name: "ML schedule",
            body: "Runs a retrain or a batch prediction you have already defined, including its promote-if-better rule.",
          },
          {
            name: "Notebook",
            body: "Runs a notebook in a batch sandbox, with the run's parameters in its inputs.",
          },
          {
            name: "Swarm",
            body: "Runs a swarm's PUBLISHED graph, not the draft on the canvas. A swarm that stops at an approval fails the step — an unattended run has nobody to ask.",
          },
          {
            name: "Refresh dashboard",
            body: "Re-queries a dashboard's widget snapshots. A per-widget failure is reported without failing the step; the dashboard did update.",
          },
          {
            name: "Data monitor",
            body: "Runs a standing check. An ALERT fails the step on purpose — putting a monitor in a graph is how you stop what comes after it when the data is wrong.",
          },
        ]}
      />

      <H3 id="outside-steps">Reaching outside</H3>
      <FieldList
        items={[
          {
            name: "HTTP request",
            body: (
              <>
                One request through the platform&apos;s SSRF guard. Headers are edited a row at a
                time, and a row&apos;s value can be one of your secrets picked <em>by name</em> —
                resolved server-side, never reaching the browser. Any 2xx is success unless you name
                the statuses that count.
              </>
            ),
          },
          {
            name: "Notify",
            body: "An in-app notification, mirrored to whatever notification integrations are connected.",
          },
        ]}
      />

      <H3 id="control-steps">Control flow</H3>
      <FieldList
        items={[
          {
            name: "Condition",
            body: "Evaluates one comparison and takes the true or false arrow.",
          },
          { name: "Wait", body: "Pauses for a fixed number of seconds, up to a day." },
          {
            name: "Approval",
            body: "Raises a request in the approvals inbox and waits for a person. Give it a timeout if it should not wait forever.",
          },
          { name: "Sub-workflow", body: "Runs another workflow whole, and waits for it." },
        ]}
      />

      <H2 id="building">Building a graph</H2>
      <Steps
        items={[
          { title: "New workflow", body: "Name it for what it produces, not for when it runs." },
          {
            title: "Pick steps from the palette",
            body: "Down the left, grouped by what a family of steps is for. Each kind has its own colour, and the canvas uses the same one.",
          },
          {
            title: "Join them",
            body: "Drag from a step's right edge to another step's left edge. Double-click an arrow to remove it. Two arrows into one step means it waits for both, unless you change its trigger rule.",
          },
          {
            title: "Configure each step",
            body: "The panel on the right has two halves: what the step runs, and how the run treats it — trigger rule, retries, timeout.",
          },
          {
            title: "Set the schedule and parameters",
            body: "Under Settings: manual, hourly, daily, weekly or a cron expression with a timezone.",
          },
          { title: "Save, then Run now", body: "The run view updates while it works." },
        ]}
      />
      <P>
        A loop is refused the moment you draw the arrow that would create one. Nothing else about
        the graph blocks an arrow — you can join two steps before either is configured, which is the
        order people actually build in.
      </P>

      <H2 id="trigger-rules">Trigger rules</H2>
      <P>
        Airflow&apos;s names, deliberately: somebody who knows one orchestrator should not have to
        learn a second vocabulary for the same three ideas.
      </P>
      <Table
        headers={["Rule", "The step starts", "Use it for"]}
        rows={[
          ["all_success (default)", "after every parent succeeds", "the ordinary case"],
          [
            "all_done",
            "after every parent finishes, however it finished",
            "a cleanup or a notification that must run whatever happened",
          ],
          [
            "one_success",
            "as soon as any one parent succeeds",
            "a step below both sides of a branch",
          ],
        ]}
      />
      <P>
        An <C>all_done</C> step is never skipped for an upstream failure — waiting for everything to
        finish is the whole point of it. A <C>one_success</C> step is skipped only once{" "}
        <em>every</em> parent has finished without one succeeding.
      </P>

      <H2 id="branching">Branching</H2>
      <P>
        A <strong>Condition</strong> step evaluates one comparison and takes one arrow out of it.
        The first arrow you draw from it is the <C>true</C> branch and the second the <C>false</C>{" "}
        one; the canvas colours them green and red and labels them. Everything on the branch that
        was not taken is marked <strong>skipped</strong>, transitively.
      </P>
      <P>
        You do not write the comparison. The step editor gives you three controls — <em>this</em>, a
        test, <em>that</em> — where each side is one of the workflow&apos;s declared parameters or a
        value you type, and the test is said in words: <em>is</em>, <em>is not</em>,{" "}
        <em>is more than</em>, <em>is at least</em>. There is no syntax to get right.
      </P>
      <Callout kind="why" title="Why the comparison is this small">
        Six comparisons and a bare flag, and that is all. An orchestrator that lets a branch run
        arbitrary code has handed the graph the ability to do anything, and the point of a condition
        step is that you can read it and know what it will do. Anything more complicated belongs in
        a SQL step or a notebook, where it is visible as work.
      </Callout>

      <H2 id="no-notation">Nothing in the editor asks for a notation</H2>
      <P>
        A step is configured by making choices. Three things used to be small languages, and each is
        now a control that can only produce something valid: a condition is assembled from pickers,
        headers are a row each rather than <C>Name: value</C> lines, and the models a build step
        covers are ticked from the ones that exist rather than typed as a comma-separated list.
      </P>
      <P>
        The header value is where this matters most. Instead of typing <C>{"{{secret:NAME}}"}</C>{" "}
        from memory, the row offers <strong>a value I type</strong> or any of your secrets{" "}
        <strong>by name</strong>. Only names reach the browser; the value is resolved on the server
        at run time.
      </P>
      <P>
        What stays free text is text that really is text — a SQL statement, a notification, a
        question for a person. Even there, a <strong>Parameter</strong> button inserts{" "}
        <C>{"{{ params.name }}"}</C> at the cursor so the spelling is never something to remember.
      </P>
      <Callout kind="warn" title="A model that no longer exists is shown, not dropped">
        If a SQL model is deleted after a step selected it, the step still lists it, ticked and
        flagged. Silently removing it would turn a build step into one that builds nothing and calls
        that success.
      </Callout>

      <H2 id="parameters">Parameters</H2>
      <P>
        A workflow declares parameters with defaults under <strong>Settings</strong>; a run may
        override any of them. The resolved set is <strong>pinned onto the run</strong>, so what it
        used stays readable after the defaults change.
      </P>
      <P>
        <C>{"{{ params.name }}"}</C> is filled into a SQL statement, an HTTP URL, header or body, a
        condition, a notification and a swarm&apos;s input, and the whole set is handed to an ETL
        pipeline step so a pipeline that takes a date window gets the run&apos;s window.
      </P>
      <Callout kind="warn" title="An unknown parameter is left as written">
        Not replaced with an empty string. A SQL statement that silently loses its date filter and
        scans all history is worse than one that fails with the placeholder still visible in the
        error. The editor also warns about a name used but not declared.
      </Callout>

      <H2 id="retries">Retries, timeouts and failure</H2>
      <P>
        Each step carries <strong>retries</strong> (attempts after the first, up to 10) and a{" "}
        <strong>first wait</strong> that doubles each attempt and stops at an hour. A retry reuses
        the same row, incrementing its attempt count, so a step stays one line in the run view
        however many times it was tried.
      </P>
      <Table
        headers={["Ceiling", "Default", "What it catches"]}
        rows={[
          [
            "A step's own timeout",
            "WORKFLOW_STEP_TIMEOUT_MINUTES (240)",
            "A sandbox that vanished, or a long job whose process died without reporting",
          ],
          [
            "The workflow's timeout",
            "720 minutes",
            "A graph somehow still open with nothing moving",
          ],
          ["The subsystem's own limit", "its own", "The work itself running long"],
        ]}
      />
      <Table
        headers={["State", "What it means"]}
        rows={[
          ["waiting", "Not started. Something it depends on is still running."],
          ["running", "Its work has been started and has not reported back yet."],
          ["succeeded", "Its work finished and reported success."],
          ["failed", "Its work reported a failure, or never reported at all."],
          [
            "skipped",
            "It never ran, because something it depends on did not succeed or its branch was not taken. Not a failure of its own.",
          ],
        ]}
      />
      <P>
        <strong>Skipped is deliberately not a failure.</strong> A step that never ran tells you
        nothing about itself, and folding the two together makes a run report say four things broke
        when one did.
      </P>
      <P>
        <strong>Carry on if this step fails</strong> reverses that for one step: its children run
        anyway, and its failure does not redden the run — the failure was declared acceptable in
        advance. Use it for the step that refreshes a dashboard, not the one that loads the data.
      </P>
      <Callout kind="warn" title="A partial model build counts as a failure">
        A SQL model build reports <C>partial</C> when some models failed and everything downstream
        of them was skipped. The workflow treats that as a failed step, because the tables the next
        step is about to train on are stale.
      </Callout>

      <H2 id="runs">Runs</H2>
      <UL>
        <li>
          <strong>One at a time.</strong> A workflow will not start a second run while one is in
          flight — two runs of the same graph would start the same pipeline twice and race each
          other&apos;s tables.
        </li>
        <li>
          <strong>The graph and the parameters are pinned.</strong> Editing the workflow never
          rewrites the history of what ran.
        </li>
        <li>
          <strong>Re-run</strong> repeats a finished run with its own parameters.{" "}
          <strong>From failed</strong> keeps every step that succeeded and starts at the ones that
          did not — the point of a re-run is usually the step that broke, not the four-hour load
          above it.
        </li>
        <li>
          <strong>Cancel</strong> stops anything that has not started. Work already in flight keeps
          its own life: the pipeline or training job it started is not killed.
        </li>
        <li>
          <strong>Notifications</strong> are per workflow: never, on failure (the default), or every
          run.
        </li>
      </UL>
      <P>
        Steps are advanced by the platform scheduler, which sweeps once a minute, and again whenever
        you open a live run — so a manual run visibly moves while you watch it.
      </P>

      <H2 id="api">Starting a run from outside</H2>
      <P>
        Under <strong>Settings → Start it from outside</strong>, mint a bearer token. It is shown
        once and stored as a hash, so a lost token is rotated rather than recovered.
      </P>
      <Code lang="bash">{`curl -X POST "$APP_ORIGIN/api/workflows/run" \\
  -H "Authorization: Bearer wfk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"workflow_id":"…","params":{"day":"2026-01-01"}}'`}</Code>
      <P>
        &ldquo;No such workflow&rdquo;, &ldquo;no token minted&rdquo; and &ldquo;wrong token&rdquo;
        all answer one undifferentiated <C>404</C>, so a caller holding a valid token for one
        workflow cannot enumerate the ids of the others. A paused workflow answers <C>409</C>.
        Accepted calls are rate limited by <C>WORKFLOW_TRIGGER_PER_MIN</C> (default 6), globally
        rather than per process so the ceiling holds across replicas.
      </P>

      <H3 id="limits">Knobs</H3>
      <Table
        headers={["Setting", "Default", "What it does"]}
        rows={[
          [
            "WORKFLOW_STEP_TIMEOUT_MINUTES",
            "240",
            "How long a step may stay running before the workflow gives up on it, unless the step names its own.",
          ],
          [
            "WORKFLOW_RUNS_PER_SWEEP",
            "20",
            "How many due workflows are started, and how many live runs advanced, per sweep.",
          ],
          [
            "WORKFLOW_TRIGGER_PER_MIN",
            "6",
            "External trigger calls accepted per workflow per minute, across every replica.",
          ],
        ]}
      />

      <H2 id="governance">Who may run it, and what gets recorded</H2>
      <P>
        A workflow belongs to the account that created it. Every server function resolves the caller
        from their access token and scopes the query by owner, and there is no workflow grant type
        in IAM — orchestration is not shared, the same way an ETL pipeline is not.
      </P>
      <Callout kind="why" title="Why a step is checked twice">
        A step can only point at something you own, and that is verified when the workflow is
        <strong> saved</strong> and again when it <strong>runs</strong>. A pipeline can be deleted
        or transferred in between, and a graph that keeps executing against something no longer
        yours is exactly the failure worth preventing. A graph that could start work its viewer
        cannot see would be a way around every grant the platform has.
      </Callout>

      <H3 id="audit">The audit trail</H3>
      <P>
        Two writers, and the split is deliberate. The <strong>database</strong> records the row
        changes through a trigger, so creating, deleting or reshaping a workflow is recorded even by
        a write that never went through the app. The <strong>app</strong> records what a row change
        cannot show: that a run started, how it was triggered, and that somebody was refused.
      </P>
      <Table
        headers={["Action", "Written by", "Written when"]}
        rows={[
          ["workflow.create", "trigger", "A workflow row is inserted"],
          [
            "workflow.update",
            "trigger",
            "Its name, graph, schedule, active flag, cron expression or timezone changes",
          ],
          ["workflow.delete", "trigger", "The row is deleted"],
          [
            "workflow.run",
            "app",
            "A run starts — with how it was triggered, its parameter names and its parent run",
          ],
          ["workflow.run.finished", "app", "A run closes, with its outcome"],
          ["workflow.run.cancel", "app", "Somebody cancels a live run"],
          ["workflow.trigger_token.rotate", "app", "A bearer token is minted"],
          ["workflow.trigger_token.revoke", "app", "One is revoked"],
          [
            "workflow.trigger.denied",
            "app",
            "A bearer token was refused against a workflow that exists",
          ],
        ]}
      />
      <Callout kind="why" title="Why the cron expression is on that list">
        The trigger used to watch <C>schedule</C> but not <C>cron_expr</C>, so moving a workflow
        from &ldquo;07:00 on weekdays&rdquo; to &ldquo;every minute&rdquo; left no audit row at all
        — <C>schedule</C> read <C>cron</C> on both sides. Changing when work runs is exactly the
        kind of change a review asks about.
      </Callout>
      <P>
        The run event is written in one place inside the runner rather than at each caller, so a run
        started by the scheduler, by the API or by a parent workflow is recorded on exactly the same
        terms as one somebody clicked. <C>trigger</C> is the column that tells them apart, and{" "}
        <C>api</C> means a bearer token was accepted.
      </P>
      <Callout kind="warn" title="A refused trigger reaches the owner, not the caller">
        A bad token presented against a workflow that exists is audited to that workflow&apos;s
        owner — the same class of signal as an embed or swarm API-key denial. Nothing is written
        when the workflow does not exist: there is nobody to tell, and the caller learns nothing
        either way because the answer is the same undifferentiated <C>404</C>. The token itself is
        never recorded, only whether it was wrong or never minted.
      </Callout>

      <H3 id="step-logs">Getting from a step to its logs</H3>
      <P>
        A step is a remote control, not the machine: when a model build fails, the reason is in the
        build&apos;s own log. Each step in the run view carries a link to where its work keeps its
        logs, with the first characters of the run id beside it to correlate against. A swarm step
        links to its own trace; the rest link to the page that owns the run, because only a swarm
        run has a page of its own today and a link to a <C>404</C> is worse than no link. Detached
        work — a SQL statement, a prep flow, a dashboard refresh, a monitor — never had a run row to
        point at, so those steps show their output inline instead.
      </P>

      <P>
        The one-hop chain a pipeline can carry is still there and still works — see{" "}
        <DocLink to="/docs/etl">ETL Pipelines</DocLink>. Reach for a workflow when the shape is a
        graph rather than a line.
      </P>

      <NextPrev current="/docs/workflows" />
    </>
  );
}
