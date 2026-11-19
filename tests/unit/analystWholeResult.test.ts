// R512: the AI Analyst's numbers come from the whole result.
//
// Found on 8080: "daily sales in 2025 as a calendar heatmap" returned 323
// days, and the findings said "total: 70869.17" — the first 50 days. Local
// steps ran through the playground's 50-row runner, so the self-check and the
// write-up summed a sample, and the calendar drew January to March.
import { describe, expect, it, vi } from "vitest";

const DAYS = Array.from({ length: 323 }, (_, i) => ({
  day: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
  total_sales: i + 1,
}));
// 1 + 2 + … + 323, and what the first 50 days add up to.
const WHOLE = (323 * 324) / 2;
const FIRST_50 = (50 * 51) / 2;

vi.mock("@/lib/sqlEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sqlEngine")>()),
  // The playground runner, as it behaves: the first 50 rows, and the count.
  runQuery: async () => ({
    columns: ["day", "total_sales"],
    rows: DAYS.slice(0, 50),
    row_count: 50,
    total_matched: DAYS.length,
    capped: true,
    duration_ms: 1,
  }),
  runQueryUnlimited: async (_sql: string, maxRows: number) => ({
    columns: ["day", "total_sales"],
    rows: DAYS.slice(0, maxRows),
    total: DAYS.length,
    capped: DAYS.length > maxRows,
  }),
}));

import {
  ANALYST_CHART_ROW_CAP,
  ANALYST_ROW_CAP,
  chartEveryStep,
  rerunStep,
  runAnalystTurn,
  trimStepForStorage,
  type AnalystTurn,
} from "@/lib/aiAnalyst";
import { readableCell, readableDecimals } from "@/lib/readableNumbers";

function fakeModel() {
  const calls: string[] = [];
  let synthesis = "";
  const llm = async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    const p = a.systemPrompt + a.userPrompt;
    if (/OVERSIZED SQL/.test(p)) {
      calls.push("reshape");
      return { sql: "SELECT month, total_sales FROM months" } as T;
    }
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      calls.push("plan");
      return { approach: "one step", steps: [{ goal: "daily sales in 2025" }] } as T;
    }
    if (/writing up findings/.test(a.systemPrompt)) {
      calls.push("synthesis");
      synthesis = a.userPrompt;
      return { answer: "Sales were 474150.4844 (step 1).", follow_ups: [] } as T;
    }
    if (/"sql"/.test(p)) {
      calls.push("sql");
      return { sql: "SELECT day, total_sales FROM days" } as T;
    }
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      calls.push("check");
      return { checks: [{ verdict: "pass", note: "ok" }], headline: 0 } as T;
    }
    calls.push("other");
    return {} as T;
  };
  return { llm, calls, synthesis: () => synthesis };
}

const turnArgs = (question: string, m: ReturnType<typeof fakeModel>) => ({
  question,
  datasets: [],
  semantics: new Map(),
  metrics: [],
  priorTurns: [],
  llm: m.llm,
  onUpdate: () => {},
});

