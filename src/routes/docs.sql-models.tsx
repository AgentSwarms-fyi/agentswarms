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

export const Route = createFileRoute("/docs/sql-models")({
  head: () => ({
    meta: [
      { title: "SQL Models — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "A transformation layer over the lakehouse: models that reference each other with ref(), built in dependency order, with tests that stop a broken model reaching everything downstream.",
      },
      { property: "og:title", content: "SQL Models — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Models that name each other, built in order, with tests that stop the damage spreading.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/sql-models" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/sql-models" }],
  }),
  component: SqlModelsDocsPage,
});

function SqlModelsDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="SQL Models"
        description="A model is one SELECT that becomes a lakehouse table. ref('other') names another model, which both declares the dependency and resolves to its table. A build walks the graph in dependency order, so a staging table is always rebuilt before the fact that reads it."
      />

      <H2 id="what">What it is</H2>
      <P>
        The vocabulary is dbt&apos;s on purpose: if you have written a dbt project you already know
        what a model, a ref, a materialization and a <C>not_null</C> test are. What is deliberately
        absent is Jinja, macros, seeds and packages. The gap this closes is{" "}
        <strong>ordered transformation</strong>, not a templating language.
      </P>
      <P>
        Find it under <strong>Data &amp; BI → SQL Models</strong>.
      </P>

      <H2 id="why">Why this and not a materialized view</H2>
      <P>
        A <DocLink to="/docs/lakehouse">materialized view</DocLink> already turns one query into one
        table on a schedule. What it cannot do is the thing every warehouse team actually has: a set
        of tables that depend on each other. Two behaviours follow from the graph, and neither is
        available without it.
      </P>
      <UL>
        <li>
          <strong>Order.</strong> A model is built only after everything it refs. A fact rebuilt on
          one schedule while its staging table is rebuilt on another leaves the two disagreeing for
          however long the gap is.
        </li>
        <li>
          <strong>Propagation.</strong> When a model fails — or an <C>error</C> test on it fails —
          everything downstream is <strong>skipped</strong>, not built. A fact silently rebuilt from
          a staging table you already know is broken is the failure mode this exists to prevent.
        </li>
      </UL>
      <P>
        A model and a materialized view cannot claim the same <C>schema.table</C>. Saving a model
        over an existing view&apos;s target is refused by name.
      </P>

      <H2 id="writing">Writing a model</H2>
      <Code>{`select
  order_id,
  customer_id,
  cast(created_at as date) as order_date,
  amount
from analytics.raw_orders
where amount is not null`}</Code>
      <P>
        Saved as <C>stg_orders</C> into a schema you own, that becomes the table{" "}
        <C>&lt;schema&gt;.stg_orders</C> — the model&apos;s name <strong>is</strong> its table name,
        so there is one way to refer to it and no chance of the ref name and the physical name
        drifting apart. Then a model that reads it:
      </P>
      <Code>{`select
  order_date,
  count(*) as orders,
  sum(amount) as revenue
from ref('stg_orders')
group by 1`}</Code>
      <UL>
        <li>
          <C>ref(&apos;stg_orders&apos;)</C> is replaced with the quoted table before the query
          runs, and the dependency is recorded. Nothing else is templated.
        </li>
        <li>
          <strong>A ref inside a comment is not a dependency.</strong> A commented-out ref that
          still imposed a build order would refuse projects that are actually fine.
        </li>
        <li>
          <strong>A cycle is refused when you save</strong>, by name, with the loop spelled out —
          while the project still builds, rather than at the next scheduled build when nothing runs.
        </li>
        <li>
          Names are lower case letters, digits and underscores, starting with a letter or
          underscore.
        </li>
      </UL>

      <H3 id="materialization">Table or view</H3>
      <Table
        headers={["Stored as", "What happens", "Use it when"]}
        rows={[
          [
            "table",
            "Rows are written at build time (CREATE OR REPLACE).",
            "The default. Reads are fast and repeatable.",
          ],
          [
            "view",
            "The query runs on every read.",
            "The model is cheap and you want it always current.",
          ],
        ]}
      />
      <P>
        A build lands as one DuckLake commit, so readers see the previous table or the new one and
        never a half-built one. A <strong>failed</strong> build leaves the previous table in place:
        stale data someone can see and diagnose beats no data at all.
      </P>

      <H2 id="tests">Tests</H2>
      <P>Tests run after a model builds, against the table it just wrote.</P>
      <Table
        headers={["Test", "Asserts"]}
        rows={[
          ["not_null", "A column is never null."],
          ["unique", "A column has no repeated value."],
          ["accepted_values", "A column is one of a list."],
          ["range", "A numeric column sits between two bounds."],
          ["row_count_min", "The table has at least N rows."],
        ]}
      />
      <UL>
        <li>
          <strong>error</strong> — the model is marked failed and everything downstream is skipped.
          Use it for anything that would make a dependant wrong.
        </li>
        <li>
          <strong>warn</strong> — the failure is recorded on the build and the build carries on.
        </li>
      </UL>
      <Callout title="A test that cannot run is not a pass">
        A misspelled column is recorded as an error, not a pass. A misspelling that read as a clean
        assertion for ever would be worse than having no test at all. And a model with no tests
        always counts as built, however wrong the rows are.
      </Callout>

      <H2 id="building">Building</H2>
      <UL>
        <li>
          <strong>Build all</strong> builds every active model, in order.
        </li>
        <li>
          <strong>Build this and what it reads</strong> builds one model with its ancestors —
          dbt&apos;s <C>+model</C>. Rebuilding a fact without the staging table it reads would leave
          the two disagreeing.
        </li>
        <li>
          <strong>A schedule on a model</strong> (hourly, daily, weekly, or a cron expression with a
          timezone) does the same thing on its own. Several due models for one owner become{" "}
          <strong>one</strong> build over the union of their ancestors, so a shared staging table is
          built once per sweep rather than once per dependant.
        </li>
        <li>
          <strong>Pausing</strong> a model stops it being rebuilt, not being read: its table stays
          on disk and <C>ref()</C> still resolves to it.
        </li>
        <li>
          <strong>Deleting</strong> a model deletes the definition. The table stays, because a
          dashboard or an agent may still be reading it — drop it from the Lakehouse page if you
          want it gone. Models that still ref a deleted one are named when you delete it.
        </li>
      </UL>
      <P>
        Scheduled builds ride the same sweep as every other schedule on the platform, with the same
        compare-and-set claim, so every replica behind a load balancer can run it without building
        twice.
      </P>

      <H2 id="metrics">After it builds: naming what the columns mean</H2>
      <P>
        A model produces a <strong>table</strong>. It does not say that <C>net_usd</C> summed is
        &ldquo;revenue&rdquo;, that only completed orders count, or that nobody outside Finance may
        see the margin. That is the <DocLink to="/docs/semantics">semantic layer</DocLink>, and the
        two are meant to be used together.
      </P>
      <UL>
        <li>
          Build the model. It writes <C>analytics.fct_orders</C>.
        </li>
        <li>
          Press <strong>Define metrics on this</strong> on the model, or on the table in the
          Lakehouse page.
        </li>
        <li>The semantic editor opens on that table. Name the metrics and dimensions once.</li>
        <li>
          Dashboards, the AI Analyst, agents through the <C>metric_query</C> tool and the{" "}
          <C>/api/v1/metrics</C> HTTP API then all compute them the same way.
        </li>
      </UL>
      <P>
        The lakehouse is reached as a warehouse connection whose provider is the built-in lakehouse,
        so this needs one connection row the first time. The button offers to create it, and asks
        only for a name.
      </P>
      <Callout title="Keep the division clean and both layers stay small">
        Shape belongs in the model: joins, filters, casts, deduplication, incremental history, done
        once at build time. Meaning belongs in the semantic layer: aggregations, ratios, fiscal
        calendars, row filters per role, resolved at query time.
      </Callout>

      <H2 id="governance">Governance</H2>
      <P>
        Everything a model does, it does <strong>as its owner</strong>. A schedule has no session
        behind it, so the owner&apos;s grants are the only correct authority.
      </P>
      <UL>
        <li>
          <strong>Where it can write.</strong> Only a lakehouse schema the owner owns. A mounted
          data lake is read-only and is refused, at save and again at every build.
        </li>
        <li>
          <strong>What it can read.</strong> Re-checked on every build against the owner&apos;s
          current grants, not against what they had when the model was saved.
        </li>
        <li>
          <strong>What it can be.</strong> A model must be a <C>SELECT</C>. A definition edited into
          a write is refused by the same classifier the SQL workbench uses.
        </li>
        <li>
          <strong>Audit.</strong> <C>sql_model.build</C> for every build with the trigger and each
          model&apos;s outcome, <C>sql_model.pause</C> and <C>sql_model.resume</C>, and the
          table&apos;s own row trigger for every change to a definition, its schedule or its tests.
        </li>
        <li>
          <strong>Lineage.</strong> Model-to-model edges are written on every build and appear in
          the <DocLink to="/docs/data">Data Catalog</DocLink> lineage panel beside crawled and ETL
          edges. They are replaced wholesale each build: a stale edge is worse than a missing one,
          because a stale graph is believed.
        </li>
      </UL>

      <H3 id="troubleshooting">Troubleshooting</H3>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "ref('x') names a model that does not exist",
            "The model was renamed or deleted. The editor flags an unknown ref before you save; the Build order tab lists every one.",
          ],
          [
            "These models depend on each other in a circle",
            "The loop is named in the message. Break it by inlining one side or splitting a model.",
          ],
          [
            "A model says skipped",
            "Something it reads failed. The build log names which one; fix that model and rebuild.",
          ],
          [
            "A model can only be built into a schema you own",
            "The target schema is shared with you, or is a data-lake mount. Mounts are read-only; create your own schema.",
          ],
          [
            "... is already a materialized view",
            "That schema.table is claimed. Delete the view on the Lakehouse page, or give the model another name.",
          ],
          [
            "A build wrote nothing and says error",
            "The whole plan was refused before anything ran — a cycle, or the lakehouse is not configured on this instance.",
          ],
        ]}
      />

      <NextPrev current="/docs/sql-models" />
    </>
  );
}
