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

## 2026-09-22 — A data monitor run and its incident, before and after, ADVERSARIAL_LOG R84

**Why this round exists.** The data monitor's records: a verdict not
stamped on the monitor, an incident not opened, extended or resolved
while the owner was told it was.

### Before the fix

| Driven                                                                                        | Read back                                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Data monitors → the alerting monitor `revenue_facts · negative net rows`, its open incident   | `Opened 16d ago · seen 16 times · last 6m ago`                                                                            |
| its Run now                                                                                   | toast `Value 2 is above the maximum of 0.` after 5 s                                                                      |
| the incident, two seconds later                                                               | `Opened 16d ago · seen 17 times · last 1s ago` — the verdict stamped and the incident extended                            |

A check whose stamp and incident writes land reports itself. The writes
run in the monitor runner on the server, so a failed one cannot be
produced from the browser: the defect half — a verdict the monitor's row
never took, an alert with no incident, "Recovered" over an incident still
open — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `fe257b08f644`);
the Data monitors page reloaded onto it.

| Driven                                                                    | Read back                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| the open incident of `revenue_facts · negative net rows`                  | `Opened 16d ago · seen 17 times · last 23m ago`                                     |
| its Run now                                                               | toast `Value 2 is above the maximum of 0.` after 3 s                                |
| the incident, two seconds later                                           | `Opened 16d ago · seen 18 times · last 1s ago` — the verdict stamped, the incident extended |

The two writes a still-failing check makes — the monitor's verdict and
the incident's extension — are driven here and report themselves as
before. The resolve path needs the table to pass, which means changing
the data under it, so the "Recovered, incident still open" title and the
failed-open notification are held by the tests, along with every write
that fails: a failed database write cannot be produced from the browser
against the monitor runner.

Findings from this round: R84 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A SQL model built, before and after, ADVERSARIAL_LOG R83

**Why this round exists.** The SQL model build's records: a run left
"running" after it finished, a model's badge left on the previous build or
on "edited", lineage rewritten beside what could not be cleared.

### Before the fix

| Driven                                                                    | Read back                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` → Build this and what it reads                 | the button disabled and spinning for about 40 s; toast `Built 1 model`                                        |
| Builds                                                                    | the new run on top: `success · manual · 1m ago · 60.6s · selected stg_revenue · stg_revenue built 836 rows`     |

A build whose close and stamps land reports itself: the run closed with
its outcome and the model's row, the model built with its row count. The
writes run in the model runner on the server, so a failed one cannot be
produced from the browser: the defect half — a run left "running", a
badge left on the previous build or on "edited", a graph drawn beside
what could not be cleared — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `56d9a5952a68`);
the SQL Models page reloaded onto it.

| Driven                                                                     | Read back                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stg_revenue` → Build this and what it reads                               | toast `Built 1 model` after 9 s; Builds: `success · manual · 8s ago · 7.5s · selected stg_revenue · stg_revenue built 836 rows` |
| the model's own header                                                     | `built · 41s ago · 836 rows · builds into analytics` — the stamp landed                                                        |
| the SQL edited by one newline → Save                                       | toast `Saved stg_revenue`; `edited 1s ago · not built since` and `last build, of the previous definition: built · 836 rows · 1m ago` |
| Build this and what it reads, on that edit                                 | toast `Built 1 model`; the edited mark gone, the header `built · 18s ago · 836 rows · builds into analytics`                   |

Both of R83's stamps are driven here: the model's outcome, and the clear
of R60's "edited — not built since" mark by the build of that very edit.
The writes run in the model runner on the server, so a failed one cannot
be produced from the browser: the defect half — a run left "running", a
badge left on the previous build or on "edited", a graph drawn beside what
could not be cleared — is held by the tests.

Findings from this round: R83 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A catalog source re-crawled, before and after, ADVERSARIAL_LOG R82

**Why this round exists.** The catalog crawl's records: a crawl that
succeeded but left its source "crawling", stale assets reported removed and
still listed, lineage cleared and not rewritten — or rewritten beside what
could not be cleared.

### Before the fix

| Driven                                                                                  | Read back                                                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Data Catalog → Sources → `Lakehouse catalog` (10) → "Re-crawl, schedule, remove" → Re-crawl | a spinner on the source; the asset list growing from `21 of 21+` to `54 of …` as the crawl wrote                 |
| about 85 s later                                                                        | toast `Crawled "Lakehouse catalog" — 21 assets, 184 columns · 11 added`; the spinner gone — the source `ready`   |

A crawl whose status writes land reports itself. The writes run in the
crawler on the server, so a failed one cannot be produced from the
browser: the defect half — a source left "crawling" over a crawl that
succeeded, stale assets claimed removed, a lineage graph left stale or
mixed — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `d218d394edca`);
the Data Catalog reloaded onto it, `Lakehouse catalog` now 21 assets.

| Driven                                                                          | Read back                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Lakehouse catalog` → "Re-crawl, schedule, remove" → Re-crawl                    | a spinner on the source; 23 s later toast `Crawled "Lakehouse catalog" — 21 assets, 184 columns`   |
| the source, after                                                               | the spinner gone — the source `ready`; nothing added or removed this time, so no drift noted        |

A crawl whose ready mark and asset writes land reports itself as before.
One whose ready mark fails twice now fails the crawl with the reason
instead of leaving the source "crawling"; stale assets are claimed removed
only once they are; lineage is never written beside what could not be
cleared — held by the tests, since a failed database write cannot be
produced from the browser against the crawler.

Findings from this round: R82 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A scheduled retrain judged, before and after, ADVERSARIAL_LOG R81

**Why this round exists.** The promotion the API and the schedule make
kept the three writes in the order R73 fixed on the page path and dropped
every error, saying "promoted" whatever happened.

### Before the fix

| Driven                                                                                             | Read back                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Automation → `Nightly retrain · retrain · No tuning · promote when better` → Run now | toast `Training started` 22 s later; the schedule row `started`; Versions (25)                                                              |
| the same row, four minutes later                                                                   | `kept 4m ago` — the candidate judged against production and kept                                                                              |
| the bell                                                                                           | `"revenue_facts · groups" v25 trained; production kept · silhouette: 0.2490 vs production 0.2490 (not better) · 3m ago`                       |

A verdict whose promotion is not attempted, or whose writes land, reports
itself. The API path — a version registered from outside — needs an ML API
key and an artifact in the lake bucket, which these rounds never mint or
upload; both halves of that path, and a promotion whose writes fail, are
held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `09f1a7bb3de1`);
the same model reloaded onto it, Automation tab, the schedule `kept 23m ago`.

| Driven                                                   | Read back                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Nightly retrain · promote when better` → Run now        | toast `Training started` 20 s later; Versions (26) on reload                                                                           |
| the schedule row, two minutes later                      | `kept 2m ago` — the candidate judged against production and kept                                                                        |
| the bell                                                 | `"revenue_facts · groups" v26 trained; production kept · silhouette: 0.2490 vs production 0.2490 (not better) · just now`               |

A verdict whose promotion is not attempted, or whose writes land, reports
itself as before. A promotion whose writes fail is now answered as such on
every path — `promoted: false` and `promotion_error` from the API, `kept`
with `last_error` on the schedule and "trained, but could not be promoted"
to the owner — held by the tests, since a failed database write cannot be
produced from the browser against a server function, and the API path
needs a key and an artifact these rounds never mint. Version v26 is kept as
a candidate.

Findings from this round: R81 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A server kernel started and stopped, before and after, ADVERSARIAL_LOG R80

**Why this round exists.** The sandbox's own record, under every ML and ETL
sandbox: a container the session row never learned of, a stopped container
whose row stays live, a touch the idle reaper never sees.

### Before the fix

| Driven                                                                                       | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer workspace → `My Python notebook` → Run cell                                        | the toolbar `Starting kernel…`; `POST /api/notebook/runtime` answering a session `starting`, then — sixteen polls and about 70 s later — `ready` |
| the same page, after                                                                         | `Kernel error: Kernel connect timed out` — the browser could not reach the kernel's gateway (`gatewayUrl: ""`; `NOTEBOOK_GATEWAY_URL` is unset in this deployment), an environment limit, not this round's |
| Developer workspace → Running kernels                                                        | `1 live · ready · My Python notebook · started 2:06:25 PM · Stop`                                                                          |
| Stop                                                                                         | toast `Kernel stopped` about 14 s later; the Running kernels panel gone — no live kernel                                                    |

The session's container was recorded (the runtime answered `ready`, which
needs the ref) and its stop was recorded (the panel emptied). The writes run
in the runtime service, so a failed one cannot be produced from the browser:
the defect half — a container the row could not take left running, a
stopped container's row left live — is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `c28597f45d18`);
the same notebook reloaded onto it.

| Driven                                                                  | Read back                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `My Python notebook` → Run cell                                         | `Starting kernel…`; `POST /api/notebook/runtime` answering a new session `starting`, then `ready` after eleven polls — the container recorded on the row, since `ready` needs its ref |
| Developer workspace → Running kernels                                   | `1 live · ready · My Python notebook · started 2:39:43 PM · Stop`                                                     |
| Stop                                                                    | toast `Kernel stopped` 8 s later; the Running kernels panel gone                                                       |

A session whose container ref and stopped mark land reports itself as
before. One whose ref could not be written is now stopped again and the
start fails as a start; one whose stopped mark could not be written is
said — held by the tests, since a failed database write cannot be produced
from the browser against the runtime service. As before, the page then
reports `Kernel connect timed out` over the ready kernel: `NOTEBOOK_GATEWAY_URL`
is unset in this deployment.

Findings from this round: R80 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Training a version, before and after, ADVERSARIAL_LOG R79

**Why this round exists.** The training job's records: a job claimed
"succeeded" and then a version write that dropped its error — a finished
job over a version "training" for ever — and workers written onto the job
without reading the answer.

### Before the fix

| Driven                                                                                                | Read back                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Train new version → "Train a new version … trains v22", time budget 5 → Train | toast `Training started` about 45 s later                                                                    |
| Jobs                                                                                                  | the new job `running 19s`, then `succeeded 38s kmeans_k2 · Silhouette 0.249`                                  |
| Versions (22)                                                                                         | `v22 candidate kmeans_k2 0.249 836 45s ago`; `v1 production` unchanged                                          |
| Train new version again → Train                                                                       | `Training started` 24 s later; the job `succeeded 12s` before its view could be opened — no cancel to drive     |
| Versions (23)                                                                                         | `v23 candidate kmeans_k2 0.249 836 27s ago`                                                                    |

A job whose outcome writes land shows the version ready, as a candidate,
under a job that succeeded. The writes run in the training service, so a
failed version write cannot be produced from the browser: the defect half —
a job "succeeded" over a version left "training" — is held by the tests.
Versions v22 and v23 are kept as candidates.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `9112063e9cde`);
the same model reloaded onto it.

| Driven                                                                                  | Read back                                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Train new version → "Train a new version … trains v24", time budget 5 → Train           | toast `Training started` 15 s later                                                                |
| Jobs                                                                                    | the new job `running 19s`, then `succeeded 52s kmeans_k2 · Silhouette 0.249`                        |
| Versions (24)                                                                           | `v24 candidate kmeans_k2 0.249 836 11s ago`; `v1 production` unchanged                               |

A job whose version write lands shows a ready candidate under a job that
succeeded, as before; one whose write fails twice is now failed with the
reason instead of left "succeeded" over a version "training" — held by the
tests, since a failed database write cannot be produced from the browser
against the training service. Version v24 is kept as a candidate.

Findings from this round: R79 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — An ETL run cancelled, before and after, ADVERSARIAL_LOG R78

**Why this round exists.** The ETL run's records: a sandbox started that
the run row never learned of, a cancel said over a row still running, a
watermark a successful run could not keep — and a page that said
"Stopping", or nothing, whatever the server answered.

### Before the fix

| Driven                                                                                      | Read back                                                                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ETL Pipelines → `bi_seed` (7 s runs, 108 rows) → Run                                        | toast `Run started` about 25 s later; `Running now 1`                                                                            |
| the pipeline → Runs, a minute in: `Running … 1m 15s` → Cancel, as the sandbox was finishing | **no toast of any kind**; the row read `Succeeded … 1m 16s 108 rows → 1 target(s)` a moment later — the cancel had answered `false` and the page said nothing |
| Run again → the pipeline → Runs, 14 s in: `Running … 14s` → Cancel                          | **no toast**; the row `Cancelled … 16s`                                                                                          |

A cancel that lands shows the row; one that did not — the run already
over — shows nothing at all. The server side — the cancel's write, the
sandbox's session, the watermarks — runs in server functions and the
sandbox, so a failed database write cannot be produced from the browser:
that half is held by the tests.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `906b223c7b32`,
after an intermediate image `53d14b03e6b1` carrying everything but the
page's catch); the ETL page reloaded onto it. Runs of `bi_seed` now finish
17–46 s after `Run started`, so each path below is its own run.

