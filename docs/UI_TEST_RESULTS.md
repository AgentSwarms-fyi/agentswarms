# UI test results

> Part of the [AgentSwarms docs](../README.md#documentation).

The per-round record of what was driven in the browser and what the rows said.
A rendered card proves nothing: every round below presses the real control,
waits for the real round-trip, and reads the result from the DOM and from the
database row it should have written — `ml_predictions`, `swarm_run_steps`, the
persisted analyst step, `messages.metadata.sources` — never from the screen
alone. Findings that came out of a round are filed in the
[Adversarial log](./ADVERSARIAL_LOG.md) under the reference given.

Fixtures a round creates are deleted afterwards unless the entry says they were
kept for review.

<!-- newest first -->

## 2026-09-18 — A shipped sample pipeline, run; what the product wrote, it could not read back

**Driven.** The running instance, signed in as the owner. `recon_live2`,
created from the bundled **Orders ↔ payments reconciliation** sample — the
most complex graph the product ships: two Python sources, a dedupe, an
aggregate, a **full outer join**, a Python classifier, a two-way filter branch,
and two object-storage targets in **different file formats**. Ten nodes, nine
edges, one run.

The expected answer was computed first, independently, by re-deriving the graph
node by node in pandas inside the runtime image over the same two CSVs — so the
run had something to be wrong against.

| Step                                        | Reference (computed first) | The run reported                   |
| ------------------------------------------- | -------------------------- | ---------------------------------- |
| orders.csv / payments.csv                   | 308 / 290 rows             | 8 / 5 columns, both read           |
| dedupe on `order_id`                        | 300 (8 duplicates dropped) | —                                  |
| payments per order                          | 284 groups                 | `order_id, paid_total, n_payments` |
| **full outer join**                         | **309 rows**               | **309 rows loaded**                |
| classify                                    | 11 columns out             | 11 columns out                     |
| → `finance/orders_reconciled` (**parquet**) | **257**                    | **257**                            |
| → `finance/recon_exceptions` (**jsonl**)    | **52**                     | **52**                             |

Succeeded in 49s. Every number matched, including the classification split
(ok 257 · missing_payment 25 · amount_mismatch 12 · orphan_payment 9 ·
duplicate_payment 6).

Then the Data Catalog was opened on the two tables it had just re-crawled, and
the round stopped being about the join.

### What the catalog said about the files the run had just written

| Asset               | Catalog said         | Actually in the bucket                                 |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `orders_reconciled` | parquet · 257 rows   | `1789716743.9029138.58bdd233ab.parquet` — correct      |
| `recon_exceptions`  | ndjson · **10 rows** | `1789716749.8566182.2f2a328a13.**jsonl.gz**` — 52 rows |

And **Query data** on `recon_exceptions`, the catalog's own button over the
catalog's own asset:

```
IO Error: No files found that match the pattern
"s3://etl/finance/recon_exceptions/*.ndjson"
```

One cause, three faces, all of them "dlt gzips text output":

| #   | Defect                                                                                                                                                                                                                | How it surfaced                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | **The catalog globbed a name nothing has.** `*.${logical format}` over a folder of `*.jsonl.gz` — the fqn is the catalog's join key, so the Workbench, an ETL catalog-asset source and lineage all pointed at nothing | pressing Query data                                             |
| 2   | **The row count was counted in compressed bytes.** Newlines that happen to occur in a gzip stream; 52 rows became a confident, plausible **10**                                                                       | comparing the catalog's row count with the run's own load count |
| 3   | **The object-storage source could not read it back.** `fs.open(k, 'rb')` hands pandas gzip: `UnicodeDecodeError: … byte 0x8b`                                                                                         | reproduced in the runtime image with fsspec + pandas, both ways |
| 4   | **The run and the crawler would then disagree.** A run REPORTS its target's fqn and `catalog_lineage` joins on that string — fixing the crawler alone would have broken the lineage edge instead                      | followed from 1; what dlt writes was then measured, not assumed |

Defect 3 is the one that decides how bad this was: this product's own
object-storage target is what writes the `.gz`, so "pipeline B reads what
pipeline A wrote" — the medallion pattern the other bundled sample
demonstrates — could not work for csv or jsonl at all.

What dlt actually names its files was measured in the runtime image against
dlt 1.30.0 rather than assumed, because assuming is how this happened:

| loader format | file left in the bucket                     |
| ------------- | ------------------------------------------- |
| jsonl         | `1789717247.006242.313c9cc5f7.**jsonl.gz**` |
| csv           | `1789717247.5861135.1a09cd7f30.**csv.gz**`  |
| parquet       | `1789717248.6333005.a2880ca09f.parquet`     |

Spark's naming is different again (`part-*.json`, `part-*.snappy.parquet`), so
the two engines report different globs for the same graph — on purpose, and
asserted as such.

### Union and the quality gate — the last two transform kinds with no live evidence

**`union_live`** — the two halves the reconciliation run wrote, put back
together: a **Data Catalog asset** source on `finance/orders_reconciled`
(Parquet, 257 rows) and another on `finance/recon_exceptions`
(**gzipped** NDJSON, 52 rows) → **union** → `analytics.recon_union`.

The picker named the second one `Reads JSONL at
finance/recon_exceptions/*.jsonl.gz` — the glob the crawler had just corrected
— and the sandbox opened it with pandas, which is the read that used to die on
`byte 0x8b`.

Succeeded in 1m 23s, **309 rows → 1 target**. Read back from the lakehouse:

| recon_status      | rows | reference |
| ----------------- | ---- | --------- |
| ok                | 257  | 257       |
| missing_payment   | 25   | 25        |
| amount_mismatch   | 12   | 12        |
| orphan_payment    | 9    | 9         |
| duplicate_payment | 6    | 6         |
| **total**         | 309  | 309       |

257 + 52 = 309, and the five categories are the reconciliation's own, so the
union is provably the two inputs and nothing else.

**`gate_live`** — `analytics.recon_union` (309 rows) → **quality gate** →
`analytics.gate_out`. Five rules, run in order, covering five of the six check
kinds and all three severities:

| #   | Rule                                | Severity | Expected | The run said                |
| --- | ----------------------------------- | -------- | -------- | --------------------------- |
| 1   | `allowed_values(recon_status ∈ ok)` | drop     | 52       | `DROP … removing 52 row(s)` |
| 2   | `not_null(customer_id)`             | warn     | 5        | `WARN … 5 row(s) violate`   |
| 3   | `range(amount ≥ 0)`                 | warn     | 4        | `WARN … 4 row(s) violate`   |
| 4   | `regex(order_id ~ ORD-[0-9]+)`      | fail     | 0        | silent — nothing to report  |
| 5   | `row_count_min(300)`                | fail     | abort    | **run FAILED**              |

> `RuntimeError: Quality gate Quality gate: row_count_min(300) failed — 257 row(s), need 300`

257 is 309 minus the 52 that rule 1 dropped, so the ordering is real: rule 5
measured the frame rule 1 had already shrunk. Rules 2 and 3 counted their
violations **after** the drop too — 5 nulls and 4 negative amounts among the
257 survivors, not the 15 and 13 in the whole table.

Lowering rule 5 to 250 and re-running: **Succeeded, 257 rows → 1 target.**

With these two, **all fifteen transform kinds have been run against real data
from the canvas**, not only compiled.

### One more thing the round found, by mis-clicking

Creating `recon_live` from the sample produced the **blank starter graph** —
two nodes where the sample has ten — under the name chosen for the sample, and
nothing said so. The New pipeline dialog had been dismissed earlier by a
mis-aimed click on the overlay while a template was selected; Radix unmounts
the dialog's content but not the component holding its state, so on reopening
the tile was still highlighted. Clicking the tile you want is what anybody
does — and the tile toggles. The create path already cleared both fields; only
the dismiss path did not.

### And the fix did not reach the pipeline that found it

With everything deployed and the catalog re-crawled, re-running `recon_live2`
**still wrote the old target fqn** — its lineage edge went on pointing at a
filename that does not exist, beside a catalog asset that was now right.
Pressing **Save** to recompile did nothing: the button is disabled when the
graph has not changed.

The generated program is a cache of the graph, and the run executed the cache.
Every visual pipeline on an upgraded deployment keeps running the previous
release's program until somebody edits it for an unrelated reason — runs still
succeeding, nothing pointing at it. This sitting had already paid for it once
without noticing: the SQL step's move off ibis never reached a pipeline created
before that rebuild, and its stored requirements went on installing ibis.

### A node left half-configured, and what it said

Building the platform-dataset case, the "Choose a dataset" select was never
opened. The graph **saved**, the run **started**, and it failed with

```
requests.exceptions.HTTPError: 404 Client Error: for url:
http://agentswarms:8080/api/notebook/runtime/source
```

— the app's own internal API, named as though it were the problem. Targets had
said the right thing all along ("Node “Reconciled” has no bucket selected",
"Lakehouse table must be a valid identifier … got ''"); sources and transforms
reached pandas, requests or DuckDB first and failed in whichever library got
there. Every required field is now refused at compile, naming the node.

### Three more node kinds, driven

| Pipeline        | Graph                                                             | Result                                           |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `platform_live` | **platform dataset** `summary_segment_data` → lakehouse           | **9,992 rows** — the count the picker advertised |
| `http_live`     | lakehouse `analytics.gate_out` (257) → **HTTP API (reverse ETL)** | **3 requests, 257 records** at the receiver      |

The reverse-ETL target was driven against a real HTTP receiver on the kernel
network, counting what arrived: `rows=100 · rows=100 · rows=57`, 257 records
carrying all thirteen columns. Batching at 100 rows per request is exactly what
the node was configured for.

Its first attempt failed, and that is the finding: the receiver was on `:8099`,
its host was on the allow-list, the generated `allowed_domains` file carried
`.echo-target.local` — and the run died with

```
requests.exceptions.HTTPError: 403 Client Error: Forbidden for url:
http://echo-target.local:8099/hook
```

which reads as the endpoint refusing. It was squid: `http_access deny
!Safe_ports`, and Safe_ports is 80, 443, 9000, 19000. Moving the receiver to
port 80 made the same pipeline succeed first try. The allow-list covers hosts;
nothing covered ports, so the one rule that could refuse a perfectly configured
node was invisible until it fired from inside a container.

### The same graph on the other engine

`spark_live` — lakehouse `analytics.recon_union` (309) → filter
`recon_status == 'ok'` → lakehouse `analytics.spark_out`, with **Engine = Spark
cluster** in Settings. Succeeded in 10m 12s:

```
[etl] spark: connected to sc://spark-connect:15002 (4.2.0)
[etl] spark: staged 257 row(s) at s3a://lakehouse/main/_spark_stage/n3/…
[etl] {"rows_loaded": 257, … "engine": "spark",
       "lineage_sources": ["lakehouse:analytics.recon_union"]}
```

**257** is the same number the pandas engine produced for the same predicate in
`gate_live`, from the same table, with all thirteen columns carried through.
Two engines, one answer. (Ten minutes is this host, not the product: code
generation alone took 7 s on a cold JVM with 8 CPU and 11 GB.)

An earlier attempt failed with **"The run never acquired a sandbox session."** —
the app container was rebuilt while that run sat queued. The message is the
reaper's and it is the right one; noted here because it appears in the run list
above and was self-inflicted.

Kept for review: pipelines **`recon_live2`** (the bundled sample, three runs),
**`union_live`**, **`gate_live`** (one failed run and one succeeded, on purpose),
**`platform_live`**, **`http_live`** and **`spark_live`**, with their runs and
logs; lakehouse
tables `analytics.recon_union` (309), `analytics.gate_out` (257) and
`analytics.platform_out` (9,992) and `analytics.spark_out` (257); bucket
datasets `finance/orders_reconciled`
and `finance/recon_exceptions`. Two throwaway containers can be removed with
`docker rm -f`: **`agentswarms-echo-target`** (the reverse-ETL receiver, on the
kernel network as `echo-target.local`, allow-listed under Admin → Developer
runtime) and the earlier `agentswarms-redpanda-test`.

**Tests:** 21 in `tests/unit/catalogGzipDataset.test.ts`, 7 in
`tests/unit/etlRunRecompiles.test.ts`, 30 in
`tests/unit/etlUnfinishedNode.test.ts` and 6 in
`tests/unit/etlEgressPort.test.ts`, twenty-five guards
mutation-checked one at a time (each reversion caught) with a control mutant
that was correctly missed. The reader is exercised as real Python in the
runtime image, failing without `compression='infer'` and working with it; the
lakehouse mount's fqn regex and the Catalog's "Query data" test are pulled out
of the source and executed, so they are checked by behaviour, not spelling.

## 2026-09-18 — The ETL node catalogue, driven; Kafka against a real broker

**Driven.** The running instance, signed in as the owner, building pipelines
node by node on the canvas rather than from templates — which is how three of
the four defects below were found. Streaming ran against a local Redpanda
(`redpandadata/redpanda:v24.2.7`, alias `redpanda-test.local`) on the kernel
network, fed with `rpk`.

### A long chain of transforms, off an HTTP JSON source

`matrix_transforms`: **orders API (HTTP/JSON)** → filter → select → rename →
derive → deduplicate → limit → **lakehouse table**, every node added from the
toolbar and wired automatically.

| What        | Configured as                            | Read back from `analytics.matrix_out`           |
| ----------- | ---------------------------------------- | ----------------------------------------------- |
| source      | `orders.json`, records path `data.items` | 308 rows arrived                                |
| filter      | `amount > 0`                             | the 7 non-positive rows gone                    |
| select      | order_id, customer_id, country, amount   | exactly those columns, plus the derived one     |
| rename      | `amount → gross`                         | the column is `gross`                           |
| derive      | `net = gross * 0.9`                      | **`sum(net)/sum(gross) = 0.9000` exactly**      |
| deduplicate | (all columns)                            | **`count(DISTINCT order_id) = 250 = count(*)`** |
| limit       | 250                                      | **250 rows**                                    |

### Kafka, against a real broker

`kafka_live`: **Kafka topic** → filter (`status == 'paid'`) → **lakehouse
table** (append). 120 JSON messages produced to `orders_stream`, then 30 more.

| Run | Topic state                                 | Result                 | Table after                                                |
| --- | ------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| 1   | 120 messages, 90 of them `paid`             | Succeeded, **90 rows** | 90 rows, `sum(amount)` **22666.44** — to the cent          |
| 2   | nothing new                                 | **FAILED** — see below | —                                                          |
| 3   | nothing new, after the fix                  | Succeeded, **0 rows**  | unchanged                                                  |
| 4   | 30 more on a DIFFERENT partition, 20 `paid` | Succeeded, **20 rows** | **110 rows**, **25869.13**, 2 partitions, 110 distinct ids |

Run 4 is the one that matters: only the new partition's messages were read,
none of the 120 was read twice, and the totals add up exactly
(22666.44 + 3202.69 = 25869.13).

### What driving it found

| #   | Defect                                                                                                                                           | How it surfaced                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | **"Add rename" did nothing** — one of fifteen transform kinds could not be configured from the canvas at all                                     | clicking it, twice by mouse and once by `.click()` on the element |
| 2   | **A caught-up stream failed on every quiet tick** (`KeyError: 'status'` on a frame with zero rows and only `_stream_*` columns)                  | run 2 above                                                       |
| 3   | **A failed access check read as a refusal** — `no access to lakehouse schema "analytics"` while the same owner queried that schema seconds later | a run in between, then the SQL editor                             |
| 4   | **An HTTP node pointing at an unreachable host** returned forty lines of urllib3 instead of naming the host                                      | pointing an HTTP API source at the app's own origin               |

Defect 2 took two attempts, and the second attempt is the lesson: the first
guard tested for "no rows AND no columns", which is what a bare
`pd.DataFrame()` looks like — and it did not fire, because a quiet Kafka read
returns its five `_stream_*` metadata columns. The live run failed again,
identically. Row count is the honest test.

Kept for review: pipelines **`matrix_transforms`** and **`kafka_live`** with
their runs, tables `analytics.matrix_out` and `analytics.kafka_orders`, and the
Redpanda container `agentswarms-redpanda-test` (removable with `docker rm -f`;
its host is on the egress allow-list as `redpanda-test.local`).

## 2026-09-17 — Lakehouse, ETL and ML, by real runs from the UI, ADVERSARIAL_LOG R16

**Driven.** The running instance on :8080, signed in as the owner, in the
lakehouse SQL editor, the visual pipeline editor and the ML pages. Nothing here
is a rendered card: every row is a real statement against the live catalog or a
real run in the sandbox container, read back from the result grid, the run list
and the run's own log line. The ETL rounds ran on the image built at `b9aef9f`;
the lakehouse rounds on the rebuild that added `64e34dd`, which is the commit
the first pass of this same round produced.

### Lakehouse: what a write may read, and what a quote may contain (`e045783`, `e335335`, `64e34dd`)

**Driven.** The SQL editor on the rebuilt image, in `analytics`, against the
live DuckLake catalog. Row 3 and row 5 are the regression checks (my first two
attempts at this fix broke one each); rows 4 and 6 are the security checks.

| #   | Statement                                                                                | Expected                            | What came back                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `SELECT 'A--B' AS dashes, '/*' AS open_c, '*/' AS close_c`                               | three columns, values intact        | 1 row, 1746 ms — `A--B`, `/*`, `*/`                                                     |
| 2   | the same three literals, one statement earlier (previous image)                          | —                                   | "unterminated quoted string" for the first; the other two silently became ONE column    |
| 3   | `UPDATE analytics.authz_probe SET plan = plan WHERE authz_probe.net_usd > 0`             | succeeds — the alias-qualifier case | Count 9                                                                                 |
| 4   | `CREATE TABLE analytics.authz_probe2 AS SELECT * FROM nosuch.customers`                  | refused, naming the schema it reads | `No access to schema "nosuch" — it doesn't exist, or nobody shared it with you`         |
| 5   | `UPDATE analytics.authz_probe SET status = 'A--B /* not a comment */' WHERE net_usd > 0` | succeeds; the literal survives      | Count 9, then `SELECT status, count(*) …` → `A--B /* not a comment */` ×9, `paid` ×1    |
| 6   | `SHOW ALL TABLES`                                                                        | refused — catalog-wide listing      | `"SHOW" needs a schema-qualified target here — catalog-wide listings are not available` |

Row 2 is the reason row 1 is here: the literal-aware stripper was written for
the write-authorization work and then used only there, so every SELECT kept the
two regexes that did not know what a string was. Reading the diff would not
have shown it — the commit message even claimed the opposite. Typing a
perfectly ordinary statement into the editor did.

Kept for review: `analytics.authz_probe` (10 rows; 9 of them now carry the
comment-shaped status string from row 5).

### Run parameters reach a visual pipeline (`b9aef9f`)

The claim to disprove: before this commit a parameter could be typed into
"Run with parameters", accepted, pinned on the run row and handed to
`entrypoint(inputs)` — and change nothing, because `_tick` never read its
argument. The only way to see it was to compare row counts between two runs.
So that is the test.

**Setup.** New pipeline `param_probe2` from the "Medallion branch-out" sample
(pre-wired: HTTP source → standardise → valid/rejected branches → three object
storage targets). One field edited, in the "Valid rows" filter:

```
is_valid                →   is_valid and country == '{{params.country|DE}}'
```

Saved. Settings → Default destination = "MinIO local etl demo". The source CSV
(`/etl-samples/orders.csv`, 308 rows) carries US 47, JP 34 among its countries.

| Run                 | Parameters          | Result    | Total | `orders_silver` (parameterised branch) | `orders_quarantine` | `revenue_by_country` |
| ------------------- | ------------------- | --------- | ----- | -------------------------------------- | ------------------- | -------------------- |
| 7:30:43 PM, 1 m 1 s | `{"country": "US"}` | Succeeded | 64    | **43**                                 | 18                  | 3                    |
| 7:32:47 PM, 28 s    | `{"country": "JP"}` | Succeeded | 52    | **31**                                 | 18                  | 3                    |

Read from: the Runs tab (status, duration, "N rows → 3 target(s)") and each
run's own **Logs** dialog, which carries the sandbox's `rows_loaded` line with
a per-target breakdown and load ids.

Two runs of one saved pipeline, one program, different data. The controlled
part is what did **not** move: the quarantine and country-KPI branches do not
reference the parameter and read 18 and 3 both times, so the 43 → 31 is the
parameter and nothing else.

### Auto-ingest and a row cursor cannot share a source (`9dd4c9e`)

**Setup.** Pipeline `param_probe`, a "Object storage files" source on the MinIO
bucket, folder `raw/revenue/orders`, **auto-ingest on** and **incremental
cursor `updated_at`** — the combination that used to compile, run once, and
die on its second run inside `json.loads`.

| What                       | Read from                | Result                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The canvas refuses it live | the validation banner    | `Source "Object storage files" uses auto-ingest AND an incremental cursor on "updated_at". They are two cursors for one source and overwrite each other — the pipeline would fail on its second run. Keep auto-ingest to load only new FILES…` |
| Save keeps the draft…      | the Save toast           | "Saved — but the graph can't run yet: …" then the same sentence                                                                                                                                                                                |
| …and the run is refused    | the trigger's reply      | `{ok: false}` — no run row, nothing reached the sandbox                                                                                                                                                                                        |
| The message names both     | the banner and the toast | the node label the user clicked and the column the user typed                                                                                                                                                                                  |

**A finding this round produced.** The refused run's reply was
`"Pipeline has no code to run"` — true (the graph never compiled, so
`source_code` stayed empty) and useless: it reads like the pipeline is empty
and points at a code tab a visual pipeline does not have. `startEtlRun` now
recompiles the stored graph before falling back to that sentence, so Run says
what the editor said. Tests: `tests/unit/etlRunRefusalReason.test.ts`.

Kept for review: pipelines **`param_probe2`** (two succeeded runs with their
parameters and logs) and **`param_probe`** (left in the refused state, so the
banner and the Save toast can be seen without rebuilding it).

### ML: the decision threshold on a warm endpoint (`837180d`)

The hardest of the four to drive, because it needs a **two-class** model (a
single line means nothing otherwise), a threshold set on its production
version, and a **warm** endpoint — the path a deployed model actually answers
from, and the one that was ignoring the line. None of the instance's existing
models qualified: the plan classifier predicts four classes, and no version
anywhere carried a threshold. So the round builds one.

**Setup, all through the UI.** ML → Train a model → `analytics.revenue_facts`,
target `payment_rows` (the profiler labels it "Classification · 2 distinct"),
whole table, no tuning. Trained in ~2 minutes: lightgbm, F1 macro 58.8%,
ROC AUC 86.7%, 96% of rows in the majority class. Accuracy tab → Operating
point → **the line drawn at 0.30** for the class "2" (audited:
`ml.threshold.set`, detail `{version: 1, threshold: 0.3, positive_label: "2"}`).
Automation tab → **Deploy** → "Warm endpoint · serving v1 · 1 of 1 copy
answering".

**Finding the row that tells the two apart.** A threshold only changes an
answer where the positive class scores between the line and 0.5. One batch run
over all 836 rows, then in the SQL editor:

```sql
SELECT order_id, prediction, threshold_applied, proba_2
FROM analytics.threshold_probe_payment_rows_predictions
WHERE proba_2 >= 0.3 AND proba_2 < 0.5
```

Exactly one row: **order 1197** — Customer 058, AMER, pro, `net_usd` 0 — at
`proba_2` 0.3549. argmax calls it "1"; a line at 0.30 calls it "2".

**That row, through the warm endpoint.** Predictions → Try it, with order
1197's six feature values typed in.

| Version's line | Predicted | Probability shown   | `threshold_applied` | `served` | Latency |
| -------------- | --------- | ------------------- | ------------------- | -------- | ------- |
| 0.30 on "2"    | **2**     | 35.5% (= `proba_2`) | **0.3**             | `warm`   | 0.104 s |
| removed        | **1**     | 64.5% (= `proba_1`) | absent              | `warm`   | 0.124 s |

Same row, same endpoint, same artifact; the only difference is the version's
decision threshold. Before this commit the second line was the ONLY answer the
warm path could give — the batch path sent the threshold and the warm path sent
neither it nor the positive label. The probability reported also tracks the
answer rather than the winner, so the row declined at 0.35 does not claim 64.5%
confidence in a decision nobody made.

**What the first attempt found instead.** The same row scored "1" with no
`threshold_applied` on a warm endpoint whose app container definitely carried
the fix. The scorer is not in the app image: `score()` lives in
`docker/notebook-runtime/score_server.py`, baked into
`agentswarms/notebook-runtime`, and the rebuild had named a single service
(`docker compose up -d --build agentswarms`). The old image's signature was
still `def score(rows)`. Rebuilding that image and redeploying the endpoint
produced the table above. The documented upgrade — `docker compose up -d
--build` with no service name — rebuilds both; docs/DEPLOYMENT.md now says so
out loud, because the failure is silent in exactly this way.

Kept for review: model **`threshold_probe (payment_rows)`**
(`/ml/3476e695-e025-4499-9315-1f77da0539c3`) with its line at 0.30, its warm
endpoint, its three predictions and its batch table
`analytics.threshold_probe_payment_rows_predictions` (836 rows).

### The three fixes this round produced, driven on the next image

| What                                        | Driven                                                                    | Result                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run explains a graph that will not compile  | **Run now** on `param_probe`, still in its refused state                  | the toast, and the trigger's own reply, now carry `Source "Object storage files" uses auto-ingest AND an incremental cursor on "updated_at"…` — the canvas's sentence, where "Pipeline has no code to run" used to be |
| A row count is not offered "drop"           | Quality gate node → severity dropdown, read twice                         | check `not_null` → **Fail / Warn / Drop bad rows**; switch the check to **Min row count** → **Fail / Warn** only                                                                                                      |
| Promote-when-better cannot judge an anomaly | new anomaly model, retrain schedule with promote-when-better, **Run now** | v2 trained, production kept, and the notification reads `anomaly_rate: 0.0203 vs production 0.0203 — this metric describes how much was flagged, not how well, so it cannot decide a promotion. Production kept…`     |
| …and the control, in the same inbox         | the clustering model's own scheduled retrain, two hours earlier           | `silhouette: 0.2490 vs production 0.2490 (not better)` — a real quality metric keeps the original wording                                                                                                             |

**One limit, stated rather than papered over.** The retrain produced the same
`anomaly_rate` as the incumbent (0.020335 both, 17 rows of 836), because
isolation forest is deterministic on unchanged data with a fixed contamination
and the contamination is fixed when the model is created. So the DECISION would
have been "kept" under the old comparison too; what the live run proves is the
message. The direction itself — candidate 0.40 against incumbent 0.02 reading
as "better" — is covered by `tests/unit/mlOps.test.ts`, mutation-verified.

**And a control the fix turned into a no-op**, caught by the same round: the
schedule dialog's "Promote the new version when its primary metric beats
production" would still tick for an anomaly model and then never fire. It is
now disabled there, with the reason in place of the label, and the save writes
`promote_if_better: false`.

**The controls the refusals left behind, both directions.** Driven on the
final image, with a schedule saved two builds earlier that still carries
`promote_if_better: true`:

| Where                                 | Anomaly model                                                                                               | Control (classification / clustering)         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| New-schedule dialog                   | checkbox `disabled`, unchecked, label replaced by "…the share of rows it flagged — how much, not how well…" | enabled, ticked, original label               |
| Schedule list subtitle                | `retrain · No tuning` — the suffix is gone though the stored flag is still true                             | `retrain · No tuning · promote when better`   |
| Predictions panel, single row         | —                                                                                                           | "Explain this answer" present                 |
| Batch-prediction dialog               | —                                                                                                           | "Write reason codes beside every row" present |
| Both of those, on the **recommender** | absent                                                                                                      | —                                             |

**And one more control, proved broken before it was fixed.** "Explain this
answer" on `revenue_facts · recommendations`, one row, through the panel: the
prediction succeeded and the stored row reads
`input: {"kind":"rows","count":1,"explain":true}`,
`result.explanations: null`, with the only warning about cold start. The flag
travelled from the checkbox into the request and was dropped without a word,
because the recommendation branch returns before both explain blocks. Neither
explain control is rendered for that task now, and the program says why to any
caller that asks anyway.

Kept for review: model **`anomaly_promote_probe`** with its two versions and
the `promote_probe retrain` schedule, the notification in the bell, and the
recommender's explained prediction row (`7635d72e`), which is the evidence for
the paragraph above.

## 2026-09-16 — A knowledge base chooses its own vector index, ADVERSARIAL_LOG R15

**Driven.** The store seam against this machine's real Supabase project and the
running Qdrant container, with `VECTOR_STORE` unset so the instance default was
Postgres — the case a per-collection choice has to get right and every
instance-wide guard got wrong. `tests/integration/kbVectorStore.test.ts`, run as
`QDRANT_URL=http://localhost:6333 npm run test:integration`.

| What                                    | Read from                                  | Result                                                                                      |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A collection differs from its instance  | `storeKindByKnowledgeBase` on two real KBs | the one that chose Qdrant → `qdrant`; its neighbour → `pgvector`                            |
| Its vectors are answered by Qdrant      | a real search over the real container      | planted vector first at similarity > 0.99, all three ids returned, 7.3 s round trip         |
| The move is reversible                  | the same collection searched in pgvector   | the same chunk first — the embeddings never left `kb_chunks`                                |
| A store cannot widen what a caller sees | a search naming the other collection       | empty                                                                                       |
| Leaving a store clears only that store  | delete from Qdrant, then search both       | Qdrant empty, Postgres unchanged                                                            |
| The fixtures are gone                   | `knowledge_bases`, `knowledge_documents`   | zero `__itest__` rows; the 4 vectors left in Qdrant are an earlier sample's, not this run's |

**A green run that proved nothing, first.** Every test began with an early
return for an unbuilt fixture, and a test that returns early passes. Five ticks,
no Qdrant touched. The cause: the shipped sample collections have a null owner,
so borrowing the first knowledge base borrowed nobody. The file now fails when
`QDRANT_URL` is set and the fixture did not build.

**Then the control itself**, after the owner signed in to a production build of
the commit served on :8081 beside the running instance. The 100-chunk RAG eval
collection was moved to Qdrant and back, through the dialog.

| What                                | Read from                                 | Result                                                                                          |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The control names the real default  | the Retrieval tab on open                 | "Instance default — pgvector"                                                                   |
| It warns before it moves data       | choosing Qdrant                           | the notice about moving vectors appears; no "not configured" warning, since QDRANT_URL was set  |
| Saving moves the vectors            | the toast                                 | "Retrieval settings saved — 100 vector(s) moved into qdrant"                                    |
| They are really there               | Qdrant's own API                          | 4 points → 104; exactly 100 for this collection; a stored chunk's vector finds itself at 1.0000 |
| The choice sticks                   | reopening the dialog                      | opens on Qdrant, and the move warning is gone                                                   |
| Retrieval still answers             | Agent Chat, multi-hop question            | firmware 5.2 and "45 seconds on 3 or more links", cited                                         |
| …and handles a version conflict     | Agent Chat, recency question              | 768 nodes, naming the older 512 document and why it is superseded                               |
| **The query really went to Qdrant** | Qdrant's request counter, before/after    | +1 per question while the collection was on Qdrant                                              |
| Switching back is a plain save      | the toast                                 | "Retrieval settings saved", no move — pgvector needs no copy                                    |
| …and clears only what left          | Qdrant's API                              | this collection's 100 points gone, the other collection's 4 untouched                           |
| **And stops using Qdrant**          | the counter after a question, post-switch | unchanged, while the answer still came back correctly cited                                     |
| Both moves are recorded             | `audit_events`                            | `vector_store.knowledge_base_changed`, pgvector→qdrant 100, then qdrant→pgvector 0              |

Nothing kept: every row the integration test created was deleted, and the eval
collection was restored to the settings it had before this round.

## 2026-09-16 — Every service by default, proved by a fresh clone, ADVERSARIAL_LOG R14

**Driven.** A clone of the commit installed from scratch with
`bash scripts/setup.sh`, beside the running stack with its published ports
remapped so neither touched the other. Its `.env` was made the documented way:
`.env.example` plus this machine's Supabase keys, nothing else edited.

| What                            | Read from                                    | Result                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The clone is runnable           | `git ls-files -s` in the clone               | `scripts/setup.sh` arrives `100755`                                                                                                                                                                                                     |
| One command, every service      | `docker compose ps` in the clone             | 11 services from `bash scripts/setup.sh`, no flags, in 444 s                                                                                                                                                                            |
| The app answers                 | `curl /api/health` on the remapped port      | 200, five seconds after the installer returned                                                                                                                                                                                          |
| The object store has its bucket | `docker compose logs minio-init`             | "Bucket created successfully `lake/lakehouse`" — after three bugs: the Docker Hub image is not pullable, the folded-YAML command read the access key as a command, and the health grace was too short for a first-run format under load |
| The install wired itself        | the clone's `.env`                           | `VECTOR_STORE`, `QDRANT_URL`, `FEATURE_STORE_URL`, `SPARK_CONNECT_URL`, `LAKEHOUSE_CATALOG_URL`, `LAKEHOUSE_DATA_URL`, `LAKEHOUSE_S3_ENDPOINT` all set; the catalog password generated into both places that carry it                   |
| The app reaches every service   | `node` inside the app container              | qdrant, minio, docgen, notebook-gateway, js-sandbox all HTTP 200; valkey tcp open; the catalog and Spark refused at that moment                                                                                                         |
| Those two refusals              | the same probes after they finished starting | the catalog: "accepting connections" and healthy once Postgres' first-boot init ended; Spark: still fetching its connector jars (the installer says it does), and tcp open on a stack whose ivy volume already holds them               |
| The running stack was untouched | `docker compose ps` in the repository        | unchanged throughout                                                                                                                                                                                                                    |

Nothing kept: the clone, its containers and its volumes were removed at the end.

## 2026-09-15 — Installers, compose, Dockerfiles, manifests, backup and restore, ADVERSARIAL_LOG R13

**Driven.** Every installation and deployment asset, statically where a
cluster is not needed and live against the running stack where it is: the
three shell installers and the PowerShell one (parsed, `--help` / `-Help`
exercised), the five Dockerfiles through `docker build --check`, the compose
file rendered with and without every profile, the four Kubernetes manifests
through the new structural checker, the doc-command checker over 73
documents, `scripts/ui-smoke.mjs` over every route of the running server, a
real backup and the documented restore drill against the live catalog and
lake, the runtime verifier and the notebook hardening suite.

| What                                  | Read from                                                    | Result                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell and PowerShell installers parse | `bash -n`, the PowerShell parser                             | six shell scripts and `setup.ps1` parse; every `--help` prints its whole header (they cut mid-sentence before, and `setup-k8s.sh` and `setup.ps1` had none)                                                                                                                                                                                           |
| Exec bits                             | `git ls-files -s`                                            | all six shell scripts were `100644` — `./scripts/setup.sh` as the in-app page said would be "Permission denied" on a fresh Linux or macOS clone; now `100755`, and the page says `bash scripts/setup.sh` like every other doc                                                                                                                         |
| Installer ↔ compose parity            | `scripts/check-infra.mjs`                                    | seven compose profiles, each a flag of both installers and part of `--all`; `setup.sh --help` had lost `--featurestore` and both installers said "six profiles" — fixed and pinned                                                                                                                                                                    |
| Dockerfiles                           | `docker build --check`, all five                             | one warning (the publishable Supabase key in ENV — the anon key, public by design; the directive skips the rule with that reasoning); the other four clean                                                                                                                                                                                            |
| Compose                               | `docker compose config -q`, with and without `--profile all` | renders                                                                                                                                                                                                                                                                                                                                               |
| Kubernetes manifests                  | `scripts/check-infra.mjs` (js-yaml), no cluster              | 47 documents: every workload's selector matches its template, every container has an image, every Service and PodDisruptionBudget selects a pod, the HPA targets a defined Deployment, the two secrets pods read are created by the installer or the handbook; two Deployments without requests sit in a namespace whose LimitRange supplies them     |
| Documented commands                   | `npm run check:doc-commands`                                 | 73 documents, every `npm run` script, every script a page runs, every manifest path and every `--profile` name resolves                                                                                                                                                                                                                               |
| Every route                           | `scripts/ui-smoke.mjs` against the running server            | 83 routes, 0 failing (no 500, no error boundary)                                                                                                                                                                                                                                                                                                      |
| Backup                                | `npm run backup -- --out <scratch>`                          | catalog dump 83,803 bytes / 161 objects via the live catalog container; 79 lake objects (3,384,762 bytes) mirrored; all 25 catalog-referenced data files present in the bucket; the application database skipped as documented (no `SUPABASE_DB_PASSWORD` for the hosted project); 6 secrets listed by name only                                      |
| Restore drill                         | `npm run restore -- <dir> --drill`                           | scratch database `lakehouse_catalog_drill` restored — 11 tables, 17 data files, snapshot 460 — compared with the live catalog (unchanged) and dropped; 25 objects re-uploaded under a scratch prefix, sizes verified, prefix removed; **DRILL PASSED**                                                                                                |
| Runtime verifier                      | `bash deploy/notebooks/test/verify-runtime.sh`               | before: 15 of 16, the failure "Kernel reaches the platform — All connection attempts failed" was the verifier pointing the kernel at the host gateway from an `internal` network; after mirroring the product's callback URL: **16 of 16**, "Kernel reaches the platform (knowledge bases: 19)"                                                       |
| Notebook hardening suite              | `bash deploy/notebooks/test/security-suite.sh`               | builds the runtime image as `agentswarms/notebook-runtime:test` and launches it hardened: non-root uid, read-only rootfs, writable work dir, apt blocked, no Docker socket, no provider secrets, all capabilities dropped, pids and memory limits, no-new-privileges; the frameworks import and a runtime pip install works — **12 passed, 0 failed** |
| Infra checker in the gate and CI      | `package.json`, `.github/workflows/ci.yml`                   | `check:doc-commands` and `check:infra` run in `npm run check` and in CI; nine mutants (an exec bit lost, a help line dropped, the count regressed, the verifier's origin, the Dockerfile directive, the page's dot-slash, a Service selecting nothing) caught, a comment-only control missed                                                          |

Nothing to keep or clean up: the backup went to the session scratch directory,
the drill removed its scratch database and prefix, and no rows were created.

## 2026-09-15 — Agent Chat with a complex knowledge base: accuracy, tool bloat, context bloat, ADVERSARIAL_LOG R12

**Driven.** Knowledge Bases → the fixture collection → **Index 12 documents**
(indexed 12/12, 100 chunks, all embedded); Agent Builder, **New Agent**
(name, prompt, `openai/gpt-5.2`, the collection toggled on the Knowledge
tab, no tools) → **Create Agent**; Agent Chat → two questions typed into the
box and sent with the button; the twenty-question rounds through `/api/chat`
from the signed-in page with the chat page's own request body, answers read
from the stream. Then **Edit → Tools** with thirteen tools on → **Update
Agent**, the round again, and the tools off again.

| What                               | Read from                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The corpus                         | `knowledge_documents`, `kb_chunks`                                      | 12 documents (1,300–24,000 characters), 100 flat chunks of 14–290 tokens, `text-embedding-3-small` via OpenRouter, `retrieval_settings` null                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Baseline, 20 questions             | the stream: answer, `citations`, `sources`, usage                       | 11 pass · 3 partial · 6 fail; every citation exactly 560 characters; 705 prompt tokens and 9.8 s a turn on average; no hallucination — each miss said the excerpt lacked the table, the price, the RTO                                                                                                                                                                                                                                                                                                                                                                         |
| Where the answer chunk ranked      | the same RPCs the server calls, per question                            | the SLA table (chunk 0) at vector rank 3 behind the document's own boilerplate at rank 1, so the one-chunk collapse dropped it; keyword search ranks the two SLA tables 1 and 2 for the short phrasing and finds nothing for the long one                                                                                                                                                                                                                                                                                                                                      |
| After the fix, same 20 questions   | the stream, rebuilt image                                               | **20 pass**; citations 500–3,100 characters, ~10,000 of grounding a turn; 2,434 prompt tokens and 6.5 s a turn on average; 512-or-768 answered with both figures and the firmware condition; the credit capped at €6,000; Mumbai Q1 2027 from the newer report                                                                                                                                                                                                                                                                                                                 |
| Typed into the real chat           | DOM + `messages.metadata.sources`                                       | "What is the RTO … and what heartbeat-loss condition declares one?" → 20 minutes; 45 seconds on 3 or more links, cited [1]; Sources (5) rendered under the answer, the runbook first with chunks 0, 1 and a later one joined; the persisted row carries five `kb` sources of 1,037–2,748 characters (conversation `4f327f20-db7f-4bde-a824-1c6000f5984c`)                                                                                                                                                                                                                      |
| Thirteen tools on                  | the stream's `tool` events, usage                                       | 20 pass; 10,390 prompt tokens and 8.2 s a turn; three `calculator` calls, all on the credit question (37,016 tokens, 18.0 s); weather / date / local tables / arithmetic each called its tool once and answered from it; no web search, SQL or ML call on a knowledge-base question; `cached_tokens: 0` throughout                                                                                                                                                                                                                                                             |
| 24-turn conversation               | the stream, full history sent each turn                                 | prompt tokens 2,162 → 4,222 then flat (20-message window), 4.7–13.5 s a turn, every answer right; "what was my first question" answered wrongly and confidently at turn 25 because nothing was persisted for the summariser to fold                                                                                                                                                                                                                                                                                                                                            |
| Rolling summary, rows persisted    | `messages` rows written as the page writes them; the stream             | window forced to 4 messages; the fifth turn carried `memory_used {summaryUsed: true}` and the reply listed the folded questions as "referenced only in the conversation summary", declining to quote them verbatim                                                                                                                                                                                                                                                                                                                                                             |
| Overlap trimmed (third image)      | the stream's `citations`, same runbook question                         | the runbook citation is 2,144 characters instead of 2,304: chunks 0 and 1 joined once — "## Do not" and the RPO sentence appear once where the second image showed them twice — and the answer is unchanged                                                                                                                                                                                                                                                                                                                                                                    |
| Per-tool cost, then the SQL budget | the stream's `cost` event, one tool enabled at a time, same question    | each tool's prompt tokens over the bare request: `sql_query` 5,240, `ml_predict` 701, `kb_graph_search` 508, `data_health` 264, `weather` 185, `web_browse` 185, `calculator` 162, `datetime` 154; n8n, MCP and notifications 0 until something is connected. On the fourth image, with the listing budgeted at 4,000 characters: `sql_query` 1,416 (twice, identical), the thirteen-tool request 5,613 across two rounds against 26,924 across four before                                                                                                                    |
| Similarity floor (fifth image)     | the stream: `citations`, usage; ten off-topic questions then the twenty | before: every question grounded on five documents (~2,400 prompt tokens); measured best-chunk similarity 0.38–0.75 for the twenty, 0.10–0.32 for the ten off-topic, no keyword hit off-topic. After, floor 0.3: nine of the ten off-topic questions carry 0 citations at 155–167 prompt tokens and are answered plainly (weather declined, the date, a haiku, Canberra); "how many local data tables" at 0.32 still grounds (3 citations, 1,952 tokens) and is answered honestly; the twenty: **20 pass**, no question below 4 citations, 2,358 prompt tokens and 6.8 s a turn |
| A 36,000-character question        | the stream                                                              | status 200, the right answer, 10,108 prompt tokens, five citations — the query embedding survived; the 4,000-character input guardrail is off by default                                                                                                                                                                                                                                                                                                                                                                                                                       |

Kept for review: the collection **RAG eval · Halvard Systems**
(`461854a2-6b32-444d-9dd3-6c306b82adf9`, 12 documents), the agent
**RAG eval · Halvard support** (`c21fd5a9-0d80-4e20-b3cc-cc7f229f751d`,
restored to the knowledge base alone), and its two conversations — the
first question and the memory-probe rows (`da5d8b96-0ad5-460d-bab2-8c52d4c2caed`),
the runbook question (`4f327f20-db7f-4bde-a824-1c6000f5984c`). The corpus
generator and the answer key are in the session scratchpad, not the repo.

## 2026-09-14 — Handbook reorganisation: page families, subsections, the map and the rail

**Driven.** The rebuilt image, public docs routes, no sign-in. Read from the
DOM at 1400px (the rail), the pane's default 1223px, 768px and 375px; two
screenshots kept in the session, everything else read from the page.

| What                          | Read from                                   | Result                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ML guide is a family      | sidebar anchors on /docs/ml                 | ML Models followed by Training, Predictions, Serving, Trust, Operations; the overview's card grid links the same five; "In this guide · 5 sections" pills: What it is, In this guide, Tasks, Use cases, How this compares                                             |
| A sub-page knows where it is  | /docs/ml/training at 1400px                 | title "ML Models · Training"; sidebar: ML Models marked, Training `aria-current=page` and indented, the four siblings indented and quiet; six H2 ids (prepare … experiments); 15 heading anchors (`aria-label="Link to this section"`); back-to-top absent at the top |
| The rail follows the reader   | same page, jumped to `#results`             | scrollY 2239; the rail lists the six sections and, under the active "Read the results", its one subsection "What the trainer warns about" — no other section's subsections; back-to-top present (screenshot)                                                          |
| A one-section page still maps | /docs/self-hosting/kubernetes               | "In this guide · 7 headings": Kubernetes, Kubernetes in detail, EKS, GKE, AKS, OKE, After any of them; eyebrow SELF-HOSTING; sidebar family Install & deploy → Configuration, Kubernetes (current), Operations                                                        |
| The moved anchor lands        | /docs/ml/predictions#api                    | `#api` exists ("Public API"), top at 96px after load, scrollY 3300 — the API page's link followed the section                                                                                                                                                         |
| Families close elsewhere      | /docs/etl                                   | 34 sidebar links; of the two families only /docs/ml and /docs/self-hosting are present                                                                                                                                                                                |
| Tablet                        | /docs/ml/training at 768px                  | document scrollWidth 762 ≤ 768 (no sideways scroll); the sidebar collapses to the page picker showing "Training"; six pills wrap to 84px; compact "On this page (15)"                                                                                                 |
| Phone                         | /docs/ml/training at 375px, scrolled 1500px | scrollWidth 375 (no sideways scroll); pills wrap to 117px; back-to-top button at (314, 750) bottom-right; compact "On this page (15)"                                                                                                                                 |
| Search reaches a sub-page     | docs search, "EKS"                          | two results: the page "Install & deploy · Kubernetes" and its heading "Amazon EKS, step by step" (index rebuilt for 43 pages, 586 headings)                                                                                                                           |

Nothing to keep or clean up: the round created no rows.

## 2026-09-14 — Predictive-model chooser and the narrow window, ADVERSARIAL_LOG R11

**Driven.** AI Analyst → New: the dialog's new **Predictive models** section
(radio "Any model it can use (7)" / "Only these", then one checkbox per
model with its task → target and a warning mark on the drifted classifier).
Ticked only the plan classifier and created the analyst; reopened it with
the pencil; asked a question naming a model outside its list; widened it to
any model and asked again. Then the page at 1000, 768 and 375px.

| What                                | Read from                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog captions                     | DOM                                                        | "Only these" with nothing ticked → "No predictive models — steps are never scored — tick at least one, or choose any."; one ticked → "1 of 7 predictive models."                                                                                                                                                                                                                                                                                                                                                              |
| The choice is stored                | `ai_analysts.ml_model_names`                               | `["revenue_facts plan classifier"]` on the new analyst; `null` on the older ones (unchanged behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The choice reloads                  | Edit dialog                                                | reopened with "Only these" and the classifier ticked; the card says "1 of 7 predictive models"                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A question naming an unlisted model | DOM                                                        | the analyst stopped and asked rather than scoring with the classifier — first with the planner's own words ("What is the name of the anomalies model you are referring to?"), after the fix with the exact reason: "revenue_facts · anomalies" exists but is not enabled for this analyst — its predictive models are "revenue_facts plan classifier". Enable it under the analyst's settings (the pencil on its card), or ask with one it may use. — with "Go with the assumption" (answer from the data alone)              |
| Widened to any model, same question | DOM + `ml_predictions`                                     | row now `ml_model_names = null`, card "Any predictive model (7)"; the same question scored with "revenue_facts · anomalies" — "Scored 50 of 836 rows … Ranked by anomaly_score (highest first), top 10 of the 50 scored" (which also verifies F17 live: the SQL sampled fifty, not the requested ten), the reviewer's proposed `ORDER BY anomaly_score` refused with the note, findings list the ten orders with their scores                                                                                                 |
| Narrow window                       | container scrollWidth vs clientWidth at 1000 / 768 / 375px | 1000px: container 800/800, rail 223px, four actions visible as icons · 768px: 568/568, rail 223px, four icons · 375px: 375/375, rail hidden, "Show analysts" opens it full-width (374px) with the thread hidden; the app's own "Best on a larger screen" notice shows first, as on every page; picking an analyst closes the rail and shows the thread (verified by dispatching the card's click — the pane's pointer clicks and Enter did not reach the card in the scaled phone emulation, a harness limit, not a page one) |

Kept for review: the restricted analyst (id `0978594e-822c-41fa-a4e4-09423798b263`,
named "Lakehouse analyst" like the session one) with its threads.

## 2026-09-14 — AI Analyst × trained ML models (session), ADVERSARIAL_LOG R10

**Setup.** One analyst ("Lakehouse analyst", reasoning model
`openai/gpt-4o-mini` via OpenRouter, data = the built-in Lakehouse), created
through **AI Analyst → New**. One question per model kind, each in a fresh
analysis thread. Kept on the instance for review: the analyst and all of its
threads (the "before" threads and the "after" threads are both there, newest
last). Models in scope: a classifier bound to a feature view (`order_id`), a
regression, a clustering, an anomaly detector, a recommender and two forecast
models, all on `analytics.revenue_facts`.

### Before the fix

| #   | Question (shortened)                                                               | What happened                                                                                                                                                                                      | Verdict    |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q1  | 15 most recent orders likely enterprise, plan classifier                           | Scored by key, badge + drift health shown; **findings table built from column totals** (`22104 enterprise 0.91` — 22104 is the sum of the ids); reviewer "corrected" the query over the same total | F1, F2     |
| Q2  | Estimate net_usd of March's top 10 with the regression model, compare to actual    | No scored step; step 2 written as SQL over the actual values; reviewer "passed" it as the model's estimate; findings show actual = "estimated"                                                     | F3         |
| Q3  | Assign the 10 largest orders to a group with the clustering model, describe groups | Scored from feature columns; reviewer fixed LIMIT 50 → 10 and re-scored; write-up "distinctions are not provided" — cluster profiles never reached it                                              | F4, F5     |
| Q4  | 10 most anomalous orders since January, anomaly model                              | 50 random rows scored; reviewer proposed `ORDER BY anomaly_score` (binder error); write-up: "the SQL query failed" over a successful step                                                          | F6, F7, F8 |
| Q5  | Monthly net_usd over the next 3 months, "use a trained forecast model if one fits" | Regression model scored 50 orders; write-up invented "month 1–3: 480.89"                                                                                                                           | F9         |
| Q6  | Score the customers with "the churn model", five most at risk                      | Clustering model substituted silently; rows carried 1 of 7 features; "top five at risk" reported                                                                                                   | F10, F11   |
| Q7  | Three recommendations each for two customers                                       | 13 duplicate rows per customer scored (cold-start); reviewer invented `item_id`; write-up "no recommendations … due to query errors"                                                               | F8, F12    |

Evidence read per question: the step's badge title and disclosure line
(DOM), the check line, the FINDINGS block, and the `ml_predictions` row
(`via = ai_analyst`, `status = succeeded`, row count).

### After the fix (rebuilt image, same analyst, same questions)

Three rebuilds: the twelve fixes, then a parser tolerance the re-run found
(F13), then three small follow-ups it found (F14–F16). Every row below was
read from the DOM of the analyst's page and from the persisted step.

| #   | What happened after                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | `SELECT DISTINCT order_id … LIMIT 15`, scored by key, ranked by probability; check passed with a sane note; findings list the three real orders the model called enterprise (1025 0.912, 1713 0.894, 1658 0.862); model notes (class meaning + two leakage warnings) on the step                                                                                                                                                                                     | F1, F2 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q2  | The step naming the regression model is scored (feature columns, `WHERE order_id IN (…)`); findings show actual vs predicted with different numbers; caveats name r2 −0.006 as poor predictive power                                                                                                                                                                                                                                                                 | F3 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Q3  | Scored from feature columns, ranked by distance; model notes carry "Group 0: 752 training rows (90.0%); typical row: plan free, region EMEA, net_usd 492.29 …"; the write-up describes the rows' region/plan but does not quote the profile it was given (LLM writing, not a missing input)                                                                                                                                                                          | F4, F5 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q4  | First attempt: "no analysis steps" — the planner returned a bare `{"score": {…, "rank": …}}` (F13). After the parser tolerance: one step, 50 rows scored, "Ranked by anomaly_score (highest first), top 10 of the 50 scored", write-up says all scores are negative, so nothing is anomalous; no correction touched the model's columns                                                                                                                              | F6, F7, F8 fixed; F13 found and fixed; F14 (rows carried no order id) fixed and verified on the last image: the rows carry order_id, the findings name the ten orders with their scores, and the reviewer's proposed `ORDER BY anomaly_score` was refused in code with the note shown on the step. F17: the SQL limited its sample to the requested 10 rather than the 50-row cap, so the ranking ran over 10 rows; the scoring goal now tells the writer the platform keeps the top N after scoring — verified live in the R11 round (50 sampled, top 10 ranked). |
| Q5  | First attempt: "no analysis steps" — a bare `{"forecast": {…, "horizon": 3}}` (F13). After: a forecast step with the moving-average model — "forecast by" badge, three projected periods with widening intervals, no SQL, caveats about the short last period; the model's period is a week where the question said months (F15)                                                                                                                                     | F9 fixed; F15 found and fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q6  | The analyst stops: "No trained model named "churn" is available to this analyst; it can use … Which should it use, or should it answer without a model?" with "Go with the assumption"                                                                                                                                                                                                                                                                               | F10 fixed; F11 no longer reachable here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q6b | "Go with the assumption": the planner asked the same question again (F16). After the third rebuild it asked a third time ("Which churn model should I use?") with a nonsense assumption of its own; a plan that substitutes under an accepted assumption is now stripped of its scoring in code (unit-tested; not reachable live because the planner keeps asking rather than substituting). Residual: a smaller model may keep asking; it can no longer substitute. | F16 found and fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q7  | `SELECT DISTINCT customer_name …` → one row per customer, both scored; the write-up explains cold_start from the model notes and calls the recommendations unreliable                                                                                                                                                                                                                                                                                                | F8, F12 fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

What the user checking this can open: **AI Analyst → Lakehouse analyst**
(analyst id `820592df-e17f-4ab3-badf-7ad1e7e6e931`) — the "before" and
"after" threads are both kept, newest last, each with its badge, disclosure
line, model notes and findings as read here.

## 2026-09-14 — ML integration program, items 1–6 and R3

Each item was implemented, unit-tested, mutation-checked, then driven in the
browser and read back from the rows before its commit. The commits carry the
full narrative; this is the index.

| Item                                        | Surface driven                                                                             | Evidence read                                                                                                       | Commit    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------- |
| 1 · model picker for the agent's ML tool    | Agent Builder (the ML Predictions picker); Playground; a scheduled headless run            | `agents.ml_model_names` after save/clear; `messages.metadata.sources = [ml_list_models]`; the tool's refusal string | `ce37ba1` |
| 2 · predict by key                          | Playground forced `ml_predict` with `keys`                                                 | `ml_predictions` row `via = agent_tool`, `features_served_from`, `keys_not_found`                                   | `5bae68f` |
| 3 · Score with model canvas node            | Swarm canvas inspector → "Score with model" → run; publish + schedule for the headless leg | `swarm_run_steps.tool_calls` (canvas), the node's output and `swarm_snapshot` (headless)                            | `9c9f561` |
| 4 · prediction as a table in the Playground | Playground Tools panel                                                                     | the SSE `tool` event's `data` block; the ok/error badge                                                             | `a8a93cd` |
| 5 · analyst scores a step                   | AI Analyst, new analyst, scored question, three rounds                                     | persisted `scored` on the step, `ml_predictions` `via = ai_analyst`, `execution_traces` raw replies                 | `40fc2df` |
| 6 · model health everywhere                 | Playground list, forced `ml_predict`, analyst badge/disclosure, four rounds                | `"health"` in the SSE event; the panel notes; persisted `scored.health`; drift score on the prediction row          | `7e662aa` |
| R3 · headless tool calls                    | Published fixture swarm + never-run schedule; observability page Timeline → step → Tools   | `swarm_run_steps.tool_calls` on the agent step and the tool node step                                               | `f2a606c` |

Findings from these rounds: R1–R9 in the Adversarial log.
