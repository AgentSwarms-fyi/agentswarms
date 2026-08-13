// The dedicated AI Analyst's reasoning loop — the PURE pieces, called for
// real. The loop's LLM calls and SQL execution are exercised end to end in
// the browser; what belongs here is everything that decides what those
// calls SEND and how their replies are TRUSTED: prompt builders, parsers,
// the SELECT-only gate, storage trimming, conversational memory, and the
// reasoning-model nudge. Wiring between page, nav, exporter and loop is
// pinned as source guards — dropping any hop leaves units green while the
// feature quietly degrades.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ANALYST_MEMORY_TURNS,
  ANALYST_ROW_CAP,
  ANALYST_TOKENS,
  analystNameOnEdit,
  assertSelectOnly,
  buildAnalysisPlanPrompt,
  buildCheckPrompt,
  buildSynthesisPrompt,
  chartEveryStep,
  isChartableShape,
  isReasoningModelId,
  leadChartStep,
  MAX_ANALYSIS_STEPS,
  MAX_FOLLOW_UPS,
  modelsUsedIn,
  parseAnalysisPlan,
  parseCheckResponse,
  parseSynthesis,
  parseSynthesisReply,
  priorContext,
  QUOTE_ROWS_UP_TO,
  describeStepResult,
  rerunStep,
  withStaleAnswer,
  trimStepForStorage,
  trimTurnForStorage,
  type AnalystStep,
  type AnalystTurn,
} from "@/lib/aiAnalyst";
import { NAV_GROUPS } from "@/lib/appNav";

describe("the reasoning-model nudge", () => {
  it("recognises the reasoning families", () => {
    for (const id of [
      "openai/gpt-5",
      "openai/gpt-5-mini", // the model the live E2E ran with
      "openai/o3",
      "openai/o1-preview",
      "o4-mini",
      "deepseek/deepseek-r1",
      "qwen/qwq-32b",
      "anthropic/claude-opus-4.1",
      "google/gemini-2.5-pro",
      "anthropic/claude-3.7-sonnet:thinking",
    ]) {
      expect(isReasoningModelId(id), id).toBe(true);
    }
  });

  it("does not flag ordinary chat models", () => {
    for (const id of [
      "openai/gpt-4o",
      "openai/gpt-4o-mini", // the o in 4o must not read as o4
      "anthropic/claude-3.5-haiku",
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct",
      "mistralai/mistral-large",
    ]) {
      expect(isReasoningModelId(id), id).toBe(false);
    }
  });
});

describe("the SELECT-only gate", () => {
  it("passes single SELECT/WITH statements and strips a trailing semicolon", () => {
    expect(assertSelectOnly("SELECT 1;")).toBe("SELECT 1");
    expect(assertSelectOnly("  with t as (select 1) select * from t ")).toBe(
      "with t as (select 1) select * from t",
    );
  });

  it("refuses anything else — the analyst reads, it never writes", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DROP TABLE t",
      "DELETE FROM t",
      "CREATE TABLE t (x int)",
    ]) {
      expect(() => assertSelectOnly(sql), sql).toThrow(/only run SELECT/);
    }
  });

  it("refuses statement smuggling via semicolons", () => {
    expect(() => assertSelectOnly("SELECT 1; DROP TABLE t")).toThrow(/single statement/);
  });
});

describe("plan parsing", () => {
  it("keeps valid steps and clamps to the step budget", () => {
    const raw = {
      approach: "Two angles.",
      steps: Array.from({ length: MAX_ANALYSIS_STEPS + 2 }, (_, i) => ({ goal: `step ${i}` })),
    };
    const plan = parseAnalysisPlan(raw);
    expect(plan.approach).toBe("Two angles.");
    expect(plan.steps).toHaveLength(MAX_ANALYSIS_STEPS);
  });

  it("filters junk steps and refuses a shapeless plan", () => {
    const plan = parseAnalysisPlan({ steps: [{ goal: "  real  " }, { goal: "" }, { nope: 1 }] });
    expect(plan.steps).toEqual([{ goal: "real" }]);
    expect(() => parseAnalysisPlan({ steps: [] })).toThrow(/no analysis steps/);
  });

  it("accepts the shapes models actually return", () => {
    // Same lesson as the synthesis parser: JSON mode is not one schema.
    expect(parseAnalysisPlan({ steps: ["total by region", "top countries"] }).steps).toEqual([
      { goal: "total by region" },
      { goal: "top countries" },
    ]);
    expect(parseAnalysisPlan({ plan: { approach: "a", steps: [{ goal: "g" }] } })).toEqual({
      approach: "a",
      steps: [{ goal: "g" }],
    });
    expect(parseAnalysisPlan({ steps: [{ description: "d" }] }).steps).toEqual([{ goal: "d" }]);
    expect(parseAnalysisPlan({ analysis_steps: [{ title: "t" }] }).steps).toEqual([{ goal: "t" }]);
  });

  it("names the REAL cause when the model returns nothing at all", () => {
    // Measured live: gpt-5-mini, planning a three-part question under a
    // 1,200-token cap, spent 1,152 completion tokens reasoning and returned
    // `{}`. "Try rephrasing" sends the user to fix the one thing that was
    // fine — the budget was the fault, and the budgets below are the fix.
    expect(() => parseAnalysisPlan({})).toThrow(/completion budget on reasoning/);
    expect(() => parseAnalysisPlan(null)).toThrow(/completion budget on reasoning/);
    expect(ANALYST_TOKENS.plan).toBeGreaterThanOrEqual(4000);
    expect(ANALYST_TOKENS.check).toBeGreaterThanOrEqual(4000);
    expect(ANALYST_TOKENS.synthesis).toBeGreaterThanOrEqual(4000);
  });

  it("the loop actually spends those budgets", async () => {
    // A constant nobody passes is a comment. Each stage must use its own.
    const { readFileSync } = await import("node:fs");
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    expect(lib).toContain("maxTokens: ANALYST_TOKENS.plan");
    expect(lib).toContain("maxTokens: ANALYST_TOKENS.check");
    expect(lib).toContain("maxTokens: ANALYST_TOKENS.synthesis");
  });
});

