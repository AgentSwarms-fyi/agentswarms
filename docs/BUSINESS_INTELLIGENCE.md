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
- **Export PDF** — one click renders the dashboard (layout preserved) into a
  downloadable A4 PDF report, entirely client-side.
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
