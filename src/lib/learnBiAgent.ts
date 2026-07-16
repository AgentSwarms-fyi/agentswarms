// Curriculum module: BI Agent (Wren-style GenBI inside AgentSwarms).
//
// Explains the BI Agent feature in the SQL & Chat Playground — the
// Plan → SQL → Execute → Chart → Narrative pipeline — in two voices
// (beginner + engineer), how AgentSwarms runs it under the hood, and
// how a developer can replicate the pattern in their own product.

export const biAgentIntro = {
  child:
    "Imagine asking a friend, 'What were my top 5 selling products last quarter?' and they instantly draw a chart on a napkin, point to the biggest bar, and say one sentence about it. That's the BI Agent. You type a question in normal English, the robot picks the right table, writes the database query for you, runs it, picks the best chart, and writes a short answer — all in a few seconds.",
  engineer:
    "The BI Agent is a 5-stage GenBI pipeline (Plan → SQL → Execute → Chart → Narrative) inspired by Wren AI. A semantic layer (table descriptions, column aliases, saved metrics) is fed to an LLM in JSON-mode, which produces a structured plan, then a SELECT statement constrained to known columns, then a chart spec (`bar | line | pie | area | kpi | table`) plus a 2–3 sentence summary. SQL runs in-browser via AlaSQL against CSVs stored in our managed backend. All four LLM calls hit a dedicated `/api/bi` Cloudflare Worker route that enforces `response_format: json_object` against the AgentSwarms AI gateway.",
  whyItMatters: [
    "Charts beat tables for 90% of real business questions — humans read shapes faster than numbers.",
    "A semantic layer is the difference between a parlor trick and a tool you can trust on real data.",
    "Splitting the work into Plan / SQL / Chart / Narrative gives each LLM call one focused job, which dramatically cuts hallucinations.",
  ],
};

export const biPipeline = [
  {
    step: "1",
    title: "Plan",
    body: "The LLM reads your question + the semantic layer (tables, columns, aliases, saved metrics) and outputs a structured intent: which tables, which metrics, which breakdowns, what time grain.",
  },
  {
    step: "2",
    title: "Generate SQL",
    body: "A second JSON-mode call writes ONE SELECT statement constrained to columns from the schema, with appropriate GROUP BY / ORDER BY / LIMIT. No INSERT/UPDATE/DELETE — ever.",
  },
  {
    step: "3",
    title: "Execute",
    body: "The SQL runs in your browser via AlaSQL against the CSV rows fetched from Supabase. Zero server round-trip on the actual query — fast and private.",
  },
  {
    step: "4",
    title: "Choose chart",
    body: "Given the columns + sample rows, the LLM picks the best visualization: bar for categorical, line/area for time-series, pie for part-of-whole, KPI for single values, table when nothing fits.",
  },
  {
    step: "5",
    title: "Narrative",
    body: "A final call writes a 2–3 sentence executive summary in plain language ('EMEA led with $1.2M in profit, driven by FinanceHub deals'). Numbers get rounded humanely (1.2M, 3.4k).",
  },
];

export const biSemanticLayer = [
  {
    title: "Table & column descriptions",
    body: "Tell the agent that `cust_seg` means 'Customer Segment' and that 'Profit' is in USD. The LLM stops guessing column meaning — accuracy jumps overnight.",
  },
  {
    title: "Business-friendly aliases",
    body: "Map 'rev' → 'Net Revenue' or 'qty' → 'Units Sold'. Both your charts and the narrative use the human name instead of cryptic warehouse identifiers.",
  },
  {
    title: "Saved metrics",
    body: "Pin formulas like `gross_margin = (revenue - cost) / revenue` once. The agent reuses the exact formula every time someone asks 'what's our gross margin?' — no drift across answers.",
  },
  {
    title: "Join hints",
    body: "Declare that `orders.customer_id` joins to `customers.id`. The agent stops inventing impossible joins between unrelated CSVs.",
  },
  {
    title: "Per-user RLS isolation",
    body: "Semantics and saved metrics live in `user_data_semantics` / `user_saved_metrics` with row-level security. Your business definitions never leak to another tenant.",
  },
];

