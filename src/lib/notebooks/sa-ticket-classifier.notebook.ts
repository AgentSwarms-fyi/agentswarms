import type { Notebook } from "./types";

export const saTicketClassifierNotebook: Notebook = {
  id: "sa-ticket-classifier",
  title: "Customer Support Ticket Classifier",
  description:
    "Intent-routing agent: reads a complaint and outputs category, priority and a sentiment score. Add categories or paste edge-case complaints.",
  difficulty: "beginner",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 12 · Customer Support Ticket Classifier

This is the heart of any support automation: turn free-form text into a
**typed routing decision**. We classify category + priority and score
sentiment 1-10.

**Experiments:**
- Add a new category to the Zod enum (e.g. \`"fraud"\`).
- Try ambiguous complaints — does the model still pick something sensible?`,
    },

    {
      id: "classify", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

// 👇 Add a new category here and the model will start using it.
const Category = z.enum(["refund", "tech_support", "billing", "shipping", "account", "other"]);

const schema = z.object({
  category: Category,
  priority: z.enum(["low", "medium", "high", "urgent"]),
  sentiment_score: z.number().min(1).max(10).describe("1=very negative, 10=very positive"),
  suggested_team: z.string(),
  one_line_summary: z.string(),
});

// 👇 Try other complaints, including edge cases.
const TICKET = \`I've been charged THREE times for the same order #4421 and nobody from
your team has replied to my last 4 emails. This is the worst service I've ever experienced.
I want a full refund TODAY or I'm going to dispute on my card.\`;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(schema, { name: "classify_ticket" });

return await llm.invoke([
  ["system", "Classify the support ticket. Be strict — pick the single best category."],
  ["human", TICKET],
]);
`,
    },
    { id: "md-x", kind: "markdown", source: `**Why Zod enums?** They force the model to pick from a closed set. No more \`"category": "refunds (urgent!!)"\` weirdness. If the model tries to invent a category, validation throws and you can retry or fall back.` },
  ],
};
