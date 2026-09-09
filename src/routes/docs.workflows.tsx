import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
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
          "One graph over pipelines, SQL models, ML schedules and notebooks: fan-out, fan-in, skipped steps and a single run history.",
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
        description="One graph over the pipelines, model builds, retrains and notebooks you already have — so ingest, transform and train stop keeping four separate clocks."
      />

      <P>
        Open <strong>Data &amp; BI → Workflows</strong>. A workflow is a graph: each step is
        something the platform can already run, and each arrow means <em>after</em>. A step starts
        when everything it waits for has succeeded, steps that nothing orders run at the same time,
        and a step whose dependency failed is not run at all.
      </P>

      <Callout kind="why" title="Why a chain was not enough">
        A pipeline could already name SQL models and ML schedules to start when it succeeds. But a
        chain is a <em>line</em>. It cannot fan out to three things at once, and — the part that
        actually bites — it cannot fan <em>in</em>. &ldquo;Retrain only after both the orders
        pipeline and the customers model have finished&rdquo; is not expressible as a chain, so the
        workaround is to stagger cron times and hope the first is done before the second starts.
        That hope is what a workflow removes.
      </Callout>

      <H2 id="steps">The four kinds of step</H2>
      <FieldList
        items={[
          {
            name: "ETL pipeline",
            body: "Runs one of your pipelines, exactly as its own schedule would. Its overlap guard and concurrency cap still apply.",
          },
          {
            name: "SQL models",
            body: "Builds models. Naming them builds those and their ancestors; leaving it blank builds every active model, which is what a build normally does.",
          },
          {
            name: "ML schedule",
            body: "Runs a retrain or a batch prediction you have already defined, including its promote-if-better rule.",
          },
          {
            name: "Notebook",
            body: "Runs a notebook in a batch sandbox, the same way the run button does.",
          },
        ]}
      />
      <P>
        Nothing new executes here. A workflow only decides <strong>when</strong>, and records what
        happened as one run instead of four unrelated ones.
      </P>

      <H2 id="building">Building a graph</H2>
      <Steps
        items={[
          { title: "New workflow", body: "Name it for what it produces, not for when it runs." },
          {
            title: "Add steps",
            body: "The four buttons above the canvas. Pick what each one points at in the panel on the right.",
          },
          {
            title: "Join them",
            body: "Drag from a step's right edge to another step's left edge. Double-click an arrow to remove it. Two arrows into one step means it waits for both.",
          },
          {
            title: "Choose a schedule",
            body: "Manual, hourly, daily or weekly. Manual is the default — a graph is usually built before anyone wants it on a clock.",
          },
          { title: "Save, then Run now", body: "The run view opens and updates while it works." },
        ]}
      />
      <P>
        A loop is refused the moment you draw the arrow that would create one, rather than at save:
        the arrow that caused it is under your cursor now and will not be later.
      </P>

      <H2 id="failure">What happens when a step fails</H2>
      <Table
        headers={["State", "What it means"]}
        rows={[
          ["waiting", "Not started. Something it depends on is still running."],
          ["running", "Its work has been started and has not reported back yet."],
          ["succeeded", "Its work finished and reported success."],
          ["failed", "Its work reported a failure, or never reported at all."],
          [
            "skipped",
            "It never ran, because something it depends on did not succeed. Not a failure of its own.",
          ],
        ]}
      />
      <P>
        <strong>Skipped is deliberately not a failure.</strong> A step that never ran tells you
        nothing about itself, and folding the two together makes a run report say four things broke
        when one did. The whole branch below a failure is skipped, not just the next step — leaving
        the rest pending would be a run that never ends.
      </P>
      <P>
        <strong>Carry on if this step fails</strong> reverses that for one step: its children run
        anyway. Use it for the step that refreshes a dashboard, not the one that loads the data.
      </P>
      <Callout kind="warn" title="A partial model build counts as a failure">
        A SQL model build reports <C>partial</C> when some models failed and everything downstream
        of them was skipped. The workflow treats that as a failed step, because the tables the next
        step is about to train on are stale. Calling it green is exactly the silent staleness a
        workflow exists to prevent.
      </Callout>

      <H2 id="runs">Runs</H2>
      <UL>
        <li>
          <strong>One at a time.</strong> A workflow will not start a second run while one is in
          flight — two runs of the same graph would start the same pipeline twice and race each
          other&apos;s tables.
        </li>
        <li>
          <strong>The graph is pinned.</strong> A run keeps the graph as it was when it started, so
          editing the workflow never rewrites the history of what ran.
        </li>
        <li>
          <strong>The run is red if anything failed</strong>, even when later steps succeeded around
          it. The alternative — calling it green because the last step was fine — is how a broken
          nightly load goes unnoticed for a week.
        </li>
        <li>
          <strong>Cancel</strong> stops anything that has not started. Work already in flight keeps
          its own life: the pipeline or training job it started is not killed.
        </li>
      </UL>
      <P>
        Steps are advanced by the platform scheduler, which sweeps once a minute, and again whenever
        you open a live run — so a manual run visibly moves while you watch it.
      </P>

      <H3 id="limits">Knobs</H3>
      <Table
        headers={["Setting", "Default", "What it does"]}
        rows={[
          [
            "WORKFLOW_STEP_TIMEOUT_MINUTES",
            "240",
            "How long a step may stay running before the workflow gives up on it. A backstop for a sandbox that vanished without reporting, not a cap on the work.",
          ],
          [
            "WORKFLOW_RUNS_PER_SWEEP",
            "20",
            "How many due workflows are started, and how many live runs advanced, per sweep.",
          ],
        ]}
      />

      <Callout kind="info" title="Workflows are owner-only">
        A workflow belongs to the account that created it, matching the pipelines and models it
        orchestrates. A graph that could start work its viewer cannot see would be a way around
        every grant the platform has, so sharing one is a larger change than adding a policy. Name,
        graph, schedule and active changes are written to the audit log.
      </Callout>

      <P>
        The one-hop chain a pipeline can carry is still there and still works — see{" "}
        <DocLink to="/docs/etl">ETL Pipelines</DocLink>. Reach for a workflow when the shape is a
        graph rather than a line.
      </P>

      <NextPrev current="/docs/workflows" />
    </>
  );
}