| Driven                                                                                                       | Read back                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `bi_seed` → Run → `Run started` → the pipeline → Runs: `Running … 10s` → Cancel                              | the row `Cancelled … 11s` six seconds later, no toast — a cancel that landed shows the row (and on `53d14b03e6b1`, `Running … 3s` → `Cancelled … 3s`) |
| Run again → Runs: `Running … 32s` → Cancel, with every `POST /_serverFn/…` rejected                          | toast **`Could not cancel the run · Failed to fetch. It is still running.`**; the row still `Running`; the page's own reload saying `Couldn't load pipelines: Failed to fetch` |
| Run again → Runs: `Running … 16s` → Cancel, the sandbox finishing at 17 s                                    | toast **`Could not cancel the run · That run is not running.`** — the server's own answer; the row `Succeeded … 17s 108 rows → 1 target(s)` |

Before the fix the second and third rows said nothing at all. The server
side — the cancel's write, the sandbox's session, the watermarks — is held
by the tests, a failed database write not being producible from the
browser against a server function.

Findings from this round: R78 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A warm endpoint deployed and stopped, before and after, ADVERSARIAL_LOG R77

**Why this round exists.** The server-side write survey's largest cluster:
the ML endpoint module, 23 writes with their result dropped. The ready
stamp answered ok over a row left `starting`; `undeploy` said "stopped"
over a row left `ready`; a copy whose session write failed could never be
stopped.

### Before the fix

| Driven                                                                                          | Read back                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Automation → Warm endpoint `off` → Deploy                | toast `Starting the endpoint and loading the model…`; a scorer sandbox up (`[score] listening on 0.0.0.0:8888`); the server function answering `{ ok: true, version: 1 }` |
| the panel, a second later                                                                        | toast `Serving v1`; `Warm endpoint serving v1`, `Stop`, `Redeploy production`, `0 requests served · not called`                            |
| Stop                                                                                             | the server function answering `{ ok: true }` after 24 s; toast `Endpoint stopped`; `Warm endpoint off`, `Deploy`                            |

The endpoint runs in a sandbox the server starts and stops, so a failed
database write cannot be produced from the browser: the defect half — ok
over a stamp that failed, "stopped" over a row still ready — is held by
the tests. What the browser holds is the regression half: a deploy and a
stop whose writes land report themselves exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `46df8dfdd4a3`);
the same model reloaded onto it, Automation tab, `Warm endpoint off`.

| Driven                                    | Read back                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                                    | toast `Starting the endpoint and loading the model…`; about 80 s later the server function answering `{ ok: true, version: 1 }`, toast `Serving v1` |
| the panel, a second later                 | `Warm endpoint serving v1`, `Stop`, `Redeploy production`                                                                                |
| Stop                                      | the server function answering `{ ok: true }` after 19 s; toast `Endpoint stopped`; `Warm endpoint off`, `Deploy`                          |

A deploy whose ready stamp lands and a stop whose three writes land report
themselves as before. A stamp or a stop that could not be written now
answers with the state it left — held by the tests, since a failed database
write cannot be produced from the browser against a server function.

Findings from this round: R77 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Knowledge Bases across a base change, before and after, ADVERSARIAL_LOG R76

**Why this round exists.** Seen while pressing the siblings of R64: the page
kept the previous base's documents on screen, under the next base's name,
until the next read landed — and kept counting them on the tab after that
read had failed.

### Before the fix

| Driven                                                                                                   | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge Bases → `RAG eval · Halvard Systems`                                                           | heading `RAG eval · Halvard Systems`; 12 documents listed, the first `04-regional-availability-and-compliance-matrix-2026-01.md`; `Documents (12)` |
| `Test`, with every `GET /rest/v1/knowledge_documents` rejected — read 2.5 s in                           | heading **`Test`**; **the same 12 documents still listed**, the same first one; **`Documents (12)`**                                        |
| the same, 10 s in, after the client's four attempts                                                      | `Could not load the documents: TypeError: Failed to fetch`; nothing listed; **`Documents (12)`** still on the tab                             |
| fetch restored; `RAG eval` then `Test` again                                                             | `No documents in this knowledge base.`; `Documents (0)` — what `Test` holds                                                                 |

For the seven seconds a read spends failing — or however long a slow one
takes — the page presents the previous base's list as this base's; and a
count that outlives the read it came from is a claim about rows the page
never read.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `ae7506f1384c`);
the Knowledge Bases page reloaded onto it. The same two bases, the same
rejection — this time of both reads, `knowledge_documents` and
`kb_sources`.

| Driven                                                                                       | Read back                                                                                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RAG eval · Halvard Systems`                                                                 | 12 documents listed, the first `04-regional-availability-and-compliance-matrix-2026-01.md`; `Documents (12)`, `Sources (0)`             |
| `Test`, with every `GET` of both tables rejected — read 2.5 s in                             | heading `Test`; **nothing listed**; `Loading documents…` (a `role="status"` line); **`Documents (…)`, `Sources (…)`**                   |
| the same, 10 s in, after the client's four attempts on each read                             | `Could not load the documents: TypeError: Failed to fetch`; nothing listed; **`Documents (?)`, `Sources (?)`**                          |
| fetch restored; `RAG eval` then `Test` again                                                 | `No documents in this knowledge base.`; `Documents (0)`, `Sources (0)`                                                                 |

The previous base's rows are gone the moment the next base is picked; the
tab counts say what has been read — nothing yet, or nothing at all — and
the panel says it is loading rather than that there is nothing.

Findings from this round: R76 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A workflow run closing, before and after, ADVERSARIAL_LOG R75

**Why this round exists.** The server-side write survey's next file, the
workflow runner. Its closing write was conditional — only the replica that
still saw the run as running wins — and it read back the rows alone, so a
close whose write FAILED looked like a close another replica had made and
returned without a word: a run "running" for ever, no audit entry, no
notification.

### Before the fix

| Driven                                                                                       | Read back                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Workflows → `Test` (no steps) → a Wait step added from the palette, `Wait (seconds)` set to 2 → Save | toast `Saved`; the canvas holds one node, `Wait`                                                        |
| Run now                                                                                      | toast `Run started`; ten seconds later the list reads `Test manual · less than a minute ago succeeded` |
| Runs tab                                                                                     | one run, `succeeded less than a minute ago · manual`, its one step `Wait`                              |

The close runs in the workflow runner on the server, so a failed row write
cannot be produced from the browser: the defect half — a failed close read
as "another replica closed it first" — is held by the tests. What the
browser holds is the regression half: a run that closes still reports
itself, in the list and on the Runs tab, exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the Workflows page reloaded onto it, `Test` with its one Wait step.

| Driven                                   | Read back                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Test` in the list, before the run       | `Test manual · 10 minutes ago succeeded` — the earlier run                                                             |
| Run now                                  | toast `Run started`; ten seconds later the list reads `Test manual · less than a minute ago succeeded`                 |
| Runs tab                                 | two runs, `succeeded less than a minute ago · manual` above `succeeded 10 minutes ago · manual`, each with its `Wait`  |

A run whose closing write lands reports itself as before, in the list and
on the Runs tab; one whose write fails is now retried and, failing twice,
logged with what a person needs — held by the tests, since a failed
database write cannot be produced from the browser against the server-side
runner.

Findings from this round: R75 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Dropping a lakehouse schema, before and after, ADVERSARIAL_LOG R74

**Why this round exists.** The server-side write survey's next file. Dropping
a schema runs `DROP SCHEMA` and then two catalog-row deletes whose errors
were dropped; removing a materialized view, one. Each reported done
whatever the rows answered.

### Before the fix

| Driven                                                                                   | Read back                                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lakehouse → New schema → `r74_probe` → Create                                            | `3 schemas · 21 tables`, `r74_probe` in the object explorer                                             |
| `r74_probe` → Drop schema and everything in it → "Drop schema "r74_probe"? …" → Drop schema | toast `Dropped r74_probe`; the explorer still `3 schemas` with `r74_probe` listed until a reload — stale, not undropped |
| Reload                                                                                   | `2 schemas · 21 tables`; `r74_probe` gone                                                             |

The drop runs in a server function, so a rejected row delete cannot be
produced from the browser: the defect half — done reported over a catalog
row that stayed — is held by the tests. The browser holds the regression
half: a drop that lands reports itself as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the Lakehouse page reloaded onto it, `2 schemas · 21 tables`.

| Driven                                                                                                    | Read back                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| New schema → `r74_probe` → Create                                                                         | a few seconds later `3 schemas · 21 tables`, `r74_probe (0)` in the object explorer                               |
| `r74_probe` → Drop schema and everything in it → "Drop schema "r74_probe"? Every table in it is dropped too. This cannot be undone." → Drop schema | toast `Dropped r74_probe`; the explorer `2 schemas · 21 tables` with `r74_probe` gone, this time without a reload |
| Reload                                                                                                    | `2 schemas · 21 tables`; no `r74_probe`                                                                           |

A drop whose catalog-row deletes land reports itself as before; one whose
row delete fails now names the row that stayed, with the schema already
gone — held by the tests, since a failed database write cannot be produced
from the browser against a server function.

Findings from this round: R74 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Promoting a model version, before and after, ADVERSARIAL_LOG R73

**Why this round exists.** The server-side write survey (237 error-less
writes in 64 files), taken to the one that changes what agents and
dashboards compute with: promoting a version to production. All four of
its writes dropped their error and it answered ok.

### Before the fix

| Driven                                                                                                                    | Read back                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` → Versions (21) → v21 (candidate) → Promote → "Promote v21 to production? Agents and dashboards using this model switch to it immediately." → Promote | toast `v21 is now in production`; v21 `production`, v1 `archived`                                                          |
| v1 → Promote → confirm                                                                                                     | toast `v1 is now in production`; v1 `production`, v21 `archived` — the fixture restored, v21 left archived rather than candidate |

The promotion runs in a server function, so a rejected database write
cannot be produced from the browser: the defect half — `ok: true` over a
write that failed — is held by the tests. What the browser holds is the
regression half: a promotion that lands reports itself exactly as before.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0dd063722838`);
the same model reloaded onto it, Versions tab.

| Driven                                                                                                                        | Read back                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `revenue_facts · groups` → Versions (21): v1 `production`, v21 `archived`                                                     | the fixture as the earlier round left it                                                        |
| v21 → Promote → "Promote v21 to production? Agents and dashboards using this model switch to it immediately." → Promote      | toast `v21 is now in production`; v21 `production`, v1 `archived` — stage, pointer and archive all landed |
| v1 → Promote → confirm                                                                                                        | toast `v1 is now in production`; v1 `production`, v21 `archived` — the fixture restored          |

A promotion whose five writes all land reports itself as before; one whose
write fails now says which step failed and what state it left — held by the
tests, since a failed database write cannot be produced from the browser
against a server function.

Findings from this round: R73 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The sibling paths of R60–R72, every one driven, on the R72 container

**Why this round exists.** Each round above drove one path through its fix
and left the siblings — the same guard on the next button over — to the
tests. This round presses every sibling reachable from the browser, on the
container that carries R72 (`f308cd0a9c0a`), with the same rejected writes
and reads. Nothing here is a new fix; it is the proof the earlier fixes
asked for.

| Round | Driven                                                                                                                                                                  | Read back                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R60   | SQL Models → `stg_revenue` → definition edited by one character → Save                                                                                                  | toast `Saved stg_revenue`; header `edited 1s ago · not built since` and `last build, of the previous definition: failed · 57 rows · 2m ago`; the build dot on the edited state, not the old outcome              |
| R66   | Agent Builder → agent limit changed, with `POST /rest/v1/agent_limits` rejected                                                                                         | toast `Could not save the agent limit TypeError: Failed to fetch. The value shown is what is saved.`; status `Not saved — agent limit: TypeError: Failed to fetch`; the field back on the saved `10`             |
| R71   | Bell (30 unread) → Mark all read, with `PATCH /rest/v1/notifications?read_at=is.null` rejected                                                                         | toast `Could not mark the notifications read …`; the popover's items still listed; badge still `30 unread`                                                                                                       |
| R71   | Bell → one notification (`"revenue_facts · groups" v21 trained; production kept`), with `PATCH /rest/v1/notifications` rejected                                         | toast `Could not mark the notification read TypeError: Failed to fetch. It is still unread.`; badge still `30 unread`                                                                                            |
| R72   | Agent Chat → the 10-message conversation → Regenerate on the last reply, with `DELETE /rest/v1/messages` rejected                                                      | toast `Could not regenerate the reply TypeError: Failed to fetch. The previous reply could not be removed, so it stands.`; 10 bubbles before and after; no new reply streamed                                   |
| R72   | Agent Chat → Delete on the chat `Make a 2-slide PowerPoint about the saas_sales tab` → confirm, with `DELETE /rest/v1/messages` rejected                               | toast `Could not delete the chat …`; the chat still listed; 10 bubbles                                                                                                                                           |
| R72   | Agent Chat → Edit a message, `(edited)` appended → Resend, with `DELETE /rest/v1/messages?id=in.(…)` rejected                                                            | toast `Could not resend the edited message TypeError: Failed to fetch. The conversation is unchanged.`; 10 bubbles; the original text still in place                                                             |
| R64   | Knowledge Bases → `Test` selected after `RAG eval · Halvard Systems`, with every `GET /rest/v1/knowledge_documents` and `GET /rest/v1/kb_sources` rejected                | `Could not load the documents: TypeError: Failed to fetch` on the Documents tab and `Could not load the sources: TypeError: Failed to fetch` on Sources — after the client's four attempts (0 s, 1 s, 3 s, 7 s) |
| R68   | Knowledge Bases → `Test` (0 documents) → its Trash → `Delete "Test"? …` → Delete knowledge base, with `DELETE /rest/v1/knowledge_bases` rejected                         | toast `Could not delete the knowledge base TypeError: Failed to fetch. Its embeddings were already removed — re-index it to restore retrieval.`; `Test` still listed and still selected                          |
| R70   | BI → dashboard `db14d61a…` → Schedule & alerts → alert `Total Sales · row count > 1` added as a fixture; its Trash with `DELETE /rest/v1/bi_alerts` rejected              | toast `Could not delete the alert TypeError: Failed to fetch. It is still set and will still fire.`; the row still listed                                                                                        |
| R70   | The alert's mail button (`Also email me when this alert triggers`), with `PATCH /rest/v1/bi_alerts` rejected                                                            | toast `Could not change the alert's email setting TypeError: Failed to fetch. It is unchanged.`                                                                                                                |
| R70   | The alert's switch, on → off, with `PATCH /rest/v1/bi_alerts` rejected                                                                                                   | toast `Could not switch the alert off TypeError: Failed to fetch. It is still on and will still fire.`; the switch back on. Then deleted for real: the row gone, no toast                                        |
| R69   | Integrations → the Google Gemini card → Disconnect → `Disconnect gemini? The stored key is deleted, not disabled. …` → Disconnect, with `PATCH /rest/v1/integrations` rejected    | toast `Could not disconnect the provider TypeError: Failed to fetch. The provider is still connected.`; the card still `Connected`                                                                               |

