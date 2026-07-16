import type { Notebook } from "./types";

/**
 * Real-world example 5 — Personal AI Investment Analyst.
 *
 * Combines: two external "tools" (earnings transcript, market sentiment),
 * a structured Buy/Hold/Sell synthesis with catalysts + risks.
 */
export const rwInvestmentAnalystNotebook: Notebook = {
  id: "rw-investment-analyst",
  title: "Personal AI Investment Analyst",
  description:
    "Pull a stock ticker's latest earnings summary and live sentiment headlines from two tools, then synthesise a structured Buy/Hold/Sell micro-report with catalysts and risks.",
  difficulty: "intermediate",
  tags: ["agent", "structured-output", "fintech", "real-world"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 📈 Personal AI Investment Analyst

Equity research is one of the canonical "many small inputs, one careful synthesis" workflows — exactly the kind of thing LLMs are uniquely good at. Sell-side analysts spend most of their time reading transcripts, scanning headlines, and pattern-matching against historical setups. None of that work is **deciding**; it's all **assembling the brief**.

This notebook automates the assembly:

1. **Tool A** returns the most recent quarterly-earnings transcript summary.
2. **Tool B** returns the live price plus the last few market-sentiment headlines.
3. The agent merges both into a **structured \`{recommendation, conviction, catalysts[], risks[], horizon}\`** micro-report.

> ⚠️ This is a demo. The output is for learning how to wire tools + structured outputs together. It is not investment advice. Real production systems also feed in fundamentals, options flow, insider transactions, and compliance disclaimers, and they are reviewed by humans before any client ever sees them.`,
    },

    // ── Step 1: Tools ─────────────────────────────────────────────────────
    {
      id: "md-tools",
      kind: "markdown",
      source: `## Step 1 — Two "external" tools

Both tools below would normally be API calls — earnings transcripts from AlphaVantage / SeekingAlpha, prices and headlines from IEX / Polygon / Finnhub. We hard-code two tickers (AAPL, NVDA) so the notebook is self-contained, but the function signatures are identical to what you'd use against a live API. The agent never sees the difference.`,
    },
    {
      id: "tools",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — define the two tools (mocked but realistic shapes).
const TRANSCRIPTS = {
  AAPL: {
    quarter: "Q2 FY26",
    summary:
      "Services revenue +14% YoY, an all-time high. iPhone unit growth flat but ASP up. " +
      "Greater China revenue down 3% YoY, framed as 'FX-adjusted essentially flat.' " +
      "Management guided next-quarter Services to mid-teens growth; gross margin guide unchanged at 46–47%. " +
      "Capex guide raised on AI infrastructure buildout.",
  },
  NVDA: {
    quarter: "Q1 FY27",
    summary:
      "Data Center revenue $48B, +112% YoY. Blackwell ramping faster than internal plan, " +
      "fully booked through CY26. Guided next quarter to $52B (+24% QoQ). " +
      "Gross margin compressed 80bps on Blackwell mix; expected to recover by Q3. " +
      "Hyperscaler concentration risk acknowledged — top 4 customers ~46% of DC revenue.",
  },
};

const HEADLINES = {
  AAPL: {
    price_usd: 218.42,
    change_pct: -0.6,
    headlines: [
      { source: "Reuters",      text: "Apple loses EU antitrust appeal on App Store rules; €1.8B fine stands." },
      { source: "Bloomberg",    text: "Apple Intelligence rollout in China delayed pending regulator approval." },
      { source: "WSJ",          text: "Foxconn ramps India production to 25% of global iPhone output." },
    ],
  },
  NVDA: {
    price_usd: 932.10,
    change_pct: 2.3,
    headlines: [
      { source: "CNBC",         text: "TSMC says CoWoS capacity sold out through 2026; NVIDIA largest allocation." },
      { source: "Reuters",      text: "DOJ opens informal probe into hyperscaler GPU-allocation practices." },
      { source: "Bloomberg",    text: "Sovereign-AI orders from Saudi PIF expand to multi-billion contract." },
    ],
  },
};

ctx.state.fetchEarnings = async (ticker) => TRANSCRIPTS[ticker.toUpperCase()] ?? null;
ctx.state.fetchMarket   = async (ticker) => HEADLINES[ticker.toUpperCase()]  ?? null;

return { available_tickers: Object.keys(TRANSCRIPTS) };
`,
      sampleOutput: { result: { available_tickers: ["AAPL", "NVDA"] } },
    },

    // ── Step 2: Schema ────────────────────────────────────────────────────
    {
      id: "md-schema",
      kind: "markdown",
      source: `## Step 2 — The output schema

This is what makes the report *useful* instead of just text. A downstream UI can render the recommendation badge in colour, sort the catalyst/risk bullets, and present \`conviction\` as a meter. The schema also forces the model to be balanced — it cannot return zero risks or zero catalysts, so even a "buy" includes acknowledged downsides.`,
    },
    {
      id: "schema",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — pin down the analyst report shape.
const { z } = ctx.lc;

ctx.state.ReportSchema = z.object({
  ticker:         z.string(),
  recommendation: z.enum(["BUY", "HOLD", "SELL"]),
  conviction:     z.enum(["low", "medium", "high"]).describe("How confident the analyst is in the call."),
  horizon:        z.enum(["short", "medium", "long"]).describe("short=quarters, medium=1-2y, long=5y+"),
  thesis:         z.string().describe("2–3 sentences. The single biggest reason for the call."),
  catalysts:      z.array(z.string()).min(2).max(5).describe("Upside drivers, one per bullet."),
  risks:          z.array(z.string()).min(2).max(5).describe("Things that could break the thesis."),
});

return { schema: "ReportSchema ready" };
`,
      sampleOutput: { result: { schema: "ReportSchema ready" } },
    },

    // ── Step 3: Analyze ───────────────────────────────────────────────────
    {
      id: "md-analyze",
      kind: "markdown",
      source: `## Step 3 — Pull both data sources in parallel, then synthesize

We hit both tools with \`Promise.all\` (latency = max of the two, not sum) and pipe both blobs into a single \`withStructuredOutput\` call. The system prompt is short and *contains the guardrail* — the model is told to weight transcript fundamentals heavier than headlines, and to acknowledge headline risks even on a buy call.`,
    },
    {
      id: "analyze",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — the full analyzer.
const { ChatOpenAI } = ctx.lc.openai;

async function analyze(ticker) {
  const [earnings, market] = await Promise.all([
    ctx.state.fetchEarnings(ticker),
    ctx.state.fetchMarket(ticker),
  ]);
  if (!earnings || !market) throw new Error("No data for " + ticker);

  ctx.log("📊 " + ticker + " @ $" + market.price_usd + " (" + market.change_pct + "% today)");

  const llm = new ChatOpenAI({
    model: "google/gemini-3-flash-preview",
    temperature: 0.2,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  }).withStructuredOutput(ctx.state.ReportSchema);

  const prompt =
    "You are a sell-side equity analyst writing a one-page Buy/Hold/Sell brief.\\n" +
    "Weight earnings fundamentals heavier than news headlines. Always surface risks " +
    "even when the call is BUY. Be specific — cite numbers from the transcript.\\n\\n" +
    "TICKER: " + ticker + " — $" + market.price_usd + " (" + market.change_pct + "% today)\\n\\n" +
    "EARNINGS (" + earnings.quarter + "):\\n" + earnings.summary + "\\n\\n" +
    "RECENT HEADLINES:\\n" + market.headlines.map((h) => "- [" + h.source + "] " + h.text).join("\\n");

  return await llm.invoke(prompt);
}

ctx.state.analyze = analyze;
return await analyze("NVDA");
`,
      sampleOutput: {
        logs: ["📊 NVDA @ $932.1 (2.3% today)"],
        result: {
          ticker: "NVDA",
          recommendation: "BUY",
          conviction: "high",
          horizon: "medium",
          thesis: "Blackwell is fully booked through CY26 with $48B Data Center revenue (+112% YoY) and management guiding $52B next quarter, indicating demand still outruns the steepest supply ramp in semiconductor history. The 80bps gross margin compression is transitory mix and recovers by Q3.",
          catalysts: [
            "CoWoS capacity at TSMC sold out through 2026 with NVIDIA holding the largest allocation.",
            "Sovereign-AI deals (e.g. Saudi PIF) expanding into multi-billion-dollar contracts.",
            "Guided $52B Q2 implies +24% QoQ on an already record base.",
            "Gross-margin recovery to historical band by Q3 as Blackwell mix matures.",
          ],
          risks: [
            "Top 4 hyperscalers concentrate ~46% of Data Center revenue — single-customer pullback would dent the print.",
            "Informal DOJ probe into GPU-allocation practices introduces regulatory overhang.",
            "Any execution slip on Blackwell ramp would compound margin pressure beyond Q3.",
          ],
        },
      },
    },

    // ── Step 4: Multi-ticker comparison ───────────────────────────────────
    {
      id: "md-compare",
      kind: "markdown",
      source: `## Step 4 — Compare two tickers side-by-side

Same analyzer, fired twice. This is where a small structured schema pays off: comparing two free-text reports is annoying, but comparing two JSON objects is trivial and renders cleanly in any UI.`,
    },
    {
      id: "compare",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — run on both tickers in parallel.
const [aapl, nvda] = await Promise.all([
  ctx.state.analyze("AAPL"),
  ctx.state.analyze("NVDA"),
]);

return {
  AAPL: { rec: aapl.recommendation, conviction: aapl.conviction, thesis: aapl.thesis },
  NVDA: { rec: nvda.recommendation, conviction: nvda.conviction, thesis: nvda.thesis },
};
`,
      sampleOutput: {
        result: {
          AAPL: {
            rec: "HOLD",
            conviction: "medium",
            thesis: "Services strength (+14% YoY, all-time high) offsets flat iPhone units, but the EU antitrust fine and China-AI delay cap the upside in the near term. Capex raise on AI infrastructure is the right call but the payoff is a 2027 story.",
          },
          NVDA: {
            rec: "BUY",
            conviction: "high",
            thesis: "Blackwell is fully booked through CY26 with Data Center revenue +112% YoY and management guiding +24% QoQ. The 80bps gross-margin compression is transitory mix.",
          },
        },
      },
    },

    {
      id: "wrap",
      kind: "markdown",
      source: `## 📌 Where this would slot in

The schema is the API contract. Once you have it, the same JSON can power:

- A Slack \`/analyze NVDA\` slash command
- A daily morning-brief email per watchlist
- A column in your portfolio dashboard
- An audit log for the compliance team

The hard part is never the LLM call — it's writing a schema strict enough that the downstream consumers can rely on it. Get the schema right and everything else slots in.`,
    },
  ],
};
