# Data monitors

Standing checks on your tables, run on the platform's own clock, with the
history to know what normal looks like, an incident opened when a check
fails and closed when it passes again, and a notification either way. Under
**Data & BI → Data monitors**.

The catalog notices schema drift when it crawls and ETL gates quality on
the way in. Nothing watched a table that was simply standing there: going
stale, shrinking, filling with nulls, growing duplicates. That is how a
dashboard shows last week's number with today's date on it. A monitor is
the standing question; an incident is the open answer.

## What a monitor checks

| Check          | Asks                                                                                                                     | Alerts when                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Freshness**  | The newest value of a timestamp column.                                                                                  | It is older than the limit you set, or the column is empty.                                             |
| **Volume**     | The row count, and the rows added since the last run.                                                                    | The total is outside your bounds, or the judged value is unusual against the last runs (see baselines). |
| **Schema**     | The column names and types: the lakehouse catalog listing, or `information_schema` on a warehouse.                       | A column was added, removed or retyped since the last run. The first run records the baseline.          |
| **Null rate**  | The share of nulls in a column.                                                                                          | It is above the limit you set.                                                                          |
| **Uniqueness** | Duplicate combinations of the columns you name.                                                                          | There is at least one.                                                                                  |
| **Custom SQL** | A `SELECT` of your own returning one number: negative amounts, orphaned keys, a ratio, whatever the table's own rule is. | It is outside the minimum and maximum you set.                                                          |

Tables can live in the **lakehouse** (pick a table; columns are offered) or
in a **connected warehouse** you own (pick the connection, type the schema
and table). A lakehouse check runs through the same governed chokepoint as
every other lakehouse read, audited as a data read and stamped with the
snapshot it saw; a warehouse check runs the read-only query path with the
connection's own concurrency budget.

## Baselines

Volume is the check where "normal" is not a number you know in advance. A
volume monitor keeps the value it judges from each run (rows added since
the last run for an append-only table, the total for a table that is
replaced) and, once it has five, alerts when a new value is further from the
mean than three standard deviations (`DATA_MONITOR_ANOMALY_SIGMA`, or Admin
→ Developer runtime). A history with no spread at all treats any change as
unusual, because that is what the history says; a tiny spread is floored so
one-row jitter never pages anyone. Bounds you set apply first and always.

## Schedules and incidents

Monitors run hourly, daily, weekly or on a cron expression, on the
scheduler sweep the ETL pipelines and ML schedules already share, claimed by
clock so several replicas never run one monitor twice. **Run now** runs a
check on demand; creating a monitor runs it once by default, so the answer
shows before the schedule takes over. Pausing stops the clock and keeps the
history; deleting removes both.

The first failing run opens an incident and notifies you (in-app, and on any
notification channel you connected: Slack, Teams, a webhook). Further
failing runs extend the same incident and count occurrences; they do not
notify again. The first passing run resolves it and notifies "Recovered".
**Acknowledge** marks an incident as seen; **Resolve** closes it by hand. A
check that cannot answer (a timeout, a dropped table, a query error) is
recorded as an error, shown on the page, and opens no incident: a table is
not declared broken on a timeout.

## Agents

An agent with the **Data health** tool turned on can answer "is the revenue
table fresh?" from the monitors and open incidents of the person it runs
as, on scheduled and headless runs too, because the tool re-derives what it
may read from the run's owner.

## Governance

- **Ownership.** A monitor belongs to the person who created it and reads
  the table as that person; a warehouse monitor needs a connection you own.
- **Audit.** The table's trigger audits every change to a monitor's
  definition (`data_monitor`); the runner audits `data.monitor.alert` when an
  incident opens and `data.incident.resolved` when a run closes one; a person
  acknowledging or resolving audits `data.incident.acknowledged` /
  `data.incident.resolved`. Runs themselves are the run history, not audit
  rows, and lakehouse reads are audited as reads.
- **Limits.** `DATA_MONITORS_PER_SWEEP` (20) is how many due monitors one
  sweep runs; a check must answer within 60 seconds. Both defaults are
  editable under Admin → Developer runtime.

## How this compares

Monte Carlo, Anomalo and Metaplane sell this as a product: freshness, volume,
schema and custom checks with learned baselines and incidents. This is the
same shape, on the tables the platform already governs, alerting through the
channels it already has, and readable by its agents. What it does not do
yet: column-level lineage of an incident to the dashboards it affects, and
checks that run inside a pipeline before its load commits (the ETL quality
gates cover that half).

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| "The check failed" with a column name      | The column was renamed or dropped; edit the monitor. A schema monitor on the same table would have said so.                      |
| Volume never alerts on anomaly             | It needs five runs of history first; the first run says how many it has. Set bounds for the meantime.                            |
| Freshness alerts on a table loaded nightly | Set the limit above the load interval (a nightly load needs at least 1,500 minutes), or schedule the check after the load.       |
| A warehouse monitor answers "not yours"    | Monitors run on connections you own; a shared connection cannot carry one yet.                                                   |
| No notification arrived                    | Incidents notify once when opened and once when resolved; a still-failing monitor extends the incident silently. Check the page. |