**Not driven, and why.** The encrypted-provider disconnect (Bedrock, Azure
OpenAI, Vertex, OCI) and the notification-channel disconnect: no such
provider or channel is connected in this account, and connecting one means
typing a key or a webhook secret, which these rounds never do. Both stay
held by the R69 tests, which pin the `error` read and the message on each.

**Seen on the way, filed rather than fixed.** While the `Test` base's
documents were still loading — seven seconds under the client's retries —
the previous base's 12 documents stayed listed under the `Test` heading,
and after the load failed the tab still read `Documents (12)` for a base
with none. Queued as a candidate: the previous base's list is a stale read
rendered as the current one.

All rejected fetches were restored afterwards; the alert fixture was
deleted; no knowledge base, chat, provider or notification was changed.

## 2026-09-22 — Agent Chat, a message delete that failed, before and after, ADVERSARIAL_LOG R72

**Why this round exists.** The write-side survey's last file, back on the
Agent Chat page: its four deletes — a message, a chat, the reply a
regenerate replaces, the tail an edit-and-resend replaces — all dropped
their error.

### Before the fix

| Driven                                                                                                       | Read back                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)", its conversation of 10 messages                      | 10 bubbles                                                                                    |
| Delete on the last bubble ("I could not find any information…"), with every `DELETE /rest/v1/messages` rejected | **9 bubbles**; one DELETE rejected; **no toast**                                                |
| Reload                                                                                                       | **10 bubbles** — the message was never deleted                                                 |

A message deleted on screen and not in the database is a message that
comes back.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `f308cd0a9c0a`);
the same agent and conversation reloaded onto it. Same bubble, same
rejection.

| Driven                                                                                                      | Read back                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete on the last bubble ("I could not find any information…"), with every `DELETE /rest/v1/messages` rejected | **10 bubbles** — the message back at once; toast **`Could not delete the message · TypeError: Failed to fetch. It is still in the conversation.`**; one DELETE rejected |

The conversation shows what is stored, and the toast says why the press
changed nothing. The chat delete, the regenerate and the edit-and-resend
share the shape and are held by the tests; no real delete was made.

Findings from this round: R72 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The notification bell's Clear, before and after, ADVERSARIAL_LOG R71

**Why this round exists.** The write-side survey's next file. The bell
clears and marks notifications read optimistically and dropped every
write's error.

### Before the fix

| Driven                                                                                          | Read back                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bell (`Alerts & notifications (30 unread)`) → open                                              | `Notifications` · `Mark all read` · `Clear`; newest: `"revenue_facts · groups" v21 trained; production kept`            |
| Clear, with every `DELETE /rest/v1/notifications` rejected                                       | popover **`No notifications — dashboard alerts and scheduled-refresh results land here.`**; badge **`Alerts & notifications`** (no count); one DELETE rejected; **no toast** |
| Reload                                                                                          | badge `Alerts & notifications (30 unread)` — nothing was cleared                                                        |

Thirty notifications were "cleared" on screen and none in the database.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `5b6a98fb8215`);
the page reloaded onto it. Same bell, same rejection.

| Driven                                                                                     | Read back                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bell (`Alerts & notifications (30 unread)`) → open → Clear, with every `DELETE /rest/v1/notifications` rejected | the list **back** (`"revenue_facts · groups" v21 trained; production kept`, …); badge **`Alerts & notifications (30 unread)`**; toast **`Could not clear the notifications · TypeError: Failed to fetch. They are still there.`**; one DELETE rejected |

The list and the badge show what is stored, and the toast says why the
press changed nothing. No notification was cleared: the thirty are as they
were. The two read-marks share the shape and are held by the tests.

Findings from this round: R71 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — A BI data alert switched off, before and after, ADVERSARIAL_LOG R70

**Why this round exists.** The write-side survey's next file, the BI
schedule dialog: every write in it — removing the schedule, deleting an
alert, switching one on or off, its email setting — dropped its error.

### Before the fix

| Driven                                                                                                                                       | Read back                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| BI → "AI verification - generated from saas_sales" → Scheduled refresh & data alerts → Widget `Total Sales`, threshold `1` → Add alert         | toast `Alert added — it's checked after every scheduled refresh`; `Total Sales · row count > 1`, switch on |
| The alert's switch pressed, with every `PATCH /rest/v1/bi_alerts` rejected                                                                    | switch **off** on screen; one PATCH rejected; **no toast**                                       |
| Reload → Scheduled refresh & data alerts                                                                                                     | `Total Sales · row count > 1`, switch **on** — the alert was never switched off                   |

An alert switched off on screen that is still on in the database will
still fire; the dialog showed the switch the person made, not the one that
was stored.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `0e9ad05ab36b`);
the dashboard reloaded onto it. Same alert, same rejection.

| Driven                                                                                            | Read back                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduled refresh & data alerts → `Total Sales · row count > 1`, switch on                          | as left                                                                                                                                    |
| The alert's switch pressed, with every `PATCH /rest/v1/bi_alerts` rejected                          | switch **back on**; toast **`Could not switch the alert off · TypeError: Failed to fetch. It is still on and will still fire.`**; one PATCH rejected |
| `fetch` restored → the alert's delete                                                             | the alert is gone from the dialog; only the schedule switch remains — the fixture is gone for real                                          |

The switch shows what is stored, and the words say what that means. The
schedule removal, the alert delete and the email setting share the shape and
are held by the tests.

Findings from this round: R70 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Integrations, a disconnect that failed, before and after, ADVERSARIAL_LOG R69

**Why this round exists.** The write-side survey's next page. The
Integration Hub disconnects a provider or a notification channel and said
"disconnected" whatever the request answered.

### Before the fix

| Driven                                                                                                                                          | Read back                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Integration Hub → LLM Providers → OpenRouter (`Connected`) → Disconnect → "Disconnect openrouter? The stored key is deleted, not disabled…" → Disconnect, with every write to `provider_credentials` and `integrations` rejected | toast **`Provider disconnected`**; one `PATCH /rest/v1/integrations?id=eq.…` rejected; the card **still `Connected`, its Disconnect still there** |
| Reload                                                                                                                                          | OpenRouter still `Connected`                                                                               |

The dialog had just said the stored key is deleted, not disabled; the page
then said it was done; nothing was.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `4da715363ad2`);
the page reloaded onto it. Same provider, same rejection, same dialog.

| Driven                                                                                                                       | Read back                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration Hub → OpenRouter → Disconnect → confirm, with every write to `provider_credentials` and `integrations` rejected | toast **`Could not disconnect the provider · TypeError: Failed to fetch. The provider is still connected.`**; the card **still `Connected`, its Disconnect still there**; one PATCH rejected; **no "Provider disconnected"** |

The page now says what is true — the provider is still connected — and
says nothing else. No real disconnect was made: the key stays where it
was. The encrypted-provider and notification-channel paths share the shape
and are held by the tests.

Findings from this round: R69 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Knowledge Bases, a document delete that failed, before and after, ADVERSARIAL_LOG R68

**Why this round exists.** The write-side survey's next page. The Knowledge
Bases page deletes a base, a document, or a source's documents, and said
"Deleted" whatever the request answered.

### Before the fix

| Driven                                                                                                                       | Read back                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Knowledge Bases → `Test` → Add Document: name `R68 probe`, a one-sentence body → Add 1 Document & Process                     | `Documents (1)`, `R68 probe` listed                                                        |
| Delete on the document → "Delete "R68 probe"? Its chunks and embeddings go with it…" → Delete document, with every `DELETE /rest/v1/knowledge_documents` rejected | toast **`Document deleted`**; one DELETE rejected; **`Documents (1)`, `R68 probe` still listed** |
| Reload → `Test`                                                                                                              | `Documents (1)`, `R68 probe` still there                                                   |

The page said the document was deleted and showed it in the same breath.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `ce7602e87093`);
the page reloaded onto it. Same fixture, same rejection.

| Driven                                                                                                   | Read back                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge Bases → `Test` (`Documents (1)`, `R68 probe`)                                                  | as left                                                                                                                                                                         |
| Delete on the document → confirm, with every `DELETE /rest/v1/knowledge_documents` rejected              | toast **`Could not delete the document · TypeError: Failed to fetch. Its embeddings were already removed — re-index the knowledge base to restore retrieval.`**; `Documents (1)`, `R68 probe` still listed; **no "Document deleted"** |
| `fetch` restored → Delete → confirm                                                                       | toast `Document deleted`; `Documents (0)`; the fixture is gone for real                                                                                                         |

A delete that fails is said, with what the earlier step already did and what
to do about it; a delete that lands says so and is gone. The base and
source variants share the shape and are held by the tests.

Findings from this round: R68 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — The swarm canvas's delete, before and after, ADVERSARIAL_LOG R67

**Why this round exists.** The write-side survey's next page. The swarm
gallery already says "Failed to create swarm" and "Failed to delete"; the
canvas, which has its own create and delete, did not.

### Before the fix

| Driven                                                                                                                 | Read back                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Swarms gallery → New Swarm (with every `POST /rest/v1/swarms` rejected)                                                 | toast `Failed to create swarm` — the gallery's own path, already honest; `My Swarms 15` unchanged                    |
| `fetch` restored → New Swarm                                                                                            | `Swarm 16` created and opened in the canvas                                                                        |
| Canvas → Delete swarm → "Delete this swarm? Swarm 16 will be permanently removed…" → Delete swarm, with every `DELETE /rest/v1/swarms` rejected | toast **`Swarm deleted`**; the canvas switched to `Swarm 1`; one DELETE rejected                                     |
| Reload the gallery                                                                                                     | **`My Swarms 16`; `Swarm 16` is still there**                                                                        |

The canvas said the swarm was gone and moved on; the swarm was not gone.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `8f15b4f4261f`);
the gallery reloaded onto it. Same fixture, same rejection.

| Driven                                                                                                                | Read back                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Swarms gallery (`My Swarms 16`) → Open `Swarm 16` → canvas                                                            | canvas on `Swarm 16`                                                                                   |
| Delete swarm → confirm, with every `DELETE /rest/v1/swarms` rejected                                                   | toast **`Could not delete the swarm · TypeError: Failed to fetch`**; the canvas **stays on `Swarm 16`**; one DELETE rejected |
| `fetch` restored → Delete swarm → confirm                                                                              | toast `Swarm deleted`; the canvas moves to `Swarm 1`                                                   |
| Reload the gallery                                                                                                    | `My Swarms 15`; no `Swarm 16` — the fixture is gone for real                                           |

A delete that fails now changes nothing and says why; a delete that lands
says so and is gone. The canvas's create failure is held by the tests: its
control is not on the canvas toolbar, and the gallery's own create already
said "Failed to create swarm".

Findings from this round: R67 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-22 — Budgets, a cap whose save failed, before and after, ADVERSARIAL_LOG R66

**Why this round exists.** The write-side survey's next page. Budgets saves
every change optimistically, and the page has a button that says the
settings are auto-saved.

### Before the fix

| Driven                                                                                                            | Read back                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Budgets & Guardrails                                                                                              | Monthly Hard Cap `20`; `Month-to-date spend: $1.79 / $20.00`                                                |
| Every `PATCH /rest/v1/budget_settings` rejected (`Failed to fetch`); cap typed as `25`, focus moved on             | cap `25`; **`Month-to-date spend: $1.79 / $25.00`**; one PATCH rejected; **no toast**                        |
| The page's "Settings auto-save on change" button pressed                                                          | toast **`All settings auto-saved`**                                                                          |
| Reload                                                                                                            | cap `20`; `Month-to-date spend: $1.79 / $20.00`                                                            |

A cap that was never saved was the cap on screen, and the page said so in
so many words.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `cb763ab67128`);
the page reloaded onto it. Same rejection, same edit.

| Driven                                                                                                | Read back                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budgets & Guardrails                                                                                  | cap `20`; status button `Settings auto-save on change`                                                                                                                                                      |
| Every `PATCH /rest/v1/budget_settings` rejected; cap typed as `25`, focus moved on                     | cap **back to `20`**; `Month-to-date spend: $1.79 / $20.00`; toast **`Could not save the budget · TypeError: Failed to fetch. The value shown is what is saved.`**; status **`Not saved — budget: TypeError: Failed to fetch`** |
| The status button pressed                                                                             | toast `Not saved — budget: TypeError: Failed to fetch`                                                                                                                                                      |
| `fetch` restored; cap typed as `21`, focus moved on                                                    | cap `21`; `Month-to-date spend: $1.79 / $21.00`; status **`Saved 12:56 AM`**                                                                                                                                 |
| Cap typed back to `20`; reload                                                                        | cap `20`; `$1.79 / $20.00`; status `Settings auto-save on change`                                                                                                                                            |

A write that fails is undone on screen and said; a write that lands is
said with its time; the button says only what the last write did. The cap
is back at its saved 20.

Findings from this round: R66 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Agent Chat, a message whose save failed, before and after, ADVERSARIAL_LOG R65

**Why this round exists.** The failed-read survey's largest file, the Agent
Chat page, turned out to have the write-side twin of the problem: five of
its six message inserts dropped their error, so a turn that was never saved
looked exactly like one that was.

### Before the fix

| Driven                                                                                                                       | Read back                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)", its conversation of 10 messages                                      | 10 bubbles, last: "According to the documents, what products does Acme Corp sell?" / "I could not find any information…"                       |
| Every `POST /rest/v1/messages` rejected (`Failed to fetch`); "R65 probe: reply with the single word OK" sent by the icon button | 12 bubbles: `You R65 probe: reply with the single word OK` · `Assistant OK`; **two POSTs rejected, no toast, no mark of any kind**                |
| Reload, same agent, same conversation                                                                                        | 10 bubbles; the probe turn is **gone**                                                                                                          |