describe("self-check parsing", () => {
  it("aligns checks to steps, defaults to pass, keeps only real refinements", () => {
    const out = parseCheckResponse(
      {
        checks: [
          { verdict: "suspect", note: "empty result", refined_sql: "SELECT 2" },
          { verdict: "nonsense", note: 42 },
        ],
        headline: 1,
      },
      3, // three steps, one check missing entirely
    );
    expect(out.checks).toHaveLength(3);
    expect(out.checks[0]).toEqual({
      verdict: "suspect",
      note: "empty result",
      refined_sql: "SELECT 2",
    });
    expect(out.checks[1]).toEqual({ verdict: "pass", note: "" });
    expect(out.checks[2]).toEqual({ verdict: "pass", note: "" });
    expect(out.headline).toBe(1);
  });

  it("clamps an out-of-range headline to the first step", () => {
    expect(parseCheckResponse({ headline: 9 }, 2).headline).toBe(0);
    expect(parseCheckResponse({ headline: -1 }, 2).headline).toBe(0);
    expect(parseCheckResponse(null, 2).headline).toBe(0);
  });
});

describe("synthesis parsing — measured shapes, not hoped-for ones", () => {
  it("accepts the canonical shape and the shapes models actually return", () => {
    // gpt-5-mini's live run returned a shape the strict `.answer` read
    // missed, and a finished analysis fell back to "no write-up".
    expect(parseSynthesis({ answer: "EMEA leads." })).toBe("EMEA leads.");
    expect(parseSynthesis("EMEA leads.")).toBe("EMEA leads."); // bare JSON string
    expect(parseSynthesis({ markdown: "EMEA leads." })).toBe("EMEA leads.");
    expect(parseSynthesis({ write_up: "EMEA leads." })).toBe("EMEA leads."); // single string, odd key
  });

  it("returns empty (→ honest fallback) when there is nothing usable", () => {
    expect(parseSynthesis(null)).toBe("");
    expect(parseSynthesis({ a: "x", b: "y" })).toBe(""); // ambiguous — refuse to guess
    expect(parseSynthesis({ answer: 42 })).toBe("");
  });
});

describe("storage trimming", () => {
  const bigStep: AnalystStep = {
    goal: "g",
    sql: "SELECT 1",
    columns: ["x"],
    rows: Array.from({ length: ANALYST_ROW_CAP + 70 }, (_, i) => ({ x: i })),
    rowCount: ANALYST_ROW_CAP + 70,
    status: "done",
  };

  it("caps stored rows and keeps the rest of the trace", () => {
    const trimmed = trimStepForStorage(bigStep);
    expect(trimmed.rows).toHaveLength(ANALYST_ROW_CAP);
    expect(trimmed.rowCount).toBe(ANALYST_ROW_CAP + 70); // the true count survives
    expect(trimmed.sql).toBe("SELECT 1");
  });

  it("trims every step of a turn; small steps pass through untouched", () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [bigStep, { goal: "small", rows: [{ x: 1 }], status: "done" }],
      status: "done",
    };
    const t = trimTurnForStorage(turn);
    expect(t.steps[0].rows).toHaveLength(ANALYST_ROW_CAP);
    expect(t.steps[1].rows).toHaveLength(1);
  });
});

describe("conversational memory", () => {
  const doneTurn = (q: string, a: string): AnalystTurn => ({
    question: q,
    steps: [],
    answer: a,
    status: "done",
  });

  it("carries only finished Q→A pairs, capped, newest kept", () => {
    const turns: AnalystTurn[] = [
      doneTurn("q0", "a0"),
      { question: "failed", steps: [], status: "error" },
      ...Array.from({ length: ANALYST_MEMORY_TURNS }, (_, i) => doneTurn(`q${i + 1}`, `a${i + 1}`)),
    ];
    const ctx = priorContext(turns);
    expect(ctx).not.toContain("q0"); // pushed out by the cap
    expect(ctx).not.toContain("failed"); // error turns carry nothing
    expect(ctx).toContain(`Q: q${ANALYST_MEMORY_TURNS}`);
    expect(priorContext([])).toBe("");
  });

  it("truncates long answers so memory cannot crowd out the schema", () => {
    const ctx = priorContext([doneTurn("q", "x".repeat(2000))]);
    expect(ctx.length).toBeLessThan(700);
  });
});

