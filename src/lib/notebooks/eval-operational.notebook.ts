import type { Notebook } from "./types";

/**
 * Agentic Evals #8 — Operational Metrics.
 * Token cost, end-to-end latency, TTFT vs TTLT, inter-token latency,
 * tokens-per-second, concurrency throughput. All measured locally.
 */
export const evalOperationalNotebook: Notebook = {
  id: "eval-operational",
  title: "Operational Metrics — Cost, Latency, TTFT, TPS & Throughput",
  description:
    "Measure what production cares about: token cost per request, end-to-end latency, Time To First Token (TTFT) vs Time To Last Token (TTLT) using streaming, inter-token latency, and concurrent-request throughput.",
  difficulty: "advanced",
  tags: ["evaluation"],
  subgroup: "Safety & Operations",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 8 · Operational Metrics

Quality evals (accuracy, faithfulness, guardrails) tell you whether the agent is *right*. Operational evals tell you whether it's **shippable** under real load and cost constraints.

We measure five things in this notebook, all from the browser, against real model calls:

1. **Cost per request** — input tokens × in-price + output tokens × out-price.
2. **End-to-end latency** — wall clock time from request to response.
3. **TTFT vs TTLT** — using streaming, how quickly the user sees the *first* token vs the last.
4. **Inter-token latency** — average gap between tokens (smoothness of the stream).
5. **Throughput** — requests-per-minute under N concurrent callers.

Together these are what an SRE team looks at on a per-feature dashboard.`,
    },

    // ───────── prices
    {
      id: "md-p",
      kind: "markdown",
      source: `## Step 1 · Mini price book

Token prices change. These are sample numbers (USD per 1M tokens) — replace with the current sheet from your provider for real budgets.`,
    },
    {
      id: "prices",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Sample USD per 1M tokens. Replace with current values for real calculations.
const PRICES = {
  "google/gemini-2.5-flash":      { in: 0.30, out: 2.50 },
  "google/gemini-2.5-pro":        { in: 1.25, out: 10.00 },
  "openai/gpt-5-mini":            { in: 0.25, out: 2.00 },
  "openai/gpt-5":                 { in: 3.00, out: 15.00 },
};
ctx.state.PRICES = PRICES;

ctx.state.cost = (model, usage) => {
  const p = PRICES[model] ?? { in: 0, out: 0 };
  const inUsd  = (usage.prompt_tokens     ?? 0) / 1e6 * p.in;
  const outUsd = (usage.completion_tokens ?? 0) / 1e6 * p.out;
  return { in_usd: +inUsd.toFixed(6), out_usd: +outUsd.toFixed(6), total_usd: +(inUsd + outUsd).toFixed(6) };
};
return PRICES;
`,
    },

    // ───────── 1. cost & latency
    {
      id: "md-1",
      kind: "markdown",
      source: `## Step 2 · Cost + end-to-end latency across models

Same prompt, three models. We capture wall-clock latency, token usage, and computed cost. This is the table you put in a "which model do we ship?" doc.`,
    },
    {
      id: "compare",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { cost } = ctx.state;
const PROMPT = "Summarize the plot of Hamlet in exactly 3 bullet points.";
const MODELS = ["google/gemini-2.5-flash", "google/gemini-2.5-pro", "openai/gpt-5-mini"];

async function timeOne(model) {
  const start = performance.now();
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: PROMPT }] }),
  });
  const j = await res.json();
  const latency_ms = Math.round(performance.now() - start);
  return {
    model,
    latency_ms,
    tokens: j.usage,
    cost_usd: cost(model, j.usage ?? {}),
    answer: j.choices[0].message.content,
  };
}