export const biUnderTheHood = {
  intro:
    "When you press Enter in the BI Agent tab, here is the exact dance AgentSwarms performs in the background — explained so you can read along in any trace.",
  steps: [
    {
      who: "Your browser",
      does: "Loads the dataset metadata + your saved semantics + saved metrics from Supabase. This is the agent's 'business dictionary'.",
    },
    {
      who: "Browser → /api/bi (Plan)",
      does: "Sends question + schema dictionary to a Cloudflare Worker. Worker calls the AgentSwarms AI gateway with `response_format: json_object`. Returns a structured plan.",
    },
    {
      who: "Browser → /api/bi (SQL)",
      does: "Sends plan + schema. Worker asks the LLM for a single SELECT. The model can only reference columns we listed — it cannot invent new ones.",
    },
    {
      who: "Browser",
      does: "Runs the SQL locally in AlaSQL against the rows for that table. Your raw data never leaves your session.",
    },
    {
      who: "Browser → /api/bi (Chart + Narrative in parallel)",
      does: "Two more JSON-mode calls run together: one picks the chart type and which columns map to x/y/series, the other writes the executive summary.",
    },
    {
      who: "UI",
      does: "Renders a Recharts chart, a collapsible data table, the SQL (collapsible), and the natural-language narrative. A 'Save as metric' button lets you pin the query.",
    },
  ],
  whySafe: [
    "All SQL is parsed before execution — DDL/DML keywords are rejected at the AST level.",
    "The 50-row cap on raw queries pushes the model toward aggregates, which is what an analyst would write anyway.",
    "Worker enforces auth (Bearer token → authenticated user) before forwarding to the AI gateway. No anonymous calls.",
  ],
};

export const biBuildYourOwn = {
  intro:
    "The BI Agent is a deliberately small, copyable pattern. Here is the recipe to ship the same capability inside your own product.",
  ingredients: [
    {
      title: "1 — Define your semantic layer",
      body: "A small Postgres/SQLite table per tenant: `table_id`, `column_meta` (jsonb of `{name, alias, description, unit}`), `join_hints`, `primary_key`. This is the single biggest accuracy lever — invest here first.",
    },
    {
      title: "2 — Add a saved-metrics table",
      body: "`name`, `sql_expression`, `description`, optional `table_id`. Show users a 'Save as metric' button after every successful query. Within a week your 20 most-asked questions become deterministic.",
    },
    {
      title: "3 — Pick a JSON-mode-capable model",
      body: "Any of GPT-5/4o, Gemini 2.5/3 Flash, or Claude with tool calling. Use `response_format: { type: 'json_object' }` and keep temperature ≤ 0.2. JSON-mode kills 95% of 'AI returned non-JSON' bugs.",
    },
    {
      title: "4 — Stage the pipeline, don't combine it",
      body: "One LLM call per stage (plan, sql, chart, narrative). Each prompt stays small and focused → better quality, easier to debug, cheaper than one giant prompt that tries to do everything.",
    },
    {
      title: "5 — Sandbox the SQL executor",
      body: "Parse to an AST, allow only SELECT, hard-cap rows. Use AlaSQL for in-browser execution on small datasets, or DuckDB-WASM for medium, or a real warehouse with read-only credentials for production.",
    },
    {
      title: "6 — Render with a charting library you already trust",
      body: "Recharts, Visx, Apache ECharts — pick one. The LLM only outputs `{ type, xField, yField, seriesField }`; your renderer maps that to actual JSX. Don't let the model emit raw SVG/HTML.",
    },
    {
      title: "7 — Generate suggested questions",
      body: "On dataset load, run one extra LLM call: 'suggest 4 specific business questions answerable from this schema'. Cold-start friction disappears — users always have something to click.",
    },
    {
      title: "8 — Persist conversation + audit trail",
      body: "Log every (question, plan, sql, chart, narrative) tuple. This is your compliance trail AND your training set for fine-tuning a smaller cheaper model later.",
    },
  ],
};