describe("the prompts say what the loop relies on", () => {
  it("plan: decompose over the schema, no SQL yet, step budget stated", () => {
    const p = buildAnalysisPlanPrompt({ schema: "TABLE t (x)", question: "why?", prior: "" });
    expect(p.systemPrompt).toContain(`1-${MAX_ANALYSIS_STEPS}`);
    expect(p.systemPrompt).toContain("Do not write SQL here");
    expect(p.userPrompt).toContain("TABLE t (x)");
    expect(p.userPrompt).toContain("why?");
  });

  it("check: reviews own work, may refine with a single SELECT", () => {
    const p = buildCheckPrompt({
      question: "why?",
      steps: [{ goal: "g1", sql: "SELECT 1", facts: "1 row" }],
    });
    expect(p.systemPrompt).toContain("REVIEWING YOUR OWN WORK");
    expect(p.systemPrompt).toContain("refined_sql");
    expect(p.userPrompt).toContain("STEP 1: g1");
    expect(p.userPrompt).toContain("headline");
  });

  it("synthesis: numbers only from step results, cited by step", () => {
    const p = buildSynthesisPrompt({
      question: "why?",
      approach: "two angles",
      prior: "",
      steps: [{ goal: "g1", facts: "total 150" }],
    });
    expect(p.systemPrompt).toContain("ONLY the step results");
    expect(p.systemPrompt).toContain("(step 2)");
    expect(p.userPrompt).toContain("total 150");
  });
});

describe("the wiring (real nav, source guards)", () => {
  it("AI Analyst is the FIRST item under Data & BI", () => {
    const dataBi = NAV_GROUPS.find((g) => g.label === "Data & BI");
    expect(dataBi).toBeDefined();
    expect(dataBi!.items[0].title).toBe("AI Analyst");
    expect(dataBi!.items[0].url).toBe("/ai-analyst");
  });

  it("the page runs the real loop and stores TRIMMED turns", () => {
    const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
    expect(page).toMatch(/runAnalystTurn\(\{/);
    expect(page).toContain("trimTurnForStorage(turn)");
    // The dialog is TWO choices by design: the model and the data.
    expect(page).toContain("Reasoning model");
    expect(page).toMatch(/<BiModelSelect value=\{draftModel\}/);
    expect(page).toContain("Choose the data it analyses");
    // The nudge is a suggestion, not a gate.
    expect(page).toContain("draftIsReasoning === false");
    // The whole analysis exports as PDF.
    expect(page).toMatch(/exportAnalysisPdf\(\{/);
  });

  it("the PDF is built from TURN DATA — vector text, charts from the DOM", () => {
    // The first exporter rasterised prose and shipped soft type; the report
    // is now laid out from the turns themselves. The page must hand over the
    // turns and resolve chart elements by index — nothing else is captured.
    const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
    const pdf = readFileSync("src/lib/biPdf.ts", "utf8");
    expect(page).toContain("turns: turnsToRender");
    expect(page).toContain("data-analysis-chart");
    expect(pdf).toContain("buildAnalysisPdfBytes");
    expect(pdf).not.toContain("[data-analysis-block]");
  });

  it("step SQL comes from the SAME generator as the BI analyst", () => {
    // A second SQL prompt would immediately drift from the battle-tested
    // one (identifier quoting, null ordering, window rules — all measured).
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    expect(lib).toMatch(/import \{[^}]*generateSql[^}]*\} from "@\/lib\/biAgent"/s);
    expect(lib).toMatch(/repair: \{ sql: step\.sql, error: /);
    // Every statement passes the SELECT-only gate before running.
    expect(lib).toMatch(/const clean = assertSelectOnly\(sql\)/);
  });
});

/**
 * Every text run a PDF reader would find, in draw order.
 *
 * pdf-lib emits standard-font text as hex string operands inside FLATE
 * content streams, so neither a raw byte scan nor a plain inflate finds
 * them — the streams have to be decoded through the PDF's own filters.
 */
async function pdfTextRuns(doc: import("pdf-lib").PDFDocument): Promise<string[]> {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  // Standard fonts encode as WinAnsi, which differs from latin1 exactly in
  // 0x80–0x9F — the range holding the typography this report uses (bullets,
  // dashes, curly quotes). Decoding those back is what makes the assertions
  // below read like the text a person sees.
  const WIN_ANSI_HIGH: Record<number, string> = {
    0x85: "…",
    0x91: "‘",
    0x92: "’",
    0x93: "“",
    0x94: "”",
    0x95: "•",
    0x96: "–",
    0x97: "—",
  };
  const decodeWinAnsi = (buf: Buffer) =>
    [...buf].map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b)).join("");
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: import("pdf-lib").PDFRawStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = doc.context.lookup(contents.get(i));
        if (s instanceof PDFRawStream) streams.push(s);
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents);
    }
    for (const s of streams) {
      const decoded = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        runs.push(decodeWinAnsi(Buffer.from(m[1], "hex")));
      }
    }
  }
  return runs;
}

