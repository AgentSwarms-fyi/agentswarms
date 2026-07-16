import type { Notebook } from "./types";

export const voltWorkflowsNotebook: Notebook = {
  id: "volt-workflows",
  title: "Workflows — createWorkflowChain, andThen, andAgent, andAll, andWhen",
  description:
    "VoltAgent's typed step graph: createWorkflowChain() composed via .andThen / .andAgent / .andAll / .andWhen with Zod input/output schemas. Build a content pipeline and watch the types flow.",
  difficulty: "intermediate",
  tags: ["agent", "structured-output"],
  subgroup: "Workflows",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 8 · Workflows — typed step graphs with \`createWorkflowChain\`

A VoltAgent **workflow** is a typed, replayable chain of steps. Unlike an Agent (which improvises a tool-call loop), a workflow is **deterministic at the structural level**: the order of steps, what each takes, and what it returns are decided up front. The model only runs inside the steps you tell it to.

Step helpers you'll meet:

| Helper | Purpose |
| --- | --- |
| \`andThen\` | Plain TypeScript function — transform, fetch, validate |
| \`andAgent\` | Run an Agent and get structured output via a Zod \`schema\` |
| \`andAll\` | Fan out and run steps in parallel; results merged |
| \`andWhen\` | Conditional step; only runs if predicate matches |
| \`andRace\` / \`andTap\` | First-wins / pass-through side effect |

We'll build a 5-step content pipeline below, one piece at a time, so you can read each cell, run it, and see the trace grow.`,
    },

    {
      id: "md-chat", kind: "markdown",
      source: `## Step 1 · The shared \`chat()\` helper + tiny schema describer

All \`andAgent\` steps call the model with JSON-mode and parse against a Zod schema. We need one tiny helper to convert a Zod object into a plain-English shape we can paste into the prompt.`,
    },
    {
      id: "code-chat", kind: "code", language: "js", runtime: "browser",
      source: `const AI = ctx.aiBaseURL, KEY = ctx.aiApiKey;
globalThis.z = ctx.lc.z;

globalThis.chat = async function chat(messages, json = false) {
  const r = await ctx.fetch(\`\${AI}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview", messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message ?? r.statusText);
  return data.choices[0].message.content;
};

globalThis.describeSchema = function describeSchema(s) {
  const def = s?._def ?? s?.def ?? s?._zod?.def ?? {};
  const type = def.typeName ?? def.type;
  if (type === "ZodObject" || type === "object") {
    const rawShape = def.shape ?? s.shape;
    const shape = typeof rawShape === "function" ? rawShape() : rawShape;
    const out = {};
    for (const [k, v] of Object.entries(shape ?? {})) out[k] = describeSchema(v);
    return out;
  }
  if (type === "ZodArray" || type === "array") {
    const inner = describeSchema(def.element ?? (typeof def.type === "string" ? undefined : def.type));
    const checkDefs = (def.checks ?? []).map((c) => c?._zod?.def ?? c?._def ?? c);
    const min = def.minLength?.value ?? checkDefs.find((c) => c?.minimum !== undefined)?.minimum;
    const max = def.maxLength?.value ?? checkDefs.find((c) => c?.maximum !== undefined)?.maximum;
    const exact = def.exactLength?.value ?? checkDefs.find((c) => c?.length !== undefined)?.length;
    const checks = [];
    if (exact !== undefined) checks.push(\`length=\${exact}\`);
    if (min !== undefined) checks.push(\`min=\${min}\`);
    if (max !== undefined) checks.push(\`max=\${max}\`);
    return \`array<\${typeof inner === "string" ? inner : JSON.stringify(inner)}>\${checks.length ? \` (\${checks.join(", ")})\` : ""}\`;
  }
  if (type === "ZodNumber" || type === "number") return "number";
  if (type === "ZodBoolean" || type === "boolean") return "boolean";
  if (type === "ZodString" || type === "string") return "string";
  return type ? String(type).replace(/^Zod/, "").toLowerCase() : "any";
};


ctx.log("helpers ready: chat(), describeSchema(), z");
return "ok";
`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## Step 2 · A minimal Agent with \`generateObject(prompt, schema)\`

\`andAgent\` calls \`agent.generateObject(...)\` under the hood and validates the result against the step's Zod schema. Here's the smallest version that actually works.`,
    },
    {
      id: "code-agent", kind: "code", language: "js", runtime: "browser",
      source: `// Build a concrete example JSON from a described shape, so the model has
// something unambiguous to mimic.
function exampleFor(shape) {
  if (shape && typeof shape === "object" && !Array.isArray(shape)) {
    const o = {};
    for (const [k, v] of Object.entries(shape)) o[k] = exampleFor(v);
    return o;
  }
  if (typeof shape === "string") {
    if (shape.startsWith("array<string>")) return ["item one", "item two", "item three"];
    if (shape.startsWith("array<number>")) return [1, 2, 3];
    if (shape.startsWith("array"))         return ["example"];
    if (shape === "number")  return 0;
    if (shape === "boolean") return true;
    return "example";
  }
  return null;
}

// Best-effort coercion so common model drift doesn't crash schema.parse().
function coerceToShape(value, shape, topLevelKeys) {
  if (Array.isArray(value) && shape && typeof shape === "object" && !Array.isArray(shape)) {
    const keys = Object.keys(shape);
    if (keys.length === 1 && typeof shape[keys[0]] === "string" && shape[keys[0]].startsWith("array")) {
      return { [keys[0]]: value };
    }
  }
  // Unwrap single-key wrapper objects like {"result": {...}} or {"outline": [...]}.
  if (value && typeof value === "object" && !Array.isArray(value) && topLevelKeys) {
    const keys = Object.keys(value);
    const hasAny = keys.some((k) => topLevelKeys.includes(k));
    if (!hasAny && keys.length === 1) {
      const inner = value[keys[0]];
      if (inner && typeof inner === "object") value = inner;
    }
  }
  if (Array.isArray(value) && shape && typeof shape === "object" && !Array.isArray(shape)) {
    const keys = Object.keys(shape);
    if (keys.length === 1 && typeof shape[keys[0]] === "string" && shape[keys[0]].startsWith("array")) {
      return { [keys[0]]: value };
    }
  }
  if (shape && typeof shape === "object" && !Array.isArray(shape) && value && typeof value === "object") {
    const out = { ...value };
    for (const [k, sub] of Object.entries(shape)) {
      const expectsArray = typeof sub === "string" && sub.startsWith("array");
      const expectsString = sub === "string";
      let v = out[k];
      // Find by alias if missing.
      if (v === undefined) {
        const aliases = [k + "s", k.replace(/s$/, ""), "items", "list", "outline", "sections", "points", "values"];
        for (const a of aliases) {
          if (out[a] !== undefined) { v = out[a]; break; }
        }
      }
      if (expectsArray) {
        if (typeof v === "string") {
          v = v.split(/\\n|;|,/).map((s) => s.trim()).filter(Boolean);
        } else if (v && typeof v === "object" && !Array.isArray(v)) {
          const numeric = Object.keys(v).every((kk) => /^\\d+$/.test(kk));
          if (numeric) v = Object.keys(v).sort((a,b)=>+a-+b).map((kk) => v[kk]);
        }
      } else if (expectsString && Array.isArray(v)) {
        v = v.join("\\n");
      }
      out[k] = v;
    }
    return out;
  }
  return value;
}

class Agent {
  constructor({ name, instructions }) { Object.assign(this, { name, instructions }); }
  async generateObject(prompt, schema) {
    const shape = describeSchema(schema);
    const example = exampleFor(shape);
    const topKeys = shape && typeof shape === "object" ? Object.keys(shape) : null;
    const sys = \`\${this.instructions}
Return ONLY a valid JSON object. No prose, no markdown fences, no wrapper key.
The object MUST match this shape exactly (types and array constraints are strict):
\${JSON.stringify(shape, null, 2)}
Concrete example of a valid response (use the same KEYS, vary the values):
\${JSON.stringify(example, null, 2)}
Rules:
- Return the object directly. Do NOT nest under "result", "data", "output" etc.
- For any "array<...>" field, return a real JSON array — never a comma-separated string.\`;

    const parseRaw = (raw) => {
      const cleaned = raw.trim().replace(/^\`\`\`(?:json)?\\s*|\\s*\`\`\`$/g, "");
      return JSON.parse(cleaned);
    };

    const attempt = async (messages) => {
      const raw = await chat(messages, true);
      let parsed;
      try { parsed = parseRaw(raw); }
      catch (e) { return { ok: false, raw, error: new Error("Model did not return JSON: " + raw.slice(0, 200)) }; }
      const coerced = coerceToShape(parsed, shape, topKeys);
      const result = schema.safeParse(coerced);
      if (result.success) return { ok: true, data: result.data };
      return { ok: false, raw, error: result.error };
    };

    const messages = [
      { role: "system", content: sys },
      { role: "user",   content: prompt },
    ];
    let res = await attempt(messages);
    if (res.ok) return res.data;

    // One corrective retry with the bad output + error in-context.
    const retryMessages = [
      ...messages,
      { role: "assistant", content: res.raw },
      { role: "user", content: \`That response did not match the required schema. Error:\\n\${res.error.message}\\nReturn the corrected JSON only, matching the shape exactly.\` },
    ];
    res = await attempt(retryMessages);
    if (res.ok) return res.data;

    ctx.log("⚠️ generateObject failed. Last raw model output:\\n" + res.raw);
    throw res.error;
  }
}
globalThis.Agent = Agent;

globalThis.outliner = new Agent({ name: "outliner", instructions: "You outline LinkedIn posts. Be specific." });
globalThis.angle    = new Agent({ name: "angle",    instructions: "You pick the single sharpest angle." });

ctx.log("agents ready:", outliner.name, "·", angle.name);
return "ok";
`,
    },

    {
      id: "md-chain", kind: "markdown",
      source: `## Step 3 · Build \`createWorkflowChain\` itself

The real \`@voltagent/core\` version is hundreds of lines (observability, replay, suspend/resume). The *core* idea fits on one screen: a list of steps and a runner that walks them and records a trace.`,
    },
    {
      id: "code-chain", kind: "code", language: "js", runtime: "browser",
      source: `function createWorkflowChain({ id, input }) {
  const steps = [];
  const addStep = (step) => {
    const existing = steps.findIndex((s) => s.id === step.id);
    if (existing >= 0) steps[existing] = step;
    else steps.push(step);
    return api;
  };
  const api = {
    andThen({ id, execute })                { return addStep({ kind: "then",  id, execute }); },
    andAgent({ id, agent, schema, prompt }) { return addStep({ kind: "agent", id, agent, schema, prompt }); },
    andAll({ id, fanout })                  { return addStep({ kind: "all",   id, fanout }); },
    andWhen({ id, when, then })             { return addStep({ kind: "when",  id, when, then }); },
    async run(initial) {
      let data = input.parse(initial);
      const trace = [];
      for (const step of steps) {
        const t0 = Date.now();
        if (step.kind === "then")  data = await step.execute({ data });
        if (step.kind === "agent") data = { ...data, ...(await step.agent.generateObject(step.prompt(data), step.schema)) };
        if (step.kind === "all") {
          const fanout = step.fanout(data);
          const results = await Promise.all(fanout.map(s => s.execute({ data })));
          data = { ...data, [step.id]: results };
        }
        if (step.kind === "when" && step.when({ data })) data = { ...data, ...(await step.then({ data })) };
        trace.push({ step: step.id, ms: Date.now() - t0, keys: Object.keys(data) });
      }
      return { data, trace };
    },
  };
  return api;
}
globalThis.createWorkflowChain = createWorkflowChain;

ctx.log("createWorkflowChain ready · helpers: andThen, andAgent, andAll, andWhen");
return "ok";
`,
    },

    {
      id: "md-normalise", kind: "markdown",
      source: `## Step 4 · First step — \`andThen\` (pure transform)

A plain function step that normalises the topic string. No model call. This is the cheapest, most deterministic step type — use it liberally for I/O, validation, and shaping.`,
    },
    {
      id: "code-normalise", kind: "code", language: "js", runtime: "browser",
      source: `globalThis.pipeline = createWorkflowChain({
  id: "content-pipeline",
  input: z.object({ topic: z.string() }),
}).andThen({
  id: "normalise-topic",
  execute: async ({ data }) => ({ ...data, topic: data.topic.trim().toLowerCase() }),
});

const { data, trace } = await pipeline.run({ topic: "  Why Agent Observability Is The New APM  " });
ctx.log("trace:", trace);
ctx.log("data:", data);
return data;
`,
    },

    {
      id: "md-outline", kind: "markdown",
      source: `## Step 5 · Add \`andAgent\` — structured outline via Zod

Now we hand the topic to the \`outliner\` agent and demand a typed \`{ sections: string[] }\` back. If the model returns anything else, \`schema.parse()\` throws and the workflow fails loudly.`,
    },
    {
      id: "code-outline", kind: "code", language: "js", runtime: "browser",
      source: `pipeline.andAgent({
  id: "outline",
  agent: outliner,
  schema: z.object({ sections: z.array(z.string()).min(3).max(5) }),
  prompt: (d) => \`Outline a 200-word LinkedIn post about: \${d.topic}\`,
});

const { data, trace } = await pipeline.run({ topic: "Why agent observability is the new APM" });
ctx.log("trace:", trace.map(t => \`\${t.step} (\${t.ms}ms)\`).join(" → "));
ctx.log("sections:", data.sections);
return data.sections;
`,
    },

    {
      id: "md-angle", kind: "markdown",
      source: `## Step 6 · Chain a second \`andAgent\` — pick the angle

Steps see all prior data. The \`pick-angle\` agent receives the sections produced in step 5 and emits a single sentence.`,
    },
    {
      id: "code-angle", kind: "code", language: "js", runtime: "browser",
      source: `pipeline.andAgent({
  id: "pick-angle",
  agent: angle,
  schema: z.object({ angle: z.string() }),
  prompt: (d) => \`Given these sections, pick the single sharpest angle in one sentence:\\n\${d.sections.join("\\n")}\`,
});

const { data } = await pipeline.run({ topic: "Why agent observability is the new APM" });
ctx.log("angle:", data.angle);
return data.angle;
`,
    },

    {
      id: "md-fanout", kind: "markdown",
      source: `## Step 7 · \`andAll\` — fan out drafts in parallel

For each section we kick off a draft in parallel. Real \`andAll\` accepts step descriptors; ours accepts \`{ execute }\` closures so the cell stays compact.`,
    },
    {
      id: "code-fanout", kind: "code", language: "js", runtime: "browser",
      source: `pipeline.andAll({
  id: "drafts",
  fanout: (d) => d.sections.map(s => ({
    execute: async () => ({
      section: s,
      draft: await chat([
        { role: "system", content: "Write one tight paragraph (≤60 words). Angle: " + d.angle },
        { role: "user",   content: \`Section: \${s}\` },
      ]),
    }),
  })),
});

const { data } = await pipeline.run({ topic: "Why agent observability is the new APM" });
ctx.log("drafts produced:", data.drafts.length);
for (const d of data.drafts) ctx.log(\`  · \${d.section}\\n    \${d.draft.slice(0, 120)}…\`);
return data.drafts.length;
`,
    },

    {
      id: "md-gate", kind: "markdown",
      source: `## Step 8 · \`andWhen\` — conditional publish gate

Only assemble the final post if we got enough drafts. \`andWhen\` is also where you'd \`suspend()\` for human approval in real VoltAgent.`,
    },
    {
      id: "code-gate", kind: "code", language: "js", runtime: "browser",
      source: `pipeline.andWhen({
  id: "publish-gate",
  when: ({ data }) => data.drafts.length >= 3,
  then: async ({ data }) => ({
    post: data.drafts.map(d => \`## \${d.section}\\n\${d.draft}\`).join("\\n\\n"),
  }),
});

const { data, trace } = await pipeline.run({ topic: "Why agent observability is the new APM" });

ctx.log("─── full trace ───");
for (const t of trace) ctx.log(\`  · \${t.step.padEnd(16)} (\${t.ms}ms) → keys: [\${t.keys.join(", ")}]\`);
ctx.log("\\n─── final post ───\\n" + (data.post ?? "(below threshold)"));

return { sections: data.sections.length, postChars: data.post?.length ?? 0 };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap

You composed a typed 5-step chain with the exact \`createWorkflowChain\` shape VoltAgent ships:

\`\`\`text
input(Zod) → andThen → andAgent → andAgent → andAll(fanout) → andWhen → output
\`\`\`

In real \`@voltagent/core\`:

- **Replayability** — every step's input/output is recorded; replay from any point with the same inputs.
- **Observability** — every step shows up in VoltOps Console with timing, payloads, errors.
- **Suspend / resume** — \`andWhen\` can pause for a human; resumes when they respond.
- **End-to-end types** — output schemas chain through; rename a field in step 2 and step 4 fails to compile.

This is VoltAgent's answer to LangGraph: deterministic structure in code, improvisation inside agents.`,
    },
  ],
};
