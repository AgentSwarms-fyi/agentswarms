# Business Intelligence

> Part of the [AgentSwarms docs](../README.md#documentation).

The **BI Workspace** (`/bi`) turns connected data into shareable dashboards
and reports. An editable dashboard is called a **BI project**:

- **Build visuals by hand** — a right-hand builder pane: pick a source (your
  Data & SQL datasets or any connected warehouse), tick one or **more tables
  to join** (a JOIN skeleton is written for you with auto-detected join
  keys), run the read-only SQL, then pick from **18 visual types** in an
  icon picker: column, bar, line, area, **combo (bars + line, dual axis)**,
  **scatter**, pie/donut, **funnel**, **treemap**, **heatmap**,
  **box &amp; whisker**, **waterfall**, KPI card (with target comparison),
  **gauge**, **matrix (pivot) table**, **filled map** and **bubble map**
  (country-level, fully offline — no tile servers), and table. Column, line
  and area charts support **multi-series** (split by a category column —
  grouped or stacked), and every numeric visual takes a **value format**
  (currency / percent). Widgets live on a 12-column drag-and-resize grid,
  with markdown text blocks for report narrative.
- **Filters &amp; cross-filtering** — add dashboard filters (value slicers
  and date ranges) that apply to every widget containing that column, and
  **click any bar or pie slice to cross-filter** the rest of the dashboard.
  Both work on the stored snapshots — in the editor, the shared read-only
  view and the public link — and PDF export captures the filtered view.
- **Generate whole dashboards with AI** — the editor's **Generate**
  button takes one business goal ("monthly revenue review by plan"),
  plans 5–8 analyst questions against your schema, runs each through the
  GenBI pipeline with live per-question progress, and lays the finished
  widgets out automatically (KPIs on top, charts in the middle, tables
  at the bottom). Failed questions are skipped, never faked.

  **Generate from a governed model instead of a table.** The source picker
  offers a semantic model alongside your tables, and choosing one governs the
  whole dashboard: the planner is shown the model's declared metrics and
  dimensions — not its tables or columns — and every widget it proposes is
  compiled into SQL by the semantic compiler. Each lands with
  `source.kind: "semantic"`, so refresh recompiles against the CURRENT
  definition and fan-out refusal, row filters and field masks all apply,
  exactly as when you build a chart by hand.

  This closes an inversion worth naming: building one chart by hand could
  always pin it to a certified metric, while asking the AI for twelve gave you
  twelve charts whose aggregations the model chose. The path producing the most
  numbers with the least review was the only one with no governance on it, and
  a generated dashboard looked identical either way.

  The choice is made once, at the picker, so a governed dashboard cannot
  contain an ungoverned widget hiding among the certified ones. Anything the
  planner proposes that is not in the declared vocabulary — an invented metric,
  a dimension that does not exist, a chart shape that cannot render what it was
  given — is **rejected with the reason shown**, not silently dropped: a
  generate that proposed twelve and built nine has to say which three it lost.

- **Embed &amp; export** — Publish gains **Copy embed code**: an
  `<iframe>` snippet pointing at `/share/bi/<slug>?embed=1`, a
  chrome-less variant of the public page (filters and cross-filtering
  still work). Every chart's menu can **download its data as CSV** and
  the **widget as a PNG**; table widgets get click-to-sort headers,
  50-row pagination and a totals row for numeric columns.
- **Generate visuals with AI** — the same GenBI analyst as the Data & SQL
  page (plan → SQL → execute → chart → narrative) lives in the pane's **AI
  analyst** tab; insert any answer as a widget. On `/data-sql`, every
  generated visual also has an **Add to dashboard** button. Scope the
  analyst with **Tables to analyse**, and optionally select **knowledge
  documents** (up to 6, from any knowledge base you can read): the analyst
  then cross-references the query result with the documents' most relevant
  passages and blends both into the insight — naming each document it draws
  on, and saying plainly when it finds **no correlation** between the
  structured data and the selected documents rather than inventing one.
  With no documents selected it analyses structured sources only.
- **AI insights per visual** — every chart's menu has **AI insight**: the
  analyst reads that widget's data and drops a markdown card below it with
  what the data shows, caveats to watch, and suggested next steps.
- **Ontology visual** — an AI-built knowledge map of your whole data
  estate. Pick "Ontology" in the visual picker and choose the sources to
  include — expand any group to select **individual tables** (local &amp;
  prepared datasets, each connected warehouse's schema) or **individual
  knowledge bases**, with tri-state group checkboxes and live selection
  counts — then hit **Build ontology with AI**: relationships are
  first detected deterministically (semantic-layer join hints, `*_id` →
  target-table key matching across sources, data-prep lineage), then one
  AI pass — fed **real sample rows** from each selected table (schema
  only, or 5–200 rows per table, default 50; plus an optional **custom
  SQL query** whose result is sent as extra signal) and **real content
  excerpts** from each selected knowledge base's documents —
  classifies every entity (master data / transactions / events /
  reference / metrics / documents), groups them into business domains,
  labels each relationship with a verb and cardinality, and infers
  additional cross-source links down to the **field level** (a document
  that explains a table's subject links to the exact column, with a
  quoted **evidence** phrase for every relation — hover any edge to read
  it) before writing an executive summary. The result renders
  as an interactive force-directed map — entity cards with source badges
  and row/column counts inside shaded domain clusters, typed edges
  (solid = join key, dotted = prep lineage, dashed = AI-inferred) with
  key and cardinality labels, hover to spotlight a neighbourhood with a
  detail panel, plus zoom/fit/pan. The map is **multi-layer**: drill
  into any card (⊞ on the card, or Expand all) and tables unfold into
  their full field list — key columns marked, semantic-type chips per
  field — while knowledge bases unfold into their documents, join edges
  re-anchor to the exact key field row on each side (ER-diagram style,
  joined fields tinted), and the layout reflows around expanded cards. If the AI call fails the detected
  structure still renders with heuristic labels and a visible note. The
  whole map is stored in the widget, so it publishes, shares and exports
  to PDF like any other visual.
- **Pick the AI model** — the BI agent on Data & SQL and every generative
  feature in the BI Workspace (AI analyst, insights) runs on a text model
  picked from **your connected integrations**: one group per connected
  OpenAI-compatible provider (its configured default model first), with the
  full catalog when OpenRouter is connected — filtered by your IAM model
  rules and enforced server-side. Calls are **BYOK**: they execute against
  the chosen integration's own key, with the operator's shared
  `OPENROUTER_API_KEY` only as a zero-config fallback. When publishing, choose a **reader AI model**:
  signed-in viewers of a shared dashboard get an **Ask AI** panel that
  answers questions from the stored data snapshots using that model — and
  sharing with a group is validated against the group's IAM model rules
  (the anonymous public link stays data-only, no AI).
- **Refresh** re-runs every widget's SQL against its source and stores a
  capped **data snapshot** in the dashboard.
- **Scheduled refresh &amp; data alerts** — the editor's **Schedule**
  dialog refreshes a dashboard hourly / daily / weekly (UTC) entirely
  server-side: warehouse widgets run with the owner's stored encrypted
  credentials, local widgets through a server-side SQL engine over the
  stored dataset rows. **Alert rules** (widget + column + aggregation +
  operator + threshold, or plain row count) are evaluated after each
  refresh — a rule notifies once when it trips and re-arms when the
  condition clears; refresh failures notify too. Notifications land in
  the header's **alerts bell** (60s polling). The scheduler runs inside
  the node server (started on first app load); on serverless hosts point
  an external cron at `POST /api/bi/cron` with a Bearer `BI_CRON_TOKEN`.
- **Drill-down, trends &amp; time intelligence** — bar/column/pie charts
  take an ordered **drill hierarchy** (click a bar to drill Year →
  Quarter → Region…, breadcrumbs to climb back — works on snapshots in
  the editor, shared and public views). Line/area charts get a **date
  grain toggle** (day/week/month/quarter/year re-bucketing), **prior
  period / prior year** comparison overlays, **running totals**, a linear
  **trend line**, an N-period **forecast** with a ±1.96σ corridor, and
  **reference lines** (average or target value) on bar/line/area.
- **Drill-through to the rows underneath** — a widget's **Explore data**
  opens the raw rows behind an aggregate. Every narrowing you can see is
  pushed into the QUERY: the widget's own filters, the drill level you
  clicked into, and the active cross-filter. The row cap applies **after**
  that, so "1,000 of 4,219 matching rows" means the first 1,000 of a real
  4,219 — not 4,219 out of an arbitrary 1,000-row slice. When the result is
  capped it says so, and says the rows came back in no particular order
  rather than implying a ranked sample.

  The base query is derived by taking the widget's own `FROM`/`JOIN`/`WHERE`
  and dropping the aggregation, so joins, table aliases and CTEs survive
  intact. Two cases are **refused** rather than approximated: a widget whose
  query combines results with `UNION` (no single row grain to descend into —
  its own rows are shown instead, labelled as such), and a drill on a
  category computed in the select list, such as `DATE_TRUNC('month', d) AS
month`, since the rows underneath have no `month` column to filter on.
  Dropping that predicate silently would show the whole table under a label
  promising one bar's worth.

- **Export** — one control, two destinations.
  - **PDF** renders the dashboard with its layout preserved into an A4 report,
    entirely client-side.
  - **PowerPoint** builds a branded deck. Choose which visuals to include
    (grouped by dashboard page), pick the model that writes the prose, and add
    your own instructions for tone, audience or emphasis.

  **Every figure in the deck is the dashboard's own figure.** Slides are filled
  from each widget's saved snapshot — the same rows the card on screen renders
  — never re-queried and never authored by a model. A deck that disagreed with
  the dashboard it came from would be two sources of truth, and the one in the
  meeting room is the one people act on.

  The model writes the deck title, an executive summary and one takeaway per
  slide. It is given the computed values as text it may quote, and it is
  forbidden to calculate: any figure in its prose that did not come from the
  data is stripped before it reaches a slide. That holds even when your own
  instructions ask for one — "add growth percentages" produces prose whose
  invented percentages are removed, because a computed-then-presented number is
  exactly the failure the rest of this system is built to prevent. The model is
  also entirely optional: if it is slow, unconfigured or fails, you get a clean
  un-narrated deck rather than no deck.

  A visual PowerPoint cannot draw — a sankey, a geo map, a bar race — is shown
  as a table of the same data and says so on the slide. One that has no saved
  data cannot become a slide at all, and the dialog lists it with the reason
  (usually: refresh the dashboard first) rather than quietly dropping it. Long
  category lists and long tables are capped for legibility, and the cap is
  printed on the slide: "Showing the first 14 of 68 categories" is a fact the
  reader needs, and a slide showing a sample without saying so is presenting it
  as the whole.

- **Query history** — the workbench records every statement you run, local or
  warehouse, with its row count, duration and (for failures) the error. Click
  one to load it back into the editor along with the connection it ran against.
  Kept per user, newest 200, and clearable at any time — separate from the
  compliance audit trail, which is hash-chained and retention-governed.
- **Uploading data** — Data &amp; SQL → **Upload data** accepts **CSV, TSV,
  JSON, NDJSON and Excel (.xlsx)**. The file streams to the server and is
  parsed there, so a large upload is bounded by the server's limits rather than
  by a browser tab's memory; CSV/TSV/NDJSON are read incrementally, while JSON
  arrays and workbooks are read whole because those formats cannot be streamed.
  Rows are staged and only swapped onto the real dataset once the entire file
  parses, so a malformed row halfway down leaves your existing data intact.
  Exceeding `UPLOAD_MAX_BYTES` / `UPLOAD_MAX_ROWS` refuses the import outright
  rather than loading a silent subset — see [deployment](./DEPLOYMENT.md).
  Types are inferred from a sample and shown after the import; re-uploading over
  an existing dataset keeps the old contents as a restorable version.
- **Data preparation** — a visual prep studio (BI Workspace → Data
  preparation): drag tables onto the canvas to build a join pipeline (left /
  inner / right / full outer, join keys auto-detected from matching column
  names, colliding columns auto-aliased), rename columns and set their types
  — Text, Integer, Decimal, Date, Boolean, **Location**, Category, Currency,
  Percentage, Identifier — with un-convertible values nulled and counted.
  The result preview updates live at the bottom, on a 1,000-row sample; click
  the **eye** on any step to preview the data _as of that step_ (the fastest
  way to find which transform dropped the rows you expected), and **undo/redo**
  (Ctrl+Z / Ctrl+Shift+Z) covers every edit to the pipeline. **Run &amp; save**
  executes the flow **on the server against the full source data** — the same
  code path the scheduled refresh uses, so both always agree — and materialises
  the result as a local dataset (joinable again, chartable, visible to the AI
  analyst and SQL agents, semantic types recorded in the semantic layer); the
  flow itself is saved for re-editing, re-running and **duplicating**. If a
  source or the output hits its configured ceiling
  (`PREP_SOURCE_ROWS_CAP` / `PREP_OUTPUT_ROWS_CAP` — see
  [deployment](./DEPLOYMENT.md)) the run says so explicitly, naming the
  truncated table and the true row count: a prepared dataset is never silently
  sampled. Re-running writes to the same dataset, so every model, widget and
  flow pointing at it keeps working. External warehouse tables can be pulled in
  as capped snapshots to join against local data.
- **Lakehouse tables in and out** — the prep palette lists every lakehouse
  table you may read; **Link** puts one on the canvas without copying a row.
  While every source is a lakehouse table the whole recipe compiles to one
  DuckDB query that runs through the lakehouse statement guard as you
  (schema grants, row filters and column masks, audit), so a preview is what
  the run will produce. **Save as → lakehouse table** writes the result into
  a schema you own as a materialized view — one atomic
  `CREATE OR REPLACE TABLE … AS`, refreshed on the flow's schedule — and the
  table is then an ordinary lakehouse table for the SQL workbench, agents,
  dashboards and the ML wizard: the way to wrangle a training set before a
  model learns from it (see [ML.md](./ML.md)).
- **Pushdown (query folding)** — an external table can be **linked live**
  instead of snapshotted. When every source in a flow is linked to the _same_
  connection and every step is provably translatable, the whole pipeline is
  compiled into that warehouse's SQL and runs there — a summarize over
  hundreds of millions of rows returns the summary, not the rows. The same
  compiler emits both the local and the warehouse SQL (so they cannot drift),
  the folded query is validated against the real connection before it's
  trusted, and anything unprovable — an unrecognised function in a calculated
  field, remove-duplicates on specific columns, sources spanning two
  connections — falls back to local execution with the reason shown. The
  Output card always says where the work happened.
- **Incremental refresh** — a scheduled refresh can reprocess only the newest
  slice instead of rebuilding everything: pick a Date output column as the
  watermark under _Schedule_. Each run recomputes rows from the newest stored
  value onward and replaces exactly that range, so re-running is idempotent
  and rows sharing the boundary timestamp are neither duplicated nor lost.
  Pipelines where this would be wrong — summarize, pivot, remove-duplicates,
  append — are refused with an explanation and keep rebuilding fully. Edits to
  rows _older_ than the watermark aren't revisited; use **Run &amp; save** for a
  full rebuild.
- **Quality checks** — assert what has to be true of a dataset, in the
  vocabulary analysts already use: `not_null`, `unique`, `accepted_values`,
  numeric `range`, a minimum row count, and a **freshness SLA** ("alert me if
  this hasn't loaded in 24h"). Add them per dataset in **Data → Catalog**;
  each check is either an _error_ (fails the dataset) or a _warn_ (reported
  without failing). They run when you press **Run**, immediately after every
  prep refresh rewrites the dataset, and on a scheduled sweep — the sweep is
  what makes a freshness SLA work at all, since a table that _stopped_
  refreshing produces no event of its own. Alerts fire when the verdict
  **changes** (including recovery), not on every failing run, so an hourly
  check on a broken table doesn't deliver 24 identical messages a day.
  Results are written by the server and are read-only to you: a red check
  cannot be edited green. Checks that cannot run — a missing column,
  unparseable dates — report _error_ rather than quietly passing.
- **Version history** — every overwrite of a dataset (file re-upload, **Run &amp;
  save**, scheduled refresh, incremental refresh) snapshots the outgoing
  contents first, and any of the last few versions can be restored from the
  catalog. Restoring is itself snapshotted, so restoring the wrong version is
  also undoable. Above `DATASET_VERSION_ROW_CAP` rows a version records
  metadata only and says so rather than pretending to be restorable — see
  [deployment](./DEPLOYMENT.md).
- **Safe dataset deletion** — deleting a dataset (from the prep palette or
  Data &amp; SQL) first resolves everything that depends on it — prep flows that
  read it, the flow that _produces_ it, semantic models, dashboards whose SQL
  references it, saved metrics — and lists them. Deleting something with
  dependents requires typing its name; a dataset nothing uses deletes in one
  click. Prepared datasets are labelled with the flow that rebuilds them, so
  it's obvious when edits will be overwritten on the next refresh.
- **Publish & share** — publishing exposes a read-only page at
  `/share/bi/<unguessable-slug>` for anyone with the link; group sharing
  (owner-controlled, or superadmin via Admin → IAM) makes the dashboard
  appear read-only in members' BI Workspace. Viewers always see the stored
  snapshots — your warehouse credentials are never used on their behalf and
  never leave the server.
- **Workspaces, folders & promotion** — group dashboards into **workspaces**
  (with user- or IAM-group members, read-only for members) and nest them in
  **folders**; a `null` workspace stays your private _Personal_ space, so this
  is entirely opt-in. **Promote** an owned dashboard from a personal draft
  into a shared workspace (the first promote copies it in as a Draft;
  re-promoting re-syncs the content while keeping the promoted copy's publish
  link) for a lightweight dev→prod flow. Workspace/member management is
  superadmin-gated.
- **Git export (versioning)** — admins can connect a **GitHub or GitLab**
  repo (per-user, encrypted token) and push **model + dashboard definitions**
  as one commit for review/versioning. Only definitions are exported — widget
  **data rows are stripped**, never the snapshots.

## AI Analyst — your analytical partner

**AI Analyst** (`/ai-analyst`, first under Data &amp; BI) is the dedicated
conversational-analysis surface — the Spotter/conversational-BI equivalent,
built on this stack's own discipline: every answer shows its work.

An **analyst** is two choices and nothing else: a **reasoning model** (picked
from your connected providers — the dialog suggests reasoning families like
o3, GPT-5, Claude Opus, DeepSeek-R1, Gemini 2.5 Pro, and nudges you if the
pick doesn't look like one) and **the data** it is scoped to (all local
datasets &amp; uploads, one dataset, or one warehouse connection). Create as
many analysts as you have jobs for them.

Both choices stay **editable** — the pencil on an analyst's card reopens the
same dialog, so a model that turns out too slow, or data that moved, is a
two-click change rather than a new analyst. Editing applies to your next
question: analyses already on the thread are **not** re-run, and they keep
saying which model produced them. Each turn records the model that answered
it, so a report exported after a model change still names the model behind
its numbers rather than whatever the analyst is set to now. A name you typed
yourself survives an edit; one we derived from the old data source is
re-derived, so an analyst never keeps a label describing data it no longer
reads.

**Reasoning models get a longer clock.** Their wall-clock time is dominated
by thinking that counts against the completion budget, and they generate far
slower per token than chat models — a measured DeepSeek-R1 call produced
1,785 tokens in 59.8s (~33ms/token) against the 8ms/token a chat model
manages. The request deadline scales with both the completion budget and the
model class; sized for chat models it was the analyst's _required_ model
class that timed out. See `src/lib/llmDeadline.ts`.

**Governed steps compile; they are not described.** When a step's numbers
come from a governed semantic model, the plan names the model, its metrics
and its dimensions, and the SQL is produced by the **semantic compiler** —
the same one the BI builder uses, with its fan-out refusals, rollup routing,
row filters and column masks. The model chooses _what_ to ask; it does not
write the query. Before this, governed definitions were injected into the
prompt with "never improvise a different formula" attached and nothing
checked whether the SQL obeyed: a metric that is authoritative only when the
model feels like it is not a governed metric.

Every name in the block is validated against the catalog the analyst
actually loaded, and a block naming anything the model does not have is
dropped **whole** — compiling the subset that happened to match would answer
a different question under a governance badge. A dropped block is not a
refusal to answer: the step falls back to hand-written SQL and is shown
**without** the badge, which is the honest description of what happened. If
the compile itself fails, the step says so and loses the claim rather than
keeping a badge it can no longer justify.

**What-if scenarios** ride on the same compiler. A compiled step gets a
flask control offering the two things that can honestly vary: the model's
**declared parameters** (`{{commission_rate}}` in a metric's SQL is an
assumption its author named and typed) and the **values of filters the step
already has**. The scenario recompiles the _same_ query with one thing
changed, so the difference between the two numbers is that change and
nothing else — impossible with hand-written SQL, where the baseline and the
variant are two separately-written queries.

A scenario is **not a measurement**. It is labelled with exactly what was
assumed (`Scenario — commission_rate 0.1 → 0.15`), shown beside the measured
result rather than replacing it, and never folded into the findings — the
write-up keeps describing what was measured. Where both results are a single
row, the change and percentage change are computed in code; where they are
grouped, the comparison is **refused** rather than matching rows by position.
A scenario that varies nothing is refused too: re-running an identical query
under a "scenario" heading invites the reader to conclude a change was tested
and made no difference. When a model declares no parameters and the step has
no filters, the panel says so instead of offering a control that cannot
change anything.

Compiled steps are marked with the model that produced them, in the thread
and in the exported PDF. When a declared **rollup** answered instead of the
fact table, or a **row filter** narrowed what you can see, that is visible
text rather than a tooltip — both change what the number means.

Ask one a question and it runs a transparent loop:

1. **Plan** — decomposes the question into 1–4 concrete steps and states its
   approach before running anything.
2. **Query** — each step's SQL comes from the same battle-tested generator
   the BI analyst uses (identifier quoting per engine, null-ordering rules,
   window-function rules — all measured), runs on the analyst's scope
   (local DuckDB or the warehouse under your JWT), and repairs itself once
   on an engine error. Governed semantic-model definitions are injected, so
   "revenue" computes the governed way here too. Every statement passes a
   SELECT-only gate.
3. **Self-check** — the analyst reviews its own results before presenting
   them: empty results, wrong magnitudes, case-split groupings, truncated
   rankings. A wrong step gets corrected SQL that re-runs; a doubtful one is
   presented **flagged**, never silently.
4. **Write-up** — the findings cite steps by number, and every number in the
   answer appears in a step result. A headline chart accompanies it.

**Verified answers.** A finished analysis can be marked **verified** or
**flagged as wrong** (a flag requires a reason — one without leaves the next
reader where they started). The verdict records who and when, and it is
pinned to a **fingerprint** of the steps it was given: each step's SQL and
the governed model that compiled it. Edit a step, or let the self-check
rewrite one, and the verdict **voids** — shown as void rather than quietly
dropped, because the reader needs to know a check existed and no longer
covers these queries. Results and prose are deliberately outside the
fingerprint: the same SQL over refreshed data is the same checked work, and
re-verifying on every refresh would make the mark meaningless.

Ask a question someone has already judged and the verdict is **offered, not
applied** — the data has moved since, and nothing here knows by how much.
Asking re-runs the queries; the old check does not carry over. Only _active_
verdicts are offered, and a later "this is wrong" beats an earlier
"verified". Verdicts travel into the exported PDF, voided ones included.

Analyses are kept per analyst and **all of them are reachable** — the picker
beside "New analysis" lists the last 50 by title and date. It used to load
only the newest, so every earlier analysis was stored and then hidden, which
is worse than not storing it.

**Every step that has something to show gets its own visual.** A question
answered by three queries produces three charts — one per step, each chosen
for that result's shape — not a single headline picture with the rest left
as raw tables. Steps whose results have nothing plottable (no numbers, no
rows) show their table alone, which is the honest rendering.

Each step is also **actionable**:

- **Add to dashboard** pins that step as a BI widget carrying its SQL,
  chart and source, so a scheduled refresh re-runs exactly that query.
- **Edit and re-run** opens the step's SQL, runs your version (SELECT-only),
  and replaces the result. Because the write-up above was written from the
  old numbers, the findings are marked **"written before a step was
  re-run"** until you press **Rewrite findings**, which re-synthesizes from
  the current results. The edited step also loses its previous check verdict
  — a green "Check passed" must never vouch for SQL the analyst never saw.

After an answer, the analyst offers **follow-up questions** this analysis
makes worth asking; a brand-new analyst offers **starter questions** written
from its own schema.

### Analysis the model is not trusted to do

Three kinds of reasoning are computed in code rather than narrated by the
model, because a plausible-sounding number reads exactly as confident as a
correct one:

- **Why it moved.** When a step returns two periods side by side, the
  contribution of each dimension value is computed: its change, its percent
  change, and its **share of the total change** — which may exceed 100% and
  is left that way, because a region accounting for 150% of a fall that
  others partly offset is the story, not a rounding embarrassment. Drivers
  (moving with the total) and **offsets** (moving against it, which the
  headline hides) are separated, and members present in only one period are
  named rather than shown as infinite growth.
- **Trends and outliers.** A time-series step gets its slope per period and
  its outliers, found with **median and MAD** rather than mean and standard
  deviation — the outlier inflates the very standard deviation used to judge
  it, which is how the naive test misses the spike it was written to find.
- **Projections, labelled as such.** With enough history (8+ periods) the
  fitted trend is extended up to 6 periods, carrying its method, its mean
  fit error, and an explicit statement that it assumes the trend continues
  and knows nothing about seasonality. **With less history it refuses** —
  the analysis says what the data shows and does not extrapolate.

### It asks before it guesses

When a question cannot be answered well without an answer from you — an
unstated time range, a word the schema defines two ways, a metric that does
not exist under any name — the analyst **stops before querying** and asks,
offering the assumption it would otherwise make so accepting is one click.
It does not ask about things it can decide sensibly itself (sort order, row
limits, chart type); a tool that asks about everything is a tool nobody
uses.

The whole trace — approach, per-step SQL, result samples, per-step charts,
check verdicts, findings — renders in the thread, persists (owner-only rows;
result samples capped at 50 rows per step), carries across questions ("what
about that top region?" resolves from earlier turns), and **exports as a
branded PDF** with one click: real vector text, every step's chart included.

**Steps run concurrently.** A three-query analysis issues its three queries at
once rather than one after another, bounded so a single question cannot become
everyone's rate limit. This is safe for a specific reason worth stating: no
step consumes another's output — each step's SQL is written from its own goal,
and results are read only after every step finishes. It is a property of the
loop rather than a law, so if a step ever comes to depend on an earlier step's
rows this has to become sequential again; parallelism there would not fail
loudly, it would produce plausible numbers computed from missing context.
Results are matched back to steps **by index**, never by completion order —
the trace still reads top to bottom, you just see steps finish out of order.

Identical SQL issued twice inside one analysis runs **once**. The cache holds
the in-flight query rather than its value, so two steps asking the same thing
at the same moment collapse into one round-trip instead of both missing. It is
deliberately scoped to a single question and is never carried across
questions: between two questions the data can move, and a cached row served
later is a number that is no longer true with nothing on screen saying so. A
failed query is not cached either — one warehouse timeout must not poison the
rest of the analysis.

**Scheduled analyses re-run the queries, they do not re-ask the question.**
An analysis can refresh hourly, daily or weekly. The tempting design is to
hand the question back to the model each morning, and it is wrong: the analyst
re-plans, so consecutive runs can answer the same sentence with different SQL —
a number you watch over time whose definition moves underneath you, which is
the failure the semantic layer exists to prevent. So the **steps are pinned**:
the SQL that ran is the SQL that runs again, and a genuinely new analysis is a
question you ask. No model is called, which also removes a 6am dependency on
someone else's inference uptime.

The findings were written from the previous numbers, so a refreshed analysis
is marked **"written before a step was re-run"** — the same marker an edited
step uses — rather than being silently re-synthesized behind you. A human
**verdict survives**, deliberately: the fingerprint covers each step's SQL and
its governed model, neither changed, and the rule was always that the same SQL
over refreshed data is the same checked work. A **what-if is dropped** — one
computed against last week's numbers is not a what-if against this week's.

What moved is computed rather than narrated: precise for a single-row result,
a **row count** where results are grouped, because matching rows between runs
is guesswork and a wrongly matched row is a fabricated finding. The digest
says plainly when **nothing changed**, since a report that only ever arrives
with news teaches people that silence means "did not run". A failing run still
advances its schedule, so it recovers on the next tick instead of re-running a
broken query forever. **Run now** goes through the identical code path.

**Sharing an analyst shares the analyst, not your data access.** An analyst
can be granted to IAM groups; recipients open it and ask their own questions,
and every query they run is authorised as **them** — their dataset grants,
their warehouse credentials, their row filters and column masks. Which means
a shared analyst can legitimately return **different numbers to different
people**, so the share dialog says so before the grant is made, with blocking
problems (datasets the recipients cannot reach; a warehouse connection they
do not have) ranked above advisory ones. An analyst scoped to _all local
datasets_ is called out specially: that scope resolves per reader, so shared
it points at the recipient's datasets rather than yours.

**Saved analyses are not shared.** Threads hold result samples fetched under
the owner's access; showing them to a reader with narrower row filters would
leak exactly the rows those filters exist to withhold. Recipients get the
analyst and start their own conversations. Writes stay with the owner too —
renaming, repointing and deleting are owner-only, and the list marks an
analyst someone shared with you rather than offering controls that would fail.
A grant is **refused** when the recipients' IAM model rules do not allow the
analyst's pinned model: an analyst you can open and never run is a broken
feature, not a policy decision, so the refusal names the model and the groups.

**Where these numbers came from.** Every step that ran a query carries a
lineage disclosure. The tables it names are read out of **the SQL that
actually ran**, never out of the model definition — models get edited, and a
panel built from today's definition would quietly misdescribe a query that ran
against yesterday's. It is the same rule the verification fingerprint follows.
So a step routed to a **rollup** names the rollup, and says the fact table was
not read; a step whose SQL was **edited by hand** says no governed definition
vouches for it, whatever compiled the original.

The parsing is shared with the catalog's lineage index, the warehouse-query
audit and the object-store query planner — one parser, because two of them
drifting is how the Workbench and the catalog end up disagreeing about what a
query touched. It used to be a regex, and a regex reports a comment reading
`-- was: from legacy_orders`, a string containing `'imported from
stripe_charges'`, and a CTE alias as tables. For catalog search that was
noise; here it is an assertion, and a false one. It equally has to **find**
quoted identifiers: a scanner that treats `"orders"` as opaque misses the
table entirely, and on `FROM "orders" WHERE x` reports WHERE as the source.
Quoted names are therefore read as names, and marked as quoted so a column
called `"order"` is still not an ORDER BY. Underneath each table,
where the evidence exists, sits what a **prep flow** combined to build it and
what the **warehouse's own lineage** records upstream — loaded only when the
disclosure is opened, since that read is not worth paying for on a page whose
job is asking questions. A lookup that **fails** says so rather than reporting
"nothing upstream", which would be a claim about the catalog that only a
successful read can support.

**Export data** produces the same analysis as a **workbook** for people who
need to keep working on the numbers. It is not one flattened sheet: an
_Analysis_ sheet carries the questions, the approach, the findings and — per
step — which governed model compiled it, what the self-check said, whether a
human verified it, and whether a step was edited by hand. Then one sheet per
step result. A spreadsheet gets mailed around and outlives the query behind
it, so everything that qualifies a number travels in the cells rather than in
the app: the export is stamped with its date, a stale-findings caveat is
carried across, and **what-if rows land on their own sheet with the
assumption in the first column** — a hypothetical that reaches a spreadsheet
unlabelled becomes a measurement the moment someone copies it. Steps that
returned nothing are skipped rather than exported as empty sheets, which read
as "this query found nothing" and are indistinguishable from a failure. Sheet
names are de-duplicated **after** Excel's 31-character truncation, since that
is where two long, similar step goals collide and a workbook with duplicate
sheet names does not open at all.

## Asking from Slack

Questions get asked in Slack. An answer that needs another tab opened mostly
does not get looked up, so an analyst can be reached with a slash command:

```
/ask what was revenue last month
```

Set it up in **Integrations → Slack** (beside Notifications — that tab is the
outbound webhook; this one authenticates an inbound caller):

1. Create an app at `api.slack.com/apps`, pick your workspace.
2. **Slash Commands** → new command `/ask`, Request URL
   `https://<your-host>/api/slack/command` (the tab shows and copies the exact
   URL for your deployment, and warns if it is a localhost address Slack cannot
   reach).
3. **Basic Information** → copy the **Signing Secret** and your workspace id
   (starts with `T`).
4. Add both in the tab with the analyst that should answer, then install.

**Security.** The endpoint is public because Slack has to reach it, so the
signature is the whole boundary: HMAC-SHA256 over the raw body, compared
timing-safely, inside a five-minute replay window checked in both directions. A
missing header, an unparseable timestamp or an unconfigured secret are all
rejected — there is no path that accepts a request because something was
absent. Every failure returns the same terse 401; the reason goes to the server
log, not to a prober. The secret is AES-GCM encrypted, never returned to a
client, and an edit that leaves the field blank keeps the stored one rather
than clearing it.

**Slack answers are summaries.** The rows, the SQL and the lineage stay in the
app and every message links back. What does survive the trip is the part that
must: a **governed** step is still labelled governed, a capped result still
says it was capped, and a long answer names how many steps it did not show
rather than quietly ending.

**Status is not "connected".** The tab distinguishes _configured_ from
_receiving commands_, because a saved row only proves a form was filled in —
`last_command_at` is set by Slack and by nothing else. A failed run records its
error on the workspace, so a broken integration is visible in the app rather
than only to whoever happened to be in the channel.

## Theming

Every dashboard has a **Theme** (editor toolbar): upload a **background
image** — compressed client-side to ≤0.9MB and stored with the dashboard,
so the public link, embeds and PDF export need no storage bucket — with
cover/contain/tile fit and a darken slider for readability, plus a
**dashboard font** (Inter, serif, humanist, mono, rounded). Each widget's
menu has **Appearance**: an **accent colour** (recolours the chart primary
and header icon via a scoped CSS variable) and a **card style** — default,
accent tint, or glass (translucent blur, made for image backgrounds).
All AI calls also carry hard timeouts now (120s client / 100s upstream),
so a stalled model provider surfaces as a clear error instead of an
infinite spinner.

## Pivot conditional formatting

The pivot (matrix) widget supports **conditional formatting**: a
**colour scale** (min → max background intensity in your chosen hue) or
**rules** — value conditions (above / at least / below / at most /
equals / not / between) checked top-down, first match tints the cell and
colours its text. Totals stay uncoloured, and the pivot now honours the
widget's currency / percent value format too.

## Embedded analytics: one dashboard, many customers

An embed key is a **capability token**. It ships inside the host page's HTML,
so every visitor to that page holds the same one and sees the same rows — the
owner's. That is right for a public dashboard and wrong for embedding
analytics inside a product, where each customer must see only their own data.
Issuing one key per customer does not fix it: the keys are equally public, so
any customer can use any other customer's.

**Signed viewers** close that gap. On a dashboard embed (Integrations → **Web
Embedding**, the shield button on the row) you name the attributes the data is
scoped by and generate a signing secret. Your **backend** then mints a
short-lived HMAC-signed token naming the viewer and puts it in the iframe URL:

```
https://<your-host>/embed/bi/<embed-key>?vt=<payload>.<signature>
```

The dialog hands you the exact Node snippet, pre-filled with your key and
attributes. The token is `base64url(JSON claims) + "." + base64url(HMAC-SHA256)`
— the same encoding as a JWT payload, UTF-8, so `Buffer.from(json).toString("base64url")`
in Node, `base64.urlsafe_b64encode(json.encode())` in Python, and our verifier
all agree, including on non-ASCII attribute values.

The browser can read the token. It cannot forge one, and it cannot mint itself
a better one — that is the whole mechanism.

### What is enforced

- **Verification is fail-closed.** A missing, malformed, expired or forged
  token is a **403 with the reason stated**, never the owner's unfiltered view.
  So is an unreadable signing secret (e.g. after an envelope-key rotation).
- **An expiry is required**, capped at 12 hours, with 60 seconds of clock
  skew. A viewer token that never expires is a permanent grant sitting in
  someone's browser history.
- **Every named attribute must be present.** A token missing one is refused,
  naming it. Without this, a host-side typo (`tenat` for `tenant`) would build
  no filter at all — and no filter renders as everything.
- **Attributes intersect.** `{tenant: acme, region: emea}` describes one
  viewer, and a row must satisfy both. (Contrast IAM _grants_, which union:
  holding two grants must never show you less than holding one.)
- **The signature is checked before the payload is parsed**, and compared in
  constant time.
- **The embedded AI analyst reads the same scoped rows.** Scoping the charts
  and not the analyst would leak the whole dashboard in prose.

### Widgets that cannot be scoped are withheld, not blanked

An embedded dashboard renders **stored result rows** — the query already ran,
as the owner. If a widget projects the scope column, those rows can be filtered
and the number is right. If the widget aggregated it away — `SELECT month,
sum(revenue) FROM sales GROUP BY month` — the total already contains every
customer, and nothing done to those rows can recover one customer's share.

So such a widget is **withheld**, and says so in place of its chart: _"this
widget's results do not include "Region", so they cannot be limited to your
data. Add "Region" to the widget's query to show it here."_ Rendering it
unfiltered would leak; rendering it blank would read as "no data", which is a
different and untrue statement. An empty widget that **does** project the
column is left as an honest zero — that viewer has no rows.

Scoped viewers also see a one-line banner (_"Showing data for Region =
EMEA."_), because a subset presented as a total is the same wrong answer
whether policy or a bug produced it. Widget narratives are dropped from scoped
widgets: they were written about the owner's full result.

### Operating it

The secret is shown **once**, at generation, and stored encrypted under the
same envelope as provider credentials — there is no "show it again", only
rotation, which invalidates every token your backend has already issued.
Enabling and rotating are both written to the audit log. The setting exists
only on dashboard embeds, and only alongside at least one attribute; the
database refuses the other combinations, so the toggle can never be a badge
that vouches for nothing.

## Scan: the obvious questions, asked automatically

The **Scan** button reads every widget's snapshot and reports what a person
would notice — a sustained trend, a point far off the others, one member
holding most of a total. It is **computed, not generated**: no model call, no
cost, no wait, and the same answer twice. The arithmetic is the same code the
AI Analyst uses for its own trend and outlier work (`src/lib/analystSeries.ts`),
so a finding here and a finding there cannot disagree.

Three checks, each with a stated bar:

| Check         | Bar                                      | Why that bar                                                                                                                                                                                      |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trend         | slope ≥ 2% per period, ≥ 5 points        | 2%/period compounds to ~27% a year; below it, a "trend" over a dozen points is mostly noise wearing a direction. A line through three points fits perfectly and predicts nothing.                 |
| Outlier       | ≥ 3 MAD from the median                  | Median and MAD, not mean and standard deviation — the outlier inflates the very standard deviation a naive check judges it by, which is how that version misses the spike it was written to find. |
| Concentration | one member ≥ 60% of a total, ≥ 4 members | With two members one is always over half, and with three, over a third. Below four, "concentrated" describes the number of categories rather than the business.                                   |

Findings are ranked by how far each cleared **its own** threshold, shown as a
multiple (`2.6×`). That is what makes an outlier and a trend comparable at
all; it is a defensible ordering, not a claim to know which one you care
about.

### Finding nothing is not an all-clear

This is the failure a proactive feature is most prone to, because nobody
prompted it and so it is trusted more than an answer they asked for. "No
insights" reads as reassurance; what is actually known is narrower. So an
empty scan states all three parts: how many widgets were examined, how many
could **not** be and why, and the exact thresholds applied.

Widgets are skipped for reasons that are worth reading:

- **The snapshot hit its row cap.** Every check here is an aggregate — a
  slope, a share, a total — so over a capped result they would be aggregates
  of an arbitrary prefix. Refused, with the remedy named.
- **The measure has negative values.** A share is `part ÷ total`, and when the
  total nets losses against profits that fraction can exceed 1, go negative,
  or explode as the total nears zero. Concentration is refused on those;
  trend and outliers, which never divide by a total, still run.
- **Not enough history**, or **not a data widget** (text and image cards).

Examined-and-clean is counted as **swept**, not skipped — "we looked and found
nothing" and "we could not look" are different claims, and the summary keeps
them apart.

## Embedding the AI Analyst

**Integrations → Web Embedding → Embed AI Analyst** puts the analyst chat
itself on your site. Visitors type their own questions and see the analyst's
stated approach, each step's result and chart, the findings, and what to ask
next — the same reasoning loop the signed-in screen runs, not a summariser
bolted onto it.

### It runs server-side, as the owner

The analyst normally runs in the asking user's browser: their DuckDB holds the
local datasets, their session compiles governed queries and reaches the model.
An anonymous visitor has none of those. So an analyst embed runs the loop
**server-side under the analyst's owner** — the same arrangement an embedded
agent already uses — with local SQL executed by the server engine that backs
scheduled refreshes, and warehouse SQL by the stored connection.

**The analyst's data scope is the access boundary.** An analyst scoped to two
datasets can only ever read those two; one pointed at a warehouse connection
can only read that connection. Scope the analyst to what you would be
comfortable publishing, then embed it — the create dialog says so before it
gives you the snippet. Your IAM model rules and any semantic row filters and
column masks still apply, because the compile still happens under your id.

### What visitors never receive

- **The generated SQL.** The signed-in screen shows it because the reader owns
  the data and re-running it is the point; on a public page it would publish
  internal table and column names. It is stripped server-side
  (`sanitizePublicTurn`), not merely left unrendered — a field that reaches
  the browser has been published whatever the UI does with it.
- **The compiled semantic query.** Same reasoning. The governed model's _name_
  survives, because "this number came from a governed definition" is the
  reader's evidence and not a schema leak.
- **Edit-and-re-run, pin-to-dashboard, verify, what-if scenarios.** Each
  writes to your workspace or records a human verdict, and an anonymous
  visitor is neither.

### What bounds the cost

Every question is several model calls billed to you, triggered by strangers.
The controls are the ones every embed has, plus a tighter limit: **5 analyst
turns per minute per key** (against 10 for a dashboard question), the per-key
**monthly budget cap**, the domain allow-list, key expiry, and instant
deactivation. Spend is metered to the embed key, so it shows up per-embed in
Analytics rather than blended into your own usage.

### iframe or React SDK

The `/embeds` snippet dialog offers the analyst two ways: the classic iframe,
or the **React SDK** (`@agentswarms/react`, in [`sdk/react`](../sdk/react/README.md)).
`useAgentAnalyst` streams the same sanitized turns — `activeTurn` fills in
live (approach, steps, findings) and finished turns accumulate with follow-up
context carried automatically — so you can render the reasoning loop in your
own components instead of a fixed frame. Everything in this section still
holds: the SDK hits the same `/api/embed/analyst` endpoint, so the
server-side run-as-owner model, SQL stripping, rate limit and budget cap are
unchanged.

### It takes time, and it shows you why

A turn plans, writes SQL, executes, self-checks and synthesises. Measured on
the bundled HR sample: **~37–95s end to end**, depending on how many steps the
plan needs.

It **streams**. `POST /api/embed/analyst` is server-sent events: the visitor
sees a named stage ("Planning the approach…", "Writing and running the
queries…", "Checking the results…") and the trace fills in as it is produced.
Measured on the same sample: the stated approach and first step land at
**~6s**, step results at ~10–18s, the self-check at ~27s, the finding at ~48s.
A generic spinner for 48 seconds is indistinguishable from a hang; a named
stage is not.

Every streamed frame is sanitised, not just the last one — a partial turn
carries the same step SQL the finished one does.

### Not signed viewers

Per-viewer scoping (see above) turns a token's attributes into row filters
over **stored** results. An analyst writes fresh SQL for every question, so a
filter could be enforced on the governed steps and not on the raw-SQL ones —
enforcement on part of an answer is a badge that vouches for less than it
appears to. Signed viewers therefore remain dashboard-only, and the database
constraint enforces that.
