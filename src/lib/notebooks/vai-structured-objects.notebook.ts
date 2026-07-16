import type { Notebook } from "./types";

export const vaiStructuredObjectsNotebook: Notebook = {
  id: "vai-structured-objects",
  title: "generateObject & streamObject (Typed JSON with Zod)",
  description:
    "Force the model into a Zod-typed object — and stream it in as it generates. The shape that powers every Vercel AI SDK production app.",
  difficulty: "beginner",
  tags: ["structured-output"],
  subgroup: "Core Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · \`generateObject\` & \`streamObject\` — Typed JSON, First-Class

\`generateText\` returns a string. Strings are awkward — you have to parse, validate, retry. **\`generateObject\`** is the Vercel AI SDK's answer: pass a Zod schema, get back a fully-typed object that has already been validated.

\`\`\`ts
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: openai("gpt-5"),
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ item: z.string(), quantity: z.string() })),
      steps: z.array(z.string()).min(3),
    }),
  }),
  prompt: "Generate a vegan tofu stir-fry recipe.",
});

object.recipe.ingredients[0].item;  // ← typed end-to-end, no .parse()
\`\`\`

The SDK does the heavy lifting:
1. Derives JSON Schema from your Zod schema.
2. Picks the best **mode** for the provider:
   - \`mode: "tool"\` — uses a synthetic tool call (universal).
   - \`mode: "json"\` — JSON mode on OpenAI-compatible providers.
   - \`mode: "auto"\` (default) — picks the best one for the chosen model.
3. Parses with Zod and **auto-retries** on validation failure (configurable with \`maxRetries\`).

### \`streamObject\` — same idea, partial objects as they arrive

\`\`\`ts
const { partialObjectStream } = streamObject({ model, schema, prompt });

for await (const partial of partialObjectStream) {
  // Each yield is a deeper-filled-in version of the final object.
  // Perfect for streaming a long structured response into a UI.
}
\`\`\`

The other shapes:

| Variant | Use for |
| --- | --- |
| \`output: "object"\` (default) | Single object matching the schema. |
| \`output: "array"\` | A list — partial stream yields elements one at a time. |
| \`output: "enum"\` | A single value from a string enum (no Zod needed). |
| \`output: "no-schema"\` | Free-form JSON (last resort). |

Below we build a runnable version against the proxy.`,
    },

    {
      id: "md-generate", kind: "markdown",
      source: `## 1 · \`generateObject\` — full result, validated

A typical product use case: extract a structured **action plan** from a free-form user request. The agent decides intent + steps + priority — and the schema makes it safe to feed into your task queue.`,
    },
    {
      id: "generate", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

const ActionPlan = z.object({
  intent: z.enum(["schedule_meeting", "send_email", "create_task", "other"]),
  priority: z.enum(["low", "medium", "high"]),
  steps: z.array(
    z.object({
      order: z.number().int().min(1),
      description: z.string(),
      eta_minutes: z.number().int().min(1),
    })
  ).min(2).max(6),
});

// JSON Schema equivalent (what the SDK auto-derives).
const jsonSchema = {
  type: "object",
  properties: {
    intent:   { type: "string", enum: ["schedule_meeting","send_email","create_task","other"] },
    priority: { type: "string", enum: ["low","medium","high"] },
    steps: {
      type: "array", minItems: 2, maxItems: 6,
      items: {
        type: "object",
        properties: {
          order:       { type: "integer", minimum: 1 },
          description: { type: "string" },
          eta_minutes: { type: "integer", minimum: 1 },
        },
        required: ["order","description","eta_minutes"],
        additionalProperties: false,
      },
    },
  },
  required: ["intent","priority","steps"],
  additionalProperties: false,
};

async function generateObject({ model, schema, jsonSchema, prompt, maxRetries = 2 }) {
  let lastErr = null;
  const messages = [
    { role: "system", content: "Return ONLY a JSON object matching the schema." },
    { role: "user", content: prompt },
  ];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (lastErr) messages.push({ role: "user", content: \`Validation failed: \${lastErr}. Return corrected JSON.\` });
    const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
      body: JSON.stringify({
        model, messages,
        response_format: { type: "json_schema", json_schema: { name: "plan", schema: jsonSchema, strict: true } },
      }),
    });
    const raw = (await res.json()).choices[0].message.content;
    try { return { object: schema.parse(JSON.parse(raw)), attempts: attempt + 1 }; }
    catch (e) { lastErr = e.message; messages.push({ role: "assistant", content: raw }); }
  }
  throw new Error("Exceeded retries: " + lastErr);
}

const { object, attempts } = await generateObject({
  model: "google/gemini-3-flash-preview",
  schema: ActionPlan, jsonSchema,
  prompt: "Please book a Zoom call with the design team for Thursday afternoon to review the new logo, and email everyone the calendar invite afterwards.",
});
ctx.log("attempts:", attempts);
ctx.log("object:  \\n" + JSON.stringify(object, null, 2));
return object;
`,
    },

    {
      id: "md-stream", kind: "markdown",
      source: `## 2 · \`streamObject\` — partial fills as they arrive

The killer feature for UIs: each chunk yields a *more-complete* version of the object. You can render a form that fills itself in field-by-field — exactly what tools like v0.dev do.

> We simulate the SDK's behaviour: stream the JSON, attempt to parse incrementally, and yield each successfully-parsable prefix.`,
    },
    {
      id: "stream", kind: "code", language: "js", runtime: "browser",
      source: `// Lightweight "best-effort partial JSON" parser.
function tryParsePartial(s) {
  for (let i = s.length; i > 0; i--) {
    try { return JSON.parse(s.slice(0, i)); } catch { /* keep shrinking */ }
  }
  return null;
}

async function* streamObject({ model, prompt }) {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model, stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return only a JSON object with keys: name, tagline, features (array of 3 strings), pricing { monthly_usd, yearly_usd }." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", json = "", lastSnap = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.startsWith("data: ")) continue;
      const p = l.slice(6).trim();
      if (p === "[DONE]") return;
      try {
        const d = JSON.parse(p).choices?.[0]?.delta?.content;
        if (!d) continue;
        json += d;
        // Try to yield a partial object — but only when it's grown enough to matter.
        if (json.length - lastSnap.length > 20) {
          lastSnap = json;
          const partial = tryParsePartial(json);
          if (partial) yield partial;
        }
      } catch { /* keepalive */ }
    }
  }
  const final = tryParsePartial(json);
  if (final) yield final;
}

ctx.log("─── streamObject('product brief for: AI-powered focus timer') ───");
let lastKeys = [];
let snaps = 0;
let final = null;
for await (const partial of streamObject({
  model: "google/gemini-3-flash-preview",
  prompt: "Write a product brief for an AI-powered focus timer SaaS.",
})) {
  snaps++;
  final = partial;
  const keys = Object.keys(partial);
  // Log when a new top-level key appears
  const newKeys = keys.filter((k) => !lastKeys.includes(k));
  if (newKeys.length) ctx.log(\`📦 partial #\${snaps} — new keys: \${newKeys.join(", ")}\`);
  lastKeys = keys;
}
ctx.log("\\n✓ final object:");
ctx.log(JSON.stringify(final, null, 2));
return { snapshots: snaps, final };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & advanced shapes

- \`generateObject({ schema, prompt })\` → typed object, validated, auto-retried.
- \`streamObject({ schema, prompt })\` → \`partialObjectStream\` that yields ever-more-complete objects.
- \`output: "array"\` → stream elements one-by-one (great for lists, search results).
- \`output: "enum"\` → restrict to a literal string — perfect for cheap classifiers.
- \`output: "no-schema"\` → free JSON. Use sparingly.

### Patterns to know

| Pattern | Shape |
| --- | --- |
| Classifier | \`generateObject({ output: "enum", enum: ["spam","ham"] })\` |
| Search results | \`generateObject({ output: "array", schema: z.object({ title, url, snippet }) })\` |
| Form pre-fill | \`streamObject\` rendered live in the UI as the user pastes a paragraph |
| Multi-tool plan | \`generateObject\` with \`steps: z.array(z.object({ tool, args }))\` — then execute the plan yourself |

Pair this with Notebook 3 (\`tool\`) and you have the entire Vercel agent toolkit.`,
    },
  ],
};
