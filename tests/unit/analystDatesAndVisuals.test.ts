// R512's second UI pass, four analyst faults, on the saas sample (orders
// 2022-01-04 → 2025-12-31), asked for "daily total sales for the latest year as
// a calendar, sales by region and segment as a treemap, and a pivot of sales by
// region and segment. What is the total for the year?":
//
// 1. The plan filtered "the latest year" to 2023 — no prompt said what the
//    data covered or what today was — and reported 470,532.51, not 2025's
//    733,948.02.
// 2. The self-check called 2024 and 2025 "future years".
// 3. The self-check "corrected" a governed 4-row step for its LIMIT 101, which
//    cut nothing; the rewrite dropped the ORDER BY and the governed status, and
//    the yearly chart read 2024, 2023, 2022, 2025.
// 4. Visuals were matched to steps by position: the calendar went to the KPI
//    step, the treemap was never drawn, and the write-up said no pivot was
//    provided while one was drawn beside it.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ran: [] as string[],
  tables: [
    {
      name: "saas_sales",
      columns: [
        { name: "Order Date", type: "date" as const },
        { name: "Ship Date", type: "date" as const },
        { name: "Region", type: "string" as const },
        { name: "Sales", type: "number" as const },
      ],
      rows: [
        { "Order Date": "1/4/2022", "Ship Date": "2022-01-09", Region: "EMEA", Sales: 1 },
        { "Order Date": "7/15/2023", "Ship Date": "2023-07-20", Region: "AMER", Sales: 10 },
        { "Order Date": "12/31/2025", "Ship Date": "2026-01-03", Region: "APJ", Sales: 100 },
      ],
    },
  ],
}));

vi.mock("@/lib/sqlEngine", async (importOriginal) => {
  const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
  return {
    ...(await importOriginal<typeof import("@/lib/sqlEngine")>()),
    // The real engine, over the rows above.
    runQueryUnlimited: async (sql: string) => {
      h.ran.push(sql);
      const r = await runLocalSqlDuckDB(sql, h.tables);
      return { columns: r.columns, rows: r.rows, total: r.rows.length, capped: false };
    },
  };
});

import {
  askedChartForStep,
  correctedStepNote,
  GOVERNED_PARTIAL_NOTE_START,
  limitCutNothing,
  needlessLimitCorrection,
  runAnalystTurn,
  trailingLimit,
  type AnalystTurn,
} from "@/lib/aiAnalyst";
import {
  dateRangeSql,
  describeDates,
  readDateSpans,
  spansFromRow,
  todayIso,
} from "@/lib/analystDates";
import { askedVisualsForSteps } from "@/lib/analystVisuals";
import { requestedChartMentions } from "@/lib/biChartCatalog";
import type { DatasetMeta } from "@/lib/sqlEngine";

const SAAS: DatasetMeta = {
  id: "d1",
  name: "saas_sales",
  source_filename: null,
  is_sample: true,
  user_id: null,
  columns: h.tables[0].columns,
  row_count: 3,
  data_loaded_at: null,
  parquet_bytes: null,
};

const QUESTION =
  "Show daily total sales for the latest year as a calendar, sales by region and segment as " +
  "a treemap, and a pivot of sales by region and segment. What is the total for the year?";

