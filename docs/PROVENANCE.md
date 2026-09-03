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
decision began**. The catalog can be re-attached pinned to that snapshot, so
that single integer is the difference between an answer that is merely
_recorded_ and one that is _reproducible_ — the same question, against the data
exactly as it was.

The mechanism is `ATTACH … (SNAPSHOT_VERSION n, READ_ONLY)`, not the per-table
`AT (VERSION => n)` syntax in DuckLake's documentation: on this catalog that
form returns _"Catalog type does not support time travel"_. Pinning the whole
attachment is the better shape anyway — the recorded SQL runs **unmodified**
against the pinned alias, so a replay cannot differ from the original by a
rewrite we performed.

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

## The Answer Passport

The **Passport** button in the Provenance section downloads the decision as a
portable JSON document: the decision and its snapshot, every model turn, every
data read with the tables it touched and how it was made, the totals, and a set
of notes stating what the document does and does not establish.

It counts **data reads only**. The answer's own audit row, an approval, a
refused read — these are exported under `other_events`, because they are part of
what happened, but they are not reads and are not counted as reads. Overstating
the evidence is the failure this whole feature exists to prevent: an examiner
who checks a claim of two reads and finds one stops believing the document.

Two properties make it worth keeping.

**It is canonical.** The signed bytes are produced with sorted keys and no
incidental whitespace, so the same decision always signs to the same value.
`JSON.stringify` preserves _insertion_ order, so without this a document
assembled differently would sign differently — and a verifier could not tell
that apart from tampering. Arrays keep their order, because the sequence of
reads is part of what happened.

**It is honest about itself.** Set `PROVENANCE_SIGNING_SECRET` (16+ characters)
and the passport carries an HMAC-SHA256 signature over those canonical bytes.
Leave it unset and the signature is `null` **and the document says so in its own
notes** — an unsigned document that looked signed would be worse than none.

Verify one without this instance:

```bash
printf '%s' "$(jq -r .canonical passport.json)" | openssl dgst -sha256 -hmac "$PROVENANCE_SIGNING_SECRET" -hex
```

Compare that to the file's `signature`. The download includes `canonical`
precisely so a recipient never has to re-derive the bytes.

## Replay

A passport records what happened. **Replay reads** re-runs the decision's
recorded queries and checks the record against the data, answering two
questions that are easy to confuse and must never be merged:

| Question                        | How it is answered                                        | A mismatch means                                    |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **Is the record faithful?**     | Re-run against the snapshot that was in force at the time | Our record and the data disagree — the serious case |
| **Does the answer still hold?** | Re-run against the data as it is today                    | The world moved on — not a fault, but worth knowing |

The first is a check on us. The lake at a snapshot is immutable, so re-running
there **must** reproduce the result fingerprint stored on the audit row when
the answer was given. Collapsing the two into one "replay succeeded" would hide
an integrity failure behind an ordinary data update.

For this to be possible each data read records, alongside the tables it
touched, the **query text** and a **`result_digest`** — a short fingerprint of
what it returned. Re-running a query later only proves the query still runs;
comparing against the digest taken at the time is what shows the answer's data
was what the record says it was.

The fingerprint is taken over a **normalised** result — these column names, in
this order, holding these values — not over whatever shape the calling code
happened to hold. That is not a detail: `executeWarehouseQuery` returns rows as
objects keyed by column name while the lakehouse runner returns arrays of
cells, and fingerprinting them as-is made every lakehouse read replay as _"does
not match the record"_ — a false accusation of tampering, on data nothing had
touched.

Digests carry their format (`v1:…`). A fingerprint this build cannot reproduce
is reported as **unknown**, never as a mismatch — otherwise changing the format
would fire the loudest alarm the system has on every historical read at once,
for a reason with nothing to do with the data.

Every read runs under the caller's own grants and row policies, from a
read-only attachment. A replay can never read more than the caller may read,
and can never write.

### A query that answers differently every time

`SELECT random()` replayed as _"does NOT match the record"_ — the tampering
verdict — against a snapshot that cannot change. The record was faithful; the
query simply does not answer the same way twice.

So a mismatch is now **measured, not assumed**. When the as-of run differs from
the record, the same query is run **again against the same immutable snapshot**:

- Two runs that disagree **with each other** → the query is non-deterministic.
  Nothing can be concluded, and the read is reported as _"query is not
  deterministic — cannot be checked"_ rather than as a disagreement. Today's
  comparison is suppressed too: a difference there would otherwise read as _"the
  world moved on"_ when it is only the query being itself.
- Two runs that agree with each other but differ from the record → a genuine
  disagreement, reported as such.

The extra query is only ever paid on a mismatch, never on the happy path. To
make such a read checkable, make the query deterministic: an explicit
`ORDER BY`, and no `random()` or `now()`.

### What cannot be replayed says so

Silence would be the wrong answer, so each unreplayable read carries its
reason:

- **No query text recorded.** Reads from before query recording shipped are
  permanently in this state; nothing can backfill them.
- **A store with no snapshot history** (external Postgres, MySQL, an uploaded
  dataset). The query could be re-run, but with nothing to compare it against a
  difference would be uninterpretable — exactly the ambiguity replay exists to
  remove.
- **No snapshot on the decision**, so only today's data can be read.

And when no digest was recorded, the verdict is _unknown_, never _faithful_.
Manufacturing assurance out of absence is the failure this feature is for.

## Retention: evidence is held longer than telemetry

Retention was already configurable, and it knew nothing about what it deleted.
Setting `trace_retention_days` to 30 removed traces carrying a `decision_id` —
the record behind an answer someone was given — leaving the decision pointing
at nothing and its passport empty. Nobody would notice it happen; they would
find out months later, when the evidence was needed.

So a row that is part of a decision's provenance now expires on its own clock:

| Rows                              | Kept for                                       |
| --------------------------------- | ---------------------------------------------- |
| Ordinary traces and swarm runs    | `trace_retention_days` (0 = forever)           |
| Ordinary audit events             | `audit_retention_days` (365 by default)        |
| Anything carrying a `decision_id` | at least `provenance_retention_days` (**183**) |

**183 days** is the EU AI Act Article 26(6) floor: a deployer of a high-risk
system must keep the automatically generated logs for at least six months, and
those obligations have applied since 2 August 2026. It is a default, not a
lock — lower it if you are outside that scope, raise it towards Article 18's
ten-year documentation standard if you need to. What the platform will not do
is destroy evidence as a side effect of a setting that never mentioned it.

The floor never _shortens_ retention. Where the ordinary window is longer, the
longer window wins — the cutoffs are compared as timestamps and the earlier one
is used, because the earlier cutoff is the one that keeps rows longer.

Purged audit rows are still streamed to stdout as NDJSON before deletion, and
the archive now mirrors each delete exactly — same cutoff, same filter — so the
two can never cover different sets of rows.

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
