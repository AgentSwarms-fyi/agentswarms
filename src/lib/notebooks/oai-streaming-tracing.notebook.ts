import type { Notebook } from "./types";

export const oaiStreamingTracingNotebook: Notebook = {
  id: "oai-streaming-tracing",
  title: "Streaming, Lifecycle Hooks & Tracing",
  description:
    "Stream tokens as they're generated, hook into lifecycle events (agent_start, tool_start, handoff_occurred…), and emit OpenTelemetry-compatible traces. The pieces that turn a prototype into a debuggable production agent.",
  difficulty: "advanced",
  tags: ["agent", "evaluation"],
  subgroup: "Observability",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 6 · Streaming, Hooks & Tracing — The Observability Layer

Three OpenAI SDK features keep your agent debuggable when things get gnarly:

### Streaming
Instead of waiting for the whole answer, get token deltas live. The SDK's \`run_streamed()\` returns an async iterator of typed events:

| Event type | Fires on |
| --- | --- |
| \`raw_model_stream_event\` | Every token chunk from the underlying model |
| \`run_item_stream_event\` | Higher-level items: tool_called, tool_output, message_output_created |
| \`agent_updated_stream_event\` | A handoff just happened — the active agent changed |

\`\`\`ts
import { Agent, Runner } from "@openai/agents";

const result = Runner.run_streamed(agent, "Plan my trip");
for await (const ev of result.stream_events()) {
  if (ev.type === "raw_model_stream_event" && ev.delta) process.stdout.write(ev.delta);
  if (ev.type === "agent_updated_stream_event")        console.log("→ now running:", ev.new_agent.name);
}
\`\`\`

### Lifecycle hooks
\`RunHooks\` and \`AgentHooks\` give you 5 callbacks: \`on_agent_start\`, \`on_agent_end\`, \`on_handoff\`, \`on_tool_start\`, \`on_tool_end\`. Perfect for metrics, audit logs, and side effects without polluting the agent's instructions.

### Tracing
Every run is wrapped in a top-level span (\`workflow_name\`) with nested spans for each agent call, tool call, handoff, and guardrail. The SDK exports these to:
- The OpenAI traces dashboard (default, free)
- Any OpenTelemetry collector (Honeycomb, Datadog, Jaeger, Langfuse, Braintrust…)
- Custom processors you write yourself.

Below we hand-roll all three so the wires are visible.`,
    },

    {
      id: "md-stream", kind: "markdown",
      source: `## 1 · Streaming + lifecycle hooks

We turn the OpenAI-compatible \`stream: true\` mode into the SDK's event taxonomy, and fire hooks at the right points. Watch the live log — tokens appear chunk-by-chunk.`,
    },
    {
      id: "stream", kind: "code", language: "js", runtime: "browser",
      source: `// Hooks — the exact shape RunHooks/AgentHooks use.
const hooks = {
  on_agent_start: (name)             => ctx.log("🟢 [hook] agent_start:", name),
  on_agent_end:   (name, outChars)   => ctx.log("🔵 [hook] agent_end:",   name, "—", outChars, "chars"),
  on_tool_start:  (name, args)       => ctx.log("🟡 [hook] tool_start:",  name, JSON.stringify(args)),
  on_tool_end:    (name, out)        => ctx.log("🟣 [hook] tool_end:",    name, "→", JSON.stringify(out)),
  on_handoff:     (from, to)         => ctx.log("🟠 [hook] handoff:",     from, "→", to),
};

async function runStreamed(agent, input) {
  hooks.on_agent_start(agent.name);

  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model: agent.model,
      stream: true,
      messages: [{ role: "system", content: agent.instructions }, { role: "user", content: input }],
    }),
  });

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let chunks = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          chunks++;
          if (chunks % 5 === 0) ctx.log("⚡ raw_model_stream_event δ chunk #" + chunks + ":", JSON.stringify(delta));
        }
      } catch { /* keepalives */ }
    }
  }

  hooks.on_agent_end(agent.name, full.length);
  return full;
}

const agent = {
  name: "Storyteller",
  model: "google/gemini-3-flash-preview",
  instructions: "Tell a short, vivid 4-sentence sci-fi micro-story.",
};

const story = await runStreamed(agent, "Set on Mars in 2095, featuring a sentient sandstorm.");
ctx.log("\\nFinal output:\\n" + story);
return { length: story.length };
`,
    },

    {
      id: "md-trace", kind: "markdown",
      source: `## 2 · A trace — nested spans for every step of the run

A trace is a tree of spans, each with: \`name\`, \`start\`, \`end\`, \`attributes\`, \`children\`. This is the OpenTelemetry-compatible shape the SDK exports.

> 💡 Open the *Analytics → Observability* tab in AgentSwarms to see the same shape rendered as a real waterfall.`,
    },
    {
      id: "trace", kind: "code", language: "js", runtime: "browser",
      source: `// A tiny span tree — same shape the SDK exports to OpenTelemetry.
class Tracer {
  constructor(workflow) { this.workflow = workflow; this.spans = []; }
  startSpan(name, attrs = {}) {
    const span = { name, attrs, start: Date.now(), end: null, children: [] };
    this.spans.push(span);
    return span;
  }
  endSpan(span, extra = {}) { span.end = Date.now(); Object.assign(span.attrs, extra); }
  toJSON() {
    return {
      workflow: this.workflow,
      total_ms: this.spans.reduce((m, s) => Math.max(m, s.end ?? 0), 0) -
                this.spans.reduce((m, s) => Math.min(m, s.start),     Infinity),
      spans: this.spans.map((s) => ({ name: s.name, ms: (s.end ?? Date.now()) - s.start, ...s.attrs })),
    };
  }
}

const tracer = new Tracer("ConciergeWorkflow");

// Span: triage agent decides who to hand off to
const triageSpan = tracer.startSpan("agent:Triage", { input: "I need to refund my order" });
await new Promise((r) => setTimeout(r, 120));
tracer.endSpan(triageSpan, { handoff_to: "Billing" });

// Span: handoff event
const handoffSpan = tracer.startSpan("handoff", { from: "Triage", to: "Billing" });
tracer.endSpan(handoffSpan);

// Span: billing agent runs, with a nested tool call
const billingSpan = tracer.startSpan("agent:Billing");
const toolSpan = tracer.startSpan("tool:lookup_order", { args: { id: "ord_123" } });
await new Promise((r) => setTimeout(r, 220));
tracer.endSpan(toolSpan, { result: "refundable=true" });
await new Promise((r) => setTimeout(r, 80));
tracer.endSpan(billingSpan, { output: "Refunded $42.00 to card ending 4242" });

const trace = tracer.toJSON();
ctx.log("─── TRACE: ConciergeWorkflow ───");
trace.spans.forEach((s) => ctx.log(\`  • [\${s.ms}ms] \${s.name}\`, JSON.stringify(s)));
return trace;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## Recap & what to bolt on in production

| Concern | SDK feature | Production pairing |
| --- | --- | --- |
| Live UI tokens | \`run_streamed\` + \`stream_events\` | SSE / Web Sockets to the browser |
| Audit log | \`RunHooks.on_tool_start\` / \`on_handoff\` | Append to your Postgres audit table |
| Latency breakdown | Trace spans | Honeycomb, Datadog, Langfuse |
| Replay & evals | Trace export + dataset | Run your eval suite against captured traces |
| Cost attribution | Span attributes (\`prompt_tokens\`, \`completion_tokens\`) | Roll up per user / per agent / per tool |

The SDK gives you the **shape**; you choose the **sink**. Default sink is the OpenAI Traces dashboard (zero config). Swap to Langfuse / Braintrust / your-own-collector with one \`set_trace_processors\` call.

You now have the full mental model: **Agents → Run loop → Tools → Handoffs → Guardrails → Structured Output → Sessions → Streaming → Hooks → Tracing**. Pair this track with the *Agentic Evals* track and you have everything you need to ship a real agent.`,
    },
  ],
};
