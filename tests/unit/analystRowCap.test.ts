// The analyst's 50-row trace cap, and the machinery that keeps it honest.
//
// The cap itself is by design (rows are stored per step, rendered, and fed
// back into LLM prompts — unbounded rows would bloat all three). What was
// broken around it: the SQL prompt told the model to add "LIMIT 50 if the
// result might be large", which made the engine return exactly 50 rows and
// blinded every disclosure downstream — a heatmap pull rendered as "50 rows"
// flat, for a 108-row grid, and only the LLM self-check's date arithmetic
// noticed. A cap is honest exactly when the runtime can SEE the truncation.
import { describe, expect, it } from "vitest";
import { ANALYST_ROW_CAP, isCapTruncated, trimStepForStorage } from "@/lib/aiAnalyst";
import { buildSqlPrompt } from "@/lib/biAgent";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe("trimStepForStorage", () => {
  it("records the true count when it trims", () => {
    const out = trimStepForStorage({ goal: "g", rows: rows(108) });
    expect(out.rows).toHaveLength(ANALYST_ROW_CAP);
    // Without this the "(showing 50)" disclosure has nothing to disclose and
    // the trimmed step claims its sample as the whole result.
    expect(out.rowCount).toBe(108);
  });

  it("preserves a rowCount captureResult already set", () => {
    const out = trimStepForStorage({ goal: "g", rowCount: 500, rows: rows(108) });
    expect(out.rowCount).toBe(500);
  });

  it("leaves an under-cap step untouched", () => {
    const step = { goal: "g", rows: rows(6) };
    expect(trimStepForStorage(step)).toBe(step);
  });
});

describe("isCapTruncated", () => {
  it("is true when the query returned more than the cap", () => {
    expect(isCapTruncated({ rowCount: 108, rows: rows(ANALYST_ROW_CAP) })).toBe(true);
  });

  it("is true when stored rows are fewer than the recorded count", () => {
    expect(isCapTruncated({ rowCount: 40, rows: rows(30) })).toBe(true);
  });

  it("is false for a complete result", () => {
    expect(isCapTruncated({ rowCount: 6, rows: rows(6) })).toBe(false);
    expect(isCapTruncated({ rowCount: ANALYST_ROW_CAP, rows: rows(ANALYST_ROW_CAP) })).toBe(false);
  });

  it("is false when nothing is known", () => {
    expect(isCapTruncated({})).toBe(false);
  });
});

describe("the SQL prompt and the cap", () => {
  const base = {
    question: "attrition by department and month",
    plan: { steps: [] } as never,
    schema: "TABLE hr_dept_monthly (...)",
  };

  it("no longer tells the model to add a defensive LIMIT", () => {
    const { systemPrompt } = buildSqlPrompt(base);
    // The old instruction — "LIMIT 50 if the result might be large" — made
    // the model bake the cap into the SQL, where no disclosure can see it.
    expect(systemPrompt).not.toMatch(/LIMIT 50 if the result might be large/);
    expect(systemPrompt).toMatch(/Never add a defensive LIMIT/i);
  });

  it("still allows semantic top-N limits", () => {
    const { systemPrompt } = buildSqlPrompt(base);
    expect(systemPrompt).toMatch(/LIMIT only when the question itself asks/i);
  });

  it("reshape asks for a complete smaller answer, not a LIMIT", () => {
    const { systemPrompt, userPrompt } = buildSqlPrompt({
      ...base,
      reshape: { sql: "SELECT …", rowCount: 108, cap: 50 },
    });
    expect(systemPrompt).toMatch(/returned 108 rows/);
    expect(systemPrompt).toMatch(/50 rows or fewer/);
    expect(systemPrompt).toMatch(/Do NOT simply add a LIMIT/);
    expect(userPrompt).toMatch(/ROWS RETURNED: 108 — cap is 50/);
  });

  it("reshape never claims the statement failed", () => {
    // The repair channel says "FAILED" because something did. Reshape repairs
    // a SUCCESS that was too tall — telling the model it failed teaches it
    // the wrong lesson about a correct query.
    const { systemPrompt, userPrompt } = buildSqlPrompt({
      ...base,
      reshape: { sql: "SELECT …", rowCount: 108, cap: 50 },
    });
    expect(systemPrompt).not.toMatch(/FAILED/);
    expect(userPrompt).not.toMatch(/FAILED SQL|ENGINE ERROR/);
  });

  it("repair and reshape stay independent channels", () => {
    const { userPrompt } = buildSqlPrompt({
      ...base,
      repair: { sql: "SELECT bad", error: "no such column" },
    });
    expect(userPrompt).toMatch(/FAILED SQL/);
    expect(userPrompt).not.toMatch(/OVERSIZED SQL/);
  });
});

// ── The loop itself, with a fake model and a fake engine ────────────────
//
// Everything above is source- or prompt-level; this drives runAnalystTurn
// end to end, because the first mutation run proved the reshape retry could
// be deleted from the loop while every other test stayed green. The llm and
// execute injection points exist precisely so this is possible without a
// model or a database.
import { runAnalystTurn } from "@/lib/aiAnalyst";