export const biIntegrationPatterns = [
  {
    title: "Embed in an existing SaaS dashboard",
    body: "Drop the BI panel as a side drawer next to your existing charts. Pre-populate the semantic layer from your warehouse's `information_schema` + business glossary, then let users override.",
  },
  {
    title: "Internal analytics chatbot (Slack / Teams)",
    body: "Wrap the pipeline in a slash command (`/ask sales last quarter`). Render the chart as a PNG attachment via a headless browser, post the narrative inline, link back to the SQL for power users.",
  },
  {
    title: "Customer-facing 'ask your data' add-on",
    body: "Run per-customer with strict tenant isolation (RLS in Postgres or schema-per-tenant in BigQuery). Charge as an upsell — every modern B2B SaaS has demand for this.",
  },
  {
    title: "Whitelabel inside a vertical app",
    body: "Add a fixed semantic layer for your domain (e-commerce, fintech, ops) so users don't have to write descriptions. Domain-tuned prompts + curated metrics = enterprise-grade accuracy out of the box.",
  },
  {
    title: "BI Agent as a tool inside a larger swarm",
    body: "Wire the pipeline behind a single tool call (`bi_agent.ask(question)`) that returns `{ chart, narrative, sql }`. Now any larger agent — a CFO copilot, an exec briefing bot — can call it like a function.",
  },
];

export const biPitfalls = [
  "Skipping the semantic layer. Without aliases and descriptions, the agent guesses what `usr_act_ind` means. Spend 10 minutes on metadata; save 10 hours of bad answers.",
  "One giant prompt that does plan + SQL + chart + summary at once. Quality collapses, debugging is impossible, latency goes up. Stage the pipeline.",
  "Letting the LLM output raw SVG/HTML for the chart. Always have it emit a small spec your renderer interprets. Otherwise you can't restyle, audit, or accessibility-fix anything.",
  "Forgetting `response_format: json_object`. You will spend a week writing regex to strip prose and fences. Just turn JSON-mode on.",
  "Running unsafe SQL. AST-parse before execute. SELECT-only. No string concatenation. No exceptions, even for 'just an internal tool'.",
  "Showing the SQL by default. Users get scared. Hide it behind a 'View SQL' toggle for power users; everyone else just sees chart + narrative.",
];

export const biRealWorld = [
  {
    org: "Wren AI (open-source, the inspiration)",
    quote:
      "MIT-licensed GenBI engine: semantic layer (MDL) → SQL → chart → narrative. The reference implementation that proved this pattern works on Snowflake, BigQuery, Postgres, and DuckDB.",
    url: "https://github.com/Canner/WrenAI",
  },
  {
    org: "Snowflake — Cortex Analyst",
    quote:
      "Same pattern at warehouse scale: customers define a semantic model, end-users ask in English, Cortex emits SQL + answer. Bayer and Siemens Energy report >70% of analyst questions now self-serve.",
    url: "https://www.snowflake.com/en/blog/cortex-analyst-now-generally-available/",
  },
  {
    org: "Databricks — Genie",
    quote:
      "AI/BI Genie wraps the same Plan → SQL → Chart loop on top of Unity Catalog, with the catalog itself acting as the semantic layer.",
    url: "https://www.databricks.com/product/ai-bi/genie",
  },
  {
    org: "Power BI — Copilot",
    quote:
      "Microsoft's Copilot in Power BI generates DAX/SQL plus narrative summaries from the same semantic-model-first approach. Demonstrates the pattern at hundreds of millions of seats.",
    url: "https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-introduction",
  },
];