const results = [];
for (const m of MODELS) results.push(await timeOne(m));
return results.map((r) => ({
  model: r.model,
  latency_ms: r.latency_ms,
  in_tokens:  r.tokens?.prompt_tokens,
  out_tokens: r.tokens?.completion_tokens,
  cost_usd:   r.cost_usd.total_usd,
  tokens_per_sec: r.tokens?.completion_tokens
    ? +(r.tokens.completion_tokens / (r.latency_ms / 1000)).toFixed(1)
    : null,
}));
`,
    },
    {
      id: "md-1x",
      kind: "markdown",
      source: `**Reading the table:** \`tokens_per_sec\` is your *throughput* per stream — useful for capacity planning. \`cost_usd\` × your expected daily volume gives the monthly bill. Pick the model where the cost/latency tradeoff fits the feature's tolerance.`,
    },

    // ───────── 2. streaming TTFT
    {
      id: "md-2",
      kind: "markdown",
      source: `## Step 3 · TTFT vs TTLT (streaming)

For a chat UI, users perceive responsiveness as **Time To First Token**, not Time To Last Token. A 4-second answer that *starts* at 200ms feels instant. A 1-second answer that pauses 800ms before any output feels broken.

We open a streaming connection and timestamp every token chunk.`,
    },
    {
      id: "ttft",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const MODEL = "google/gemini-2.5-flash";
const PROMPT = "Explain why the sky is blue, in 4 short paragraphs.";

const start = performance.now();
const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
  body: JSON.stringify({ model: MODEL, temperature: 0, stream: true,
                         messages: [{ role: "user", content: PROMPT }] }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
const chunkTimestamps = []; // ms since start, one per token chunk
let firstTokenAt = null;
let tokenCount = 0;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenAt == null) firstTokenAt = performance.now() - start;
        chunkTimestamps.push(performance.now() - start);
        tokenCount++;
      }
    } catch {}
  }
}

const ttft_ms = Math.round(firstTokenAt ?? -1);
const ttlt_ms = Math.round(chunkTimestamps.at(-1) ?? -1);
const gaps = chunkTimestamps.slice(1).map((t, i) => t - chunkTimestamps[i]);
const avgInterTokenMs = gaps.length ? +(gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(1) : null;
const tps = tokenCount && ttlt_ms ? +(tokenCount / (ttlt_ms/1000)).toFixed(1) : null;

return { model: MODEL, ttft_ms, ttlt_ms, chunks: tokenCount,
         avg_inter_token_ms: avgInterTokenMs, tokens_per_sec: tps };
`,
    },
    {
      id: "md-2x",
      kind: "markdown",
      source: `Typical TTFT for a small model: 200-600 ms. If you see TTFT > 1.5s, your users *will* think the app is broken.

**The fix when TTFT is bad** is almost never a faster model — it's:
- Removing pre-call work (skip an unneeded embedding lookup).
- Streaming a placeholder ("Thinking…") while you wait.
- Pre-warming the connection with HTTP keep-alive.`,
    },

    // ───────── 3. concurrency throughput
    {
      id: "md-3",
      kind: "markdown",
      source: `## Step 4 · Concurrent throughput

Real production sends multiple requests in parallel. We fire 8 concurrent requests, measure how long the whole batch takes, and convert to requests-per-minute.

Watch for **tail latency** — the slowest request in the batch usually drives perceived latency for a UI that's waiting on all of them.`,
    },
    {
      id: "concur",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const MODEL = "google/gemini-2.5-flash";
const N = 8;
const PROMPT = "In one sentence, name a fruit.";

const start = performance.now();
const tasks = Array.from({ length: N }, async (_, i) => {
  const t0 = performance.now();
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({ model: MODEL, temperature: 0.9,
                           messages: [{ role: "user", content: PROMPT + " (req " + i + ")" }] }),
  });
  const j = await res.json();
  return { req: i, latency_ms: Math.round(performance.now() - t0),
           answer: j.choices[0].message.content.slice(0, 60) };
});
const out = await Promise.all(tasks);
const batch_ms = Math.round(performance.now() - start);

const sorted = [...out].map((x) => x.latency_ms).sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

return {
  concurrent_requests: N,
  batch_total_ms: batch_ms,
  effective_rpm: +((N / (batch_ms / 1000)) * 60).toFixed(1),
  latency_p50_ms: p(0.50),
  latency_p95_ms: p(0.95),
  latency_max_ms: sorted.at(-1),
  per_request: out,
};
`,
    },
    {
      id: "md-end",
      kind: "markdown",
      source: `### Putting it on a dashboard

A minimal production dashboard for any LLM-backed feature:

| Metric | Source | Alert threshold (example) |
|---|---|---|
| p50 / p95 / p99 latency | per-request timing | p95 > 2× rolling 24h baseline |
| TTFT p95 (streamed UIs) | streaming code path | > 1.5s |
| Tokens / sec | usage / latency | < 30 tps sustained |
| Cost per request | usage × price book | > 1.5× baseline |
| Throttling / 429 rate | response status | > 0.5% |

When something feels wrong in production, you don't open the chat — you open this dashboard.

### You finished the Agentic Evals track 🎉
You can now grade an agent on quality (deterministic, semantic, judge, jury), validate the judge itself, diagnose RAG failures with the triad, score trajectories, harden against adversarial input, and measure operational cost / latency. Next: pick any of the LangChain or LlamaIndex notebooks and wire these evaluators into the agents you've already built.`,
    },
  ],
};