Nothing distinguished the two unsaved messages from the ten saved ones until
they were not there.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `c643ca45cde6`);
the same agent and conversation reloaded onto it. Same rejection, same
send.

| Driven                                                                                                   | Read back                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `POST /rest/v1/messages` rejected; "R65 probe two: reply with the single word OK" sent by the icon | 12 bubbles; under both new bubbles: **`not saved — it will not be here after a reload`**, hover text `TypeError: Failed to fetch`; two POSTs rejected                                                                    |
| A third probe, read 2.5 s after the send                                                                 | toast **`This message was not saved to the conversation · TypeError: Failed to fetch. It will not be here after a reload.`**                                                                                            |
| `fetch` restored, reload                                                                                 | 10 bubbles again once the one reply that landed after the restore (an orphan "OK") was deleted through its bubble; nothing marked, nothing missing that was not said to be                                                |

The two halves the page needed: the mark on the message, and the reason at
the moment of failure. The conversation is back to its ten messages.

Findings from this round: R65 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The Agent Builder and Knowledge Base lists, before and after, ADVERSARIAL_LOG R64

**Why this round exists.** The failed-read survey, taken to the two builder
pages every other page starts from: each dropped its list read's error and
showed the empty state — with a call to action — over rows it could not read.

### Before the fix

| Driven                                                                                                            | Read back                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Builder                                                                                                     | nine agents listed (`RAG eval · Halvard support`, `Predictive Analyst`, `Sample · Graph RAG Explorer (Acme Corp)`, …)                                                       |
| Agent Builder with every `/rest/v1/agents?…` request rejected (`Failed to fetch`, eight attempts), reloaded in-app | **`No agents yet` · "Create your first agent to get started — pick a model, write a system prompt, and add tools as you go." · a `New Agent` button** — nothing about a failure |
| Knowledge Bases                                                                                                   | six knowledge bases listed (`RAG eval · Halvard Systems`, `Sample · People Operations Playbook`, …)                                                                          |
| Knowledge Bases with every `/rest/v1/knowledge_bases?…` request rejected (eight attempts), reloaded in-app         | **`No knowledge bases yet.`** — nothing about a failure                                                                                                                      |

The obvious response to either screen is to make another one.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `3154635e5810`);
both pages reloaded onto it. Same rejections, same in-app reloads.

| Driven                                                                                        | Read back                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent Builder                                                                                 | nine agents listed                                                                                                           |
| Agent Builder with every `/rest/v1/agents?…` request rejected (eight attempts), reloaded in-app | **`Could not load your agents` · `TypeError: Failed to fetch` · a `Try again` button**; no "No agents yet", no call to action |
| `fetch` restored, `Try again` pressed                                                          | the nine agents are back (`RAG eval · Halvard support`, `Predictive Analyst`, …)                                             |
| Knowledge Bases with every `/rest/v1/knowledge_bases?…` request rejected (eight attempts), reloaded in-app | an alert: **`Could not load your knowledge bases: TypeError: Failed to fetch`**; no "No knowledge bases yet."           |

A read that failed now reads as a failure, with the reason and a way back;
the empty states are reserved for a read that answered with nothing. The
documents and sources lists of a knowledge base carry the same alert and are
held by the source-anchored tests.

Findings from this round: R64 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The home dashboard's status band, before and after, ADVERSARIAL_LOG R63

**Why this round exists.** The landing page's one sentence — "Everything is
running" or "N things need attention" — is built from seven counts. A count
whose read failed landed as zero, and one of the seven asked its column for
a value it cannot hold.

### Before the fix

| Driven                                                                                                                   | Read back                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` → test "Minimum row count" 100 (the model has 5 rows) → Save → Build                           | Builds tab: `error · manual · 16s ago · 15.3s · stg_revenue failed 5 rows row_count_min on the table failed: 1 row(s)`                          |
| Dashboard                                                                                                                | band `1 thing needs attention · 1 open data incidents · checked 10:35 PM`; **no "SQL models failing" chip**; the SQL models card: `2 models`, no warning |
| Dashboard with every `/rest/v1/etl_runs` request rejected (`Failed to fetch`, four attempts recorded), reloaded in-app    | band `1 thing needs attention · 1 open data incidents · checked 10:36 PM` — the pipeline-runs check is **absent, not unknown**                     |

A model that failed its build a minute earlier is not on the band because the
band asks for `last_status = 'error'` and the column holds `failed`. A check
that could not be read is indistinguishable from one that found nothing.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `5f104cac7842`);
the dashboard reloaded onto it. Same failing model, same rejected request.

| Driven                                                                                                                 | Read back                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                                                                                                              | band `2 things need attention · 1 open data incidents · 1 SQL models failing · checked 11:24 PM`; the SQL models card: `2 models · 1 failing`                                                                                  |
| Dashboard with every `/rest/v1/etl_runs` request rejected (`Failed to fetch`, four attempts recorded), reloaded in-app  | band `2 things need attention · 1 check could not be read · 1 open data incidents · 1 SQL models failing · ? pipeline runs failed today — could not be read · checked 11:25 PM`; the chip's hover text `TypeError: Failed to fetch`; the ETL pipelines card: `20 pipelines · could not be checked` |

The model that failed its build a minute earlier is now on the band and on
its card. The check that could not be read is a chip of its own with the
reason, the sentence counts it separately, and the card it belongs to says
so — none of it a zero. `stg_revenue` keeps its `row_count_min 100` test
and `limit 5` for now; both are fixtures of this round.

Findings from this round: R63 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The ML model page's Jobs count, before and after, ADVERSARIAL_LOG R62

**Why this round exists.** Sweep 2's last named row, ML predictions: the
model page printed the length of a capped list as the count of jobs, and its
two list handlers dropped the errors of every read they made.

### Before the fix

| Driven                                                       | Read back                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ML Models → `revenue_facts · groups` (card: "21 versions")   | tabs `Versions (21)` · `Jobs (20)`                                                                                          |
| Jobs tab                                                     | 20 rows, oldest `17d ago · succeeded · 12s · kmeans_k2 · Silhouette 0.249`; nothing says older jobs exist                   |

Twenty-one versions came from at least twenty-one jobs; the tab counted the
twenty it was given.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `4cc73580b8f3`);
the same model page reloaded onto it.

| Driven                                          | Read back                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ML Models → `revenue_facts · groups`            | tabs `Versions (21)` · **`Jobs (20+)`**                                                                                              |
| Jobs tab                                        | 20 rows, oldest `17d ago · succeeded · 12s · kmeans_k2 · Silhouette 0.249`; under the table: **The newest 20 jobs. Older jobs exist and are not listed here.** |
| Predictions tab                                 | 11 runs listed (newest `7d ago · succeeded · rows via ai_analyst · 10 row(s)`), no note — the list is under its cap of fifty          |

The count and the note come from the extra row the handler now fetches. The
failed-read half — a versions, jobs or runs read that errors — is server-side
and cannot be produced from the browser without failing the database; it is
held by the source-anchored tests on both handlers, and the page's own error
state (which the client already had) shows what it throws.

Findings from this round: R62 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A governed query at its cap, before and after, ADVERSARIAL_LOG R61

**Why this round exists.** Sweep 2, the semantic layer: a prefix presented
as the whole. The Semantics page's query runner asks for a hundred rows and
counted whatever came back as the result.

### Before the fix

| Driven                                                                                                  | Read back                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Semantic Layer → SaaS Sales model (`saas_sales`, 9,994 rows) → Query → `total_sales` × `order_id` → Run | `100 row(s)`; compiled statement ends `LIMIT 100`; 100 rows in the table — nothing says the query has 9,894 more groups |

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `e4b0a5c268a3`);
the page reloaded onto it. Same model, same query, same Run.

| Driven                                                                                                  | Read back                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic Layer → SaaS Sales model → Query → `total_sales` × `order_id` → Run                            | `first 100 rows of a larger result — the preview stops at 100; add a filter or a coarser grain to see everything`; compiled statement ends `LIMIT 101`; 100 rows in the table                    |

The runner fetched the hundred-and-first row, found it, cut the result at
the hundred the page asked for and said so; the statement shown is the one
that ran. The analyst's step note and the dashboard's parameter re-run share
the same verdict from the same runner and are held by the source-anchored
tests; the scheduled refresh's flag is the R26 test's anchor, moved to the
new line.

Findings from this round: R61 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A SQL model edited after its build, before and after, ADVERSARIAL_LOG R60

**Why this round exists.** Sweep item 2: a badge that outlives what it vouched
for. The SQL Models page shows a model's last build — status, time, row
count — and a save that replaces the model's SQL leaves all three standing.

### Before the fix

| Driven                                                                                       | Read back                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue`                                                                    | `built · 11d ago` · `836 rows` · `builds into analytics.stg_revenue`; list dot `bg-emerald-500`; SQL ends `where net_usd is not null`      |
| Append `limit 5` to the SQL, press Save                                                      | toast `Saved stg_revenue`; header **still** `built · 11d ago` · `836 rows`; list dot **still** `bg-emerald-500`; SQL now ends `limit 5`    |

The row count is the previous definition's; the SQL on the row can produce at
most five. Nothing on the page distinguishes this from a model whose build is
current.

### After the rebuild

The `agentswarms` service rebuilt and recreated (container `7396b05ad49f`);
the page reloaded onto it. The migration is **not yet applied** to the live
database — `npx supabase db push` was refused by this session's permission
gate — so this half proves the rebuilt app against the un-migrated database;
the edited state is driven once the migration is pushed (below, when it is).

