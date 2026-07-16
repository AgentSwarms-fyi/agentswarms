import type { Notebook } from "./types";

export const saTextToSqlNotebook: Notebook = {
  id: "sa-text-to-sql",
  title: "Text-to-SQL Query Generator",
  description:
    "Give the agent a schema, ask in natural language, get SQL back. Edit the schema and try complex joins.",
  difficulty: "intermediate",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 13 · Text-to-SQL Query Generator

Text-to-SQL is one of the most common LLM tasks in business apps. The
quality of the schema description matters more than the model — be
explicit about types, keys, and relationships.

**Experiments:**
- Add a new table (e.g. \`payments\`) and ask a 3-table join.
- Ask something the schema cannot answer — does the model hallucinate or refuse?`,
    },

    {
      id: "to-sql", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

// 👇 Edit this schema. Add tables, columns, foreign keys.
const SCHEMA = \`Tables (PostgreSQL):

users (
  id            uuid primary key,
  email         text not null,
  full_name     text,
  city          text,
  created_at    timestamptz
)

orders (
  id            uuid primary key,
  user_id       uuid references users(id),
  total_cents   integer,
  status        text check (status in ('pending','paid','shipped','cancelled')),
  created_at    timestamptz
)

order_items (
  id            uuid primary key,
  order_id      uuid references orders(id),
  product_name  text,
  quantity      integer,
  price_cents   integer
)\`;

// 👇 Ask anything.
const QUESTION = "Show the top 5 users in Dubai by total amount spent on paid orders in the last 30 days.";

const schema = z.object({
  sql: z.string().describe("A single valid PostgreSQL query that answers the question."),
  explanation: z.string().describe("Plain-English explanation of what the query does."),
});

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(schema, { name: "generate_sql" });

return await llm.invoke([
  ["system", "You translate natural language into PostgreSQL. Only use tables and columns from the provided schema. If the question can't be answered with this schema, set sql to '' and explain why."],
  ["human", "Schema:\\n" + SCHEMA + "\\n\\nQuestion: " + QUESTION],
]);
`,
    },
    { id: "md-x", kind: "markdown", source: `In production you'd **never** execute model-generated SQL directly — at minimum, parse it and check it's a \`SELECT\`, then run inside a read-only transaction with a row limit.` },
  ],
};
