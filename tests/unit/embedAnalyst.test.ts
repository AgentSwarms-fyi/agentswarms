// Embedding an AI Analyst on a public site.
//
// This surface is more exposed than an embedded dashboard: a dashboard serves
// numbers the owner already computed, while an analyst accepts a QUESTION and
// writes fresh SQL. So the failures worth pinning are the ones that publish
// something the owner never meant to publish, and the ones that tell a
// visitor — or the owner — something untrue about why an answer is missing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sanitizePublicTurn, type AnalystTurn } from "@/lib/aiAnalyst";

const turn = (over: Partial<AnalystTurn> = {}): AnalystTurn => ({
  question: "How many employees per department?",
  approach: "Group the latest month by department.",
  answer: "344 employees across 6 departments.",
  followUps: ["How has each department trended?"],
  status: "done",
  steps: [
    {
      goal: "Headcount by department for the latest month",
      sql: "SELECT Department, Headcount FROM hr_dept_monthly WHERE Month = (SELECT MAX(Month) FROM hr_dept_monthly)",
      columns: ["Department", "Headcount"],
      rows: [{ Department: "Engineering", Headcount: 135 }],
      rowCount: 6,
      chart: { type: "bar", xField: "Department", yField: "Headcount" },
      check: { verdict: "pass", note: "One row per department." },
      governed: { model: "headcount_model" },
      semantic: { model: "headcount_model", metrics: ["headcount"], dimensions: ["department"] },
      status: "done",
    },
  ],
  ...over,
});

describe("what a public analyst embed may return", () => {
  it("STRIPS each step's SQL — it names the owner's tables", () => {
    // `FROM hr_dept_monthly` is a table nobody outside the company should
    // learn from a chat widget on a marketing page.
    const out = sanitizePublicTurn(turn());
    expect(out.steps[0].sql).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("hr_dept_monthly");
  });

  it("strips the compiled semantic query too", () => {
    expect(sanitizePublicTurn(turn()).steps[0].semantic).toBeUndefined();
  });

  it("KEEPS the governed disclosure — it is evidence, not schema", () => {
    // "This number came from a governed model" is the reader's reason to
    // trust it. Removing it would make a governed answer indistinguishable
    // from improvised SQL.
    expect(sanitizePublicTurn(turn()).steps[0].governed?.model).toBe("headcount_model");
  });

  it("keeps everything the reader came for", () => {
    const out = sanitizePublicTurn(turn());
    expect(out.answer).toContain("344");
    expect(out.approach).toBeTruthy();
    expect(out.followUps).toHaveLength(1);
    expect(out.steps[0].rows).toHaveLength(1);
    expect(out.steps[0].chart?.type).toBe("bar");
    expect(out.steps[0].check?.verdict).toBe("pass");
  });

  it("keeps the row count, so a sampled step still says it was sampled", () => {
    expect(sanitizePublicTurn(turn()).steps[0].rowCount).toBe(6);
  });

  it("survives a turn with no steps", () => {
    expect(sanitizePublicTurn(turn({ steps: [] })).steps).toEqual([]);
  });

  it("does not mutate the turn it was given", () => {
    // The caller still holds the real trace; sanitising is for the wire.
    const t = turn();
    sanitizePublicTurn(t);
    expect(t.steps[0].sql).toContain("hr_dept_monthly");
  });
});

describe("the streaming endpoint applies it", () => {
  // A pure sanitiser nothing calls protects nothing. The analyst turn has its
  // own STREAMING route since the 30–95s blind wait was fixed; /api/embed
  // still answers resolve and ask as JSON.
  const ROUTE = readFileSync("src/routes/api/embed.analyst.ts", "utf8");

  it("sanitises the FINAL turn on the way out", () => {
    expect(ROUTE).toContain("sanitizePublicTurn(trimTurnForStorage(out.turn))");
  });

  it("sanitises EVERY streamed frame, not just the last", () => {
    // A partial turn carries the same step SQL the final one does. Streaming
    // without sanitising each frame would reopen the leak the buffered path
    // closed — and it would be invisible, because the finished turn is clean.
    expect(ROUTE).toContain("sanitizePublicTurn(turn)");
    expect(ROUTE).toMatch(/send\("turn",\s*\{\s*turn: sanitizePublicTurn\(turn\)\s*\}\)/);
  });

  it("refuses a turn on a key that is not for an analyst", () => {
    expect(ROUTE).toContain('keyRow.resource_type !== "ai_analyst"');
  });

  it("gates analyst turns on the owner's budget", () => {
    // Several model calls per question, billed to the owner, triggered by
    // strangers — the per-key cap is the control that bounds it.
    expect(ROUTE).toContain("getBudgetDecision");
    expect(ROUTE).toContain("budgetMessage(budget)");
  });

  it("rate-limits analyst turns harder than a dashboard question", () => {
    // 5/min here, against 10 for a single-shot dashboard question.
    expect(ROUTE).toMatch(/rateLimitedGlobal\([^)]*analyze:[^)]*,\s*5\)/);
  });

  it("tells proxies not to buffer, or streaming achieves nothing", () => {
    expect(ROUTE).toContain("X-Accel-Buffering");
    expect(ROUTE).toContain("text/event-stream");
  });
});

describe("the client treats a dropped stream as a failure", () => {
  const CLIENT = readFileSync("src/lib/embedClient.ts", "utf8");

  it("refuses to present a half-streamed trace as the answer", () => {
    // Ending without `done` or `failed` means the connection dropped. The
    // partial turn on screen has steps but no findings, and returning it as
    // success would render an unfinished analysis as a conclusion.
    expect(CLIENT).toContain("The connection dropped mid-analysis");
  });
});

describe("the server runner tells the owner the truth about failures", () => {
  const RUNNER = readFileSync("src/utils/analyst/run.server.ts", "utf8");

  it("distinguishes a FAILED dataset read from an empty scope", () => {
    // These were collapsed once, and a malformed query rendered as "this
    // analyst's datasets are no longer available" — an actionable-sounding
    // message sending the owner to re-scope an analyst that was fine.
    expect(RUNNER).toContain("Could not read the analyst's datasets");
    expect(RUNNER).toMatch(/catch \(e\) \{\s*return \{ ok: false, status: 503/);
  });

  it("does not ask for a row_count column that does not exist", () => {
    expect(RUNNER).not.toMatch(/select\([^)]*row_count/);
    expect(RUNNER).toContain("parquet_rows");
  });

  it("refuses an analyst belonging to someone other than the key's owner", () => {
    expect(RUNNER).toContain("data.user_id !== ownerId");
  });

  it("meters the model spend to the embed key", () => {
    expect(RUNNER).toContain("costScope: args.costScope");
  });
});
