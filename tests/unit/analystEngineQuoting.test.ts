// R512 UI test: generated SQL in the quoting of the engine that runs it.
//
// Asked for "daily total sales for the latest year as a calendar", the
// analyst's model wrote `Order Date` in backticks. DuckDB refused it, the
// repair pass shown that error wrote backticks again, and the self-check's
// correction of the next step did the same, so the turn had no answer. The
// prompt already said "never use backticks"; the SQL is now rewritten.
import { describe, expect, it, vi } from "vitest";

const ran: string[] = [];

vi.mock("@/lib/sqlEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sqlEngine")>()),
  // DuckDB as it behaves: a backtick outside a string literal is a parser error.
  runQueryUnlimited: async (sql: string) => {
    ran.push(sql);
    if (sql.replace(/'(?:[^']|'')*'/g, "''").includes("`")) {
      throw new Error('Parser Error: syntax error at or near "Order"');
    }
    return {
      columns: ["order_date", "total_sales"],
      rows: [
        { order_date: "2026-01-02", total_sales: 10 },
        { order_date: "2026-01-03", total_sales: 12 },
      ],
      total: 2,
      capped: false,
    };
  },
}));

import { runAnalystTurn } from "@/lib/aiAnalyst";
import { sqlForEngine } from "@/lib/biAgent";

const BACKTICKED =
  "SELECT `Order Date` AS order_date, SUM(`Sales`) AS total_sales FROM saas_sales " +
  "WHERE `Region` = 'it''s `fine`' GROUP BY `Order Date`";

function fakeModel(refined?: string) {
  return async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    const p = a.systemPrompt + a.userPrompt;
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      return { approach: "one step", steps: [{ goal: "daily total sales" }] } as T;
    }
    if (/writing up findings/.test(a.systemPrompt)) {
      return { answer: "Sales were 22 (step 1).", follow_ups: [] } as T;
    }
    if (/"sql"/.test(p)) return { sql: BACKTICKED } as T;
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      return {
        checks: [
          refined
            ? { verdict: "suspect", note: "Narrow it.", refined_sql: refined }
            : { verdict: "pass", note: "ok" },
        ],
        headline: 0,
      } as T;
    }
    return {} as T;
  };
}

const args = (llm: ReturnType<typeof fakeModel>) => ({
  question: "daily total sales",
  datasets: [],
  semantics: new Map(),
  metrics: [],
  priorTurns: [],
  llm,
  onUpdate: () => {},
});

describe("sqlForEngine", () => {
  it("rewrites backtick identifiers for local DuckDB and leaves literals alone", () => {
    expect(sqlForEngine(BACKTICKED, {})).toBe(
      'SELECT "Order Date" AS order_date, SUM("Sales") AS total_sales FROM saas_sales ' +
        `WHERE "Region" = 'it''s \`fine\`' GROUP BY "Order Date"`,
    );
    expect(sqlForEngine(BACKTICKED, { localEngine: "duckdb" })).not.toMatch(/`Order Date`/);
  });

  it("keeps what was written for a warehouse or for AlaSQL", () => {
    expect(sqlForEngine(BACKTICKED, { dialect: "MySQL" })).toBe(BACKTICKED);
    expect(sqlForEngine(BACKTICKED, { localEngine: "alasql" })).toBe(BACKTICKED);
  });
});

describe("an analyst step over local data", () => {
  it("runs the model's backticked SQL in DuckDB's quoting", async () => {
    ran.length = 0;
    const turn = await runAnalystTurn(args(fakeModel()));
    const step = turn.steps[0];
    expect(step.status).toBe("done");
    expect(step.error).toBeUndefined();
    expect(step.sql).toContain('"Order Date"');
    expect(step.rowCount).toBe(2);
    expect(ran.every((sql) => !sql.includes("`Order Date`"))).toBe(true);
  });

  it("runs the self-check's backticked correction too", async () => {
    ran.length = 0;
    const turn = await runAnalystTurn(
      args(
        fakeModel(
          "SELECT `Order Date` AS order_date, SUM(`Sales`) AS total_sales FROM saas_sales GROUP BY 1",
        ),
      ),
    );
    const step = turn.steps[0];
    expect(step.check?.verdict).toBe("refined");
    expect(step.sql).toBe(
      'SELECT "Order Date" AS order_date, SUM("Sales") AS total_sales FROM saas_sales GROUP BY 1',
    );
    expect(step.check?.note).not.toMatch(/failed to run/);
  });
});

describe("an analyst step over a warehouse", () => {
  it("sends the SQL as written", async () => {
    const sent: string[] = [];
    await runAnalystTurn({
      ...args(fakeModel()),
      dialect: "MySQL",
      execute: async (sql: string) => {
        sent.push(sql);
        return {
          columns: ["order_date", "total_sales"],
          rows: [{ order_date: "2026-01-02", total_sales: 10 }],
          row_count: 1,
          duration_ms: 0,
        };
      },
    });
    expect(sent[0]).toContain("`Order Date`");
  });
});