| Driven                                                                 | Read back                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` (SQL still ends `limit 5` from the save above) | `built · 11d ago` · `836 rows`, dot `bg-emerald-500` — no mark column, so the page falls back to the last build's stamps exactly as before                        |
| "Build this and what it reads"                                         | toast `Built 1 model`; Builds tab, newest run: `success · manual · 25s ago · 18.5s · selected stg_revenue · stg_revenue built 5 rows`; Model tab: `built · 22s ago` · `5 rows` |

The runner's guarded clear skipped cleanly on a row with no mark, and the
stamps landed; the page reads them as before. The trigger itself was proven in
both directions against the empty local Postgres twin in a throwaway schema
(set by a SQL, name, schema, materialization or tests change; not by a
description, tags, schedule or pause change; not by a jsonb-equal re-save of
the tests; not cleared by a build's own stamp; cleared by the runner's guarded
update), and the schema was dropped afterwards. `stg_revenue` is left with
`limit 5` for the post-migration drive, which restores it.

### On the live database, after the migration (2026-09-22)

`npx supabase db push` was run by the owner; `db push --dry-run` reports the
remote up to date. Driven on the R72 container (`f308cd0a9c0a`), which
carries the R60 page and runner:

| Driven                                                                                          | Read back                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Models → `stg_revenue` (`failed · 11h ago` · `5 rows`, red dot, from R63's row-count test)  | as left                                                                                                                                                                       |
| SQL changed (`limit 5` → `limit 57`) → Save                                                     | `Saved stg_revenue`; header **`edited 1s ago · not built since`** · **`last build, of the previous definition: failed · 5 rows · 11h ago`**; list dot **amber**, hover `Edited since its last build` |
| Control: `fct_region_revenue` (`built · 12d ago · 4 rows`) → description changed only → Save    | `Saved fct_region_revenue`; header **still `built · 12d ago · 4 rows`**, dot green — a description is not the definition                                                       |
| `stg_revenue` → Build                                                                           | run `error · stg_revenue failed 57 rows row_count_min…`; header **`failed · 46s ago · 57 rows`**, red dot, **no "edited"** — the build that read the definition cleared the mark |
| Fixture restored: test removed and limit removed → Save (`edited 1s ago · not built since` again) → Build | `success · stg_revenue built 836 rows`                                                                                                                                       |

Both directions, on the live trigger: the mark on a definition change and
not on a description change, and the mark cleared by the build that read
it. `stg_revenue` is back to its original SQL, no tests, 836 rows.

Findings from this round: R60 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The scheduler on the Monitoring page, before and after, ADVERSARIAL_LOG R59

**Why this round exists.** R57 gave the scheduler's pass a record of its
failures and nowhere to show them. R59 adds the scheduler to the Monitoring
page's services. This is a new surface, so the browser proves both halves:
that the row was absent, and that it is present with the live pass's figures.

### Before the fix

| Driven                | Read back                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring            | `2 needing attention · checked 6:30:34 PM`; twelve services — Application server, Supabase, Document renderer, JS sandbox, Notebook gateway, Notebook egress proxy, Lakehouse catalog, Spark Connect, Docker API proxy, Online feature store, Vector store (Qdrant), Object store (MinIO) — and no scheduler |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
container (`ba1fe8ede7eb`, up 4 minutes). Same page, same health check.

| Driven                | Read back                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monitoring            | `No problems detected · checked 8:37:06 PM`; thirteen services — the twelve above and, third in the list after Supabase, **Scheduler · Healthy** · "Runs every schedule the platform has — BI refreshes, prep flows, crawls, ETL, retention — once a minute, in this process." · `last_pass=5 s ago · processed=0 · prep_flows=0 · failures=0` |

The row's figures are the live pass, not a fixture: `last_pass=5 s ago` on a
process four minutes old is the tick that ran just before the check. The two
services that needed attention before the rebuild were optional services that
were down at the time and are up now; the count is unrelated to this round.
The degraded branches — a pass with failures, a scheduler that has stopped, a
process that never passed — cannot be produced from the browser without
breaking the server's own reads, and are held by the six behavioural tests on
`schedulerProbe`.

Findings from this round: R59 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Grounded retrieval, before and after, ADVERSARIAL_LOG R58

**Why this round exists.** R58 changes what the model is told when a
knowledge-base search cannot be checked or completed, and makes the ACL filter
fail closed. Every one of those failures is the server's own — the vector RPC,
the ACL read, the document scan — so the browser proves the REGRESSION half:
a grounded agent answers as before when nothing fell short. The defect half is
behavioural on the pure prompt builder (`tests/unit/retrievalDegraded.test.ts`)
and source-anchored on the retrieval function, the tool and the route.

### Before the fix

| Driven                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)" → "According to the documents, what products does Acme Corp sell?" | 24 s: `I could not find any information regarding the products sold by Acme Corp in the available documents. The knowledge graph returned no matches for "Acme Corp" or "products."` — zero citations, no toast |

Whether that is a true absence or a search that fell short is exactly what
the answer could not say: the same words come back from an empty knowledge
base and from a failed one.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`playground-V1hgo98G.js`). Same agent, same question, same submit.

| Driven                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → "Sample · Graph RAG Explorer (Acme Corp)" → "According to the documents, what products does Acme Corp sell?" | 48 s: `I could not find any information in the available documents regarding the products sold by Acme Corp. The knowledge graph search returned no results for this entity or its related products.` — zero citations, no toast |

The answer has the same shape as before the fix, and now that shape means
something: none of the new wording — "the search could not be completed",
"retrieval was partial", "could not be checked" — appears, so this is a
knowledge base with no match, not a search that fell short. The wording for a
search that fell short is held by the behavioural tests on the prompt builder,
which cannot be reached from the browser without failing the server's own
reads.

Findings from this round: R58 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The scheduler's pass, before and after, ADVERSARIAL_LOG R57

**Why this round exists.** R57 makes the scheduler's pass record every folded
sweep and every failed read in an `errors` field, and the cron endpoint's `ok`
follow it. The reads and steps are the server's own, so the browser proves the
REGRESSION half through the one thing it can see: the body of the
`/api/bi/cron` POST the page makes every few minutes. The defect half is
behavioural (`tests/unit/cronPassFailures.test.ts`): against the unpatched
source a failed schedule read resolved `0` — nothing due — with no error
anywhere.

### Before the fix

| Driven                                                  | Read back                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's own `/api/bi/cron` POST, read from the network log | `{"ok":true,"skipped":false,"ran":true,"processed":0,"prep_flows":0,"quality_checks":0,"catalog_crawls":0,"etl_runs":0,"matview_refreshes":0,"sql_model_builds":0,"workflow_runs":0,"workflow_steps":0,"analyses":0,"swarm_schedules":0,"kernels_reaped":0,"ml_evaluations":0}` — no field for anything that failed |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the Monitoring page reloaded
(client chunk `monitoring-Dbmpp_RF.js`, unchanged — this round is server-side).

| Driven                                                          | Read back                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's next `/api/bi/cron` POST, read from the network log  | `{"ok":true,"skipped":false,"ran":true,"processed":0,"prep_flows":0,"quality_checks":0,"catalog_crawls":0,"etl_runs":0,"matview_refreshes":0,"sql_model_builds":0,"workflow_runs":0,"workflow_steps":0,"analyses":0,"swarm_schedules":0,"kernels_reaped":0,"ml_evaluations":0,"errors":[]}` |
| Monitoring                                                      | `2 needing attention · checked 7:16:50 PM`; the same twelve services; no scheduler row — the surface is R59's                                                                                                                                 |

The pass ran clean under the live deployment, and for the first time the
answer says so with a field rather than by the absence of one: `errors: []`,
and `ok` computed from it.

Findings from this round: R57 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Credential and audit reads, the regression half, ADVERSARIAL_LOG R56

**Why this round exists.** R56 makes two server-side reads fail with their
reason instead of answering "not configured" and "an id". The failures are
the server's own and cannot be injected from the browser, so — as in R41 and
R53 — the browser proves the REGRESSION half: a model call that resolves its
credential still answers, and the Audit Log still shows people. The defect
half is proved behaviourally (`tests/unit/serverReadFolds.test.ts`): against
the unpatched source a failed credential read resolved `null`.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the pages reloaded onto the
new bundle (`audit-D7coIzc4.js`).

| Driven                                                                    | Read back                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Audit Log, before the rebuild                                             | 333 rows, 334 email mentions, no 8-character ids, no "deleted account", no toast                                                         |
| Audit Log, after the rebuild                                              | 333 rows, 334 email mentions, no 8-character ids, no "deleted account", no toast — identical                                             |
| Workbench → BI Agent → "How many rows does saas_sales have?" (submit pressed) | `The 'saas_sales' table contains 9,994 rows` as a KPI in 14 s; every `/api/bi` POST in the exchange 200 — the credential lookup resolved |

The user list behind attribution and the credential behind the model call
both read cleanly under the live deployment; what changed is only what each
answers when it cannot, which the behavioural tests hold.

Findings from this round: R56 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The report generator over a failed read, before and after, ADVERSARIAL_LOG R55

**Why this round exists.** The queue's next "failed read rendered as absence"
was the BI report route's bare hydration catch. The dialogs it feeds are
reachable from the browser, and the rejection is armed before the in-app
navigation so the route mounts under it — the real catch meeting a real
failure.

### Before the fix

| Driven                                                                                      | Read back                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BI Workspace → Reports → "Revenue pack - known series", every `user_data_tables` request rejected | the designer, **no toast**; 2 rejected reads                                                                                                                     |
| Generate with AI                                                                            | Source `Local & prepared datasets`; Table placeholder and notice both `No local datasets — upload data on the Data & SQL page first.`; `Plan the report` disabled; 4 rejected reads |

The account holds thirty-three local datasets.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`bi-D0lePUV8.js`). Same report, same rejection armed before the
in-app navigation.

| Driven                                                                          | Read back                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports → "Revenue pack - known series", every `user_data_tables` request rejected | toast `Could not load local datasets: could not list datasets: Error: injected: user_data_tables unreachable` at 7 s — the catch that used to be bare; 4 rejected reads                              |
| Generate with AI                                                                | placeholder and notice both `Local datasets could not be read — could not list datasets: Error: injected: user_data_tables unreachable`; `Plan the report` disabled — the advice to upload is gone |
| The same report reloaded with `fetch` untouched → Generate with AI              | Table `sftest_users` selected, no notice, `Plan the report` enabled, no toast                                                                                                                          |

An empty list with a reason now shows the reason; an empty list without one
still says where to get data (the behavioural test holds that case); a kept
list is not blocked by a failed re-read.

Findings from this round: R55 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — A deck generated over a failed read, before and after, ADVERSARIAL_LOG R54

**Why this round exists.** The queue's next "failed read rendered as absence"
was the document generator's data fill. It is reachable from the browser: the
fill hydrates the datasets client-side, so rejecting `user_data_tables` in the
page is the real failure the real code meets. Each drive is a real model round
trip (Gemini 2.5 Flash via OpenRouter) that plans the deck, then the browser
builds it.

### Before the fix

| Driven                                                                                                                   | Read back                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Chat → PowerPoint mode, every `user_data_tables` request rejected, "a 2-slide deck: bar chart of sales by region, KPI of row count", send | 21 s: `Here's your PowerPoint — Make-a-2-slide-PowerPoint-about-the-saas.pptx` · `PowerPoint · ready` · Download; **4 rejected reads, no toast, no error** |

The plan asked for a chart and a KPI; the fill could read nothing; the deck
was delivered as if it had.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`playground-DZ4tALaf.js`). Same page, same prompt, same submit.

| Driven                                                                     | Read back                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PowerPoint mode, every `user_data_tables` request rejected, the same prompt | 31 s: the deck card, **and** the toast `Charts could not be filled — could not read your datasets: could not list datasets: Error: injected: user_data_tables unreachable · The deck was built with its chart slides falling back to text. Check the data connection and generate it again.`; 4 rejected reads |
| PowerPoint mode, `fetch` restored, the same prompt                          | 60 s: the deck card (`SaaS Sales Executive Overview`); **no toast** — neither the read-failure error nor the partial-fill warning; no rejected reads                                                                                                              |

So the failure now says what happened and the deck still ships; the clean run
is unchanged: charts filled, nothing to warn about.

Two things about driving this panel, for the next round that needs it: Return
in the box does not send (the icon beside it does, and after a generation the
document mode resets to plain chat), and a 12-second toast that the pointer
happens to rest on never expires — it sat over the send icon for several
minutes and swallowed every click until it was removed.

### Fixtures

Each drive leaves a conversation in Agent Chat titled after its prompt, with
the generated `.pptx` attached (uploaded to the `chat-docs` bucket by the page
as part of delivery). They are kept — deleting chat history is not this
round's to do — and are listed here so they are not mistaken for the user's
own work.

Findings from this round: R54 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The model policy under a live read, before and after, ADVERSARIAL_LOG R53

**Why this round exists.** R53 makes four IAM reads fail closed instead of
answering "no policy". The failure cannot be injected from the browser — the
reads are the server's own — so, as in R41, the browser proves the REGRESSION
half: the live policy still resolves and a model call still goes through. The
defect half is proved by behavioural tests on the real functions
(`tests/unit/iamPolicyReadFailure.test.ts`): against the unpatched source a
failed `iam_settings` read resolved `null` — unrestricted — and a failed
`iam_group_members` or `iam_model_rules` read resolved `[]`; a failed role
read answered "Forbidden: superadmin access only", closed but for the wrong
reason.

### Before the fix — the live policy

| Driven                                          | Read back                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| IAM → Settings                                  | `Deny by default (allow-list only)` switch **off**; `Allow anyone to sign up` on                    |
| IAM → Access → Model access                     | no rules — "By default everyone can use every model"                                               |

So the live policy collapses to `null`, unrestricted, and every model call
this deployment makes goes through `getEffectiveModelRules` first.

### After the rebuild

The `agentswarms` service rebuilt and recreated (server code only — the client
chunk `data-sql-CiXUwY60.js` is unchanged from R52, as it should be).

| Driven                                                                        | Read back                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IAM → Settings                                                                | `Deny by default (allow-list only)` still **off**; `Allow anyone to sign up` on — the policy this deployment runs under is unchanged                          |
| Workbench → BI Agent → "How many rows does saas_sales have?" (submit pressed) | `The 'saas_sales' table contains 9,994 rows of data.` as a KPI chart (`10.0k`, 1 row) in 6 s; every `/api/bi` POST in the exchange answered **200**           |

The model call goes through `llmJsonServer` → `getEffectiveModelRules` first;
after the fix a failed policy read would have been an error response here
instead of an answer, and the four reads succeeded. That is the regression
half. The defect half — a failed settings read resolving `null`, unrestricted —
is proved by `tests/unit/iamPolicyReadFailure.test.ts` against the real
function, which resolved exactly that before the fix and rejects after it.

One thing learned about the panel on the way: Return in the question box does
nothing — it is not a form — and the first `/api/bi` 200 I read was the
panel's suggested-questions call, not a question. The icon button beside the
box is the submit, and the round above pressed it.

Findings from this round: R53 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The catalog's first paint, sampled before and after, ADVERSARIAL_LOG R52

**Why this round exists.** R51's validation sampled a fresh load every two
seconds instead of reading it once, and the sample showed two wrong answers
before the right one. Same technique here: a full reload, the page left alone,
the Sources panel and the resource log read every two seconds.

### Before the fix

| t    | Read back                                                    |
| ---- | ------------------------------------------------------------ |
| 8 s  | `Local tables 0` — loading, rendered as a count; 0 server-function calls |
| 18 s | `Local tables 33`, no `sftest` row; still 0 server-function calls — a pass made before the session resolved |
| 20 s | `Local tables 26` · `sftest 7`; 1 call, made at 17.97 s      |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-CiXUwY60.js`) and left alone, sampled every two seconds.

| t    | Read back                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 11 s | `Local tables …` · `All assets 21+` · footer `21 of 21+ assets`; no banner; 0 server-function calls   |
| 23 s | `Local tables 26` · `sftest 7` · `All assets 54` · `54 of 54 assets`; 1 call, made at 21.6 s          |

No sample read `0`, and none read `33`: the loading state is an ellipsis with
floored totals, and the first pass waited for the session, so the first
attribution painted is the right one. The one server-function call is the
only one made.

Findings from this round: R52 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — Where a synced dataset came from, under a failed read, ADVERSARIAL_LOG R51

**Why this round exists.** The first normal reading after R50's rebuild was
`Local tables 33`, not 26, with the `sftest` connector row missing from the
Sources panel. R50's entry blamed a connections server call failing while the
container was still starting; that was a reading taken once, and it was wrong
(see the sampled timeline below). The symptom itself — a failed attribution
read filed as "local" — was then reproduced on purpose by rejecting that read
alone.

### Before the fix

| Driven                                                                            | Read back                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog, loaded normally                                                     | `All assets 54` · `Local tables 26`; Sources panel lists `sftest 7`                                                                             |
| Data Catalog mounted with the attribution read (`select=id,saas_connection_id`) rejected | `All assets 54` · `Local tables 33`; no `sftest` row; the seven `sftest_*` datasets shown with SOURCE `Local tables`; no toast, no banner; 8 rejected requests |

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-tERoPyTu.js`).

| Driven                                                                            | Read back                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog mounted with the attribution read rejected                           | `Local tables 33`, no `sftest` row, and the banner `Where synced datasets came from could not be read — they are listed under Local tables until it can be: … Retry`; 14 s                            |
| Retry, `fetch` restored                                                           | `Local tables 26` · `sftest 7`; banner gone; 11.5 s                                                                                                                                                  |
| Re-read under the rejection over the known attribution (Workbench → Catalog)      | `Local tables 26` · `sftest 7` stand; banner `Where synced datasets came from could not be re-read — showing the last known attribution: … Retry`; 18 s                                              |
| The same toggle with `fetch` restored                                             | banner gone, 26 · `sftest 7`; 15.5 s                                                                                                                                                                 |

### The first load, sampled instead of read once

| Driven                                        | Read back                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh full load, untouched, sampled every 2 s | 8 s: `Local tables 0` (loading), 0 server-function calls · 18 s: `Local tables 33`, no `sftest` row, still **0** server-function calls · 20 s: `Local tables 26` · `sftest 7`, after the one call at 17.97 s |

