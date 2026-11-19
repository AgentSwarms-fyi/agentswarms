# Business Intelligence

> Part of the [AgentSwarms docs](../README.md#documentation).

The **BI Workspace** (`/bi`) turns connected data into shareable dashboards
and reports. An editable dashboard is called a **BI project**:

- **Build visuals from fields** — pick a table and click fields into
  **Group by** and **Values**; the builder writes the aggregating query
  (sums, averages, distinct counts, date periods, filters, top N or latest
  N, calculated fields), runs it over the whole table, picks the chart and
  names it. See [Building a visual from fields](#building-a-visual-from-fields).
- **Build visuals by hand** — a right-hand builder pane: pick a source (your
  Data & SQL datasets or any connected warehouse), tick one or **more tables
  to join** (a JOIN skeleton is written for you with auto-detected join
  keys), run the read-only SQL, then pick from **38 visual types** in an
  icon picker: column, bar, **stacked column**, **stacked bar**, **bar
  race**, line, area, **combo (bars + line, dual axis)**, **scatter**,
  pie/donut, **nightingale**, **radar**, **funnel**, **sankey**,
  **treemap**, **word cloud**, **heatmap**, **box &amp; whisker**,
  **waterfall**, KPI card (latest period against the one before, a trend
  line and progress toward a target), **narrative**, **gauge**, **matrix
  (pivot) table**, **filled map**, **bubble map** (country-level, fully
  offline — no tile servers), table and **ontology**. Column, line
  and area charts support **multi-series** (split by a category column —
  grouped or stacked), and every numeric visual takes a **value format**
  (currency / percent). Widgets live on a 12-column drag-and-resize grid,
  with markdown text blocks for report narrative.
- **Saves as you go** — an edit is saved 0.7 s later, and the badge by the
  title reads Saving, Saved or Save failed. Until a save has gone through,
  closing the tab asks first, and a link saves first — asking only if that
  save fails, with the reason (R281).
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
  at the bottom). Failed questions are skipped, never faked. With a date
  in the table, headline KPIs compare periods and the plan can add
  narratives (top regions, change since last month, next month's
  forecast), each shaped from the columns the query returned (R498).

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
    your own instructions for tone, audience or emphasis. The dialog ticks every
    visual that can be exported each time it opens; what you untick then stays
    unticked until you export or close it, through a session refresh too (R218).

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
  compliance audit trail, which is hash-chained and retention-governed. A query
  you typed and never ran is in no history. So when a table in the explorer, a
  pick from Recent queries or the Catalog's ▶ replaces it, a toast offers
  **Undo** (R304).
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
  A NUL character (U+0000) cannot be stored in Postgres. Legacy exports and
  fixed-width dumps often pad with it, so it is removed from values and column
  names as each row arrives, and the result says in how many cells ("NUL
  characters removed from 1 cell"). Before R300, one NUL anywhere failed the
  whole import with "unsupported Unicode escape sequence". Every other save
  has the character removed in transit too (R301), so a title, text block or
  cell holding pasted terminal output saves with the NUL removed.
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
  never leave the server. The groups you tick stay ticked until you press
  **Save group access** or close the dialog, through a session refresh too
  (R217).
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

## Paginated reports

A dashboard is a grid you scroll and resize. A **paginated report** is the
other shape: a fixed page, a flow of blocks down it, and content that
continues onto the next page when the room runs out. It is what a month-end
pack, an invoice or a regulatory return has to be, because somebody prints it
and the page count matters.

Open **BI Workspace → Reports** (`/bi`, the Reports tab). A report opens in
its own designer at `/bi/report/:id`.

The designer does not save as it goes: blocks, page settings, header and footer
stay in the page until **Save**, and an "Unsaved changes" note says so. **← BI**,
any other link or closing the tab with something unsaved asks first — "Discard
the changes to "Month-end pack"?" — and Cancel keeps it (R278).

Save writes only over the version the designer opened. If the report was saved
from another tab or session since, Save is refused — "This report was changed in
another tab or session after this page read it" — and a banner offers **Reload**
(that version, dropping the edits here) or **Overwrite with mine** (R284).

A report that could not be loaded says so, with **Try again**. That covers a read that failed on the server
and a request that never arrived. "Report not found" means the read answered and there is no such report
(R296). Before, a failed read said "Report not found", and a failed request left the page a skeleton.

### The two halves are shared on purpose

Everything below the layout is the dashboard's. A report's chart block **is**
a `BiWidget` — the same query, the same cached rows, the same `ChartSpec` and
the same renderer — so nothing about a number changes when it moves from a
tile to a page. What is new is the geometry: page size, margins, a running
header and footer, explicit breaks, and a table that repeats its header row
every time it crosses a page.

| File                                                 | What it holds                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/lib/biReports.ts`                               | The pure model: page geometry, token substitution, `sliceTable`, `paginateBlocks`, validation. No React, no PDF.  |
| `src/lib/biReportAgent.ts`                           | The AI planner: `suggestReportOutline` on top of the dashboard generator's `describeSchema` and governed catalog. |
| `src/lib/biReportPdf.ts`                             | `buildReportPdfBytes` — vector-text PDF via pdf-lib, charts embedded as PNG.                                      |
| `src/components/bi/ReportPagePreview.tsx`            | The paged preview, driven by `paginateBlocks`.                                                                    |
| `src/components/bi/GenerateReportDialog.tsx`         | Plan → review → build, reusing `runBiTurn` and `widgetFromBiTurn`.                                                |
| `src/components/bi/AddFromDashboardDialog.tsx`       | Lift an existing dashboard widget onto a page.                                                                    |
| `src/routes/_authenticated/bi_.report.$reportId.tsx` | The designer.                                                                                                     |
| `src/utils/biReports.functions.ts`                   | Owner-scoped server functions over `bi_reports`.                                                                  |

### Blocks

| Kind        | Behaviour                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `heading`   | Level 1/2/3. Levels 1 and 2 rule off underneath.                                                             |
| `text`      | A paragraph, wrapped to the content width.                                                                   |
| `spacer`    | Vertical room in points (72pt = 1 inch).                                                                     |
| `pagebreak` | Starts the next page. Ignored when the page is still empty, so a leading break does not print a blank sheet. |
| `chart`     | A widget's chart at a set height. Rasterised at export.                                                      |
| `table`     | A widget's rows, **flowing** across pages with the header redrawn on each.                                   |

### One pagination function, two consumers

The designer's preview and the PDF renderer call the **same**
`paginateBlocks`, in the same units (points), with the same `TABLE_ROW_H` and
`TABLE_HEADER_H`. A preview that flowed differently would be a picture of a
document nobody receives. `tests/unit/biReports.test.ts` builds real PDFs with
`pdf-lib` and asserts the preview and the renderer agree on the page count for
tables of 5, 60 and 200 rows — the drift this design exists to prevent would
otherwise be invisible until somebody printed it.

`sliceTable` carries the rule: a table needs its header plus at least one row
to be worth starting, so one that cannot fit both begins on the next page
rather than stranding a header at the bottom of this one.

### Reusing a dashboard's widgets

**Add from a dashboard** in the designer lists every chart widget with saved
rows across every page of a chosen dashboard, and drops the chosen one in as a
chart block or as a table block. The `BiWidget` is carried across by reference,
not rebuilt, which is what makes the two surfaces incapable of disagreeing. A
widget with no snapshot is not offered — it would print an empty box.

### Page setup, header and footer

A4, Letter, Legal or A3; portrait or landscape; one uniform margin, clamped so
it cannot swallow the page. The header and footer each have a left, centre and
right slot accepting `{{page}}`, `{{pages}}`, `{{title}}`, `{{date}}` and
`{{time}}`. A new report opens with `Page {{page}} of {{pages}}` in the footer.

The bands are stamped in a **second pass** over the finished pages, not during
layout: `{{pages}}` is not knowable until the last block has been placed, and a
footer that says "of 3" on a four-page report is worse than no footer at all.
The date and time are fixed once per export so every page of one file agrees.

### Generating a report with AI

**Generate with AI** runs the dashboard generator's machinery with one
difference of shape. `suggestReportOutline` asks for an ordered narrative of
**sections** rather than a set of tiles, and each section declares whether its
answer belongs in a chart or in a table somebody will check a row of, plus
whether it should start a new page. Each chosen section then runs the ordinary
`runBiTurn` → `widgetFromBiTurn` path, so a generated block is
indistinguishable from one lifted off a dashboard.

The planner goes through the same IAM-gated `POST /api/bi` route as every other
BI generation and is traced as **BI Agent: Report outline** (`stage: "report"`).

A section whose query fails or returns no rows is reported with its reason and
skipped; the rest of the report is still built. If nothing could be built the
dialog stays open with the reasons rather than handing back an empty document.

### Export

**Export PDF** builds a real vector-text PDF: headings, paragraphs and table
cells are selectable text, not a screenshot. Only charts are images, rasterised
by `html2canvas-pro` from the very nodes the preview is showing (tagged
`data-chart-block`), so the exported chart is the chart you were looking at. A
chart with no rows prints a visible `[chart unavailable]` marker rather than a
silent gap.

### Parameters, fields, pictures and barcodes

R508 makes a report a document that runs for one order, one month or one
region at a time.

- **Parameters**, defined under Parameters in the designer, are stored with
  the page settings (`page.params`), so no schema change was needed.
  - Each is the dashboard parameter model (`BiParamConfig`) plus a
    report-only **Text** kind, up to 200 characters with no control
    characters. Dashboards, which viewers drive, never accept text:
    `parseParams` drops it unless called with `allowText`.
  - A value reaches SQL through `substituteParams` as a literal: text quoted
    with quotes doubled, a date as `DATE '…'`, a number as written.
  - `{{name}}` also fills text, headings, the bands and barcodes
    (`fillParamTokens`). In text a List parameter prints its label; a barcode
    encodes the value itself (`{ raw: true }`), since that is what is scanned.
  - Names the report fills itself (`page`, `pages`, `title`, `date`, `time`)
    are refused.
- **A block's own query.** Fields and Table blocks added in the designer carry
  a widget with its own SQL and source (local datasets or a warehouse), and
  every query block shows its SQL in the editor with a Run button.
  - **Run report** runs every query block with the chosen values. Each block
    records the values its rows came from (`ranWith`, saved with it), and the
    bar asks for a run while a block that reads a parameter has rows for other
    values (`blockNeedsRun`). A parameter no block reads never asks.
  - Export runs the report first when one does, so a PDF never prints one
    order's lines under another's number.
  - A table a value leaves empty prints `[no rows: name]` in the preview and
    the PDF alike, at the height the paginator gave it.
- **Fields** print the first row of a query as label and value pairs, one to
  three across.
  - Labels are the column names tidied, unless the author writes their own.
  - Several rows print the first with "The first of N rows"; no row says so.
- **Pictures** are a PNG, JPEG or SVG kept in the report as a data URL (up to
  about 1 MB), or an https address fetched at export. One the browser cannot
  fetch prints `[picture unavailable]`. An SVG (R510) is drawn as vectors by
  `svgPdf` (`svgPicture` in `src/lib/biReportImages.ts` reads its size from
  width and height, else its viewBox); its scripts, links and embedded
  pictures are never followed. One with no size to place it at is left out.
- **Barcodes** are drawn as shapes (`src/lib/biBarcode.ts`, `barcodeShapes`),
  the same rectangles in the SVG preview and the PDF.
  - Code 128 is encoded in-house: set B, with set C for digit runs of four or
    more. Its pattern table is checked by tests (11 modules each, an even bar
    width) and its bars decode back to the symbols.
  - QR uses `qrcode-generator` (MIT), with UTF-8 bytes and error correction
    M.
  - A value the format cannot hold prints the reason.

Fields, pictures and barcodes have fixed heights (`blockHeight`) that both the
preview's `paginateBlocks` and the PDF reserve, and a test pins their page
counts together.

### Scheduled delivery

R509 sends a report by itself. **Schedule** in the designer opens the
report's schedules (`bi_report_schedules`, migration `20261118000000`). Each
schedule names when it runs, who gets it and the parameter values it runs
with. The server runs the report and mails the PDF as an attachment.

- **When.** Daily, on weekdays, weekly on a weekday, or monthly on day 1-28
  or the last day, at an hour in an IANA time zone. `nextReportRun`
  (`src/lib/biReportSchedule.ts`) works the next run out in that zone every
  time, so the local hour survives a clock change. An hour that does not
  exist on the morning the clocks go forward runs at the first hour that does.
- **Values.** A date parameter can hold a relative date (`@prev_month_start`,
  `@prev_week_end`, `@today` and so on, `RELATIVE_DATES`), resolved on the day
  it runs in the schedule's zone by `scheduledValues`. A stored value the
  report no longer accepts runs at the parameter's default, and the delivery
  record names it.
- **The run's clock.** `runClock` gives the day and time in the schedule's
  zone (`2026-11-18`, `08:00`). The subject's `{{date}}`, the attachment's
  file name and the PDF's `{{date}}` and `{{time}}` all print it
  (`buildReportPdfBytes` takes it as `clock`). The server's own locale and
  zone never reach the page: a 06:00 Tokyo run is still the day before in
  UTC.
- **One path.** The tick, **Send now**, **Send to me** and **Preview PDF** all
  call `runReport` (`src/utils/bi/reportSchedule.server.ts`). It re-runs every
  query block as the report's owner (`localSqlRunnerForUser`; warehouse
  connections loaded by the owner's id) and lays the PDF out with
  `buildReportPdfBytes`. A block whose query fails prints as empty and is named
  in the email and the delivery record. It never prints the rows from its last
  run.
- **Charts without a browser.** `renderVisualMarkup`
  (`src/utils/bi/reportCharts.server.tsx`) renders the same `BiChartRender`
  with `react-dom/server`. The BI charts take their `ResponsiveContainer` from
  `src/components/bi/biChartBox.tsx`, which starts at a fixed size under
  `FixedChartSize` and otherwise measures as before.
  - `src/lib/svgPdf.ts` draws the SVG into the PDF as vectors: paths, shapes,
    text, transforms, opacity, gradients as their mean colour, and theme
    tokens resolved to the light palette (`PRINT_TOKENS`, which a test holds
    to `src/styles.css`).
  - Path data has its whitespace collapsed before pdf-lib reads it. pdf-lib
    splits only on spaces and commas, so a line break inside Recharts' sector
    arcs read as an extra `0` and drew pies as huge wedges off the chart.
  - With nothing to measure text with, Recharts keeps every axis tick on the
    server. `crowdedTicks` thins them as the browser would: the first and
    last label stay, and a label in between stays when it clears the last
    one kept, measured with the PDF font.
  - Legends are HTML in the markup. They are read out (`readLegend`), the
    chart is rendered again at the size left once a strip is reserved for
    them, and the legend is drawn in the strip.
  - `SCHEDULED_DRAW` lists what is drawn. 24 types draw as SVG, KPIs come
    from `kpiFigures` (the tile reads the same function), the heatmap and the
    pivot are drawn as grids, and narratives as text. Anything not listed (now
    only the ontology map) prints a note where it would be, and the dialog
    names it before anyone schedules.
  - **Laid out for paper (R511).** Cards, range, word cloud, pictogram, small
    multiples, bar race and point map are HTML or animated on screen, so their
    server render had no one chart SVG to draw. `renderVisualMarkup` sends
    them to `components/bi/biPrintVisuals.ts`, which lays each out as one
    SVG (`data-print="1"`) from the same data helpers the cards use (moved
    into `biDrawHelpers`: `wordCloudTerms`, `raceFrames`, `rangeItems`,
    `pictogramData`, `smallMultipleGroups`, `mapPoints`), with text
    measured in the PDF's Helvetica. The word cloud is set in centred lines
    and shrunk together until it fits; a bar race prints its last frame with a
    caption; the pictogram's part picture is clipped, and so is a point map's
    ground: tiles overhang the map, which a browser hides at the svg's edge
    and a PDF does not.
  - A grid (the heatmap, the pivot, a data table) never cuts a number to fit
    its column (R511): "1.5" cut to "1." prints another value. Numbers that
    do not fit are set smaller, one size for the whole table, down to 4.5pt;
    one that still does not fit is left to its cell's colour, as a dense
    heatmap is on screen. Words end in "…".
  - `svgPdf` gained `<image>` (pictures are resolved and embedded by
    `drawServerVisual` first, since drawing is synchronous; an SVG picture is
    drawn as vectors) and one-rectangle `clip-path`, honoured only in a
    `data-print` drawing so the chart library's own clips stay undrawn.
  - Card pictures and a point map's street tiles are fetched by the server
    through `fetchPicture` (SSRF guard, 1 MB cap, a User-Agent naming the
    app), at most 24 per visual, tiles one at a time, and inlined as data
    URLs. Tiles are asked for only when `PUBLIC_MAP_TILES_URL` is set, and the
    credit is printed; a picture that will not load is left out.
  - `tests/unit/biReportServerPdf.test.ts` renders every catalogue visual on
    the server and holds `SCHEDULED_DRAW` to what came back.
- **Who receives it.** Recipients must be accounts on the install
  (`report_recipient_accounts`, service role only) or in a domain listed in
  `REPORT_EMAIL_DOMAINS` (`client.com`, `.client.com` with subdomains, `*`
  for any). This is checked on save and again on every send. The table has an
  owner `SELECT` policy and no write policy: every write goes through
  `biReportSchedules.functions.ts`, because RLS cannot see an environment
  policy. Changes to recipients, timing and values are audited
  (`audit_row_change('bi_report_schedule')`).
- **Sending.** One message per recipient, with Reply-To set to the owner.
  The mailer (`src/lib/email/mailer.server.ts`) gained attachments and
  Reply-To for both SMTP and Resend. The subject is one line, with control
  characters removed. A PDF over 10 MB is not sent.
- **Clock.** `processDueReportSchedules` runs in the scheduler pass
  (`report-schedules` step, at most 5 a pass). It claims each schedule by
  moving `next_run_at` only if nobody moved it first, so overlapping passes
  cannot send twice, and a failed run still advances. Every run writes an
  insert-only row to `bi_report_deliveries` (sent, partial, skipped or
  failed). These rows are purged after a year.

#### Dashboards on a schedule (R510)

Migration `20261119000000` lets a schedule name a dashboard instead of a
report (`dashboard_id`, exactly one of the two, and `pages`, the page ids to
send; empty is every page). The dashboard editor opens the same dialog from
Export, then Email on a schedule, for the owner only.

- **Run.** `runDashboard` (`src/utils/bi/dashboardSchedule.server.ts`) runs
  each chosen page's widgets through `runDashboardWidgets`, the scheduled
  refresh's own runner (`src/utils/bi/refresh.server.ts`), as the owner, at
  the schedule's parameter values, in full, on copies. Nothing is written
  back: a copy run for one schedule's values is not the snapshot viewers see.
  A widget whose query fails is printed as "Not refreshed" in its card.
- **Layout.** `buildDashboardPdfBytes` (`src/lib/biDashboardPdf.ts`) prints
  each page on A4 landscape sheets. The grid keeps its proportions
  (`GRID_ROW_PX` and `GRID_GAP_PX`, shared with the editor's grid, on a
  1,200 px canvas). `paginateGrid` breaks a sheet only at a row no card
  crosses, and chooses the breaks for the fewest sheets, then the least
  shrinking: a sheet may shrink its rows to `MIN_SHEET_SCALE` (80%) of their
  height rather than leave a sheet nearly blank (found in the UI test: a page
  of two picture rows over ten rows of charts printed as a strip and a sheet).
  A band with no clean break within a sheet is shrunk onto one. Cards draw
  through `drawServerVisual` like a report's charts, at the shrunk size. A
  data table is the card's own `WidgetDataTable` (now
  `src/components/bi/BiDataTable.tsx`), rendered on the server and drawn as a
  grid that keeps its header and total. Text widgets are set from their
  markdown (`markdownBlocks`); a styled one breaks lines where they were typed
  and takes its sizes from the card's (`TEXT_BASE_PX`, `TEXT_HEADING_SCALE`),
  centred down the card. Pictures are fetched through the SSRF guard, an SVG
  drawn as vectors; a Controls visual prints the values the copy ran with; a
  chart's zoom slider is left off (`renderVisualMarkup` turns `zoomBar` off).
- **White paper.** The PDF is white whatever the dashboard's background. A
  widget colour (text, heading or title) that would not read on white, under
  3:1 contrast, prints in ink (`paperColour`): white text set for a dark
  canvas vanished in the UI test.
- **Every page, everywhere.** A dashboard's content is `pages`; the top-level
  `widgets` only mirrors page 1. The scheduled refresh read the mirror alone,
  so widgets on later pages were never refreshed and their alerts never ran.
  It now walks every page (`dashboardWidgetDoc`) and writes `pages` with the
  page-1 mirror (`refreshedDocument`). Catalog lineage, the impact checks
  before a dataset or semantic model is deleted, and a metric's usage had the
  same blind spot; they read every page through `allDashboardWidgets`
  (`tests/unit/biDashboardEveryPage.test.ts`).

### Access

A report is **owner-only**. `bi_reports` carries RLS on `auth.uid() = user_id`
and every server function re-resolves the caller and scopes by `user_id`.
There is deliberately no `has_resource_access('bi_report', …)` policy: the
`iam_resource_grants.resource_type` CHECK does not admit `'bi_report'`, so such
a policy would be dead code that reads like a working share. Send the exported
PDF instead. Name, page setup and band changes are written to the audit log via
`audit_row_change('bi_report')`.

## AI Analyst — your analytical partner

**AI Analyst** (`/ai-analyst`, under Data &amp; BI) is the dedicated
conversational-analysis surface — the Spotter/conversational-BI equivalent,
built on this stack's own discipline: every answer shows its work.

An **analyst** is three choices and nothing else: a **reasoning model**
(picked from your connected providers — the dialog suggests reasoning
families like o3, GPT-5, Claude Opus, DeepSeek-R1, Gemini 2.5 Pro, and nudges
you if the pick doesn't look like one), **the data** it is scoped to (all
local datasets &amp; uploads, one dataset, or one warehouse connection), and
the **predictive models** it may score or forecast with — any trained model
it can use, or exactly the ones you tick. It chooses among them by the
question, and a model outside the list is refused even when a plan names it:
the same allow-list rule as an agent's ML tool, enforced when a step scores,
not only in what the planner is shown. Create as many analysts as you have
jobs for them.

**One question runs at a time.** Ask, Enter and a starter chip share one
in-flight guard. It is set the moment a question is asked, before the analyst
fetches a warehouse schema, so a quick second Enter neither runs the analysis
again nor saves a second thread (R216).

All three choices stay **editable** — the pencil on an analyst's card reopens the
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

**Scored steps predict; the analyst never estimates.** When a question asks
what _will_ happen, which rows are _likely_ something, or for a predicted
value, and a trained model from **ML Models** is in scope, the plan may add
`"score": { "model": "<name>" }` to a step. The step's SQL selects the
entities — the model's key column(s) when it is bound to a feature view, so
the features are read from the view, or its feature columns otherwise — and
the model supplies the prediction columns, joined onto the step's rows (at
most fifty, the same cap the agent tool has). The step carries a **scored**
badge naming the model, and under its table says how many rows were scored,
the model's version and headline metric, where the features came from and
which keys were not found. Every name is checked against the models the
analyst actually loaded; a step naming anything else simply is not scored. A
scoring that fails leaves the rows unscored and says so in the self-check
note — the analyst does not fill a prediction in itself. The write-up is told
which steps were scored and must report predictions as what the model
estimates, naming it, never as something observed. A step whose SQL the
self-check corrects is scored again on the corrected rows, and its note says
so; a step re-run by hand loses its predictions along with the badge — they
belonged to the old rows — until the question is asked again. A prediction
column that collides with one the SQL already returned is kept under a
`predicted_` prefix, so the model's numbers are the ones on the table the
badge vouches for. The SQL writer is told, in the step's own goal, that the
rows will be scored afterwards and what they must carry — the model's key
column(s) from the source table, at most fifty rows, no stored predictions
table and no prediction of its own. And a write-up that comes back as data
rather than prose (an object of rows under `answer`, with `caveats`) is
rendered as a table with its caveats, not reported as "no write-up". The
self-check is told which columns the model added and that they exist in no
table — it judges the SQL by the rows it was asked to return, and a
correction it writes never selects the model's columns (live, one did, and
died on a binder error); and the contribution and trend arithmetic the check
and the write-up are handed reads only the observed columns, never the
estimates (live, a table of `order_id`, `prediction`, `probability` was read
as a two-period breakdown by prediction, and the write-up listed the
resulting "total change" as a caveat beside the real one). The
model's **health** rides along: the planner sees each scorable model's latest
drift reading or evaluation verdict, and a scored step's badge and disclosure
say it — "open drift alert (PSI 3.291 on 2026-09-14)" — so the write-up can
warn beside the numbers it cites.

**Forecasts, rankings and what a model can say.** A trained **forecast**
model in scope is offered to the planner as a forecast step (`"forecast":
{ "model": "<name>", "horizon": N }`): no SQL — the step's rows are the
model's projected periods with their interval, the badge says **forecast
by**, and the write-up is told the rows are a projection. A regression
model is never a forecast: the planner is told so, and the write-up is told
a scored regression step gives one estimate per row and is not a series.
The **most, least or top-N by a model's output** — most anomalous, most
likely enterprise, highest predicted value — is decided by the platform on
the scored rows (`"rank": { "by": "<output column>", "desc": true,
"limit": N }` inside `score`), never in SQL, where the column does not
exist; the disclosure says "ranked by anomaly_score (highest first), top 10
of the 50 scored". A step whose goal names a model in scope is scored by it
even when the planner forgot the block, because naming the model is the
request. The tool's **model notes** — what each class means, each group's
size and typical row, the trainer's warnings — travel with the scored step
(a collapsible under the disclosure) and into the write-up, so it can
describe a group rather than say it was not told. And the analyst refuses
rather than improvises: a question naming a model nobody has ("the churn
model") stops and asks, naming the models that exist, instead of scoring
with another; rows missing most of a model's feature columns are not
scored, and the missing ones are named; a self-review correction that reads
a model's column is refused in code and the original result stands; a
correction that fails says so, and the write-up is told the step did not
fail. A scored step's rows are quoted to the write-up in full (up to the
fifty the model scored) — summarised, fifteen scored orders became
"order_id total=22104" and a findings table built from it — and an
identifier column is never totalled in the facts at all.

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
can be granted to IAM groups (the groups you tick hold until you save, through
a session refresh too); recipients open it and ask their own questions,
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
does not get looked up, so an analyst can be reached with a slash command.
The same door takes agents: a workspace routes each command to its own agent
or analyst, and answers @mentions in thread — see
[Answering in Slack](./AGENT_CHAT.md#answering-in-slack). For the analyst:

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
All AI calls also carry deadlines, so a stalled model provider surfaces as a
clear error instead of an infinite spinner. They are computed per call rather
than fixed: 60 s upstream for a chat model, 150 s for a reasoning one, plus
time proportional to the completion budget, capped at 300 s — with the client
always given 30 s more than the upstream deadline so the server gives up
first.

## Dashboards that look like their subject

R500 adds what a designed dashboard needs, such as a race result on black with
the winner's name in large type. The **Grand Prix Results · Sample** dashboard
uses all of it. Everything is saved with the dashboard and looks the same in
the editor, on a shared view, a public link, an embed and a PDF.

**The canvas** (Theme in the toolbar):

- **Canvas: Always dark** keeps the dashboard and its widgets dark for every
  viewer, whatever their app is set to. **Follow the app** is the default.
- **Canvas colour**: Black, White, Racing red, Gold, Grey, Charcoal or any
  colour from the picker.
- **Pattern**: Grid, Fine grid or Diagonal, faint lines in a chosen colour
  tiled behind the widgets. A pattern and a background image replace each
  other.

**A widget** (Appearance in its menu):

- **Accent colour**: eight presets, six swatches or any colour.
- **Card style**: Default, Accent tint, Glass, or **No card — sits on the
  canvas**, which drops the frame. The frame shows faintly on hover, so the
  widget can still be found and moved.
- **Hide the title**, **Title size** S/M/L/XL and **Title colour**.

Editing a widget keeps its appearance and its Import/Direct mode. Before R500
the editor rebuilt the widget from the fields it shows, and saving an edit
reset both.

**Text blocks** take a size (Small to Headline), alignment, text and heading
colours and italic. A line break typed is a line break shown:

```text
# Brazilian Grand Prix
*8 November 2026 · Round 20 of 23*
```

That block is set at Display size, centred, white, with Racing red headings,
in italic, with no card and its title hidden.

**Cards** (`cards`) draw one card per row from templates over the row's
columns:

| Write                 | Gets                                        |
| --------------------- | ------------------------------------------- |
| `{{column}}`          | the value, in the visual's number format    |
| `{{column\|ordinal}}` | a whole number as 1st, 2nd, 3rd, 11th, 22nd |
| `**bold**`            | bold text                                   |

Values are always text, never markup. **Side by side (a podium)** shows a
heading, picture, title and lines; **One row each (a list)** shows a number,
picture, title, lines and a value at the end. **Picture** takes an image
address or data URI; **Small pictures** adds more, such as a flag. A list
sizes itself to its card: below 24rem it drops the small pictures and steps
the text down.

**Rank, range and radial visuals:**

- **Rank over time** (`bump`): a line per series with rank 1 at the top, named
  at both ends. The chart holds a rank until it changes, so the query needs
  only the rows where a rank changes. In the sample, 1,435 lap rows become 343,
  which fits under the 500-row snapshot cap, and the chart is unchanged.
  `xBands` shades spans such as pit-stop laps.
- **Start → finish** (`range`): a bar from start to end per row, green where it
  improved, red where it got worse and a dot where it held. Lower is better
  unless `higherIsBetter`.
- **Radial bars** (`radialbar`): concentric arcs, the largest outermost and
  sweeping three quarters of a turn, so the names fit in the clear quarter.

**Colours and labels:**

- **Colour from column** (line, rank, radial) takes each series' colour from a
  `#rrggbb` column, such as a team colour. Other values are ignored.
- **Name each line at its end** prints each line's name and last value, spaced
  apart where lines finish close together.
- Table rules gain **Gold, Silver and Bronze**.
- Table columns gain text before and after the value (`390 pts`). Such a cell
  stays on one line.
- Tables gain **Shade alternate rows**.
- Heatmaps gain **Green below zero, red above** (`scale: "diverging"`), for a
  value against a baseline where less is better.

**Fitting under the 500-row cap:**

- A rank chart needs only the rank-change rows.
- A heatmap over time can group the time axis into blocks: three-lap blocks
  give 487 cells for 22 drivers over 71 laps.
- A running total is one row per series per step: 200 rows for 10 drivers
  over 20 rounds.

**The sample's queries.** The rank chart:

```sql
WITH p AS (
  SELECT 0 AS lap, code, grid AS position, team_color FROM gp_race_results
  UNION ALL
  SELECT lap, code, position, team_color FROM gp_race_laps
), k AS (
  SELECT *, LAG(position) OVER (PARTITION BY code ORDER BY lap) AS prev,
    LEAD(position) OVER (PARTITION BY code ORDER BY lap) AS nxt
  FROM p
)
SELECT lap, code, position, team_color
FROM k
WHERE prev IS NULL OR nxt IS NULL OR position <> prev
ORDER BY lap, position
```

The points race fills every round for every driver, so a driver who missed
races keeps an unbroken line:

```sql
SELECT r.round, d.family_name, d.team_color, SUM(p.points) AS total_points
FROM (SELECT DISTINCT round FROM gp_season_points) r
CROSS JOIN gp_driver_standings d
JOIN gp_season_points p ON p.code = d.code AND p.round <= r.round
WHERE d.position <= 10
GROUP BY r.round, d.family_name, d.team_color
ORDER BY r.round, total_points DESC
```

The `gp_*` tables come from the Jolpica F1 API (CC BY-NC-SA 4.0, free for
non-commercial use). Rebuild them for any race with
`node scripts/buildGrandPrixSample.mjs [season] [round]`. Badges and flags are
drawn shapes, not photographs or logos. The sample ships in migration
`20261117000000`.

**Suggested narratives** now leave out ranks, rounds and ids as the measure
and pictures, links and colours as the label, and use the visual's own measure
and category first. Before, a standings table offered "the top 3 given names
by position" with percentages of summed positions. A query that returns a
running total still gets a sum of that total, because nothing marks a column
as cumulative. Write the narrative from the per-round figures instead.

## Parameters, point maps and pins on a road

R501 adds what a dashboard over detailed data needs when the viewer should
steer it: a value people pick that the query itself reads.

**Parameters.** A filter narrows a widget's rows after its query, by a column
the result still has. A station map grouped by station has no date left to
narrow, so the date has to go into the query before it groups.

- **Define it.** Add parameter (filter bar) takes:
  - a name for SQL;
  - a label;
  - how it is picked: a radio list, a dropdown or a date;
  - the choices, as `value | label` lines;
  - a default;
  - whether it shows in the filter bar or only in a **Controls** visual.
- **Use it.** The widget's SQL says `{{name}}`, bare:

  ```sql
  WHERE ride_date BETWEEN {{date_from}} AND {{date_to}}
    AND ({{rider}} = 'all' OR rider_type = {{rider}})
  ```

- **Values are literals.** A choice goes in as a quoted literal and a date as
  `DATE '2026-03-01'`. A value that is not one of the owner's choices, or not a
  real date, is replaced by the default before the query is built, so a
  parameter cannot carry SQL.
- **Defaults run everywhere else.** Refreshes, schedules, alerts and the
  builder's Run use the defaults.
- **Who sees changes.**
  - The owner's picks re-run every widget that reads the parameter.
  - People the dashboard is shared with see their picks re-run through
    Direct-query widgets, which the server runs as the owner with the picked
    values.
  - A viewer whose access masks columns gets the defaults, because the server
    cannot tell which columns the SQL compares a parameter with.
  - A public link or embed shows the saved snapshot.
- **Where they live.** Parameters are saved in the dashboard's filter list, so
  they travel with copies, versions and promotion. Releases before R501 ignore
  them.

**New visuals (34 in all):**

- **Point map** (`pointmap`): rows at `latField` and `lngField`.
  - Coloured by a category, or by a `#rrggbb` column, and sized by a measure.
  - Name on hover, zoom and pan: double-click or Ctrl + scroll to zoom, drag to
    move, and a button to fit every point.
  - Streets are drawn only when the deployment names a tile server with
    `PUBLIC_MAP_TILES_URL` (a `{z}/{x}/{y}` template) and
    `PUBLIC_MAP_TILES_ATTRIBUTION`.
  - Otherwise the browser asks no third party for anything, and the
    dashboard's owner sees _No street map: how to add one_ in the map's corner
    (R504; shared links and embeds show nothing). Each tile request tells the
    tile server which area a viewer looks at, and the site's address as its
    Referer, never the page's path.
  - The OpenStreetMap Foundation's server suits light use with its credit
    shown, and blocks heavy use without notice. With many viewers, run your own
    or use a tile provider.
- **Pins on a road** (`journey`): one pin per row along a winding road, in the
  query's row order, each pin holding its value.
- **Controls** (`controls`): the dashboard's parameters on the canvas, under a
  line of Markdown. It runs no query.

**Also new:**

- **Figures in a sentence** is a narrative kind that offers every numeric
  column's total by name (`{{rides}}`, `{{electric}}`), plus `{{rows}}`.
- Any narrative can set its figures in a colour of its own and leave out the
  lightbulb.
- **Value format → Whole** gives `25,207,936` for a plain number. Before, a
  plain number could only be compact (`25.2M`).
- **Handwritten** joins the dashboard fonts, using handwriting fonts viewers'
  systems already have.

**The bike-share walkthrough.** It is built on the lakehouse:

1. `node scripts/buildBikeShareSample.mjs` writes two CSVs: `bike_stations`
   (480 rows) and `bike_station_days` (350,400 rows). They hold generated rides
   of a made-up system over New York's geography, and every run writes the same
   rows.
2. Upload both in Data & SQL, then Lakehouse → Import dataset into a schema of
   your own (`bikeshare` here).
3. Build the dashboard on the built-in Lakehouse connection:
   - pins for rides per weekday (`ORDER BY dayofweek(ride_date)`, Sunday first);
   - a point map of stations coloured by area and sized by rides;
   - a figures sentence;
   - Controls for `rider`, `location`, `date_from` and `date_to`.

With every rider and the whole year, the sentence reads "About 25,207,936 rides
… 16,105,496 of them on electric bikes and 9,102,440 on classic bikes".
Picking Member makes it 19,915,795.

**Also fixed:** a Direct-query widget on any page but the first answered
"Widget not found". The server looked only at the first page's list of widgets.

## Clicks that open a page, and titles that follow the picks

R503 lets a dashboard move with its reader.

**Click actions.** A click on a bar, a slice, a point on a map or a text cell
in a table filters the page it is on. **Click action…** in a widget's menu
changes that:

- **Open another page, filtered to it.** The page you pick opens with its
  widgets narrowed to the clicked value, for example a station's own page from
  a Pareto of every station. The filter shows in the filter bar and clears
  there. If that page is later deleted, the click filters its own page again.
- **Open a link.** `{{value}}` in the link becomes the clicked value,
  URL-encoded, and the link opens in a new tab. Only an `https://` or `http://`
  address is opened, so a template cannot run script.

A detail page narrows each widget's rows by the clicked column. An Import
widget does that in the browser, on its saved snapshot of at most 500 rows
(`PUBLIC_BI_SNAPSHOT_ROWS_CAP`). A widget with a row per station per day has far
more, so set it to **Direct query**: the server then narrows the query itself,
before the cap. While that query runs, the widget is dimmed and says
"Updating…". Until its first answer arrives, it shows its snapshot narrowed in
the browser.

The server runs a Direct-query widget as `SELECT … FROM (<its SQL>)` with the
filters around it. It repeats the widget's `ORDER BY` on the outside when that
names returned columns or their positions (`ORDER BY ride_date`,
`ORDER BY 2 DESC`). Before R503 it did not, and a station's daily line on a
detail page came back with its days in hash order. An order on an expression,
such as `ORDER BY dayofweek(ride_date)`, cannot be repeated and can be lost, so
return the expression as a column and order by that.

**Titles and text that follow the picks.** In a widget title or a text widget:

- `{{rider}}` shows the parameter's picked value, as its label.
- `{{selected}}` shows what the page is filtered to by a click.
- `{{selected|every station}}` shows these words when nothing is.

A name that is neither stays as written. A value filled into a text widget is
escaped, so it cannot set formatting or add a link. A slide deck takes titles as
they read on screen. E-mailed digests, the "what changed" note and alerts read
them at the parameters' defaults; the saved titles keep their `{{…}}`.

**Page links.** `[Back to the overview](#page=Overview)` in a text widget, or
`#page=Overview` as an image's link, goes to that page. It takes a page's name
(`%20` for a space) or its number, counting from 1.

**Number parameters.** A parameter can be a **number box** or a **slider**,
with a lowest and highest value and a step. It goes into SQL as a bare number,
so `ORDER BY rides DESC LIMIT {{top_n}}` makes a Top N chart. A value must be
written as plain digits and sit on the steps; anything else becomes the
default. A negative number goes in brackets, `(-5)`, because after a minus
sign a bare `-5` would make `--`, which starts a SQL comment. A number box
applies on Enter or when the reader leaves it, and a slider when it is let go.

Shared links and embeds follow click actions and page links too, with the
parameters at their defaults.

## Pareto, calendars, small multiples and pictograms

R502 adds four visuals (38 in all) and three options for lines and columns.

- **Pareto** (`pareto`): bars largest first, the running share of the total
  on a second axis from 0 to 100%, and a line at 80%.
  - A sentence above it says how many rows make up 80%.
  - At most 40 bars are drawn, but the share and the sentence count every row.
    On the bike-share sample, stations by rides read "216 of 458 make up 80%
    of the total. The largest 40 are drawn."
  - Negative values are left out, since a share of a total cannot be negative.
- **Calendar** (`calendar`): one square per day, a column per week (Sunday
  first), shaded by the day's total.
  - Rows on the same day are added together.
  - Days with no row are drawn empty, not as zero.
  - The latest 400 days are drawn.
- **Small multiples** (`smallmultiples`): the same small line or column chart
  once per value of a split field.
  - Every panel uses the same value scale, so the panels compare by eye.
  - Panels are ordered by their total, largest first, and at most 12 are drawn.
- **Pictogram** (`pictogram`): a row of pictures per category (a person, a
  bike, a car, a house, a coin or a box).
  - Each picture is worth a set unit. With no unit set, a round one (1, 2, 5
    or 10 times a power of ten) is picked so the largest row needs about 20.
  - The last picture is cut to the remainder.
  - On the sample, riders by type with bikes give "Each picture is 1.00M":
    members 19.92M, casual riders 5.29M.

**Line and column options**, under the visual's options in the builder:

- **Moving average over** _N_ points (2–365) draws the average of the last _N_
  points beside the line. Like the trend and forecast, it applies to a line
  with one series. It starts once _N_ points are in, and a missing point is
  skipped rather than counted as zero.
- **Log scale** makes the value axis logarithmic, so an area in the hundreds
  of thousands and one in the millions both read. A log axis cannot show zero
  or a negative number, so those points are left out.
- **Zoom bar** puts a slider under the chart. Dragging its ends shows part of
  the range; the data is not fetched again.

## 100% stacks, legends, notes and coloured treemaps

R505 adds four options, under the visual's options in the builder.

- **Show as 100%** (`percentStack`) on a stacked column or bar, a column chart
  split by a series and stacked, or an area with more than one part.
  - Every column reaches the top, and each part is its share of that column.
  - The axis reads 0% to 100%. The tooltip gives the share and the value, such
    as `62% (4,180)`.
  - A part below zero is not drawn; a column with nothing in it is empty.
- **Legend** (`legend`): below the chart (the default), above it, to the
  right, or hidden. On the right it takes at most a third of the width and
  scrolls past that. Column, bar, line, area, pie, combo and radar charts take
  it.
- **Notes on the chart** (`annotations`): up to ten, each an x value and up to
  80 characters of text, on column, line and area charts.
  - A note sits above the highest mark at its x, or the top of the stack.
  - Notes side by side take separate rows; a note near an edge reads inwards.
  - The x is typed as the axis shows it (`2026-07` on a monthly line). A note
    whose x is not on the chart is not drawn.
- **Colour tiles by** (`colorMeasure`) on a treemap: a second measure colours
  each tile.
  - **Low to high** runs from pale to deep; **Split at zero** is green on one
    side and red on the other, with **Below zero is good** for a delay.
  - A key under the treemap gives the measure's lowest and highest values.
  - Without a measure, a `#rrggbb` column (**Colour from column**) colours
    each tile.

## Combos, US state maps and pivots with several measures

R506 finishes the chart types that took one measure or one kind of place.

- **A combo with several measures** (`extraMeasures`, `extraLines`,
  `stackBars`, `lineAxis`).
  - **More values** adds measures. Each is drawn as bars until **Draw each
    value as** makes it a line.
  - **Stack the bars** stacks them. **Lines use the bars' axis** puts the
    lines on the left-hand axis, for measures in the same units, and drops
    the right-hand one.
  - In Fields mode the first value is the bars, the second the line, and each
    further value joins the bars.
- **A map of US states** (`region`) on a filled map or a bubble map.
  - A state can be a name (`New York`), a postal code (`NY`), an ISO code
    (`US-NY`) or a FIPS code (`36`). The 50 states and DC are drawn, with
    Alaska and Hawaii inset. A territory has no shape and is counted as not
    matched.
  - **Map of** picks countries or states. Left automatic, the map draws states
    when at least 80% of the distinct values are states and more of them are
    states than countries, or, on a tie, when the column's name contains
    "state".
  - Postal codes are also country codes. In the claims sample, 7 of the 12
    state codes are countries, so on the world map its claims landed in
    Azerbaijan, Gabon and Israel, and 62 of its 150 claims matched nothing.
  - The shapes are the US Census Bureau's (us-atlas), bundled and loaded on
    first use; no tile server.
- **A pivot with several measures** (`extraMeasures`, `columnFormats`).
  - Each column heading spans one column per measure, named in a second
    header row, and Total does the same.
  - **Value formats** gives each measure a title, a number format, colours and
    icons. A measure without colours of its own takes the pivot's
    conditional formatting, scaled over its own cells.
  - Totals: sums and counts add; `min_` and `max_` measures total as the
    lowest and highest; averages, rates, percentages and distinct counts get
    no total (an empty cell that says why). This applies to one-measure
    pivots too, which used to add up averages.

## Every visual for the AI

R507 lets the AI choose any visual the builder offers. Four things ask a
model for a chart, and all four now choose from one list
(`src/lib/biChartCatalog.ts`):

- **Generate Entire Dashboard**, from a table or a governed model;
- the **AI Analyst**, one chart per step, including scheduled and embedded
  analysts;
- **Visual BI in chat**;
- the chat of an **embedded agent** with Visual BI on.

Until R507 the chart step's list stopped at the word cloud. So nothing
generated could be a pareto, a calendar, small multiples, a pictogram, radial
bars, start → finish, rank over time, a point map, pins on a road, cards or a
map, and an embed could draw six types in all.

- **The list.** Every visual in the picker except Controls and Ontology, with
  the fields each takes and when it fits, and the options that go with them
  (`percentStack`, `movingAverage`, `zoomBar`, `logScale`, `endLabels`,
  `colorMeasure`, `legend`, `extraMeasures`, combo lines, KPI periods). A
  test fails when the picker gains a visual that is in neither the list nor
  the excluded set.
- **The planner** is told the result each visual needs and phrases its
  question to match.
  - A calendar asks for the measure per day.
  - Small multiples ask for the measure for each value of a second category.
  - A combo names two or more measures.
  - Rank over time asks for each item's rank.
  - A point map is proposed only with latitude and longitude columns, and a
    map only with countries or US states.
- **What comes back is read before it is drawn.**
  - A model's word for a visual maps onto the one that draws it: "donut" is a
    pie, "choropleth" a map, "pivot table" a matrix.
  - A setting with a value no chart reads is dropped.
  - A type no chart draws becomes a line over a date or bars by a category.
- **The planner's visual is kept.** When the chart step draws something else
  and the returned columns can carry the plan, the dashboard builds the
  planned visual.
- **The user's visual is kept (R511).** A chat request for several visuals is
  split into one question per visual, and an analyst question into steps;
  both rewordings dropped the visual each part named, so "as a treemap", "as a
  funnel" and "as a pivot table" all came back as bar charts.
  `requestedChartTypes` (`biChartCatalog`) reads the visuals a request
  names, in order ("as a …", or "a heatmap of …"; words such as "number" or
  "list" count only after "as"). Each chat question and each analyst step is
  given its own as the chart step's `preferChart` when there is one per part,
  and the chat splitter is told to keep the wording.
- **A category and a measure the wrong way round are swapped back (R511).**
  For a chart of one category and one measure, numbers in the category and
  labels in the measure cannot be drawn: "the top 10 customers as horizontal
  bars" put the sales on the axis and drew no bars. `reconcileChartFields`
  swaps them.
- **A KPI is captioned by its measure (R511).** With no label column a single
  value took the planner's intent as its caption, and an intent like
  "Calculate the total sales amount from the SaaS sales dataset" headed the
  number. An instruction, or anything over 40 characters, gives way to the
  measure's name (`kpiCaption`): "Total sales".
- **A gauge reads a ratio against a percentage on one scale (R511).** A
  margin is a ratio in SQL (0.12) and its target is written as a percentage
  (15), and the dial read "target 15 · 1%". `gaugeReading` (`biDrawHelpers`)
  treats a fractional value as the ratio when, as a percentage, it sits within
  ten times of the target and the raw value does not (or the maximum is
  exactly 100), and shows both as percentages. A whole number is a count and
  is never rescaled; money never is. The dial is captioned by the measure's
  name rather than its column. The figure check that marks an answer's
  numbers "Not checked against the data" (`verifyClaims`) accepts a
  percentage that a fractional value rounds to, so "12%" for 0.1247 passes
  and "15%" does not.
- **The columns are checked everywhere.**
  - The check that re-points a chart's fields at the columns its query
    returned (`reconcileChartFields`) used to run only on generated
    dashboards and reports. It now also runs on analyst steps, Visual BI in
    chat and embeds.
  - It also catches a field the chart left out entirely, which used to draw an
    empty frame.
  - It drops extra measures, combo lines and a treemap's colour measure that
    the query did not return.
- **Governed widgets** take 29 shapes instead of 6.
  - These are every visual a query of metrics by dimensions fills: a KPI over
    one time dimension compares periods, a calendar is rolled up by the day, a
    pivot takes up to three dimensions and four metrics, and a treemap's
    second metric colours it.
  - Each shape is held to the dimensions and metrics it draws, and refused
    with the reason.
  - Box plots, bar races, rank over time, start → finish, point maps, pins on
    a road and cards are left out, because a governed query does not return
    their columns. The builder's governed metric source takes the same set.

Found by generating dashboards, asking the analyst and chatting in the
browser, and fixed:

- **A combo's date axis read raw timestamps.** The model set `dateGrain` on
  the combo, and only line and area charts apply one, but a grain also
  switched off the axis's automatic labelling. The grain is now kept only on
  line and area charts. On other charts a stored one no longer stops the
  axis labelling its dates.
- **A monthly axis read in weeks.** Twelve months span 334 days, which fits
  60 weekly labels, so the axis read "2025-W44, 2025-W49". Values that all
  fall on the first of a month (or quarter, or year) are now labelled at
  least at that grain (`autoDateGrain`).
- **Generated calendars and small multiples showed a prefix of the data.**
  The model's SQL returned one row per order, and the 500-row snapshot kept
  the first 67 days.
  - A generated widget that hits the cap is now aggregated in SQL before it
    is first shown (`src/lib/biGeneratedTotals.ts`).
  - Pareto, calendar, pictogram and small multiples now take **Aggregate in
    SQL**; each small multiple's panel adds up rows that share an x value, as
    a line chart does.
  - The planner asks a calendar for a year of days at most.
- **A refresh dropped a combo's extra measures and a treemap's colour.** The
  GROUP BY kept only the first bar and line, and the tile size, so the
  other columns vanished.
- **The analyst pivoted a year of days into 31 columns.** Its 50-row trace
  triggered a reshape whose prompt suggested pivoting, which can only be
  shown as a table. SQL is now asked to stay long (one row per group) and to
  bucket instead, and the analyst plans steps that fit 50 rows.
- **Governed time axes came back unordered.** The query is now asked
  oldest first, and the order is stored on the widget (`source.orderBy`) so
  a refresh keeps it; a governed calendar asks for its latest 400 days. The
  builder's governed metric source does the same.
- **An embed charted a table the agent was not asked about.** It now
  declines when the question names a table it cannot read. Every embed
  answer that comes without a chart logs why on the server
  (`[embed-bi] owner <id>: no chart: <reason>`).
- **A calendar starting on the last day of a month** printed two month names
  on top of each other. The month with no room for its name is now left
  unnamed.

## Building a visual from fields

The builder opens in **Fields** mode (R499). Pick a table and click the
fields you want; it writes the query — the grouping, the aggregation, the
date period, the sort and the limit — runs it over the **whole table** as you
click, picks the chart that reads best and names it. The query it wrote is
under **The query these fields write**, and **Edit as SQL** carries it into
the SQL editor when you need something fields cannot say. **SQL** mode,
beside Fields, is the hand-written path.

Before R499, picking a table wrote `SELECT * … LIMIT 50` and left the
grouping to you, so a chart over it summed fifty arbitrary rows: Sales by
Region drew the first fifty orders, not each region's total. Fields write the
aggregation into the query; the engine adds up every row.

1. **Pick a table.** The picker searches as you type, on any part of the
   name, and shows each table's column count. Each column shows its kind —
   number, date or text — read from the declared type and a 50-row sample. A
   text column of dates such as `11/9/2024` is a date; a numeric id such as
   `Customer ID`, `order_id` or `zip_code` is text even when stored as a
   number, because it labels rows.
2. **Click fields.** Text and dates go to **Group by** (dates by month);
   numbers go to **Values** as a Sum. Each row's small Group and Value
   buttons put a field in the other place. **Number of rows** counts the
   rows in each group.
3. **Adjust each chip.** A value: Sum, Average, Min, Max, Count or Count
   distinct (a number starts as Sum; text and dates can only be counted and
   start as Count distinct). A date: Year, Quarter, Month, Week or Day.
4. **Filter, sort, keep the top.** Sort orders the groups by their first
   value (largest first) or by their label; **Show top** keeps the first N.
   A grouped date runs in time order and **Show top** becomes **Show
   latest**: 12 means the latest 12 periods, still drawn oldest first.
5. **Add it.** The chart type and title follow the fields until you change
   them. The visual is saved with its fields, so editing it reopens Fields
   mode with the same picks. A visual sent to SQL with Edit as SQL stays SQL.

| Your fields                             | The chart it starts as                          |
| --------------------------------------- | ----------------------------------------------- |
| Values only, nothing grouped            | KPI                                             |
| A date grouped by a period, with values | Line                                            |
| One text field, with values             | Bar                                             |
| Two text fields and one value           | Stacked column (the second field is the series) |
| Groups only, no values                  | Table                                           |

Picking another type reassigns the same fields: the category becomes the
pie's slices, a KPI takes the grouped date as its period, a narrative ranks
by the first value, a combo draws the second value as its line.

**Filters.**

| Condition                 | Value                                           | Example                           |
| ------------------------- | ----------------------------------------------- | --------------------------------- |
| is one of / is not one of | One or more, comma-separated                    | Region · is one of · `EMEA, AMER` |
| = ≠ > ≥ < ≤               | One value                                       | Discount · > · `0`                |
| between                   | Two values, comma-separated, both ends included | Sales · between · `10, 500`       |
| contains                  | Text anywhere in the value, ignoring case       | Customer · contains · `energy`    |
| is not empty              | None; drops NULLs, and empty text too           | Industry · is not empty           |

A number field takes numbers only. A date field takes ISO (`2025-01-31`,
optionally with a time) or a date written the way the column writes it
(`1/31/2025` for `m/d/yyyy` text), and compares dates as dates.

**Calculated fields.** A name and an expression over the table's columns, in
the source's SQL (quote names with spaces). With _It aggregates by itself_
ticked — `100 * SUM("Profit") / SUM("Sales")` — it is a value used as
written and cannot be grouped by. Unticked — `"Sales" - "Profit"` — it
behaves like a column: summed or averaged if a number, grouped if text. It
runs inside the same read-only query; an expression containing `;` is
refused.

**More values.** Bar, line, area and radar charts without a Series field draw
each further value as its own series: Sales and Profit by month as two lines.
On a radar each value is a spoke and each category a polygon; each spoke is on
its own scale (its largest value reaches the rim) and the tooltip gives the
actual figures, so sales in millions and quantity in units share one chart.
Stacked columns and bars
stack a Series field instead — overlapping values (profit is part of sales)
would stack into a meaningless total. In SQL mode the extra values are picked
under **More values**.

**Column titles and totals.** A table column's style button sets the heading
shown (`distinct_customer` → Customers). **Totals row** in Column formats is on
by default; turn it off where a sum means nothing. Percent-formatted columns
and columns whose names mark them as averages, rates or margins are never
totalled.

**Suggested narratives.** Under the preview, the sentences the rows support,
already computed: with a date, the change since the period before, the next
period's forecast (8+ periods) and the latest anomaly (5+); with a category,
the top and bottom members. **Add** puts one on the dashboard as its own
narrative visual over the same query.

**Refused, not guessed.** Summing a text field ("Region is not a number —
count it instead"), grouping by a calculated field that aggregates, a
non-number filter on a number field, a non-date filter on a date field, and a
field the table no longer has are each refused with that reason; nothing runs
until it is fixed.

**Engines.** On a warehouse the same picks write that warehouse's SQL: its
identifier quoting (backticks on BigQuery, MySQL and Databricks), its string
escapes and its own date truncation, so a month is its first day rather than a
`2026-07` label. Local datasets run on DuckDB — in the browser for the preview,
on the server for scheduled refreshes. A server set to `LOCAL_ENGINE=alasql`
cannot run DuckDB's date functions; build those visuals in SQL mode.

### Worked examples (sample table `saas_sales`)

`saas_sales` holds 9,994 orders from 99 customers: Order Date (as `m/d/yyyy`
text), Region, Customer, Industry, Segment, Product, Sales, Quantity,
Discount, Profit. The SQL is exactly what Fields mode writes for it.

**1. Sales by region** — click Region, then Sales → bar chart _Sales by
Region_.

```sql
SELECT "Region" AS "region",
       SUM("Sales") AS "sales"
FROM "saas_sales"
GROUP BY "Region"
ORDER BY "sales" DESC
LIMIT 1000
```

**2. Sales and profit by month** — click Order Date, Sales and Profit → line
chart with two lines, _Sales and Profit by month_. The text dates are parsed
in their own format before bucketing; months come back as `2024-11`,
`2024-12`…, quarters as `2024-Q4`, weeks as `2024-W45`.

```sql
SELECT STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m') AS "order_date_month",
       SUM("Sales") AS "sales",
       SUM("Profit") AS "profit"
FROM "saas_sales"
GROUP BY STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m')
ORDER BY "order_date_month" ASC
LIMIT 1000
```

With **Show latest** set to 12, the same picks keep the latest 12 months:

```sql
SELECT *
FROM (
  SELECT STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m') AS "order_date_month",
         SUM("Sales") AS "sales"
  FROM "saas_sales"
  GROUP BY STRFTIME(TRY_STRPTIME(CAST("Order Date" AS VARCHAR), '%m/%d/%Y'), '%Y-%m')
  ORDER BY "order_date_month" DESC
  LIMIT 12
) latest
ORDER BY "order_date_month" ASC
```

**3. This month against last month** — example 2 with Sales alone, then pick
**KPI**: the latest month, its change against the month before and a trend
line. **Compare with** → same period last year gives a year-on-year tile.

**4. Top 10 customers in EMEA by profit** — Customer, Profit; filter _Region
· is one of · EMEA_; Show top 10.

```sql
SELECT "Customer" AS "customer",
       SUM("Profit") AS "profit"
FROM "saas_sales"
WHERE "Region" IN ('EMEA')
GROUP BY "Customer"
ORDER BY "profit" DESC
LIMIT 10
```

**5. Margin by industry** — calculated field `Margin %` =
`100 * SUM("Profit") / SUM("Sales")` (aggregates by itself); Industry and
Margin %; value format Percent (it adds the sign; the expression already
multiplies by 100). Each industry's margin is total profit over total sales,
not an average of order margins.

```sql
SELECT "Industry" AS "industry",
       (100 * SUM("Profit") / SUM("Sales")) AS "margin"
FROM "saas_sales"
GROUP BY "Industry"
ORDER BY "margin" DESC
LIMIT 1000
```

**6. A product table** — Product, Sales, Customer (text is counted distinct), Number of
rows; pick Table; title the columns Sales, Customers and Orders; turn the
totals row off. A customer who bought several products counts under each, so
the Customers column adds up to 1,260 while there are 99 customers.

**7. A headline sentence** — with example 2 built, Suggested narratives offers,
computed from the sample: _Sales for Dec 2025 decreased by 19.5% (−21.9k) from
112.3k to 90.5k._ and _The most recent anomaly was Nov 2025: sales was 112.3k,
higher than the typical 39.8k._ Added, each is recomputed when filters change
its rows.

## KPIs that compare periods

A KPI with a **date** treats its rows as a series and shows the **latest
period**, its change against **the period before** or **the same period last
year**, and — with **Trend line** — the periods behind it; a target column
adds a progress bar, and **Lower is better** turns a fall green (R498).
**Period** sets what one period is: _As the rows are_ keeps one row per
period, so rates and averages are never summed, while a month, week, quarter
or year adds the rows inside each together. `2026-Q3` and `2026-W05` labels
read as dates. A comparison period with no data is reported as missing
("No data for Oct 2026 to compare with"), never replaced by an older one.
The e-mailed digest, the "what changed" log and the PowerPoint export use
the same latest period.

## Narratives computed from the data

The **Narrative** visual writes one sentence from its own rows: top or
bottom N, period over period, forecast (8+ periods), most recent anomaly
(5+ periods, median-based), compounded growth rate, or top movers between
the latest two periods (R498). It is arithmetic, not model prose, so it
follows filters and cross-filters like a chart and cannot state a number the
data lacks; too little history gets the reason instead of a sentence. **Your
own sentence** replaces the wording, with `{{period}}`, `{{change_pct}}`,
`{{list}}` and the other values picked from a menu. AI insight remains the
written reading of one snapshot.

## Table cell styles

Each table column has a style button in **Column formats** (R498): draw the
cells as a **data bar**, a **picture** or a **link** (absolute http(s) only,
plus image data and `mailto:`), colour them with a **scale** or **rules** —
numeric, or text rules `is` / `contains` — give each rule an **icon**, and
let a matching rule **colour the whole row**. Scales and bars are measured
over every row, not the page shown.

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