describe("the branded report builds for real (vector text, pdf-lib)", () => {
  const longSentence =
    "Revenue concentrates in EMEA, with the United Kingdom contributing the largest share and discounts holding steady across segments (step 1). ";
  const fixtureTurn = (n: number): AnalystTurn => ({
    question: `Question ${n}: which region leads and why does it keep leading over time?`,
    approach: "Aggregate by region first, then decompose the winner by country and month.",
    steps: [
      {
        goal: "Total sales by region",
        sql: "SELECT region, SUM(sales) AS total_sales FROM saas_sales GROUP BY region",
        columns: ["region", "total_sales"],
        rows: Array.from({ length: 12 }, (_, i) => ({ region: `R${i}`, total_sales: i * 100 })),
        rowCount: 12,
        check: { verdict: "pass", note: "Four regions, magnitudes consistent with the raw table." },
        status: "done",
      },
      {
        goal: "Top countries within the leading region",
        sql: "SELECT 1",
        columns: ["country", "total_sales"],
        rows: [{ country: "United Kingdom", total_sales: 320000 }],
        rowCount: 1,
        check: { verdict: "suspect", note: "Single row — verify the region filter matched." },
        status: "done",
      },
    ],
    answer: `**Direct answer:** EMEA leads (step 1).\n- ${longSentence}\n- ${longSentence}\n${longSentence.repeat(18)}`,
    status: "done",
  });

  it("produces a real multi-page PDF with the branding and the content as TEXT", async () => {
    const { buildAnalysisPdfBytes } = await import("@/lib/biPdf");
    const { PDFDocument } = await import("pdf-lib");
    const bytes = await buildAnalysisPdfBytes({
      title: "Regional revenue deep-dive",
      analystName: "saas_sales analyst",
      model: "openai/gpt-5-mini",
      sourceText: "saas_sales",
      turns: [fixtureTurn(1), fixtureTurn(2)],
    });
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF")).toBe(true);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("Regional revenue deep-dive");
    // Two long turns cannot fit one portrait page — pagination must engage.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595); // portrait A4
    expect(Math.round(height)).toBe(842);

    // THE POINT OF THE REWRITE: the report's words are real text operators
    // in the content streams, not pixels in a screenshot. Extracting them
    // is what a PDF reader's copy/search does, so this test fails the day
    // anyone rasterises prose again.
    const strings = await pdfTextRuns(doc);
    const dump = strings.join("\n");
    // The wordmark is its own draw — the footer stamp that also contains
    // the brand name must not be what satisfies this.
    expect(strings.includes("AgentSwarms")).toBe(true);
    expect(dump.includes("Generated with AgentSwarms AI Analyst")).toBe(true);
    expect(dump.includes("STEP 1")).toBe(true);
    expect(dump.includes("Page 1 of")).toBe(true);
    expect(dump.includes("which region leads")).toBe(true);
    // Findings prose survives as text, including its markdown-bold run.
    expect(dump.includes("EMEA")).toBe(true);
    expect(dump.includes("Direct answer:")).toBe(true);
  });

  it("refuses an empty export honestly", async () => {
    const { exportAnalysisPdf } = await import("@/lib/biPdf");
    await expect(
      exportAnalysisPdf({
        title: "t",
        analystName: "a",
        model: "m",
        sourceText: "s",
        turns: [],
      }),
    ).rejects.toThrow(/Nothing to export/);
  });
});

describe("the report's tables stay legible", () => {
  const wideCols = [
    "Segment",
    "total_sales_discounted",
    "unique_orders_discounted",
    "avg_order_value_discounted",
    "total_discount",
    "total_profit_discounted",
    "profit_margin_discounted",
    "total_sales_nondiscounted",
    "unique_orders_nondiscounted",
    "avg_order_value_nondiscounted",
    "AOV_lift",
    "avg_discount_per_order",
  ];

  it("keeps whole columns and NAMES the ones it drops", async () => {
    // Measured on the live discount analysis: a 12+ column breakdown scaled
    // to fit rendered as "… 3719… 777 478.70…" — the key column included.
    // Nothing is squeezed now; what does not fit is disclosed by name.
    const { buildAnalysisPdfBytes } = await import("@/lib/biPdf");
    const { PDFDocument } = await import("pdf-lib");
    const turn: AnalystTurn = {
      question: "Which segment's discounting looks least justified?",
      steps: [
        {
          goal: "Per-segment comparison",
          sql: "SELECT 1",
          columns: wideCols,
          rows: [Object.fromEntries(wideCols.map((c, i) => [c, i === 0 ? "Strategic" : i * 100]))],
          rowCount: 1,
          status: "done",
        },
      ],
      answer: "Strategic (step 1).",
      status: "done",
    };
    const doc = await PDFDocument.load(
      await buildAnalysisPdfBytes({
        title: "t",
        analystName: "a",
        model: "m",
        sourceText: "s",
        turns: [turn],
      }),
    );
    const dump = (await pdfTextRuns(doc)).join("\n");
    // The key column and its value survive INTACT — no ellipsis.
    expect(dump).toContain("Segment");
    expect(dump).toContain("Strategic");
    // The omission is disclosed, by name, not silently.
    expect(dump).toMatch(/more columns not shown/);
    expect(dump).toContain("avg_discount_per_order");
  });

  it("leaves a table that already fits completely alone", async () => {
    const { buildAnalysisPdfBytes } = await import("@/lib/biPdf");
    const { PDFDocument } = await import("pdf-lib");
    const turn: AnalystTurn = {
      question: "Discounted versus not?",
      steps: [
        {
          goal: "Overall comparison",
          sql: "SELECT 1",
          columns: ["discounted_flag", "total_sales", "unique_orders", "avg_order_value"],
          rows: [
            { discounted_flag: "Discounted", total_sales: 1, unique_orders: 2, avg_order_value: 3 },
          ],
          rowCount: 1,
          status: "done",
        },
      ],
      status: "done",
    };
    const doc = await PDFDocument.load(
      await buildAnalysisPdfBytes({
        title: "t",
        analystName: "a",
        model: "m",
        sourceText: "s",
        turns: [turn],
      }),
    );
    const dump = (await pdfTextRuns(doc)).join("\n");
    expect(dump).toContain("avg_order_value");
    expect(dump).not.toMatch(/more columns not shown/);
  });

  it("keeps SQL line breaks and indentation (it is not prose)", async () => {
    const { buildAnalysisPdfBytes } = await import("@/lib/biPdf");
    const { PDFDocument } = await import("pdf-lib");
    // A first version stripped \n in the WinAnsi encoder, so every statement
    // printed as one run-on line: "total_salesFROM saas_sales".
    const sql =
      'SELECT "Region" AS region,\n  SUM("Sales") AS total_sales\nFROM saas_sales\nGROUP BY "Region"';
    const doc = await PDFDocument.load(
      await buildAnalysisPdfBytes({
        title: "t",
        analystName: "a",
        model: "m",
        sourceText: "s",
        turns: [
          {
            question: "q",
            steps: [{ goal: "g", sql, status: "done" }],
            answer: "- **A** bullet\n- another",
            status: "done",
          },
        ],
      }),
    );
    const runs = await pdfTextRuns(doc);
    const dump = runs.join("\n");
    expect(dump).not.toContain("total_salesFROM");
    expect(runs.some((r) => r.startsWith("FROM saas_sales"))).toBe(true);
    expect(runs.some((r) => r.startsWith("  SUM("))).toBe(true); // indentation kept
    // Findings bullets render as bullets, not one paragraph.
    expect(runs).toContain("•");
  });
});

