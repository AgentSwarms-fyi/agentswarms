# Decision provenance

> Part of the [AgentSwarms docs](../README.md#documentation).

"Where did this answer come from?" — answered from records the platform
already keeps, tied together by one key.

## What a decision is

A **decision** is the top-level thing a person asks about:

| Kind                | One decision is…                              | Its id is…              |
| ------------------- | --------------------------------------------- | ----------------------- |
| `chat_turn`         | one user message and the reply to it          | that turn's trace id    |
| `swarm_run`         | one execution of a deployed swarm, every node | the swarm run id        |
| `dashboard_refresh` | one refresh of a dashboard, every widget      | minted at refresh start |

The id is **reused, not invented**: a chat turn's decision _is_ its trace, a
swarm run's decision _is_ its run. Two ids for one thing is how correlation
keys drift apart. Every node turn inside a swarm adopts the run's id rather
than starting its own, so a run's provenance is one id, not one per node.

## What carries the key

While a decision is underway, its id is stamped on:

- **`execution_traces.decision_id`** — every model call: provider, model, the
  prompt, tokens, cost, latency, tool calls.
- **`audit_events.decision_id`** — every data access a tool makes on the
  answer's behalf: which warehouse, which tables, whether it was an agent
  acting for the user.

Both columns are nullable on purpose. An IAM change or a secret rotation has
nothing to correlate to, and that is correct rather than missing.

The key travels in the agent tool context (`AgentToolContext.decisionId`), so
any tool that writes an audit row can stamp it — and a test counts every audit
write inside the tool registry and fails the build if one omits it. A passport
with one silent hole is worse than none: an examiner who finds the hole
distrusts the whole document.

## The one fact that cannot be reconstructed later

The `decisions` row records **which lakehouse snapshot was current when the
decision began**. DuckLake can re-run a query `AT (VERSION => n)`, so that
single integer is the difference between an answer that is merely _recorded_
and one that is _reproducible_ — the same question, against the data exactly
as it was.

When the lakehouse is not configured, or the snapshot could not be read, the
column is `NULL` and the answer is shown as **recorded, not reproducible**.
That distinction is rendered, never papered over: external warehouses without
time travel (Postgres, MySQL) fall on the same side of it, and a passport that
implied replay was always possible would be lying about exactly the cases an
auditor would test.

Capture is best-effort and fire-and-forget, like an audit write. A provenance
failure must never fail the answer it describes.

## Reading it back

Open any trace under **Traces** and the sheet shows a **Provenance** section:
the decision id and kind, whether it is reproducible (and against which
snapshot), how many model turns and data reads it comprised, and each data read
— action, resource, the tables it touched, and whether an agent tool made it.

Programmatically, `getDecision({ decisionId })` returns the same chain. It is
owner-scoped on the decision row _and_ on each evidence table; a decision id
belonging to another tenant returns `null` rather than a 403 that would confirm
the id exists.

## What this is not

It is not compliance. No tool grants that. It is the **evidence** the EU AI
Act's logging and record-keeping obligations (Articles 12 and 26) ask for,
produced automatically rather than assembled by hand — and it only exists from
the day recording began. Nothing can backfill a decision made before that.

## Schema

`supabase/migrations/20260848000000_decision_provenance.sql`:

- `decisions (id, user_id, kind, root_ref, lakehouse_snapshot_id, created_at)`,
  RLS: owners read; only the server writes.
- `audit_events.decision_id uuid` and `execution_traces.decision_id uuid`,
  each with a partial index `WHERE decision_id IS NOT NULL`.