describe("a local step", () => {
  it(
    "is checked and written up from every row, not the first 50",
    { timeout: 300_000 },
    async () => {
      const m = fakeModel();
      const turn = await runAnalystTurn(
        turnArgs("Show daily sales in 2025 as a calendar heatmap.", m),
      );
      expect(turn.status).toBe("done");
      expect(turn.steps[0].rowCount).toBe(323);
      // The write-up is told the year's total, and no truncation.
      expect(m.synthesis()).toContain(`total=${WHOLE}`);
      expect(m.synthesis()).not.toContain(`total=${FIRST_50}`);
      expect(m.synthesis()).not.toMatch(/first 50 of 323/);
    },
  );

  it(
    "keeps a calendar's days when the question asked for a calendar",
    { timeout: 300_000 },
    async () => {
      const m = fakeModel();
      const turn = await runAnalystTurn(
        turnArgs("Show daily sales in 2025 as a calendar heatmap.", m),
      );
      // 323 rows is over the 50 a step keeps, but the visual asked for needs
      // the days: no reshape into months.
      expect(m.calls).not.toContain("reshape");
      expect(turn.steps[0].sql).toBe("SELECT day, total_sales FROM days");
    },
  );

  it("is still reshaped when no visual was asked for", { timeout: 300_000 }, async () => {
    const m = fakeModel();
    await runAnalystTurn(turnArgs("What were daily sales in 2025?", m));
    expect(m.calls).toContain("reshape");
  });

  it("re-run by hand, reports the query's own row count", async () => {
    const step = await rerunStep({
      step: { goal: "daily sales", status: "done" },
      sql: "SELECT day, total_sales FROM days",
    });
    expect(step.rowCount).toBe(323);
    expect(step.rows).toHaveLength(ANALYST_ROW_CAP);
  });
});

describe("a step drawn as a chart", () => {
  const result = {
    columns: ["day", "total_sales"],
    rows: DAYS,
    row_count: DAYS.length,
    total_matched: DAYS.length,
    capped: false,
    duration_ms: 1,
  };

  it("keeps every row its chart draws, up to the chart cap", async () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [{ goal: "daily sales in 2025", status: "done", rows: DAYS.slice(0, 50) }],
      status: "done",
    };
    await chartEveryStep({
      turn,
      question: "daily sales in 2025 as a calendar heatmap",
      results: [result],
      suggest: async () => ({ type: "calendar", dateField: "day", valueField: "total_sales" }),
    });
    expect(turn.steps[0].rows).toHaveLength(323);
    // Stored as drawn: 323 days fit the chart cap.
    expect(trimStepForStorage(turn.steps[0]).rows).toHaveLength(323);
    expect(ANALYST_CHART_ROW_CAP).toBeGreaterThanOrEqual(366);
  });

  it("but a step shown only as a table keeps 50", async () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [{ goal: "daily sales in 2025", status: "done", rows: DAYS.slice(0, 50) }],
      status: "done",
    };
    await chartEveryStep({
      turn,
      question: "daily sales in 2025",
      results: [result],
      suggest: async () => ({ type: "table" }),
    });
    expect(turn.steps[0].rows).toHaveLength(50);
    expect(trimStepForStorage({ ...turn.steps[0], rows: DAYS }).rows).toHaveLength(ANALYST_ROW_CAP);
  });
});

describe("numbers in the findings and the step tables", () => {
  it("are set with two decimals and separators from 1 up", { timeout: 300_000 }, async () => {
    const m = fakeModel();
    const turn = await runAnalystTurn(
      turnArgs("Show daily sales in 2025 as a calendar heatmap.", m),
    );
    expect(turn.answer).toBe("Sales were 474,150.48 (step 1).");
  });

  it("change only long decimals", () => {
    expect(readableDecimals("| Finance | 474150.4844 |")).toBe("| Finance | 474,150.48 |");
    expect(readableDecimals("rate: -24.709, margin 0.124712")).toBe("rate: -24.71, margin 0.1247");
    // Short decimals, integers, dates, times and versions are left alone.
    for (const s of [
      "a 12.47% margin",
      "the year 2025, order 100245",
      "on 2025-01-17",
      "at 12:30.125",
      "v1.2.345",
      "0.125 of the total",
    ]) {
      expect(readableDecimals(s), s).toBe(s);
    }
  });

  it("read a table cell the same way", () => {
    expect(readableCell(474150.48440000083)).toBe("474,150.48");
    expect(readableCell("304645.14089999977")).toBe("304,645.14");
    expect(readableCell(0.1247123)).toBe("0.1247");
    expect(readableCell(2025)).toBe("2025");
    expect(readableCell(100245)).toBe("100245");
    expect(readableCell(null)).toBe("null");
    expect(readableCell("EMEA")).toBe("EMEA");
  });
});