describe("Tier 1 — an answer with several visuals", () => {
  it("charts every step whose result has a shape worth drawing", () => {
    // The rule that decides WHICH steps get a chart, before any model is
    // asked. One visual per answer was the whole complaint: three queries
    // ran, two had plottable results, and the reader saw one picture.
    expect(
      isChartableShape({ columns: ["region", "sales"], rows: [{ region: "EMEA", sales: 1 }] }),
    ).toBe(true);
    expect(
      isChartableShape({
        columns: ["month", "sales", "orders"],
        rows: [
          { month: "Jan", sales: 5, orders: 2 },
          { month: "Feb", sales: 7, orders: 3 },
        ],
      }),
    ).toBe(true);
    // A single total is a KPI — still worth showing.
    expect(isChartableShape({ columns: ["total"], rows: [{ total: 42 }] })).toBe(true);
    // Nothing to plot: no rows, or no numbers at all.
    expect(isChartableShape({ columns: ["region"], rows: [] })).toBe(false);
    expect(
      isChartableShape({
        columns: ["region", "country"],
        rows: [{ region: "EMEA", country: "UK" }],
      }),
    ).toBe(false);
  });

  it("the lead visual is the self-check's headline — when that step drew one", () => {
    const step = (chart?: { type: string }): AnalystStep => ({
      goal: "g",
      status: "done",
      ...(chart ? { chart: chart as AnalystStep["chart"] } : {}),
    });
    // Headline drew a chart: it leads.
    expect(leadChartStep([step({ type: "bar" }), step({ type: "line" })], 1)).toBe(1);
    // Headline has no chart (or only a table): the first real chart leads.
    expect(leadChartStep([step({ type: "bar" }), step({ type: "table" })], 1)).toBe(0);
    expect(leadChartStep([step(), step({ type: "pie" })], 0)).toBe(1);
    // Nothing drew anything: no lead, and the caller must cope with that.
    expect(leadChartStep([step(), step({ type: "table" })], 0)).toBeUndefined();
  });
});

describe("Tier 1 — pinning a step to a dashboard", () => {
  const step: AnalystStep = {
    goal: "Total sales by region",
    sql: "SELECT region, SUM(sales) AS total FROM t GROUP BY region",
    columns: ["region", "total"],
    rows: [{ region: "EMEA", total: 100 }],
    rowCount: 3,
    chart: { type: "bar", xField: "region", yField: "total" },
    status: "done",
  };

  it("carries the SQL, chart and source so refresh re-runs the same query", async () => {
    const { widgetFromAnalystStep } = await import("@/lib/biDashboards");
    const w = widgetFromAnalystStep(step, { kind: "local" }, "Which region leads?");
    expect(w).not.toBeNull();
    expect(w!.sql).toBe(step.sql);
    expect(w!.chart).toEqual(step.chart);
    expect(w!.source).toEqual({ kind: "local" });
    expect(w!.title).toBe("Total sales by region");
    expect(w!.narrative).toBe("Which region leads?"); // the question is the context
  });

  it("marks the widget truncated when the step kept only a sample", async () => {
    // The analyst caps what it stores. A pinned chart drawing 1 of 3 rows
    // while claiming to be the whole picture is the failure to avoid.
    const { widgetFromAnalystStep } = await import("@/lib/biDashboards");
    expect(widgetFromAnalystStep(step, { kind: "local" })!.truncated).toBe(true);
    const whole = { ...step, rowCount: 1 };
    expect(widgetFromAnalystStep(whole, { kind: "local" })!.truncated).toBe(false);
  });

  it("refuses a step that has no result to pin", async () => {
    const { widgetFromAnalystStep } = await import("@/lib/biDashboards");
    expect(widgetFromAnalystStep({ goal: "g", status: "error" }, { kind: "local" })).toBeNull();
    expect(widgetFromAnalystStep({ ...step, rows: undefined }, { kind: "local" })).toBeNull();
  });
});

