// Curriculum module: SQL & data-grounded agents.
//
// Explains the `sql_query` tool, how AgentSwarms safely runs natural-language
// → SQL → result → natural-language answer end-to-end, and how to use it
// inside both single agents and multi-agent swarms.

export type SqlConcept = {
  id: string;
  number: string;
  title: string;
  oneLiner: string;
  child: string;     // "Like you're 10"
  engineer: string;  // "For the engineer"
};

export const sqlAgentIntro = {
  child:
    "Imagine you have a giant spreadsheet of your company's sales. A SQL agent is a robot helper you can ask questions in plain English — 'Which region sold the most last quarter?' — and it writes the database query, runs it, reads the answer, and tells you the result in a sentence. You never see the SQL.",
  engineer:
    "A SQL agent (a.k.a. text-to-SQL agent) is an LLM equipped with a `sql_query` tool that turns natural-language questions into validated SELECT statements, executes them against tabular data, and synthesizes a natural-language answer from the rows. In AgentSwarms the executor is sandboxed: SELECT-only, AST-parsed (not eval'd), capped at 50 rows, scoped to tables the user owns or that are explicitly allow-listed.",
  whyItMatters: [
    "Most business questions are SQL questions in disguise — totals, rankings, breakdowns, time-series.",
    "Letting end-users ask in English instead of SQL collapses analyst back-and-forth from hours to seconds.",
    "Done safely, it works on production warehouses without exposing them to prompt-injection or runaway queries.",
  ],
};

export const sqlPipeline = [
  {
    step: "1",
    title: "User asks in English",
    body: "Plain-language question, e.g. 'Which region had the highest profit last quarter?' No SQL knowledge required.",
  },
  {
    step: "2",
    title: "Agent inspects schema",
    body: "The agent calls `list_data_tables` to see available tables and their columns — this grounds its query in real schema, not guesses.",
  },
  {
    step: "3",
    title: "Agent writes SQL",
    body: "The LLM produces a single SELECT statement with the right GROUP BY / ORDER BY / aggregates for the question.",
  },
  {
    step: "4",
    title: "Runtime validates + executes",
    body: "AgentSwarms parses the SQL with an AST parser (no eval), enforces SELECT-only, applies a 50-row cap, and runs it against the user's allow-listed tables.",
  },
  {
    step: "5",
    title: "Rows return as a tool result",
    body: "The actual rows are streamed back to the model as a structured tool result — visible in the trace for debugging.",
  },
  {
    step: "6",
    title: "Agent answers in plain language",
    body: "The model reads the rows and replies in natural language (e.g. 'EMEA had the highest profit at $1.2M, driven by FinanceHub deals'). No raw SQL in the user-facing reply.",
  },
];

export const sqlSafety = [
  {
    title: "SELECT-only at the parser level",
    body: "Every query is parsed into an AST first. INSERT, UPDATE, DELETE, DROP, CREATE — even hidden in CTEs or subqueries — are rejected before execution. The model literally cannot mutate data.",
  },
  {
    title: "No eval, no SQL injection escape",
    body: "Cloudflare Workers (where the executor runs) forbid `new Function()` / `eval`, so we ship a pure-JS interpreter over the AST. There is no string concatenation that an attacker could break out of.",
  },
  {
    title: "Per-agent table allow-list",
    body: "Every agent that has the `sql_query` tool can be restricted to a specific list of table names via `toolConfigs.sql_table_names`. The agent never sees — let alone queries — tables outside that list.",
  },
  {
    title: "Tenant isolation via Supabase RLS",
    body: "Tables live in `user_data_tables` with row-level security. An agent run as user A cannot read user B's tables, even if it tries.",
  },
  {
    title: "Hard 50-row cap",
    body: "Every result is truncated server-side. Big questions force the model to use aggregates (SUM/AVG/COUNT/GROUP BY) instead of dumping raw rows — which is exactly what a competent analyst would do anyway.",
  },
  {
    title: "Full trace in observability",
    body: "Every `sql_query` call is logged: the SQL, the row count, latency, cost. Open Traces to audit any answer back to the exact query that produced it.",
  },
];

