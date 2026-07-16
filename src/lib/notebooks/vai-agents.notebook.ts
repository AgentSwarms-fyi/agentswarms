import type { Notebook } from "./types";

export const vaiAgentsNotebook: Notebook = {
  id: "vai-agents",
  title: "The Agent Class — stopWhen, prepareStep, hasToolCall",
  description:
    "Wrap the multi-step loop in the SDK's Agent class. Use stopWhen with hasToolCall to exit on a specific tool fire, and prepareStep to mutate the loop per step.",
  difficulty: "advanced",
  tags: ["agent"],
  subgroup: "Tools & Agents",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 4 · The \`Agent\` Class — Ergonomics on the Loop

The bare \`generateText({ tools, stopWhen })\` shape works, but for repeated use the Vercel AI SDK ships an **\`Agent\`** class that bundles model + system + tools + stop condition into one reusable object.

\`\`\`ts
import { Agent } from "ai";
import { tool, stepCountIs, hasToolCall } from "ai";

const researcher = new Agent({
  model:     openai("gpt-5"),
  system:    "You are a research assistant. Use tools to gather facts before answering.",
  tools:     { search, fetchPage, summarise },
  stopWhen:  [stepCountIs(8), hasToolCall("summarise")],   // ← stop on EITHER condition
});

const { text, steps } = await researcher.generate({ prompt: "Brief me on the EU AI Act." });
\`\`\`

### Key \`Agent\` knobs

| Knob | What it does |
| --- | --- |
| \`stopWhen: StopCondition[]\` | Array of predicates — the loop exits when ANY returns true. Built-ins below. |
| \`prepareStep({ steps, stepNumber, model, messages })\` | Called before each step. Return a mutated \`{ model, system, tools, messages }\` for the next call only. |
| \`onStepFinish(step)\` | Fired after each completed step (tool calls executed). |
| \`activeTools\` | Subset of tools that are "live" at any given moment — toggle them per step. |
| \`maxRetries\` | Per-step retry budget on transient errors. |
| \`experimental_telemetry\` | Per-agent OpenTelemetry config. |

### Built-in stop conditions

| Condition | Stops when… |
| --- | --- |
| \`stepCountIs(n)\` | The loop has run \`n\` steps. |
| \`hasToolCall("toolName")\` | The model calls a specific tool — perfect for "stop on \`done()\`". |

You combine them with a plain array — the loop exits on the **first** condition that becomes true.

Below we build an agent that gathers facts via tools, then stops the moment it calls \`submitAnswer\`.`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## 1 · An Agent that loops until it calls \`submitAnswer\`

The pattern: give the agent worker tools (\`lookupFact\`) **plus** a sentinel \`submitAnswer\` tool. The agent freely calls the workers, and when it's ready it calls \`submitAnswer\` — which trips \`hasToolCall\` and ends the loop with a structured payload.

> This is the canonical "ReAct + final-answer-as-tool" pattern, made first-class by the Vercel SDK.`,
    },
    {
      id: "agent", kind: "code", language: "js", runtime: "browser",
      source: `const z = ctx.lc.z;

// Stop-condition primitives — same names + semantics as the SDK.
const stepCountIs = (n) => (steps) => steps.length >= n;
const hasToolCall  = (name) => (steps) => steps.some((s) => s.toolCalls?.some((c) => c.toolName === name));

// A fake knowledge base for our worker tool.
const KB = {
  "EU AI Act effective date": "Phased rollout starting August 2024 — general-purpose model rules apply from Aug 2025.",
  "EU AI Act risk tiers":     "Four tiers: unacceptable, high, limited, minimal. Different obligations per tier.",
  "EU AI Act fines":          "Up to €35M or 7% of global turnover for prohibited-use violations.",
};

class Agent {
  constructor({ model, system, tools, stopWhen, prepareStep, onStepFinish }) {
    Object.assign(this, { model, system, tools, stopWhen, prepareStep, onStepFinish });
  }
  async generate({ prompt }) {
    const messages = [{ role: "system", content: this.system }, { role: "user", content: prompt }];
    const steps = [];
    let finalPayload = null;

    while (!this.stopWhen.some((cond) => cond(steps))) {
      const stepNumber = steps.length + 1;
      const ctxForPrep = { steps, stepNumber, model: this.model, system: this.system, tools: this.tools, messages };
      const prepared = this.prepareStep ? { ...ctxForPrep, ...(this.prepareStep(ctxForPrep) ?? {}) } : ctxForPrep;

      const toolSpecs = Object.entries(prepared.tools).map(([name, t]) => ({
        type: "function",
        function: { name, description: t.description, parameters: t.schema },
      }));

      const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
        body: JSON.stringify({ model: prepared.model, messages, tools: toolSpecs, tool_choice: "required" }),
      });
      const msg = (await res.json()).choices[0].message;
      messages.push(msg);

      const step = { text: msg.content ?? "", toolCalls: [] };
      for (const call of msg.tool_calls ?? []) {
        const args = JSON.parse(call.function.arguments || "{}");
        const out = await prepared.tools[call.function.name].execute(args);
        step.toolCalls.push({ toolName: call.function.name, args, result: out });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
        if (call.function.name === "submitAnswer") finalPayload = args;
      }
      steps.push(step);
      this.onStepFinish?.(step, stepNumber);
      if (!msg.tool_calls?.length) break;
    }

    return { steps, finalPayload, stoppedAtStep: steps.length };
  }
}

const tools = {
  lookupFact: {
    description: "Look up a fact in the internal knowledge base.",
    schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    execute: async ({ query }) => ({ result: KB[query] ?? "Not found. Try a different phrasing." }),
  },
  submitAnswer: {
    description: "Call this exactly once when you are ready to deliver the final report.",
    schema: {
      type: "object",
      properties: {
        title:   { type: "string" },
        summary: { type: "string" },
        sources: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["title", "summary", "sources"], additionalProperties: false,
    },
    execute: async (args) => ({ accepted: true, args }),
  },
};

const agent = new Agent({
  model: "google/gemini-3-flash-preview",
  system:
    "You are a policy researcher. Call lookupFact as many times as needed. " +
    "Try these queries: 'EU AI Act effective date', 'EU AI Act risk tiers', 'EU AI Act fines'. " +
    "When you have at least 2 facts, call submitAnswer with a structured report.",
  tools,
  // 👇 Loop ends on EITHER condition — whichever fires first.
  stopWhen: [stepCountIs(8), hasToolCall("submitAnswer")],

  // prepareStep: switch to a stronger model for the final step.
  prepareStep: ({ stepNumber }) => stepNumber >= 4 ? { model: "google/gemini-3-flash-preview" } : null,

  onStepFinish: (step, n) => {
    ctx.log(\`─── step \${n} ───\`);
    step.toolCalls.forEach((c) => ctx.log(\`  • \${c.toolName} \${JSON.stringify(c.args).slice(0,90)}\`));
  },
});

const { steps, finalPayload, stoppedAtStep } = await agent.generate({ prompt: "Brief me on the EU AI Act." });
ctx.log("\\n✓ stopped at step", stoppedAtStep);
ctx.log("✓ final structured answer:\\n" + JSON.stringify(finalPayload, null, 2));
return { stoppedAtStep, finalPayload };
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & advanced patterns

- The \`Agent\` class is **configuration over a loop** — model, system, tools, stop conditions, hooks.
- \`stopWhen: [stepCountIs(n), hasToolCall("done")]\` is the canonical "ReAct + sentinel tool" exit pattern.
- \`prepareStep\` lets you swap the model, edit the system, or hide tools per step.
- \`onStepFinish\` is where logging, persistence, and UI streaming go.

### Production patterns

| Pattern | Implementation |
| --- | --- |
| Sub-agent / supervisor | An agent's tool calls another agent's \`generate()\`. Nest indefinitely. |
| Tool-aware budget cap | \`prepareStep\` returns \`tools: omit("expensive_tool")\` once you've spent your budget. |
| Forced opener | Use \`toolChoice: { type: "tool", toolName: "plan" }\` on the first step only. |
| Self-correction loop | After step N, switch to a "Critic" system and ask the agent to revise its draft. |

You now have the full Vercel agent surface: **generateText / generateObject / tools / Agent / stopWhen / prepareStep**. The next two notebooks cover the auxiliary stacks: embeddings (RAG) and UI streaming.`,
    },
  ],
};