describe("Tier 1 — follow-ups", () => {
  it("reads the shapes a model returns them in, and stays optional", () => {
    expect(parseSynthesisReply({ answer: "A", follow_ups: ["Why?", "By segment?"] })).toEqual({
      answer: "A",
      followUps: ["Why?", "By segment?"],
    });
    expect(parseSynthesisReply({ answer: "A", followUps: ["Why?"] }).followUps).toEqual(["Why?"]);
    expect(parseSynthesisReply({ answer: "A", next_questions: ["Why?"] }).followUps).toEqual([
      "Why?",
    ]);
    // An answer with no usable follow-ups is still a complete answer.
    expect(parseSynthesisReply({ answer: "A" })).toEqual({ answer: "A", followUps: [] });
    expect(parseSynthesisReply({ answer: "A", follow_ups: "nope" }).followUps).toEqual([]);
    expect(parseSynthesisReply({ answer: "A", follow_ups: [1, "", "  "] }).followUps).toEqual([]);
  });

  it("caps the list and drops essays", () => {
    const many = parseSynthesisReply({
      answer: "A",
      follow_ups: ["a?", "b?", "c?", "d?", "e?", "x".repeat(200)],
    });
    expect(many.followUps).toHaveLength(MAX_FOLLOW_UPS);
    expect(many.followUps.every((q) => q.length <= 160)).toBe(true);
  });

  it("the synthesis prompt actually asks for them", () => {
    const p = buildSynthesisPrompt({ question: "q", approach: "a", prior: "", steps: [] });
    expect(p.userPrompt).toContain("follow_ups");
  });
});

describe("Tier 1 — an edited step, and the findings above it", () => {
  const turn: AnalystTurn = {
    question: "Which region leads?",
    approach: "Aggregate by region.",
    steps: [
      {
        goal: "Total by region",
        sql: "SELECT 1",
        columns: ["region"],
        rows: [{ region: "EMEA" }],
        rowCount: 1,
        chart: { type: "bar", xField: "region", yField: "x" },
        check: { verdict: "pass", note: "Looks right." },
        status: "done",
      },
    ],
    answer: "EMEA leads (step 1).",
    chartStep: 0,
    status: "done",
  };

  it("re-running a step drops the verdict and the chart that judged the OLD query", async () => {
    const patched = await rerunStep({
      step: turn.steps[0],
      sql: "SELECT region, SUM(sales) AS total FROM t GROUP BY region",
      execute: async () => ({
        columns: ["region", "total"],
        rows: [{ region: "AMER", total: 9 }],
        row_count: 1,
        total_matched: 1,
        capped: false,
        duration_ms: 1,
      }),
    });
    expect(patched.edited).toBe(true);
    expect(patched.rows).toEqual([{ region: "AMER", total: 9 }]);
    // A green "Check passed" from the previous query must not vouch for SQL
    // the analyst never saw, and the old chart was chosen for the old shape.
    expect(patched.check?.verdict).toBe("suspect");
    expect(patched.check?.note).toMatch(/not self-checked/i);
    expect(patched.chart).toBeUndefined();
  });

  it("still refuses anything that is not a single SELECT", async () => {
    await expect(
      rerunStep({ step: turn.steps[0], sql: "DROP TABLE t", execute: async () => ({}) as never }),
    ).rejects.toThrow(/only run SELECT/);
  });

  it("marks the findings stale, and they STAY marked until rewritten", () => {
    const stale = withStaleAnswer(turn, [{ ...turn.steps[0], edited: true }]);
    expect(stale.answerStale).toBe(true);
    expect(stale.answer).toBe(turn.answer); // the old prose is kept, not deleted
    expect(stale.steps[0].edited).toBe(true);
    // The original is untouched — the caller decides where the patch lands.
    expect(turn.answerStale).toBeUndefined();
  });
});

describe("what the write-up is actually shown", () => {
  const result = (n: number) => ({
    columns: ["segment", "total_sales"],
    rows: Array.from({ length: n }, (_, i) => ({ segment: `S${i}`, total_sales: 1000 + i })),
    row_count: n,
    total_matched: n,
    capped: false,
    duration_ms: 1,
  });

  it("quotes a small result ROW BY ROW, so findings can cite real values", () => {
    // Measured on two live runs: fed only summary statistics, the model
    // wrote "the per-segment totals are missing" with three per-segment
    // totals sitting in the table directly above the sentence. It was being
    // honest about what it had been given — which was the bug.
    const text = describeStepResult(result(3));
    expect(text).toContain("segment=S0 | total_sales=1000");
    expect(text).toContain("segment=S2 | total_sales=1002");
    expect(text).toContain("3 rows");
  });

  it("falls back to summarised facts once a result is too big to quote", () => {
    const text = describeStepResult(result(QUOTE_ROWS_UP_TO + 1));
    expect(text).not.toContain("segment=S0 | total_sales=1000");
    expect(text.length).toBeLessThan(600); // a summary, not a data dump
  });

  it("an empty result stays summarised — there is nothing to quote", () => {
    expect(describeStepResult(result(0))).not.toContain("segment=");
  });

  it("every prompt that judges or writes about a result uses it", async () => {
    // The check and the synthesis both reason about step results; feeding
    // one rows and the other statistics would have them disagree about what
    // the query returned.
    const { readFileSync } = await import("node:fs");
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    expect(lib.match(/describeStepResult\(results\[i\]!\)/g) ?? []).toHaveLength(3);
  });
});

