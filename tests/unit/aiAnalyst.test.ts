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
  assertSelectOnly,
  buildAnalysisPlanPrompt,
  buildCheckPrompt,
  buildSynthesisPrompt,
  isReasoningModelId,
  MAX_ANALYSIS_STEPS,
  parseAnalysisPlan,
  parseCheckResponse,
  parseSynthesis,
  priorContext,
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
