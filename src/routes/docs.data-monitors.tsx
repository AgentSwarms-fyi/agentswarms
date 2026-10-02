import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/data-monitors")({
  head: () => ({
    meta: [
      { title: "Data monitors — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Standing checks on lakehouse and warehouse tables: freshness, volume against a learned baseline, schema drift, null rates, uniqueness and custom SQL, with incidents, notifications, audit and an agent tool.",
      },
      { property: "og:title", content: "Data monitors — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Know a table went stale before a dashboard shows last week's number with today's date.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/data-monitors" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/data-monitors" }],
  }),
  component: DataMonitorsDocsPage,
});

function DataMonitorsDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Data monitors"
        description="Standing checks on your tables, run on the platform's own clock, with the history to know what normal looks like, an incident opened when a check fails and closed when it passes again, and a notification either way."
      />

      <H2 id="what">What it is</H2>
      <P>
        The catalog notices schema drift when it crawls and ETL gates quality on the way in. Nothing
        watched a table that was simply standing there: going stale, shrinking, filling with nulls,
        growing duplicates. That is how a dashboard shows last week&apos;s number with today&apos;s
        date on it. A monitor is the standing question; an incident is the open answer. Find them
        under <strong>Data &amp; BI → Data monitors</strong>.
      </P>

      <H2 id="checks">What a monitor checks</H2>
      <Table
        headers={["Check", "Asks", "Alerts when"]}
        rows={[
          [
            "Freshness",
            "The newest value of a timestamp column.",
            "It is older than the limit you set, or the column is empty.",
          ],
          [
            "Volume",
            "The row count, and the rows added since the last run.",
            "The total is outside your bounds, or the judged value is unusual against the last runs.",
          ],
          [
            "Schema",
            "The column names and types: the lakehouse catalog listing, or information_schema on a warehouse.",
            "A column was added, removed or retyped since the last run; the first run records the baseline.",
          ],
          ["Null rate", "The share of nulls in a column.", "It is above the limit you set."],
          [
            "Uniqueness",
            "Duplicate combinations of the columns you name.",
            "There is at least one.",
          ],
          [
            "Custom SQL",
            "A SELECT of your own returning one number: negative amounts, orphaned keys, a ratio.",
            "It is outside the minimum and maximum you set.",
          ],
        ]}
      />
      <P>
        Tables can live in the <DocLink to="/docs/lakehouse">lakehouse</DocLink> (pick a table;
        columns are offered) or in a connected warehouse you own (pick the connection, type the
        schema and table). A lakehouse check runs through the same governed chokepoint as every
        other lakehouse read, audited as a data read and stamped with the snapshot it saw.
      </P>

      <H2 id="baselines">Baselines</H2>
      <P>
        Volume is the check where &quot;normal&quot; is not a number you know in advance. A volume
        monitor keeps the value it judges from each run — rows added since the last run for an
        append-only table, the total for a table that is replaced — and, once it has five, alerts
        when a new value is further from the mean than three standard deviations. A history with no
        spread at all treats any change as unusual, because that is what the history says; a tiny
        spread is floored so one-row jitter never pages anyone. Bounds you set apply first and
        always.
      </P>

      <H2 id="incidents">Schedules and incidents</H2>
      <UL>
        <li>
          <strong>Schedules.</strong> Hourly, daily, weekly or a cron expression, on the scheduler
          sweep the ETL pipelines and ML schedules share, claimed by clock so several replicas never
          run one monitor twice. <strong>Run now</strong> runs a check on demand; creating a monitor
          runs it once by default.
        </li>
        <li>
          <strong>Incidents.</strong> The first failing run opens one and notifies you, in-app and
          on any connected channel (Slack, Teams, a webhook). Further failing runs extend it and
          count occurrences without notifying again. The first passing run resolves it and notifies
          &quot;Recovered&quot;. <strong>Acknowledge</strong> marks it seen;{" "}
          <strong>Resolve</strong> closes it by hand.
        </li>
        <li>
          <strong>Errors are not findings.</strong> A check that cannot answer — a timeout, a
          dropped table, a query error — is recorded as an error and opens no incident.
        </li>
      </UL>

      <H2 id="agents">Agents</H2>
      <P>
        An agent with the <strong>Data health</strong> tool turned on can answer &quot;is the
        revenue table fresh?&quot; from the monitors and open incidents of the person it runs as, on
        scheduled and headless runs too, because the tool re-derives what it may read from the
        run&apos;s owner.
      </P>

      <H2 id="governance">Governance</H2>
      <UL>
        <li>
          <strong>Ownership.</strong> A monitor belongs to the person who created it and reads the
          table as that person; a warehouse monitor needs a connection you own.
        </li>
        <li>
          <strong>Audit.</strong> The table&apos;s trigger audits every change to a definition; the
          runner audits <C>data.monitor.alert</C> when an incident opens and{" "}
          <C>data.incident.resolved</C> when a run closes one; a person acknowledging or resolving
          audits <C>data.incident.acknowledged</C> / <C>data.incident.resolved</C>.
        </li>
        <li>
          <strong>Limits.</strong> <C>DATA_MONITORS_PER_SWEEP</C> (20) is how many due monitors one
          sweep runs and <C>DATA_MONITOR_ANOMALY_SIGMA</C> (3) the baseline threshold; both are
          editable under Admin → Developer runtime. A check must answer within 60 seconds.
        </li>
      </UL>

      <Callout title="How this compares">
        Monte Carlo, Anomalo and Metaplane sell this as a product: freshness, volume, schema and
        custom checks with learned baselines and incidents. This is the same shape, on the tables
        the platform already governs, alerting through the channels it already has, and readable by
        its agents. Not yet: column-level lineage from an incident to the dashboards it affects, and
        checks inside a pipeline before its load commits (the ETL quality gates cover that half).
      </Callout>

      <H3 id="troubleshooting">Troubleshooting</H3>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            '"The check failed" with a column name',
            "The column was renamed or dropped; edit the monitor. A schema monitor on the same table would have said so.",
          ],
          [
            "Volume never alerts on anomaly",
            "It needs five runs of history first; set bounds for the meantime.",
          ],
          [
            "Freshness alerts on a table loaded nightly",
            "Set the limit above the load interval, or schedule the check after the load.",
          ],
          [
            "No notification arrived",
            "Incidents notify once when opened and once when resolved; a still-failing monitor extends the incident silently.",
          ],
        ]}
      />

      <NextPrev current="/docs/data-monitors" />
    </>
  );
}