describe("every chartable step really does get its own chart", () => {
  // The pure helpers above decide WHICH steps qualify; this proves the loop
  // then charts all of them. Testing only the helpers let a "chart the
  // headline and nothing else" regression pass unnoticed.
  const res = (rows: Record<string, unknown>[]) => ({
    columns: Object.keys(rows[0] ?? { x: 1 }),
    rows,
    row_count: rows.length,
    total_matched: rows.length,
    capped: false,
    duration_ms: 1,
  });

  it("charts all of them, not just the first", async () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [
        { goal: "by segment", status: "done" },
        { goal: "by region", status: "done" },
        { goal: "labels only", status: "done" },
      ],
      status: "done",
    };
    const asked: string[] = [];
    await chartEveryStep({
      turn,
      question: "q",
      results: [
        res([{ segment: "SMB", total: 3 }]),
        res([{ region: "EMEA", total: 4 }]),
        res([{ country: "UK", city: "London" }]), // nothing numeric to plot
      ],
      suggest: async (a) => {
        asked.push(a.question);
        return { type: "bar", xField: "x", yField: "y" };
      },
    });
    expect(turn.steps[0].chart?.type).toBe("bar");
    expect(turn.steps[1].chart?.type).toBe("bar");
    expect(turn.steps[2].chart).toBeUndefined(); // correctly skipped
    // Each chart is chosen for its OWN step's goal, not the whole question.
    expect(asked).toEqual(["by segment", "by region"]);
  });

  it("a chart that fails to suggest costs the step its picture, nothing more", async () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [
        { goal: "a", status: "done" },
        { goal: "b", status: "done" },
      ],
      status: "done",
    };
    await chartEveryStep({
      turn,
      question: "q",
      results: [res([{ k: "x", v: 1 }]), res([{ k: "y", v: 2 }])],
      suggest: async (a) => {
        if (a.question === "a") throw new Error("model hiccup");
        return { type: "pie", nameField: "k", valueField: "v" };
      },
    });
    expect(turn.steps[0].chart).toBeUndefined();
    expect(turn.steps[1].chart?.type).toBe("pie"); // the other still lands
  });
});

describe("Tier 2 — the analysis the model is not trusted to do", () => {
  const res = (columns: string[], rows: Record<string, unknown>[]) => ({
    columns,
    rows,
    row_count: rows.length,
    total_matched: rows.length,
    capped: false,
    duration_ms: 1,
  });

  it("attaches CONTRIBUTION arithmetic to a two-period breakdown", () => {
    // The write-up must cite computed shares, not eyeball two columns.
    const text = describeStepResult(
      res(
        ["region", "prev_sales", "curr_sales"],
        [
          { region: "EMEA", prev_sales: 500, curr_sales: 380 },
          { region: "AMER", prev_sales: 300, curr_sales: 330 },
        ],
      ),
    );
    expect(text).toContain("CONTRIBUTION ANALYSIS");
    expect(text).toContain("DRIVERS");
    expect(text).toContain("OFFSETS"); // AMER moved against the fall
  });

  it("leaves an ordinary breakdown alone", () => {
    const text = describeStepResult(
      res(
        ["segment", "total"],
        [
          { segment: "SMB", total: 3 },
          { segment: "Enterprise", total: 4 },
        ],
      ),
    );
    expect(text).not.toContain("CONTRIBUTION ANALYSIS");
    expect(text).not.toContain("SERIES:");
  });

  it("attaches TREND, OUTLIERS and a labelled projection to a time series", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      total: 100 + i * 10 + (i === 6 ? 900 : 0),
    }));
    const text = describeStepResult(res(["month", "total"], rows));
    expect(text).toContain("SERIES: 10 periods");
    expect(text).toContain("OUTLIERS");
    expect(text).toContain("PROJECTION (ESTIMATE, NOT MEASURED DATA)");
    expect(text).toContain("projections, not measurements");
  });

  it("says why it will NOT project when the history is too short", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      month: `2026-0${i + 1}`,
      total: 100 + i,
    }));
    const text = describeStepResult(res(["month", "total"], rows));
    expect(text).toContain("SERIES: 6 periods");
    expect(text).toMatch(/Too few periods to project responsibly/);
    expect(text).not.toContain("PROJECTION (ESTIMATE");
  });

  it("the plan prompt asks BEFORE guessing, with the limits on when", () => {
    const p = buildAnalysisPlanPrompt({ schema: "TABLE t (x)", question: "sales?", prior: "" });
    expect(p.systemPrompt).toContain("ASK BEFORE GUESSING");
    expect(p.systemPrompt).toContain("clarify");
    expect(p.systemPrompt).toContain("assumption");
    // And it is bounded — a tool that asks about sort order is a nag.
    expect(p.systemPrompt).toMatch(/Do NOT ask about/);
    expect(p.userPrompt).toContain("clarify");
  });

  it("a clarification stops the analysis; a hedged one does not", () => {
    const asked = parseAnalysisPlan({
      clarify: "Which quarter do you mean — calendar or fiscal?",
      assumption: "the current calendar quarter",
    });
    expect(asked.clarify).toBe("Which quarter do you mean — calendar or fiscal?");
    expect(asked.assumption).toBe("the current calendar quarter");
    expect(asked.steps).toEqual([]);

    // Both a plan AND a question means it knew how to proceed. Honouring the
    // question there would make the analyst stop for things it had already
    // decided, which is how "it asks first" becomes "it nags".
    const hedged = parseAnalysisPlan({
      clarify: "Shall I sort ascending?",
      steps: [{ goal: "total by region" }],
    });
    expect(hedged.clarify).toBeUndefined();
    expect(hedged.steps).toEqual([{ goal: "total by region" }]);
  });

  it("the loop stops at a clarification instead of querying (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    expect(lib).toMatch(/if \(plan\.clarify\) \{/);
    expect(lib).toContain('turn.status = "clarifying"');
  });
});