So the 33 after a rebuild is not a failed call: the first `reloadLocal` runs
before the session has resolved, with no token, skips the connections read by
design and paints every synced dataset as an upload; the token-driven re-run
corrects it two seconds later. A wrong paint for two seconds, after a ten
second wait, on every full page load — R52, next.

Findings from this round: R51 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The catalog under a failed local read, before and after, ADVERSARIAL_LOG R50

**Why this round exists.** R49's validation left the page on the Data Catalog
view with the table-list read still rejected, and the Sources panel read
`Local tables 0`. This round measured that properly, fixed it, rebuilt, and
measured it again. Same technique: `window.fetch` patched in the page to reject
one table's requests; the real catch running against a real rejection.

### Before the fix

| Driven                                                                     | Read back                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Data Catalog, loaded normally                                              | `All assets 54` · `Local tables 26` · footer `54 of 54 assets`                                          |
| Data Catalog mounted with every `user_data_tables` request rejected        | `All assets 21` · `Local tables 0` · footer `21 of 21 assets` — no toast, no banner, one `console.warn` |

Thirty-three assets gone silently: the 26 local tables and the 7
connector-synced datasets that are stored the same way.

### After the rebuild

The `agentswarms` service rebuilt and recreated; the page reloaded onto the new
bundle (`data-sql-Cofp-IJh.js`).

| Driven                                                                          | Read back                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Catalog mounted with every `user_data_tables` request rejected             | `All assets 21+` · `Local tables —` · footer `21 of 21+ assets`; banner `Local tables could not be loaded: could not list datasets: … Retry`; 7.5 s                             |
| Retry, `fetch` restored                                                         | `All assets 54` · `Local tables 26` · `54 of 54 assets`; banner gone; 17.5 s                                                                                                    |
| Reload over the populated list under the rejection (Workbench → Catalog toggle) | counts stand at 54 · 26 · `54 of 54`; banner `Local tables may be stale — the last reload failed: … Retry`; 6 s                                                                 |
| The same toggle with `fetch` restored                                           | banner gone, 54 · 26; 7.5 s                                                                                                                                                     |
| BI → Data preparation mounted under the rejection                               | toast `Could not load datasets: …`; section header `Local tables —` (was `0`); expanded: `Tables could not be loaded: … Retry`; 7 s                                             |
| Retry, `fetch` restored                                                         | `Local tables 33`; error state gone; 8 s                                                                                                                                        |

**Seen on the way, queued.** The first normal reading after the rebuild was
`Local tables 33`, not 26, and the `sftest` connector row was missing from the
Sources panel. The container was still `health: starting`; the catalog's
`listConnectionsFn(...).catch(() => [])` swallowed that failure and the 7
connector-synced datasets were filed as local uploads. The Retry a minute later
read 26. That is the next round. *(Corrected in R51: sampled every two seconds,
this is a two-second paint made before the session resolved; no server call had
been made, let alone failed.)*

Findings from this round: R50 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The pager sweep driven to its end, and two defects only the browser found, ADVERSARIAL_LOG R43–R49

**Why this round exists.** R43 to R47 closed the hand-rolled-pager sweep on
unit tests and mutants. This round drove each of them against the live
deployment and read the figures back from the rows they claim to describe —
and then made the same pages' reads fail, which is where R48 and R49 came from.
The failure paths were reached by patching `window.fetch` in the page to reject
one table's requests; the real handler ran against a real rejection.

### What was driven, and against what truth

| Round | Driven                                                                          | Read back                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R43   | Lakehouse → import `saas_sales`                                                 | `SELECT COUNT(*)` in the lakehouse: **9,994**; the Workbench's own count of the source: **9,994**; audit event `lakehouse.import` `rows: 9994` |
| R44   | BI → Data Prep → run "Summary data"                                             | `9,992 rows · 3 cols`; `user_data_table_versions` and quality `total_rows` **9,992** — the prep source's exact count                             |
| R45   | Audit Log → Export                                                              | **1,960** lines, every one parsed, ids distinct, no error line — equal to the live `audit_events` count                                          |
| R46   | Workbench, first load (five-window parallel reader)                             | `saas_sales` **9,994** rows and `nba_team_seasons` **1,050**, both equal to the database                                                        |
| R47   | Analytics → traces (`pageTraces`)                                               | headline `1,109 traces over the last 30 days` — `execution_traces` holds exactly 1,109                                                           |
| R48   | Workbench → Refresh, every `user_data_rows` request rejected — BEFORE           | console `Uncaught (in promise) could not count rows of …`; icon spinning indefinitely; no toast; list intact                                    |
| R49   | Workbench → Refresh, every `user_data_tables` request rejected — BEFORE         | thirty tables replaced by `No tables yet. Upload a file to get started.`; no toast; spinner cleared at ~3.5 s; 38 rejected requests             |
| R49   | the same, with `fetch` restored and Refresh pressed again                       | the same list back, `sftest_users` first — nothing had been lost                                                                               |

### After the rebuild

The `agentswarms` service was rebuilt from source and recreated; every other
container stayed up. The page was reloaded so it took the new bundle
(`data-sql-nbwNpl_R.js` — the pre-rebuild chunk was `data-sql-Dh2zJ77u.js`).

| Round | Driven                                                                                      | Read back                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R49   | Workbench → Refresh, every `user_data_tables` request rejected                              | toast `Could not refresh datasets: could not list datasets: Error: injected: user_data_tables unreachable`; list intact, `sftest_users` first; `Last refresh failed: could not list datasets: … — showing the previous list.`; spinner cleared at 8 s |
| R49   | `fetch` restored, Refresh                                                                   | the same list, note gone, 11.5 s                                                                                                                                                                                                   |
| R48   | Workbench → Refresh, every `user_data_rows` request rejected                                | toast `Could not refresh datasets: could not count rows of "sftest_users": …`; spinner cleared at 7.5 s; list intact; the stale note; 132 rejected requests                                                                        |
| R48   | `fetch` restored, Refresh                                                                   | the same list, note gone, 12 s                                                                                                                                                                                                     |
| R49   | Workbench MOUNTED under the rejection (in-app navigation away and back, patch kept)         | `Datasets could not be loaded: could not list datasets: … Retry` in place of "No tables yet"; the injection log held only the list read — **zero** seeder existence checks; Retry with `fetch` restored brought the list back in 12 s |
| R49   | Workbench → `SELECT COUNT(*) AS n FROM saas_sales`                                          | **9,994** — unchanged by the seeder's no-op RPCs in the pre-fix round                                                                                                                                                              |
| R49   | BI → Data preparation, MOUNTED under the rejection                                          | toast `Could not load datasets: could not list datasets: …`; with the Local tables section expanded, `Tables could not be loaded: … Retry`; Retry with `fetch` restored → `Local tables 33` in 8 s                                  |
| R49   | Data preparation → Reload tables under the rejection, list populated                        | the toast; badge still `Local tables 33`; no error state, no "No local tables yet"; a restored reload → 33                                                                                                                         |

**Observed, not fixed here.** While the prep tab is in its failed state the
collapsed section header still reads `Local tables 0`, and the Catalog view's
Sources panel read `Local tables 0` under the same failed list — the count of
an empty list stated as a fact beside an error. Both are the first items of the
next round.

### The two things only the browser found

**A Refresh with nowhere to put the throw (R48, S2).** R46 made the checked
reader throw instead of registering a partial table, and the first call site to
meet that throw was the workbench's Refresh handler — four lines, no try. Every
unit test of the reader passed; the spinner that never stopped was visible only
on the page.

**A failed list answered as an empty account (R49, S1).** `hydrateFromSupabase`
returned `[]` when the table list could not be read, and the page took `[]` at
its word. The injection log then filled with the sample seeder's own existence
checks, every one rejected — the mount path had read the empty list as an empty
account and started seeding. Its registration RPC returns the existing id
without writing, which is the only reason that round changed nothing; the row
insert beneath it is guarded by a count read whose error is dropped the same
way. Both are proved by behavioural tests now: the real seeder, a client whose
reads fail one at a time, and both failure cases resolving `true` before the
fix.

### Not driven, and why

**The seeder's insert-on-failed-count path.** Reaching it on the live project
means making the `user_data_rows` count fail while the registration RPC
succeeds, and success would append 9,994 duplicate rows to a shared sample
table. It is proved by the behavioural test and the mutant that deletes the
guard, and by nothing else.

**The three callers queued from R49.** `docGen/biData`, `bi_.report` and
`chatBi` render absence on a failed list; each needs its own page driven and
gets its own round.

### Fixtures and side effects

**One mis-click, corrected.** The lakehouse import dialog's Radix picker kept
`f1_constructor_standings` selected from a previous open, and the first import
brought in that 10-row table instead of `saas_sales`. The table was dropped, the
picker's trigger text verified before the second submit, and the 9,994-row
import above is the second attempt. The imported `analytics.zz_ui_check_saas_sales`
was deleted afterwards; the lakehouse is back at its 20 tables.

**One flow re-pointed, restored.** Running "Summary data" with a throwaway
output name wrote that name into the user's flow (`user_prep_flows.output_table_name`
became `zz_ui_prep_check`). It was restored to `summary_segment_data` directly
in the database and the fixture table and its versions deleted; quality tests
and results are back at 0.

**The injected window fired the seeder.** While `user_data_tables` requests
were being rejected, the mount path's background `ensureSampleDataset` ran its
18 existence checks against the rejection and called `upsert_sample_dataset`
for each. The RPC body was read: it returns the existing id and writes nothing
when the sample is registered, and no row insert followed because the
`user_data_rows` count was not injected. `saas_sales` still counts 9,994 in the
"after" table above.

Findings from this round: R48 and R49 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-21 — The partiality sweep, driven page by page, ADVERSARIAL_LOG R36–R42

**Why this round exists.** Rounds 36 to 41 were proved by unit tests, mutation
harnesses and read-only database probes, and not one of them had been driven in
a browser. Driving them found **two defects the whole apparatus had missed** —
one of them shipped, load-bearing, and years old in spirit: every group budget
query the product has ever made returned a 400.

The app was rebuilt from source and the `agentswarms` service recreated; every
other container stayed up. The failure paths were reached by patching
`window.fetch` in the page to reject the specific requests under test, which is
the real catch branch running against a real failure rather than a stub.

### What was driven, and against what truth

| Round | Driven                                                             | Read back                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R36   | `/monitoring`, every `/_serverFn/` POST rejecting, Refresh pressed | before: `2 needing attention · checked 12:55:18 AM`; after: `3 needing attention at the last successful check` + `Live updates have stopped — every figure below is from the last successful check, not from now.` |
| R37   | `/model-registry`                                                  | `Browse 770 live models across all major providers.` — unchanged by the rewrite to an exact count plus paging                                                                                                      |
| R38   | `/knowledge`, "RAG eval · Halvard Systems"                         | `Indexed 12/12 documents`; twelve badges 8, 6, 9, 6, 3, 4, 29, 11, 6, 9, 4, 5 — summing to **100**, the base's true `kb_chunks` count                                                                              |
| R40   | run `97b11bf3`                                                     | `STEPS 4`, four rows in canvas order, `Data flow (3)`, `$0.0001` — identical to the pre-change baseline                                                                                                            |
| R40   | the same run with `swarm_run_steps` / `swarm_run_edges` rejecting  | banner `The detail of this run could not be read … The totals above come from the run itself and still stand`, no truncation caveat, `Data flow (—)`                                                               |
| R41   | `/dashboard`                                                       | `Spend (month to date) $1.68`, panel `$1.69 / 1.1k runs / 1.6M tokens` — unchanged, against a DB truth of `$1.677463` over `1,104` traces                                                                          |
| R42   | `/admin/iam` → Budgets, with one real group                        | `$1.68+?` and `(≥34%)`, tooltip `At least this much: 1 call used a model with no known price…` — DB truth: `$1.677463`, cap `$5.00`, exactly **1** unpriced row                                                    |

### The two things only the browser found

**Group budgets had never worked (R42, S1).** With a real group on screen the
spend cell read `unknown`, and its tooltip carried
`invalid input syntax for type uuid: ""`. `budget_spend_since(_user_id uuid, ...)`
is called by both group callers with `userId: ""`. Confirmed straight against the
database: `""` → 400, `null` → 200 `1.677463`, single-user control → 200
`1.677463`. So `groupSpend` always returned null, and a team cap either enforced
nothing or refused every member of the group on every call, depending on
`BUDGET_FAIL_CLOSED`. All 100 budget tests passed throughout — every one of them
is source-anchored and none had ever put an argument on the wire.

R39's own change is why it surfaced: the cell said "unknown" instead of the
confident `$0.00` the previous browser-side sum would have produced.

**A truncation caveat over a failed read (R42, S2).** With the step read
failing, the run detail page showed its error banner and, directly beneath it,
`Showing the first 0 of 4 steps` — what a SUCCESSFUL read of a prefix looks like
— while the tab beside it said `Data flow (0)`. Two sentences, one failure,
different stories. A unit test could not see it: the helper is correct for
`{ fetched: 0, total: 4 }`, and the defect was entirely at the call site.

### Not driven, and why

**The capped branches of R38 and R40.** Reaching them needs more than 50,000
chunks in one collection, or more than 20,000 steps in one run. This deployment
holds 104 and 28. Covered by unit tests and mutants, and by nothing else.

**R41's defect itself.** It only bites where PostgREST's `db-max-rows` is below
the page size requested; on this project the two are both 1,000. Changing a
hosted project's setting is not this campaign's to make, so the UI round proves
the REGRESSION half — `$1.68` survives the rewrite — and the defect stays proved
by the mutant that restores the original loop and fails.

### Fixtures

One IAM group, `ZZ UI check — group budgets (delete me)`, with one member and a
$5.00 cap, created so the Budgets tab had a figure to compute. Deleted after the
round along with its membership and its `budget_limits` row.

`MODEL_REGISTRY_MAX_ROWS` was set in `.env` and the registry's page size lowered
in source to force the truncation branch on real data; both were reverted and
the service rebuilt from the restored files.