function fakeWorld(opts: { reshapedRows: number; reshapeThrows?: boolean }) {
  const calls: string[] = [];
  const llm = async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    const p = a.systemPrompt + a.userPrompt;
    if (/OVERSIZED SQL/.test(p)) {
      calls.push("reshape");
      if (opts.reshapeThrows) throw new Error("model unavailable");
      return { sql: "SELECT wide" } as T;
    }
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      calls.push("plan");
      return { approach: "one step", steps: [{ goal: "attrition grid" }] } as T;
    }
    if (/"sql"/.test(p)) {
      calls.push("sql");
      return { sql: "SELECT tall" } as T;
    }
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      calls.push("check");
      return { checks: [{ verdict: "pass", note: "ok" }], headline: 0 } as T;
    }
    calls.push("synthesis");
    return { answer: "done", follow_ups: [] } as T;
  };
  const row = (i: number) => ({ n: i });
  const execute = async (sql: string) => {
    if (/tall/.test(sql)) {
      return { columns: ["n"], rows: Array.from({ length: 108 }, (_, i) => row(i)) };
    }
    return { columns: ["n"], rows: Array.from({ length: opts.reshapedRows }, (_, i) => row(i)) };
  };
  return { llm, execute, calls };
}

const loopArgs = (w: ReturnType<typeof fakeWorld>) => ({
  question: "attrition by department and month",
  datasets: [],
  semantics: new Map(),
  metrics: [],
  priorTurns: [],
  execute: w.execute,
  dialect: "test-engine",
  llm: w.llm,
  onUpdate: () => {},
});

describe("runAnalystTurn reshapes an over-cap result", () => {
  it("replaces a 108-row result with the reshaped complete answer", async () => {
    const w = fakeWorld({ reshapedRows: 6 });
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    expect(w.calls).toContain("reshape");
    expect(step.sql).toBe("SELECT wide");
    expect(step.rowCount).toBe(6);
    expect(step.rows).toHaveLength(6);
  });

  it("keeps the original result and its disclosure when the reshape is still too tall", async () => {
    const w = fakeWorld({ reshapedRows: 200 });
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    // The rewrite did not help; the honest fallback is the original result
    // with its true count intact so "(showing 50 of 108)" can render.
    expect(step.sql).toBe("SELECT tall");
    expect(step.rowCount).toBe(108);
    expect(step.rows).toHaveLength(ANALYST_ROW_CAP);
  });

  it("keeps the original result when the reshape model call fails", async () => {
    const w = fakeWorld({ reshapedRows: 6, reshapeThrows: true });
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    expect(step.sql).toBe("SELECT tall");
    expect(step.rowCount).toBe(108);
    expect(step.status).toBe("done");
  });

  it("never reshapes a result that already fits", async () => {
    const w = fakeWorld({ reshapedRows: 6 });
    // make the first query small: return 6 rows for 'tall' too
    const smallExecute = async () => ({
      columns: ["n"],
      rows: Array.from({ length: 6 }, (_, i) => ({ n: i })),
    });
    await runAnalystTurn({ ...loopArgs(w), execute: smallExecute });
    expect(w.calls).not.toContain("reshape");
  });
});

// ── Engine-level truncation (the deeper layer) ──────────────────────────
//
// After the prompt fix, the heatmap STILL rendered "50 rows" flat: the
// browser engine (lib/sqlEngine.runQuery) caps at PLAYGROUND_ROW_CAP=50 and
// faithfully reports total_matched/capped — and captureResult read
// rows.length, throwing the disclosure away. Truncation had moved down a
// layer, and each layer must hand the truth up.
import { describeResultFacts } from "@/lib/biAgent";

describe("engine-capped results", () => {
  it("the loop sees total_matched and reshapes an engine-capped result", async () => {
    const w = fakeWorld({ reshapedRows: 6 });
    const cappedExecute = async (sql: string) =>
      /tall/.test(sql)
        ? {
            columns: ["n"],
            rows: Array.from({ length: 50 }, (_, i) => ({ n: i })),
            row_count: 50,
            total_matched: 108,
            capped: true,
            duration_ms: 1,
          }
        : {
            columns: ["n"],
            rows: Array.from({ length: 6 }, (_, i) => ({ n: i })),
            row_count: 6,
            total_matched: 6,
            capped: false,
            duration_ms: 1,
          };
    const turn = await runAnalystTurn({ ...loopArgs(w), execute: cappedExecute });
    expect(w.calls).toContain("reshape");
    expect(turn.steps[0].sql).toBe("SELECT wide");
    expect(turn.steps[0].rowCount).toBe(6);
  });
});

describe("describeResultFacts and truncation", () => {
  const result = (rows: number, total: number) => ({
    columns: ["dept", "pct"],
    rows: Array.from({ length: rows }, (_, i) => ({ dept: `d${i}`, pct: i })),
    row_count: rows,
    total_matched: total,
    capped: total > rows,
    duration_ms: 1,
  });

  it("states the truncation before any figure", () => {
    const facts = describeResultFacts(result(50, 108));
    expect(facts).toMatch(/first 50 of 108 matching rows/);
    // it must LEAD with it — a note after the numbers reads as a footnote.
    expect(facts.indexOf("first 50 of 108")).toBeLessThan(facts.indexOf("pct"));
  });

  it("says nothing about truncation for a complete result", () => {
    expect(describeResultFacts(result(6, 6))).not.toMatch(/truncated|matching rows/);
  });
});
