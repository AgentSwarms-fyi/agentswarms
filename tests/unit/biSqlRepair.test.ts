// A widget that fails on a fixable engine error gets one more try.
//
// MEASURED. Generating a dashboard over the Salesforce `opportunities` table
// produced twelve widget plans; eleven built. "Quarterly Win Rate by Close
// Date" died on:
//
//   Invalid Input Error: Failed to parse format specifier %Y-Q%q:
//   Unrecognized format for strftime/strptime: %q
//
// DuckDB has no %q. The model would fix that if shown the message — and the
// prompt builder has supported exactly that since it was written, and
// aiAnalyst uses it ("One repair pass with the engine's own error, like the
// BI analyst"). The BI turn did not, so the widget was simply lost.
import { describe, expect, it } from "vitest";

import { buildSqlPrompt, repairFailureMessage } from "@/lib/biAgent";
import type { BiPlan } from "@/lib/biAgent";

const PLAN: BiPlan = {
  intent: "Quarterly win rate by close date",
  tables: ["sftest_opportunities"],
  columns: ["CloseDate", "IsWon"],
  aggregation: "ratio",
};

const FAILED = "SELECT STRFTIME(CAST(CloseDate AS DATE), '%Y-Q%q') FROM sftest_opportunities";
const ENGINE_ERROR =
  "Invalid Input Error: Failed to parse format specifier %Y-Q%q: Unrecognized format for strftime/strptime: %q";

const prompt = (repair?: { sql: string; error: string }) =>
  buildSqlPrompt({
    question: "Quarterly win rate by close date",
    plan: PLAN,
    schema: "AVAILABLE TABLES:\n- sftest_opportunities: CloseDate (date), IsWon (string)",
    repair,
  });

describe("the retry is given what it needs to do better", () => {
  const p = prompt({ sql: FAILED, error: ENGINE_ERROR });

  it("shows the statement that failed", () => {
    // Without the failed SQL the model regenerates from scratch and is likely
    // to reproduce the same mistake — that is the whole reason for the pass.
    expect(p.userPrompt).toContain(FAILED);
  });

  it("shows the engine's own error, verbatim", () => {
    expect(p.userPrompt).toContain(ENGINE_ERROR);
  });

  it("asks for a corrected statement that runs", () => {
    expect(p.systemPrompt).toMatch(/previous statement FAILED/i);
    expect(p.systemPrompt).toMatch(/corrected single statement/i);
  });

  it("still describes the engine, so the correction targets the right dialect", () => {
    expect(p.systemPrompt).toMatch(/DuckDB/);
  });
});

describe("a first attempt carries no repair framing", () => {
  const p = prompt();

  it("does not claim a previous statement failed", () => {
    expect(p.systemPrompt).not.toMatch(/previous statement FAILED/i);
  });

  it("does not include a FAILED SQL or ENGINE ERROR section", () => {
    expect(p.userPrompt).not.toContain("FAILED SQL:");
    expect(p.userPrompt).not.toContain("ENGINE ERROR:");
  });
});

describe("when the retry fails too, the report says so", () => {
  const msg = repairFailureMessage(ENGINE_ERROR, "Binder Error: column Quarter does not exist");

  it("keeps the original error", () => {
    // The first failure is the one that describes the actual data problem;
    // dropping it leaves the reader debugging the wrong statement.
    expect(msg).toContain(ENGINE_ERROR);
  });

  it("keeps the retry's error, which is often a different problem", () => {
    expect(msg).toContain("Binder Error: column Quarter does not exist");
  });

  it("states that a retry happened", () => {
    // Reporting one message reads as a single failed query, and hides that
    // the model was already shown its mistake and did not fix it.
    expect(msg).toMatch(/retry also failed/i);
  });
});