describe("an analyst you can edit, without rewriting history", () => {
  // Changing an analyst's model is the obvious response to a timeout that
  // says "pick a different model". The risk is provenance: a report that
  // reads the analyst's CURRENT model attributes every older analysis to a
  // model that never saw the question.
  it("names the model that ANSWERED, not the one now configured", () => {
    const turns = [
      { question: "q1", steps: [], status: "done", model: "openrouter::deepseek/deepseek-r1" },
      { question: "q2", steps: [], status: "done", model: "openrouter::openai/gpt-5-mini" },
    ] as AnalystTurn[];
    expect(modelsUsedIn(turns, "openrouter::anthropic/claude-opus-4")).toBe(
      "deepseek/deepseek-r1 + openai/gpt-5-mini",
    );
  });

  it("falls back to the current model only for turns that predate the stamp", () => {
    // Those turns necessarily ran on the analyst's model of the day, and
    // before analysts were editable that is still the current one.
    const old = [{ question: "q", steps: [], status: "done" }] as AnalystTurn[];
    expect(modelsUsedIn(old, "openrouter::openai/o3")).toBe("openai/o3");
    expect(modelsUsedIn([], "openrouter::openai/o3")).toBe("openai/o3");
  });

  it("summarises rather than listing every model in a long thread", () => {
    const turns = ["a", "b", "c", "d"].map(
      (m) => ({ question: m, steps: [], status: "done", model: m }) as AnalystTurn,
    );
    expect(modelsUsedIn(turns, "x")).toBe("a + 3 more");
  });

  it("collapses a thread that never changed model to just that model", () => {
    const turns = [
      { question: "q1", steps: [], status: "done", model: "openrouter::openai/o3" },
      { question: "q2", steps: [], status: "done", model: "openrouter::openai/o3" },
    ] as AnalystTurn[];
    expect(modelsUsedIn(turns, "openrouter::other")).toBe("openai/o3");
  });

  it("keeps a name the user typed, re-derives one they never touched", () => {
    // A name we generated describes the OLD data ("Snowflake · prod"); left
    // alone after a source change it becomes a label that lies. A name the
    // user chose is theirs.
    expect(
      analystNameOnEdit({
        currentName: "Snowflake · prod",
        autoNameForOldSource: "Snowflake · prod",
        autoNameForNewSource: "saas_sales",
      }),
    ).toBe("saas_sales");
    expect(
      analystNameOnEdit({
        currentName: "Q4 board pack",
        autoNameForOldSource: "Snowflake · prod",
        autoNameForNewSource: "saas_sales",
      }),
    ).toBe("Q4 board pack");
  });

  it("stamps the running model onto the turn itself (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    // Scoped to the literal that BUILDS the turn. An unanchored search
    // matched `model: args.model` anywhere in the file — including the
    // llmJson calls — so removing the stamp left the guard green.
    const start = lib.indexOf("const turn: AnalystTurn = {");
    const literal = lib.slice(start, lib.indexOf("\n  };", start));
    expect(start).toBeGreaterThan(-1);
    expect(literal).toContain('status: "planning"');
    expect(literal).toContain("model: args.model,");
  });

  it("the page offers edit, saves both fields, and reports honest provenance", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
    // The affordance exists and prefills from the analyst.
    expect(page).toContain("Change this analyst's model or data");
    expect(page).toMatch(/function openEdit\(a: AnalystRow\)/);
    expect(page).toMatch(/setDraftData\(dataTokenFor\(a\.source\)\)/);
    // It UPDATES rather than inserting a second analyst. Whitespace-tolerant:
    // prettier splits a long call chain across lines, and a source guard that
    // breaks on reformatting is a guard nobody keeps.
    expect(page).toMatch(/\.update\(patch\)\s*\.eq\(\s*"id",\s*editingAnalyst\.id\s*\)/);
    // Naming goes through the pure rule, not a re-implementation.
    expect(page).toContain("analystNameOnEdit({");
    expect(page).toContain("autoNameForOldSource: analystNameFor(editingAnalyst.source");
    // The report reads the turns, not the analyst's current setting.
    expect(page).toContain("modelsUsedIn(turnsToRender, selected.model)");
  });
});