describe("the dates the analyst is told", () => {
  it("are today in the local calendar", () => {
    expect(todayIso(new Date(2026, 10, 20, 23, 59))).toBe("2026-11-20");
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("are each date column's real range, read on DuckDB in its own format", async () => {
    const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
    const sql = dateRangeSql(SAAS)!;
    const row = (await runLocalSqlDuckDB(sql, h.tables)).rows[0];
    expect(spansFromRow(SAAS, row)).toEqual([
      // Month-first text, the saas sample's format.
      { table: "saas_sales", column: "Order Date", earliest: "2022-01-04", latest: "2025-12-31" },
      // ISO text.
      { table: "saas_sales", column: "Ship Date", earliest: "2022-01-09", latest: "2026-01-03" },
    ]);
  });

  it("read day-first dates day-first when only that parses them all", () => {
    const d: DatasetMeta = { ...SAAS, columns: [{ name: "When", type: "date" }] };
    // 3 iso, 2 month-first, 3 day-first parses: day-first wins.
    const row = {
      c0_0_n: 0,
      c0_1_n: 2,
      c0_1_lo: "2024-01-13",
      c0_1_hi: "2024-02-01",
      c0_2_n: 3,
      c0_2_lo: "2024-01-02",
      c0_2_hi: "2024-12-01",
    };
    expect(spansFromRow(d, row)[0]).toMatchObject({ earliest: "2024-01-02" });
    // A tie goes month-first, as uploads decide it.
    expect(spansFromRow(d, { ...row, c0_2_n: 2 })[0]).toMatchObject({ earliest: "2024-01-13" });
  });

  it("skip a dataset whose range query fails, and datasets without dates", async () => {
    const plain: DatasetMeta = {
      ...SAAS,
      id: "d2",
      name: "plain",
      columns: [{ name: "x", type: "number" }],
    };
    expect(dateRangeSql(plain)).toBeNull();
    const spans = await readDateSpans([SAAS, plain], async () => {
      throw new Error("Catalog Error");
    });
    expect(spans).toEqual([]);
  });

  it("say what latest means to the planner only", () => {
    const spans = [
      { table: "saas_sales", column: "Order Date", earliest: "2022-01-04", latest: "2025-12-31" },
    ];
    const plan = describeDates("2026-11-20", spans, true);
    expect(plan).toContain("TODAY: 2026-11-20");
    expect(plan).toContain('saas_sales."Order Date": 2022-01-04 → 2025-12-31');
    expect(plan).toMatch(/"latest".*newest one the data holds/);
    expect(describeDates("2026-11-20", spans)).not.toMatch(/"latest"/);
    // No range (a warehouse): the planner is told to find it, not to guess.
    expect(describeDates("2026-11-20", [], true)).toMatch(/never from your own sense of the date/);
  });
});

describe("a LIMIT the self-check may correct", () => {
  it("is read from the end of the query", () => {
    expect(trailingLimit('SELECT 1 FROM t ORDER BY "y" LIMIT 101')).toBe(101);
    expect(trailingLimit("SELECT 1 FROM t LIMIT 5 OFFSET 10;")).toBe(5);
    expect(trailingLimit("SELECT * FROM (SELECT 1 LIMIT 3) s")).toBeNull();
  });

  it("cut nothing when fewer rows came back, unless the runner says they are a prefix", () => {
    expect(limitCutNothing("SELECT 1 LIMIT 101", 4)).toBe(true);
    expect(limitCutNothing("SELECT 1 LIMIT 5", 5)).toBe(false);
    expect(limitCutNothing("SELECT 1 LIMIT 101", 100, true)).toBe(false);
    expect(limitCutNothing("SELECT 1", 4)).toBe(false);
  });

  it("is a needless correction only when the note blames the LIMIT", () => {
    const base = { sql: "SELECT 1 LIMIT 101", rowCount: 4 };
    expect(
      needlessLimitCorrection({ ...base, note: "A LIMIT of 101 cuts the ranking short." }),
    ).toBe(true);
    expect(needlessLimitCorrection({ ...base, note: "Wrong column." })).toBe(false);
    expect(needlessLimitCorrection({ ...base, rowCount: 101, note: "The LIMIT cut it." })).toBe(
      false,
    );
  });
});

// R512's fourth UI pass: the governed daily step really was cut (100 of 323
// days), the correction brought back all 323, and the note still said "shows
// only 100 rows" — so the write-up warned the data was incomplete.
describe("the note a corrected step keeps", () => {
  const partial =
    "Partial: the governed model returned the first 100 groups of a larger result, so totals " +
    "and rankings from this step may be incomplete — narrow with a filter or a coarser grain " +
    "to see everything.";

  it("drops a compiler cut the correction cured and says what came back", () => {
    expect(
      correctedStepNote({
        pre: partial,
        reason: "Daily total sales shows only 100 rows",
        before: { rows: 100, capped: true },
        after: { rows: 323, total: 323, capped: false },
      }),
    ).toBe(
      "Daily total sales shows only 100 rows. The first run stopped at 100 rows; the " +
        "corrected query returned all 323.",
    );
  });

  it("says when the corrected query was cut too", () => {
    const still = (after: { rows: number; total?: number; capped: boolean }) =>
      correctedStepNote({ reason: "Too narrow.", before: { rows: 100, capped: true }, after });
    expect(still({ rows: 5000, total: 6200, capped: true })).toBe(
      "Too narrow. The corrected query matched 6,200 rows and kept the first 5,000, so totals " +
        "from it may be incomplete.",
    );
    expect(still({ rows: 5000, capped: true })).toBe(
      "Too narrow. The corrected query was cut at 5,000 rows too, so totals from it may be incomplete.",
    );
  });

  it("keeps a note about how the step was made, and says the count of an uncut fix", () => {
    expect(
      correctedStepNote({
        pre: "The governed model could not answer this step (no such metric).",
        reason: "",
        before: { rows: 4, capped: false },
        after: { rows: 1, total: 1, capped: false },
      }),
    ).toBe(
      "The governed model could not answer this step (no such metric). Corrected on " +
        "self-review. The corrected query returned 1 row.",
    );
  });

  it("recognises the governed cut by the words the governed step writes", async () => {
    const { readFileSync } = await import("node:fs");
    const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");
    expect(lib).toContain(`\`${GOVERNED_PARTIAL_NOTE_START}\${res.rows.length} groups`);
  });
});

describe("the visual asked for at each step", () => {
  it("has its clause read from the question", () => {
    expect(requestedChartMentions(QUESTION)).toEqual([
      {
        type: "calendar",
        phrase: "calendar",
        clause: "Show daily total sales for the latest year as a calendar",
      },
      { type: "treemap", phrase: "treemap", clause: "sales by region and segment as a treemap" },
      { type: "matrix", phrase: "pivot", clause: "a pivot of sales by region and segment" },
    ]);
  });

  it("goes to the step computing its numbers, not the step in its position", () => {
    const goals = [
      "total sales for the latest year",
      "daily total sales for the latest year",
      "sales by region and segment",
    ];
    const v = askedVisualsForSteps(QUESTION, goals);
    // By position the KPI step was offered the calendar and the daily step
    // the treemap (R512's UI test).
    expect(v.perStep.map((x) => x?.type)).toEqual([undefined, "calendar", "treemap"]);
    expect(v.unplaced).toEqual([{ type: "matrix", phrase: "pivot" }]);
    expect(askedChartForStep(QUESTION, goals, 0)).toBeUndefined();
  });

  it("lets two visuals of the same numbers be two steps", () => {
    const goals = [
      "total sales for the latest year",
      "daily total sales for the latest year",
      "sales by region and segment as a treemap",
      "pivot of sales by region and segment",
    ];
    const v = askedVisualsForSteps(QUESTION, goals);
    expect(v.perStep.map((x) => x?.type)).toEqual([undefined, "calendar", "treemap", "matrix"]);
    expect(v.unplaced).toEqual([]);
  });
});

// ── The loop, end to end ──────────────────────────────────────────────────

const GOVERNED_SQL =
  'SELECT "order_date", SUM("Sales") AS "total_sales" FROM saas_sales GROUP BY 1 ' +
  'ORDER BY "order_date" ASC LIMIT 101';
const UNORDERED = 'SELECT "Region", SUM("Sales") AS total_sales FROM saas_sales GROUP BY 1';

function fakeModel(prompts: { system: string; user: string }[]) {
  return async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    prompts.push({ system: a.systemPrompt, user: a.userPrompt });
    const p = a.systemPrompt + a.userPrompt;
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      return {
        approach: "yearly totals, then the regions",
        steps: [
          {
            goal: "yearly total sales",
            semantic: {
              model: "saas_model",
              metrics: ["total_sales"],
              dimensions: ["order_date"],
              grains: { order_date: "year" },
            },
          },
          { goal: "total sales by region" },
        ],
      } as T;
    }
    if (/writing up findings/.test(a.systemPrompt)) {
      return { answer: "Sales were 111 (step 1).", follow_ups: [] } as T;
    }
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      return {
        checks: [
          {
            verdict: "suspect",
            note: "Step 1 has a LIMIT of 101 which cuts the ranking short.",
            refined_sql: 'SELECT "Order Date", SUM("Sales") FROM saas_sales GROUP BY 1',
          },
          { verdict: "pass", note: "ok" },
        ],
        headline: 0,
      } as T;
    }
    if (/"sql"/.test(p)) return { sql: UNORDERED } as T;
    return {} as T;
  };
}