export const sqlInAgentSwarms = {
  singleAgent: {
    title: "Inside a single agent (the easy on-ramp)",
    steps: [
      "Open Data & SQL Agents → upload a CSV (or use the bundled `saas_sales` sample dataset).",
      "Open Agents → New Agent → enable the `sql_query` tool.",
      "Optional: under tool configuration, set `sql_table_names` to restrict the agent to specific tables.",
      "Save, then test in the Playground: 'What were total sales by region?' The trace will show one `sql_query` call and a natural-language answer.",
    ],
    whenToUse:
      "Best for ad-hoc analyst chatbots where one agent owns the whole loop: schema → query → interpret → answer. Low latency, simple to debug.",
  },
  insideSwarm: {
    title: "Inside a multi-agent swarm (the production shape)",
    steps: [
      "Open Swarms → load the `SaaS RevOps — Multi-Agent SQL Analyst` template.",
      "Inspect the SQL Planner Agent — it owns the `sql_query` tool and only outputs the raw rows.",
      "Inspect the RevOps Analyst Agent — it has no SQL tool. It only interprets the rows the planner produced.",
      "Inspect the Strategic Synthesizer — turns analyst findings into a VP-ready recommendation.",
      "An Approval node gates the recommendation before it lands as the swarm's output.",
    ],
    whenToUse:
      "Best when the question is a strategic one, not just a lookup. Splitting query / interpretation / strategy gives each agent a focused prompt and dramatically better quality on complex questions like 'Why is EMEA underperforming?'.",
  },
};

export const sqlExampleQueries = [
  {
    question: "Which region has the most sales transactions?",
    sql: "SELECT Region, COUNT(*) AS tx FROM saas_sales\nGROUP BY Region\nORDER BY tx DESC\nLIMIT 5;",
  },
  {
    question: "Average discount by industry, big customers only",
    sql: "SELECT Industry, AVG(Discount) AS avg_disc\nFROM saas_sales\nWHERE Sales > 5000\nGROUP BY Industry\nORDER BY avg_disc DESC;",
  },
  {
    question: "Top 5 most-profitable products in EMEA",
    sql: "SELECT Product, SUM(Profit) AS total_profit\nFROM saas_sales\nWHERE Region = 'EMEA'\nGROUP BY Product\nORDER BY total_profit DESC\nLIMIT 5;",
  },
];

export const sqlPitfalls = [
  "Skipping `list_data_tables` — the model invents column names that don't exist and the query fails. Always seed the agent's prompt with 'call list_data_tables first if you don't know the schema'.",
  "Forgetting the table allow-list (`sql_table_names`). Without it, the agent can read every table the user owns — usually fine, but explicit is safer.",
  "Asking for raw rows on a 1M-row table — the 50-row cap kicks in and the answer is misleading. Train the agent (via system prompt) to aggregate big questions.",
  "Showing the SQL string in the user-facing reply instead of the answer. The tool description explicitly forbids this; if you fork the prompt, keep that rule.",
  "Putting the `sql_query` tool on every agent in a swarm. Only the SQL Planner needs it — downstream agents should consume the rows, not re-run them.",
];

export const sqlRealWorld = [
  {
    org: "Uber — QueryGPT",
    quote:
      "Uber's internal text-to-SQL assistant serves ~78,000 monthly active analyst queries; reports a ~3.2-min reduction per query in median authoring time.",
    url: "https://www.uber.com/blog/query-gpt/",
  },
  {
    org: "Pinterest — Text-to-SQL",
    quote:
      "Combines table-retrieval + schema-linking + LLM SQL generation; ~35% reduction in median analyst time-to-query across hundreds of curated tables.",
    url: "https://medium.com/pinterest-engineering/how-we-built-text-to-sql-at-pinterest-30bad30dabff",
  },
  {
    org: "Snowflake — Cortex Analyst",
    quote:
      "Layered SQL generation + business-language synthesis on top of the warehouse; enterprise customers (Bayer, Siemens Energy) report analyst self-serve climbing past 70% on covered semantic models.",
    url: "https://www.snowflake.com/en/blog/cortex-analyst-now-generally-available/",
  },
  {
    org: "Salesforce — Agentforce",
    quote:
      "Ships pre-built CRM SQL agents with an Approvals layer that gates pipeline-mutating actions — the same human-in-the-loop pattern AgentSwarms uses for high-risk recommendations.",
    url: "https://www.salesforce.com/news/press-releases/2024/09/12/agentforce-announcement/",
  },
];
