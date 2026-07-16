import type { Notebook } from "./types";

export const saJsonEnforcerNotebook: Notebook = {
  id: "sa-json-enforcer",
  title: "Text → JSON Enforcer (Structured Output)",
  description:
    "Turn a messy email into a strict JSON object using a Zod schema and withStructuredOutput. Add a field, watch the model extract it.",
  difficulty: "beginner",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 8 · Text → JSON Enforcer

\`JSON.parse\` after an LLM call is a recipe for tears. LangChain's
\`withStructuredOutput(zodSchema)\` binds the schema as a tool under the
hood and gives you a **typed object** — no string parsing, no retries.

**Try this:** add a field to the Zod schema (e.g. \`urgency\`) and
re-run. The model adapts the output automatically.`,
    },

    {
      id: "extract", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

// 👇 Edit this schema — add \`urgency: z.enum(["low","medium","high"])\` etc.
const schema = z.object({
  sender_name: z.string().describe("Full name of the person sending the email"),
  company: z.string().nullable().describe("Company they represent, or null"),
  meeting_date: z.string().nullable().describe("ISO date of any proposed meeting, or null"),
  intent: z.enum(["sales", "support", "partnership", "spam", "other"]),
  summary: z.string().describe("One-sentence summary"),
});

const EMAIL = \`From: jane.doe@acme-corp.com
Subject: Following up on our chat at the conference

Hey there!

Jane Doe here from Acme Corp — we met briefly at the booth on Tuesday.
I wanted to see if you'd be open to a 30 min demo next Thursday, March 14th
around 2pm UTC? We'd love to explore a possible partnership on the
analytics side of things.

Cheers,
Jane\`;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(schema, { name: "extract_email" });

return await llm.invoke([
  ["system", "Extract structured data from the email. Use null when a field is unknown."],
  ["human", EMAIL],
]);
`,
    },
    { id: "md-x", kind: "markdown", source: `The returned object is already typed and validated. If the model emits something that doesn't match the schema, LangChain throws — so downstream code can trust the shape.\n\n**Experiments:**\n- Add \`urgency: z.enum(["low","medium","high"])\`. Re-run.\n- Add \`action_items: z.array(z.string())\`.\n- Paste in a totally different email and watch the same schema apply.` },
  ],
};