**One unintended write.** "Refresh now" on the Model Registry page runs a real
sync against AIMLAPI rather than re-reading the table, and pressing it took the
registry from **770 to 792 models**. Not destructive — it is the page's own
maintenance action over a public catalog that was eight weeks stale — but it was
not the read it was mistaken for, and it is recorded here rather than left to be
noticed later.

Findings from this round: R42 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — An alert's aggregate, run against the real engine, ADVERSARIAL_LOG R28

**Driven.** Not a dashboard round. The fix makes an alert ask the database for
its aggregate when the widget's snapshot is a prefix, and the risk a unit test
cannot cover is whether that SQL parses and answers correctly on a real engine
— which is exactly the class the dangling `GROUP BY` bug belonged to. So the
generated string was run through the **Workbench** against the lakehouse.

| Driven                                                                     | Read back                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------- |
| The SQL `alertAggregateSql` builds for the live "Revenue by Region" widget | `51749.84` in one row — the seeded truth total |

That is the number an alert on `sum(total_revenue)` should compare against. The
prefix it used before is whatever the first N rows happened to add up to.

**Not driven.** The notification and email that a partial widget now produces,
and the once-only transition into the `partial` state. Reaching them needs a
scheduled refresh over a widget whose snapshot actually hits the row cap, and
nothing in the seeded data is that large. They are covered by unit tests and
mutants, and by nothing else.

Findings from this round: R28 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A direct widget's sentences follow its live result, ADVERSARIAL_LOG R27

**Driven.** Generated one widget over the lakehouse, switched it to **direct
query** from its own menu, then narrowed it with a dashboard filter so the live
result stopped matching the snapshot. Widget objects read out of React state,
which is the only place the derived display object exists — by design, since it
is never written anywhere.

| Driven                                        | Live rows | Displayed note                                       |
| --------------------------------------------- | --------- | ---------------------------------------------------- |
| Generated, import mode                        | 3         | `The data has 3 rows, not 5.` — and stored           |
| Menu → **Use direct query (live)**, no filter | 3         | `The data has 3 rows, not 5.` — unchanged, correct   |
| Dashboard filter `region = AMER`              | **1**     | **`The data has 1 row, not 5.`** — derived from live |
| Filter cleared                                | 3         | back to `The data has 3 rows, not 5.`                |

**The last row is the proof that nothing is persisted.** The sentence returned
to its original wording when the filter came off, which it could only do if it
were being derived per view rather than written back. Before this change the
middle row would have read "3 rows" over a single live bar.

Findings from this round: R27 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — Stale prose withdrawn when its figures stop holding, ADVERSARIAL_LOG R26

**Driven.** The existing dashboard on the rebuilt image, 30 chart widgets of
which 23 carry a narrative. Narratives were read out of React state, because
the widget's prose is only shown on hover and the DOM does not carry it until
you are pointing at it.

| Driven                                                      | Read back                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read narratives before touching anything                    | The R24 artifact — a widget now querying five MONTHS — still carried "The top region, AMER, generated $25.9k… The three regions together generated $51.7k". Its rows total about 9k |
| Press **Refresh** (first run of the check on these widgets) | That narrative **withdrawn**. Seven of the nine Region-titled narratives kept theirs. One more went: Units Sold by Region — see below                                               |
| Press **Refresh** again, nothing changed in between         | 23 narratives before, **23 after, zero withdrawn**. The check does not churn, and does not delete prose from widgets whose data has not moved                                       |

**One withdrawal is unverified, and is recorded that way.** Units Sold by Region
has rows APAC 2121, EMEA 2118, AMER 2115 — total 6354, average 2118 — and prose
beginning "A total of 6.4k units were sold across all regions, with an average
of 2.1k units per region. APAC led with the highest sales at 2…". Every figure
in that fragment grounds. Whatever failed lies past the 130 characters that were
captured, and the prose was gone before that mattered; version history offers
restore, not read, and restoring would have destroyed the demonstration. It is
not claimed as a correct catch.

**The second refresh is the result that matters.** A check that deletes content
is dangerous in proportion to how often it fires wrongly, and over 23 narratives
whose data was untouched it fired not once.

Findings from this round: R26 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A single-value card says which row it draws, ADVERSARIAL_LOG R25

**Driven.** The existing generated dashboard on the rebuilt image — no new
generation, because the dashboard already held the three cases and inventing a
fourth would have proved less. Widget objects were read out of React state to
get `chart.type`, `valueField` and the real row arrays, then the rendered DOM
was read back for what the cards actually say.

| Card (live, unchanged)                               | Before                     | After                                                      |
| ---------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| **Revenue by Region** — kpi, 3 rows, `total_revenue` | `AMER 25.9k`, nothing else | `AMER 25.9k` **+ "1 of 3 rows"**                           |
| **Units Sold by Plan** — kpi, 3 rows, `total_units`  | `FREE 2.1k`, nothing else  | `FREE 2.1k` **+ "1 of 3 rows"**                            |
| **Best Month by Revenue** — kpi, 36 rows, `month`    | `2025-05`                  | `2025-05`, **no caveat** — correct, row zero is the answer |
| **Total Revenue** — kpi, 1 row                       | `51.7k`                    | `51.7k`, unchanged                                         |
| **Total Units Sold** — kpi, 1 row                    | `6.4k`                     | `6.4k`, unchanged                                          |

**Two caveats on the whole dashboard, and they are the right two.** Counted in
the DOM across roughly twenty-six widgets: exactly two nodes matching
`1 of N rows`, owned by Revenue by Region and Units Sold by Plan. The genuine
one-row totals stayed clean, and the ordered-label KPI stayed clean. A guard
that fires where it should not is worse than the gap it closes — on a dashboard
this size, that is the half the UI can actually prove.

**Nothing was regenerated or edited.** These cards were built in earlier rounds
and were left exactly as they were; only the renderer changed. That is the point
of computing the count at render rather than storing it — it reaches widgets
that already exist, and it cannot go stale on the ones that do not change.

Findings from this round: R25 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A note re-checked when the rows under it change, ADVERSARIAL_LOG R24

**Driven.** The running instance on the rebuilt image, against the lakehouse
`analytics.bi_demo_sales`. Widget objects were read out of React state through
the fiber, not inferred from the card, so "the field is stored" is a fact about
the object rather than about the pixels.

| Driven                                                                 | Read back                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate one widget, "Top 5 Regions by Revenue", over a 3-region table | Title `Top 5 Regions by Revenue — The data has 3 rows, not 5.`, and `reconcile_note` stored on the widget as that exact sentence. 3 rows                          |
| Press **Refresh** with the data unchanged                              | Every still-correct note preserved byte-for-byte across ~26 widgets. The no-write path, which is what stops a refresh dirtying the document over a sentence       |
| Rename the claim in the editor, `Top 5` → `Top 3`, and save            | **`Top 3 Regions by Revenue`** — note withdrawn, `reconcile_note` cleared, three bars (AMER/EMEA/APAC). The claim now matches the data, so the caveat retired     |
| Re-read the widget edited during the FIRST attempt                     | `Top 5 Regions by Revenue — The data has 3 rows, not 5.` with **5 rows**. The stale note, still standing — orphaned by the pre-fix builder. Left on the dashboard |

**The first attempt failed, and the failure was the second finding.** The plan
was: generate a widget with a note, edit its SQL so the count changes, refresh,
watch the note go. It did not go. The widget had no `reconcile_note` at all —
`BiBuilderPane` rebuilds its widget from an explicit list of fields, so editing
any widget dropped the new one and orphaned the note permanently. The test
method destroyed the thing under test. Fixed, and that widget is deliberately
left on the dashboard as the before-picture.

**Not exercised live.** The case where the DATA changes under a widget and the
note is rewritten rather than withdrawn — the seeded table's row counts do not
move, and nothing here manufactured a change to claim otherwise. All four write
sites call one function; its withdraw, rewrite, preserve and refuse branches are
covered by unit tests and eleven mutants.

**Kept for review.** Dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — now carries the stale note and the
retired one within a screen of each other.

Findings from this round: R24 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-20 — A chart's columns checked against its query, ADVERSARIAL_LOG R23

**Driven.** Four generations against the lakehouse (`analytics.bi_demo_sales`),
Gemini 2.5 Flash, each narrowed with **Clear all** to a single pick, on the
image rebuilt with the new check. `window.fetch` patched to record every
`/api/` call, so the SQL and the chart spec are readable side by side.

| Driven                                                              | Read back                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus: rank months, write no `LIMIT`                                | `SELECT month, SUM(revenue) AS total_revenue … ORDER BY total_revenue DESC`, no limit → 36 rows. **`truncate` fired live for the first time**: "Top 5 Months by Revenue — Showing the top 5 of 36." Five bars, axis 0–2.0k, tooltip `2025-12 total_revenue: 1.8k` |
| Focus: title "Best Month by Revenue", SELECT the month column only  | `SELECT month … ORDER BY SUM(revenue) DESC LIMIT 1`. The chart step chose **kpi on `month`** — a field that IS in the result — so the field check correctly said nothing. Renders "MONTH WITH HIGHEST REVENUE / 2025-05"                                          |
| Focus: same, more explicit — no aggregate in the SELECT list        | Model wrote `SELECT month, SUM(revenue) AS total_revenue … LIMIT 5` anyway. Fields present, claim 5 = 5 rows, nothing to reconcile                                                                                                                                |
| Focus: the literal one-column SQL, spelled out to be used unchanged | Same again. The SQL step declines to omit the measure                                                                                                                                                                                                             |

**The path this round was built for did NOT fire live, and this entry does not
pretend it did.** Four generations, four queries that all selected their own
measure. The bug is real and was observed twice in R22, before this check
existed — both of those runs produced `SELECT month` alone under a bar chart
declaring `yField: "revenue"` — but the SQL step would not reproduce it on
demand here. `unplottable` and the re-point repair are covered by 15 unit tests
and 14 mutants, and by nothing else.

**What four clean generations DO show.** A new guard that fires when it should
not is worse than the gap it closes: it would have turned four correct charts
into tables with an apology on them. None of the four grew a note, and the two
that had something to reconcile got the title note only. That is the half of
this change the UI can prove, and it is the half most likely to go wrong.

