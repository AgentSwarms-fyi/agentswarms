import type { Notebook } from "./types";

export const oaiStructuredOutputNotebook: Notebook = {
  id: "oai-structured-output",
  title: "Structured Output with outputType + Zod",
  description:
    "Force an agent to return a typed object instead of free text. Mirrors the SDK's outputType Zod schema, with automatic retry on validation failure.",
  difficulty: "intermediate",
  tags: ["agent", "structured-output"],
  subgroup: "Outputs",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · Structured Output — \`outputType\` with Zod

The single most useful field on \`Agent\` for production code is **\`outputType\`**. Set it to a Zod schema and the agent's final answer is *validated and parsed* before \`run()\` returns. No JSON.parse, no regex, no "the model added a trailing comma" bugs.

### Real SDK shape

\`\`\`ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";

const TicketSchema = z.object({
  category: z.enum(["billing", "tech", "sales"]),
  priority: z.enum(["low", "medium", "high"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  summary: z.string().max(140),
});

const triage = new Agent({
  name: "Ticket Triager",
  instructions: "Classify the incoming support ticket.",
  outputType: TicketSchema,           // ← the magic
});

const r = await run(triage, "I've been waiting for a refund for 12 days.");
r.finalOutput; // ← already typed as z.infer<typeof TicketSchema>
\`\`\`

Under the hood the SDK is doing 3 things:

1. Converting the Zod schema → JSON Schema → \`response_format: { type: "json_schema", json_schema: { schema, strict: true } }\`.
2. Calling the model with strict JSON mode (the model literally cannot emit non-conforming JSON).
3. Parsing the response with Zod, and if it still fails (rare with strict mode), re-asking the model with the validation error attached.

Below we build it ourselves so the contract is visible.`,
    },

    {
      id: "md-schema", kind: "markdown",
      source: `## 1 · Define the schema + ask in strict JSON mode

We use Zod (loaded via \`ctx.lc.z\`) for the developer-facing schema, and emit JSON Schema for the model.`,
    },
    {
      id: "schema", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

const TicketSchema = z.object({
  category:  z.enum(["billing", "tech", "sales"]).describe("Best-fit category for routing"),
  priority:  z.enum(["low", "medium", "high"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  summary:   z.string().min(5).max(140).describe("One-sentence summary"),
  actionItems: z.array(z.string()).min(1).max(5).describe("What the support rep should do"),
});

// Inline JSON Schema equivalent (this is what the SDK auto-derives from Zod).
const ticketJsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["billing", "tech", "sales"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    summary: { type: "string", minLength: 5, maxLength: 140 },
    actionItems: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
  required: ["category", "priority", "sentiment", "summary", "actionItems"],
  additionalProperties: false,
};

ctx.state.TicketSchema = TicketSchema;
ctx.state.ticketJsonSchema = ticketJsonSchema;
ctx.log("Schema defined ✓ — 5 required fields");
return { fields: Object.keys(ticketJsonSchema.properties) };
`,
    },

    {
      id: "md-run", kind: "markdown",
      source: `## 2 · Run with strict JSON mode + Zod validation + auto-retry

We wire it up the way the SDK does:

1. Send the schema in \`response_format.json_schema\`.
2. Parse with Zod.
3. If Zod fails, feed the validation error back and retry up to N times.

> Strict JSON mode means the model is *constrained* — invalid JSON essentially never happens. The retry is a belt-and-braces for semantic violations (e.g. enum mismatch).`,
    },
    {
      id: "run", kind: "code", language: "js", runtime: "browser",
      source: `async function runStructured(input, { maxRetries = 2 } = {}) {
  let lastError = null;
  const messages = [
    { role: "system", content: "You are a ticket triager. Output ONLY a JSON object matching the schema." },
    { role: "user", content: input },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (lastError) {
      ctx.log("  retry — feeding validation error to model");
      messages.push({
        role: "user",
        content: \`Your previous output failed validation: \${lastError}. Return corrected JSON.\`,
      });
    }
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: "ticket", schema: ctx.state.ticketJsonSchema, strict: true },
        },
      }),
    });
    const raw = (await res.json()).choices[0].message.content;
    ctx.log("  raw JSON:", raw.slice(0, 120) + "…");

    try {
      const parsed = ctx.state.TicketSchema.parse(JSON.parse(raw));
      ctx.log("  ✓ validated by Zod");
      return parsed;
    } catch (e) {
      lastError = e.message;
      ctx.log("  ✗ Zod rejected:", lastError.slice(0, 100));
      messages.push({ role: "assistant", content: raw });
    }
  }
  throw new Error("Exceeded retries: " + lastError);
}

const tickets = [
  "I've been waiting 12 days for a refund on order #4421. This is unacceptable.",
  "Hey team, our app is throwing CORS errors when calling /v1/runs. Any ideas?",
  "Hi! We love the product. We're 50 seats — would you do an annual discount?",
];

const out = [];
for (const t of tickets) {
  ctx.log("\\n─── triaging ───");
  ctx.log("input:", t);
  const r = await runStructured(t);
  ctx.log("output:", JSON.stringify(r, null, 2));
  out.push(r);
}
return out;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

- \`outputType: ZodSchema\` is the *single highest-leverage* SDK feature for production agents.
- Under the hood: Zod → JSON Schema → \`response_format: { type: "json_schema", strict: true }\` → Zod.parse.
- Strict mode is grammar-constrained decoding — invalid JSON is impossible. The retry loop handles semantic edge cases.

### What you couldn't do without it

- Pass agent output safely into a database \`INSERT\`.
- Feed agent output into the next service in a pipeline without defensive parsing.
- Render agent output in a typed UI component.
- Run programmatic evaluations (exact-match accuracy on \`category\`, etc.) — see *Agentic Evals → Programmatic Evaluation*.

### Common schema patterns

| Pattern | Schema snippet |
| --- | --- |
| Routing decision | \`z.object({ route: z.enum(["billing","tech","sales"]), reason: z.string() })\` |
| Multi-tool plan | \`z.object({ steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()) })) })\` |
| Extraction | \`z.object({ entities: z.array(z.object({ type: z.enum([...]), value: z.string() })) })\` |
| Self-grade | \`z.object({ answer: z.string(), confidence: z.number().min(0).max(1) })\` |

Set \`outputType\` on every agent that feeds another system. Treat free-text output as a UX choice, not a default.`,
    },
  ],
};
