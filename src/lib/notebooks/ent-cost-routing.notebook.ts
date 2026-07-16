import type { Notebook } from "./types";

export const entCostRoutingNotebook: Notebook = {
  id: "ent-cost-routing",
  title: "Dynamic Cost-Optimized Routing Gateway",
  description:
    "Stop sending every query to the most expensive model. This notebook builds a routing gateway that measures input complexity (token length + structural heuristics + an optional cheap classifier), then routes simple queries to a small model and only escalates to a heavy reasoner when it's actually needed.",
  difficulty: "advanced",
  tags: ["langchain", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Cost-Optimized Routing

\`\`\`
        ┌──────────────────────────────────┐
query → │ complexity score (length + rules)│
        └────────────────┬─────────────────┘
                         │
            score < 4    │    score in 4..7      score > 7
                ▼        ▼                          ▼
        ┌──────────┐  ┌──────────┐         ┌──────────┐
        │   nano   │  │   mini   │         │   pro    │
        │  $cheap  │  │  $$      │         │  $$$$    │
        └──────────┘  └──────────┘         └──────────┘
\`\`\`

The mistake every team makes: shipping with \`gpt-5.5\` (or \`gemini-2.5-pro\`) for **every** call. 80% of queries are "summarise this" or "extract these fields" — work a nano model finishes in 200ms for fractions of a cent. The remaining 20% genuinely need a reasoner.

A routing gateway in front of your LLM call collapses that bill by 5–20× without users noticing. The pattern is dead simple: score the query, pick the model, run it, log the cost.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · The model tier table\n\nThese are real Lovable AI Gateway models with rough price tiers. The actual per-million-token pricing changes — what matters is the **ratio** between tiers (nano is roughly 30× cheaper than pro). Latency tiers are equally real: nano returns in a few hundred ms, pro can take 5–15s with thinking.` },
    {
      id: "tiers", kind: "code", language: "js", runtime: "browser",
      source: `// Costs are illustrative ratios (per million tokens), not live pricing.
const TIERS = {
  nano: { model: "google/gemini-3.1-flash-lite-preview", in: 0.04, out: 0.15, label: "nano  ($)" },
  mini: { model: "google/gemini-3-flash-preview",        in: 0.25, out: 0.80, label: "mini  ($$)" },
  pro:  { model: "google/gemini-3.1-pro-preview",        in: 1.25, out: 5.00, label: "pro   ($$$$)" },
};

ctx.state.TIERS = TIERS;
return Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, v.label + " — " + v.model]));
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The complexity scorer\n\nA combination of cheap signals adds up to a 0-10 score:\n- **Length** — long inputs usually need more capability.\n- **Reasoning verbs** — words like *prove*, *derive*, *plan*, *compare* signal multi-step work.\n- **Code / math markers** — \`\`\`fenced blocks, equations, multiple parens.\n- **Multi-turn / nested questions** — chained "and then…", multiple question marks.\n\nNone of these need an LLM call. They run in microseconds.` },
    {
      id: "scorer", kind: "code", language: "js", runtime: "browser",
      source: `function scoreComplexity(query) {
  const q = query.toLowerCase();
  let score = 0;
  const breakdown = {};

  // Length: every 200 chars adds 1, capped at 4.
  const lenPoints = Math.min(4, Math.floor(query.length / 200));
  score += lenPoints; breakdown.length = lenPoints;

  // Reasoning verbs
  const reasoningVerbs = ["prove", "derive", "plan", "design", "architect", "compare", "evaluate", "critique", "analyze", "analyse", "trade-off", "tradeoff", "optimize", "optimise"];
  const verbHits = reasoningVerbs.filter((v) => q.includes(v)).length;
  score += Math.min(3, verbHits); breakdown.reasoning_verbs = Math.min(3, verbHits);

  // Code / math markers
  let codeMath = 0;
  if (/\`\`\`/.test(query)) codeMath += 2;
  if (/[=+\\-*/]\\s*[a-zA-Z0-9]/.test(query) && /[a-z]\\s*\\(/.test(query)) codeMath += 1;
  if ((query.match(/[()]/g)?.length ?? 0) > 6) codeMath += 1;
  score += Math.min(2, codeMath); breakdown.code_math = Math.min(2, codeMath);

  // Multi-question / chained
  const qMarks = (query.match(/\\?/g) ?? []).length;
  const chains = (q.match(/\\b(and then|after that|finally)\\b/g) ?? []).length;
  const chainPts = Math.min(2, (qMarks > 1 ? 1 : 0) + chains);
  score += chainPts; breakdown.chained = chainPts;

  return { score: Math.min(10, score), breakdown };
}

ctx.state.scoreComplexity = scoreComplexity;

// Quick sanity check on three sample queries
const samples = [
  "Translate 'good morning' into Japanese.",
  "Summarise the following 3 paragraphs and pull out any dates: ...",
  "Design a fault-tolerant event-sourced ordering service. Compare event store vs CDC trade-offs, then derive the minimum partition count for 10k orders/sec. Finally, prove the invariant that no order is double-charged.",
];
return samples.map((s) => ({ q: s.slice(0, 60) + (s.length > 60 ? "…" : ""), ...scoreComplexity(s) }));
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · The router\n\nTurn the score into a tier. Boundaries are deliberately fuzzy — most teams add an override mechanism so power users can force a tier from the UI.` },
    {
      id: "router", kind: "code", language: "js", runtime: "browser",
      source: `function pickTier(score) {
  if (score >= 7) return "pro";
  if (score >= 4) return "mini";
  return "nano";
}

ctx.state.pickTier = pickTier;
return [0, 2, 4, 6, 8, 10].map((s) => ({ score: s, tier: pickTier(s) }));
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · The routed gateway\n\nOne function: score → pick model → run → return answer plus cost report. We use the OpenAI-compatible \`fetch\` directly so we can capture \`usage\` from the gateway response (this is the only reliable source of token counts).` },
    {
      id: "gateway", kind: "code", language: "js", runtime: "browser",
      source: `async function routedComplete(query) {
  const { score, breakdown } = ctx.state.scoreComplexity(query);
  const tier = ctx.state.pickTier(score);
  const cfg = ctx.state.TIERS[tier];

  const start = Date.now();
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + ctx.aiApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: query }],
    }),
  });
  const json = await res.json();
  const ms = Date.now() - start;

  const usage = json.usage ?? {};
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  const costUsd = (inTok / 1_000_000) * cfg.in + (outTok / 1_000_000) * cfg.out;

  return {
    tier, score, breakdown,
    model: cfg.model,
    latency_ms: ms,
    tokens: { in: inTok, out: outTok },
    cost_usd: +costUsd.toFixed(6),
    answer: json.choices?.[0]?.message?.content ?? "(no content)",
  };
}

ctx.state.routedComplete = routedComplete;
return { ready: true };
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Run a mixed traffic batch\n\nThree queries of different complexity, all going through the same gateway. Look at the cost column: even on this tiny sample, sending everything to \`pro\` would be 4–8× more expensive than the routed total.` },
    {
      id: "batch", kind: "code", language: "js", runtime: "browser",
      source: `const QUERIES = [
  "What's the capital of France?",
  "Summarise: 'The Roman aqueducts carried water across long distances using only gravity. They influenced European hydraulics for nearly two thousand years.' In one sentence.",
  "Design a sharded queue system that guarantees exactly-once delivery across 5 regions. Compare Kafka vs NATS vs SQS-FIFO for this workload, derive the worst-case end-to-end latency given 80ms inter-region RTT, and prove that no duplicates can occur during a region failover.",
];

const results = [];
for (const q of QUERIES) {
  const r = await ctx.state.routedComplete(q);
  ctx.log("[" + r.tier.padEnd(4) + "] score=" + r.score + " | " + r.tokens.in + "→" + r.tokens.out + " tok | $" + r.cost_usd + " | " + r.latency_ms + "ms");
  results.push({ query: q.slice(0, 70) + (q.length > 70 ? "…" : ""), tier: r.tier, score: r.score, tokens: r.tokens, cost_usd: r.cost_usd, latency_ms: r.latency_ms });
}

const total = results.reduce((s, r) => s + r.cost_usd, 0);
const proCfg = ctx.state.TIERS.pro;
const allProCost = results.reduce((s, r) => s + (r.tokens.in / 1e6) * proCfg.in + (r.tokens.out / 1e6) * proCfg.out, 0);

ctx.log("");
ctx.log("ROUTED total: $" + total.toFixed(6));
ctx.log("ALL-PRO total: $" + allProCost.toFixed(6) + "  (" + (allProCost / total).toFixed(1) + "× more)");

return { results, routed_total: +total.toFixed(6), all_pro_total: +allProCost.toFixed(6), savings_multiple: +(allProCost / total).toFixed(2) };
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Edit the scorer to **escalate on the response**: if a nano answer contains "I'm not sure" or fewer than N words, re-run it on \`mini\`. This "retry-with-bigger-model" is how Cursor and Perplexity handle borderline queries.\n- Replace the heuristic scorer in cell 2 with a single \`nano\`-tier classification call: *"Rate this query's reasoning difficulty 1-10 in one number."* You pay one nano call per query to potentially save a pro call. Compare the routing decisions to the heuristic version.\n- Add a **latency budget** override: if \`latency_ms\` matters more than cost (e.g. a chat UI), force \`nano\` for queries with score ≤ 5 regardless of length. Production routers are always 2-axis: cost × latency.` },
  ],
};