**Kept for review.** Dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — now carries the whole sequence
under one title: R20's correct generation, R22's false note, R22's repair
(five labels, no bars — the widget this round's check exists for), and R23's
truncate. The empty-bars widget is deliberately left as it was generated.

Findings from this round: R23 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — A title that names an N the query capped itself below, ADVERSARIAL_LOG R22

**Driven.** Two generations against the lakehouse (`analytics.bi_demo_sales`,
the seeded 36-month series), Gemini 2.5 Flash, each narrowed with **Clear all**
to the single pick `Top 5 Months by Revenue` so one widget could be watched
end to end — once on the image that shipped R20/R21, once on the image rebuilt
with the fix. `window.fetch` patched to record every `/api/bi` call and clone
its reply, so the SQL the model wrote is readable beside the title it wrote.

**What the steer was for, and what it actually produced.** R20 closed with
`truncate` and `widen` unexercised live, because the un-steered generator wrote
correct limits every time. The focus text here told the model _not_ to write a
`LIMIT` — aimed at `truncate`. The model wrote `LIMIT 1` both times instead,
which is the `widen` case, and that is how the bug turned up. The steer did not
produce the outcome it was written for; it is recorded as what it was.

| Driven                                                  | Read back                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate, pre-fix image, one pick                       | Model wrote `... GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1` under a title claiming 5. Widget rendered **`Top 5 Months by Revenue — The data has 1 row, not 5.`** — of a 36-month table. The R22 finding |
| Generate, rebuilt image, same pick, same focus          | Model wrote `... ORDER BY revenue DESC NULLS LAST LIMIT 1`. Widget rendered **`Top 5 Months by Revenue`, no note**, five month labels: 2025-05, -04, -06, -03, -12                                              |
| Opened that widget's editor and read its persisted SQL  | `SELECT month FROM analytics.bi_demo_sales WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST **LIMIT 5**` — rewritten, so a later refresh agrees with the screen                                       |
| Cross-checked the five against R20's correct generation | The 4h-old widget on the same dashboard, whose SQL carried its own `LIMIT 5`, draws the same five months. The widened query returned the RIGHT five, not merely five                                            |

**Chart nodes were read, not assumed.** Counts above come from
`.recharts-rectangle` and `svg text` on the card after scrolling it into view —
these widgets virtualise, and a card measured while off-screen reports zero
bars and no labels whatever it actually draws. A first pass here did exactly
that and briefly showed the known-good R20 widget as empty.

**A second defect, found in the same frame and NOT fixed.** The repaired widget
draws **no bars** — five month labels along the x-axis, no y-axis ticks, no
rectangles. The model's SQL selects only `month`; it never selects `revenue`,
so the chart spec's `yField: "revenue"` has no column to plot. The R20 widget
beside it draws five bars and a 0–2.0k axis, which is what a correct generation
looks like. The title check cannot catch this — it reads the title against the
row count, and both agree. Reconciling a chart's declared fields against its
own result columns is a different check and a separate change; it is recorded
here as open, not quietly folded into this round.

**Kept for review.** Three widgets titled `Top 5 Months by Revenue` now sit on
dashboard **"Reconciled titles - lakehouse"** —
`/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — a correct generation from R20, the
false note this round found, and the same generation repaired.

Findings from this round: R22 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — The analyst's answer, checked, ADVERSARIAL_LOG R21

**Driven.** Two questions through the **AI analyst** pane on the rebuilt image,
`window.fetch` patched to record every `/api/bi` call and clone its reply, so a
narrative retry is visible as a request carrying the correction prompt.

| Asked                                              | Read back                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What is total revenue by region?"                 | One narrative call, no retry. `$2.3M` vs 2,297,201.86 · `$1.0M` vs EMEA 1,042,800 · `$415k` vs APJ 415,500, passing at exactly the ±500 its written precision allows |
| "What share of total sales does each region hold?" | Chosen to invite an invented percentage. No retry. 45.4% and 18.1% are the real shares; "about 33.3%" is the mean of the share column                                |

**What this does not show.** The catch path fired in neither run. Both answers
were correct — which is what giving the model computed facts is for — so the
check had nothing to reject. It is covered by unit tests and by a mutant that
severs it; two attempts at inducing an invented figure is not evidence that one
cannot occur, and no claim is made here that it is.

**A probe that nearly lied.** The first version detected a correction by
searching the request body for "must not appear", and duly reported one — on
the **SQL** step, whose prompt contains that phrase for unrelated reasons. The
marker is now the narrative correction's own opening sentence. Recorded because
a probe matching something other than what it claims will confirm whatever you
were hoping for.

Findings from this round: R21 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — Titles reconciled against queries, ADVERSARIAL_LOG R20

**Driven.** The running instance on the rebuilt image. Three whole-dashboard
generations against the lakehouse, each chosen to put a different reconciliation
path under load, plus a direct re-read of the two widgets that produced the
original findings.

**Why chart types were read from the DOM, not assumed.** A widget that renders
one value with a label looks in a text dump exactly like a bar chart with one
bar. Every claim below about what a widget IS comes from checking the rendered
node — `recharts` present or absent, the `svg text` labels, the count of
`.recharts-rectangle` — because assuming it once already put a wrong sentence
in this log (see the correction on R19).

| Driven                                                        | Read back                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-read "Top 5 Products by Sales" on the pre-fix dashboard    | A real recharts bar chart, **14 category labels**, SQL with no `LIMIT`. The R20 finding, confirmed rather than inferred                                           |
| Re-read "Revenue by Region" on the pre-fix dashboard          | `recharts` absent, no `svg text`, one value and a label — a **KPI**, not the bar chart R19 described. Correction filed                                            |
| Generate 13 widgets, lakehouse, no focus                      | Nothing to reconcile: every generated query matched its title. "Revenue by Region" came back without a `LIMIT` this time                                          |
| Generate 8 widgets, focus on rankings                         | "Top 5 Months by Revenue" → exactly 5 bars, and the right five: 2025-05, -04, -06, -03, -12, matching the seeded series' five highest months                      |
| …same run                                                     | "Top 3 Plans by Units Sold" → SQL carried `LIMIT 3`, **3** bars, 3 `svg text` labels. The trailing `—` in the card's text is not a category, it is a sibling node |
| Generate 1 widget, "top 5 regions" against a table with three | **The path that proves the wiring.** Title rendered as `Top 5 Regions by Revenue — The data has 3 rows, not 5.`                                                   |

**The bug this round existed to find.** On the first attempt at the last row,
the widget rendered correctly and the title carried **no note**: the generator
assigns `widget.title = picks[i].title || widget.title` two lines after the note
was applied, overwriting it. Twenty unit tests and seventeen mutants were green
— they asserted the note was produced, never that it survived. One forced
generation found it. Fixed, and the test now asserts the ORDER of the two
assignments with a mutant that reinstates the overwrite.

**Kept for review.** Both versions are on the same dashboard, adjacent:

- Dashboard **"Reconciled titles - lakehouse"** —
  `/bi/712429e4-4211-42ce-9422-d94c7cfc45dd` — two widgets titled "Top 5 Regions
  by Revenue", one from before the fix and one after, each drawing AMER / EMEA /
  APAC; only the second says what the data actually had.

**Not exercised live.** `truncate` and `widen` did not fire in any of these
runs, because the generator wrote correct `LIMIT`s every time. Both are covered
by unit tests and mutants; neither has been seen repairing a live generation,
and this entry does not claim otherwise.

Findings from this round: R20 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-19 — Every figure an AI card states, checked, ADVERSARIAL_LOG R19

**Driven.** The running instance on the rebuilt image, signed in as the owner.
The **AI insight** control on four widgets of the AI-generated lakehouse
dashboard, each one a different shape: a 36-row time series with no shares
computable, a second time series, a 3-row breakdown, and a self-capped query.

**How the catch was observed.** `window.fetch` patched to record every
`/api/bi` call and clone its reply, so a rejected first draft is visible as a
second call carrying the correction prompt — the same technique the log's
Method section describes for failed reads, and for the same reason: the screen
alone cannot tell you a retry happened. A full page reload destroys the patch,
so every measurement below was taken without one.

**The reference series.** `analytics.bi_demo_sales`, seeded from
`base(t) = 1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)` — 36 months, total
**51,749.84**, regions weighted 0.5 / 0.3 / 0.2 — so every figure a card states
was checkable rather than plausible.

| Widget                       | Calls | Read back                                                                                                                                                                          |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly Revenue Trend        | **2** | A first draft rejected and rewritten. Final card: total `$51,749.84`, max `$1,882.60` (2025-05), mean `$1,437.50` (= 51,749.84/36), low `$1,000` at January 2023 — every one exact |
| Monthly Units Sold Trend     | **2** | Rejected a **correct** sentence — the "b" of "both" read as a billion suffix (R19). After the fix: **1 call**, no correction, card still says "January 2023"                       |
| Revenue by Region            | **1** | Card claimed `100%` and "no other regions", every figure verifying, because the SQL ends `LIMIT 1` (R19). After the fix: the card states the cap itself and claims no share        |
| Sales by Region (saas_sales) | **1** | `$2.3M`, `$1.0M`, `45.4%`, `$837.9k`, `36.5%`, `$415.5k`, `18.1%` — all traceable, shares sum to 100.0%. Note `$837.9k`, not the `$837k` the checker rejects                       |

**What the two calls prove.** A second `/api/bi` call carries a system prompt
naming the offending figures, so the count is direct evidence of the check
firing — not an inference from what rendered. On "Monthly Revenue Trend" the
rejected draft and the accepted one were captured side by side; the correction
changed `177` to `176.5` and dropped a month the data did not support.

**Kept for review.** Both "Insight — Revenue by Region" cards are left on the
dashboard on purpose, the before and the after together:

- Dashboard **"AI from the lakehouse - generated"** —
  `/bi/c9bbdd5c-eab3-4717-b3bf-dc4a0392b9b3` — card `aaaf9b5f` is the one
  claiming 100% of revenue for AMER; card `9167dfa9` is the same button pressed
  after the fix, disclosing that the query returned only the top region.

Findings from this round: R19 in the [Adversarial log](./ADVERSARIAL_LOG.md).

## 2026-09-18 — BI dashboarding and reporting end to end, ADVERSARIAL_LOG R18

**Driven.** The running instance, signed in as the owner. Three surfaces: a
hand-built dashboard over a series whose every value was known before the first
tile existed; a paginated report the AI planned and built; and a whole
dashboard the AI generated unaided. Then the AI extras on top of them — the
per-widget insight, the insight sweep, the NL analyst, and an ontology over the
built-in lakehouse.

**The reference series.** `analytics.bi_demo_sales` in the lakehouse, seeded by
ETL pipeline `bi_seed` from `base(t) = 1000 + 25t + 200·sin(2πt/12) +
10·sin(7t)` — 108 rows, 36 months, three regions weighted 0.5 / 0.3 / 0.2,
total **51,749.84**. Every number a tile showed could therefore be checked
rather than eyeballed.

### Visual types

| Driven                                                                                                                                                                                                                                                   | Read back                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25 of the 26 types on one dashboard: column, bar, stacked column, stacked bar, bar race, line, area, combo, scatter, pie, nightingale, radar, funnel, sankey, treemap, word cloud, heatmap, box plot, waterfall, KPI, gauge, matrix, map, bubbles, table | Every one rendered from the lakehouse table. Matrix checked cell by cell against the seeded series; treemap and table totals 51.7k; heatmap rows AMER/APJ/EMEA against 36 month columns                         |
| The 26th, **Ontology**, built from the lakehouse (21/21 tables)                                                                                                                                                                                          | 21 entities, 1 source — and the AI step timed out at 60s, leaving 0 relationships and heuristic labels (R18)                                                                                                    |
| Forecast, 6 periods, built-in seasonal                                                                                                                                                                                                                   | 1874.2 / 1997.0 / 2095.4 / 2148.6 / 2147.7 / 2099.5 against truth 1906.24 / 2034.84 / 2131.80 / 2178.14 / 2169.33 / 2116.02 — **MAPE ≈ 1.4%**, peak at step 4 in both, band widening 208.5 → 510.6 = √6 exactly |
| Filled map and bubble map over a column of ISO alpha-2 codes                                                                                                                                                                                             | "10 rows not matched to a country" on both — 2 of 280 codes resolved, `GB` among the failures (R18)                                                                                                             |

### The AI half

| Driven                                                                          | Read back                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generate a report** over `saas_sales`, twice from the same brief              | A 4-section plan each time with a chart type and a rationale per section. Run 1 built 3 of 4 and disclosed the shortfall; run 3 built all 4 (11 blocks). Header, footer, `{{page}} of {{pages}}` and the repeated table header all behave |
| **Generate Entire Dashboard** over `saas_sales`, no focus given                 | An executive summary and 13 widgets across 13 chart types, all 13 built. Two carry a `PARTIAL` badge where the snapshot hit its row cap                                                                                                   |
| **AI analyst** (NL → SQL → chart → narrative), asked for total sales and profit | `SELECT SUM(Sales) AS total_sales, SUM(Profit) AS total_profit FROM saas_sales` → 2.30M / 286.4k, matching both generated KPI tiles and the 14-row product breakdown, which sums to 2,297,201.86                                          |
| **AI insight** on "Sales by Region"                                             | A structured card — what the data shows / watch out for / next steps — whose three percentages summed to **106%** (R18)                                                                                                                   |
| **Scan** on the generated dashboard                                             | "Swept 10 widgets and found 2 things worth a look… 4 could not be swept", each with its reason. Deterministic, no model call. The 2025-11 outlier at 3.1 MAD from the median                                                              |
| **Build ontology with AI**, lakehouse only                                      | AI enrichment refused at the 60s deadline, disclosed in the widget, heuristic fallback shown (R18)                                                                                                                                        |

### Blocked, and why

Neither AI generator can be pointed at a lakehouse or warehouse table — both
offer local datasets (and, for dashboards, a governed semantic model) only — so
the "generate from the lakehouse" path was exercised through the **Ontology**
builder, which does list it, and through a dashboard widget carried into a
report. Recorded in the log as a product decision rather than a defect.

**Kept for review.** The user asked for these to be left in place:

- Dashboard **"BI verification — known series"** — `/bi/64a77e4b-041a-4d41-b58c-092745558f7a`
  — the 25 visual types over the seeded lakehouse series, including the two map
  widgets that produced the country-code finding and the verified forecast.
- Dashboard **"AI verification - generated from saas_sales"** —
  `/bi/db14d61a-6fe7-4862-a428-42eabb600ad2` — everything on it was written by
  the AI: the executive summary, 13 widgets, the insight card whose percentages
  summed to 106%, and the ontology widget.
- Report **"Revenue pack - known series"** —
  `/bi/report/d27fef19-1c65-4287-9161-424d0e7c6d93` — the AI-planned paginated
  report, saved at the 3-section version that produced the preview/PDF finding.

### Re-driven on the rebuilt image

The same widgets, after the fixes, on the same data:

| Widget                                     | Before                                       | After                                                                                        |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Revenue by country, filled and bubble      | "10 rows not matched" of 11                  | "3 rows not matched" — all 8 real countries draw, `GB` included; the 3 are `??`, `U S`, `XX` |
| Report trend axis, and both AI time charts | `1667260800000`                              | `2022-05 … 2025-12`, on AUTO, no user action                                                 |
| "Top Products by Revenue" table            | `410379.26499999943`                         | `410,379.26` — the text the PDF prints                                                       |
| Data ontology                              | 0 links, "AI enrichment unavailable (… 60s)" | **76 entities, 55 relationships, 5 sources, "AI-built"**                                     |
| AI insight on "Sales by Region"            | 48% + 39% + 19% = **106%**                   | 45.4% + 36.5% + 18.1% = **100.0%**, with the total it divided by stated                      |

### Re-driven again: both AI generators, pointed at the lakehouse

After the source picker was added to both dialogs (and the report editor's own
route was given a real warehouse context):

| Driven                                                                                                            | Read back                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generate Entire Dashboard** → source "Lakehouse — AgentSwarms Lakehouse (built-in)" → `analytics.bi_demo_sales` | All 21 lakehouse tables offered, none with a misleading "0 rows". 13 widgets built. **Total Revenue 51.7k** — the seeded series total — and AMER 25.9k, matching the regional split verified earlier                         |
| The generated KPI's own editor                                                                                    | SQL `SELECT SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales`, source **"Lakehouse — AgentSwarms Lakehouse (built-in)"** — so refresh and drill-through return there                                               |
| **Generate a report** → same source → same table, 3 sections                                                      | 9 blocks. The detail table's 36 monthly rows sum to **51,749.84**, against 51,749.79 recomputed from the seeding formula `1000 + 25t + 200·sin(2πt/12) + 10·sin(7t)` — the 5-cent gap is per-row rounding in the stored data |
| The same report's chart axis and table cells                                                                      | `2023-01 … 2025-12` on AUTO and `1,131.56` rather than a raw float — the earlier two fixes holding on a lakehouse-sourced page                                                                                               |

**Kept for review** (added to the list above):

- Dashboard **"AI from the lakehouse - generated"** — `/bi/c9bbdd5c-eab3-4717-b3bf-dc4a0392b9b3`
  — 13 widgets, every one of them written by the AI against the lakehouse.
- Report **"Lakehouse pack - generated"** — `/bi/report/aee89589-104e-49c7-ad0f-29e0a5efb9ed`
  — the AI-planned paginated report whose numbers reconcile to the cent.

Findings from this round: R18 in the [Adversarial log](./ADVERSARIAL_LOG.md).

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