describe("an analyst turn", () => {
  it("knows today and the data's dates, keeps a governed step a LIMIT did not cut, and says which visual was not drawn", async () => {
    h.ran.length = 0;
    const prompts: { system: string; user: string }[] = [];
    const turn: AnalystTurn = await runAnalystTurn({
      question: "Show yearly total sales as a bar chart, and a treemap of sales by segment",
      datasets: [SAAS],
      semantics: new Map(),
      metrics: [],
      priorTurns: [],
      llm: fakeModel(prompts),
      today: "2026-11-20",
      catalog: [
        {
          name: "saas_model",
          table: "saas_sales",
          metrics: ["total_sales"],
          dimensions: ["order_date"],
          timeDimensions: ["order_date"],
        },
      ],
      runSemantic: async () => ({
        sql: GOVERNED_SQL,
        columns: ["order_date", "total_sales"],
        rows: [
          { order_date: "2022", total_sales: 1 },
          { order_date: "2023", total_sales: 10 },
          { order_date: "2025", total_sales: 100 },
        ],
      }),
      onUpdate: () => {},
    });

    const plan = prompts.find((p) => /"approach"/.test(p.system + p.user))!;
    expect(plan.user).toContain("TODAY: 2026-11-20");
    expect(plan.user).toContain('saas_sales."Order Date": 2022-01-04 → 2025-12-31');
    expect(plan.system).toMatch(/give EACH visual its own step/);

    const check = prompts.find((p) => /REVIEWING YOUR OWN WORK/.test(p.system))!;
    expect(check.user).toContain("TODAY: 2026-11-20");
    expect(check.user).toContain("COMPLETE: 3 rows, fewer than its LIMIT of 101");

    // The correction is refused: the governed, ordered result stands.
    const [yearly] = turn.steps;
    expect(yearly.sql).toBe(GOVERNED_SQL);
    expect(yearly.governed?.model).toBe("saas_model");
    expect(yearly.rows?.map((r) => r.order_date)).toEqual(["2022", "2023", "2025"]);
    expect(yearly.check).toEqual({
      verdict: "pass",
      note: "All 3 rows came back — the LIMIT of 101 cut nothing, so the result stands as it ran.",
    });
    expect(h.ran.some((s) => s.includes('"Order Date", SUM("Sales") FROM'))).toBe(false);

    const synth = prompts.find((p) => /writing up findings/.test(p.system))!;
    expect(synth.user).toContain("TODAY: 2026-11-20");
    expect(synth.user).toMatch(/STEP 1: yearly total sales\nSHOWN AS: bar chart/);
    expect(synth.user).toContain(
      "NOT DRAWN: the question also asked for visuals no step was drawn as (treemap)",
    );
    expect(synth.system).toMatch(/Never say a chart, table or pivot is missing/);
  });

  it("reads no date range for a warehouse", async () => {
    h.ran.length = 0;
    const prompts: { system: string; user: string }[] = [];
    const executed: string[] = [];
    await runAnalystTurn({
      question: "total sales by region",
      datasets: [SAAS],
      semantics: new Map(),
      metrics: [],
      priorTurns: [],
      llm: fakeModel(prompts),
      today: "2026-11-20",
      dialect: "Snowflake",
      execute: async (sql) => {
        executed.push(sql);
        return {
          columns: ["Region", "total_sales"],
          rows: [{ Region: "EMEA", total_sales: 1 }],
          row_count: 1,
          total_matched: 1,
          capped: false,
          duration_ms: 1,
        };
      },
      onUpdate: () => {},
    });
    expect(executed.some((s) => /TRY_STRPTIME/.test(s))).toBe(false);
    const plan = prompts.find((p) => /"approach"/.test(p.system + p.user))!;
    expect(plan.user).toContain("TODAY: 2026-11-20");
    expect(plan.user).not.toContain("DATES IN THE DATA");
  });

  it("lets a correction cure a governed cut, and stops calling the result partial", async () => {
    h.ran.length = 0;
    const prompts: { system: string; user: string }[] = [];
    const turn = await runAnalystTurn({
      question: "Show yearly total sales",
      datasets: [SAAS],
      semantics: new Map(),
      metrics: [],
      priorTurns: [],
      llm: fakeModel(prompts),
      today: "2026-11-20",
      catalog: [
        {
          name: "saas_model",
          table: "saas_sales",
          metrics: ["total_sales"],
          dimensions: ["order_date"],
          timeDimensions: ["order_date"],
        },
      ],
      // The compiler cut the result: 2 groups of a larger one.
      runSemantic: async () => ({
        sql: GOVERNED_SQL,
        columns: ["order_date", "total_sales"],
        rows: [
          { order_date: "2022", total_sales: 1 },
          { order_date: "2023", total_sales: 10 },
        ],
        truncated: true,
      }),
      onUpdate: () => {},
    });

    // The LIMIT concern is real here, so the correction runs (not refused).
    expect(h.ran.some((s) => s.includes('"Order Date", SUM("Sales") FROM'))).toBe(true);
    const [yearly] = turn.steps;
    expect(yearly.rowCount).toBe(3);
    expect(yearly.governed).toBeUndefined();
    expect(yearly.check?.verdict).toBe("refined");
    expect(yearly.check?.note).toBe(
      "Step 1 has a LIMIT of 101 which cuts the ranking short. The first run stopped at 2 " +
        "rows; the corrected query returned all 3. The correction is hand-written SQL, so this " +
        "step is no longer compiled from saas_model.",
    );

    const synth = prompts.find((p) => /writing up findings/.test(p.system))!;
    expect(synth.user).not.toContain("Partial:");
    expect(synth.user).toContain("the corrected query returned all 3");
    expect(synth.system).toMatch(/Never repeat a flaw a correction fixed as a caveat/);
  });
});
