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
- **Data preparation** — a visual prep studio (BI Workspace → Data
  preparation): drag tables onto the canvas to build a join pipeline (left /
  inner / right / full outer, join keys auto-detected from matching column
  names, colliding columns auto-aliased), rename columns and set their types
  — Text, Integer, Decimal, Date, Boolean, **Location**, Category, Currency,
  Percentage, Identifier — with un-convertible values nulled and counted.
  The result preview updates live at the bottom. **Run &amp; save**
  materialises the result as a local dataset (joinable again, chartable,
  visible to the AI analyst and SQL agents, semantic types recorded in the
  semantic layer) and the flow itself is saved for re-editing and re-running.
  External warehouse tables can be pulled in as capped snapshots to join
  against local data.
- **Publish & share** — publishing exposes a read-only page at
  `/share/bi/<unguessable-slug>` for anyone with the link; group sharing
  (owner-controlled, or superadmin via Admin → IAM) makes the dashboard
  appear read-only in members' BI Workspace. Viewers always see the stored
  snapshots — your warehouse credentials are never used on their behalf and
  never leave the server.

