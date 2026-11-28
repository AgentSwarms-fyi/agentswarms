// Data-quality findings quote no personal value, and alerts quote no value at
// all (R557). A failing `unique` check on an email column read "e.g.
// "ann@…" ×2", and the alert carrying that line is mirrored to the owner's
// Slack, Teams and webhooks, where everyone in the channel reads it.
//
// The evaluator is the real one; the classifier is the real one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  evaluateQualityTest,
  qualityAlertLines,
  type QualityContext,
  type QualityTest,
} from "@/lib/dataQualityCore";

const test = (over: Partial<QualityTest>): QualityTest => ({
  id: "t1",
  table_id: "d1",
  kind: "unique",
  column_name: "contact",
  config: {},
  enabled: true,
  severity: "error",
  ...over,
});

/** 20 rows; `contact` holds addresses, two of them repeated. */
const rows = Array.from({ length: 20 }, (_, i) => ({
  contact: `person${i < 2 ? 0 : i}@example.com`,
  phone: `+44 20 7946 0${String(100 + (i < 3 ? 0 : i)).slice(-3)}`,
  status: i < 18 ? "shipped" : "lost",
  amount: i === 19 ? 9999 : 10 + i,
  email_campaign_id: i < 2 ? 7 : 1000 + i,
  email: i < 2 ? 5 : 1000 + i,
}));
const ctx: QualityContext = { rows, totalRows: rows.length };

const NO_ADDRESS = /@example\.com/;

describe("a finding on a personal column", () => {
  it("unique on email addresses says how many, never which", () => {
    const out = evaluateQualityTest(test({ kind: "unique", column_name: "contact" }), ctx);
    expect(out.status).toBe("fail");
    expect(out.failingRows).toBe(2);
    expect(out.detail).not.toMatch(NO_ADDRESS);
    expect(out.detail).toBe(
      '2 rows share a duplicated "contact". No examples are shown: the column holds email addresses.',
    );
    expect(out.brief).toBe('2 rows share a duplicated "contact".');
  });

  it("accepted values on phone numbers quotes none of them", () => {
    const out = evaluateQualityTest(
      test({ kind: "accepted_values", column_name: "phone", config: { values: ["x"] } }),
      ctx,
    );
    expect(out.status).toBe("fail");
    expect(out.detail).not.toMatch(/7946/);
    expect(out.detail).toContain("the column holds phone numbers");
    expect(out.brief).not.toMatch(/7946/);
  });

  it("a range check on a text column of phone numbers does not quote the numbers it could not read", () => {
    const out = evaluateQualityTest(
      test({ kind: "range", column_name: "phone", config: { min: 0, max: 10 } }),
      ctx,
    );
    expect(out.status).toBe("fail");
    expect(out.detail).toContain("not numeric");
    expect(out.detail).not.toMatch(/7946/);
    expect(out.detail).toContain("the column holds phone numbers");
  });

  it("a column named as personal, with too few values to overrule the name, is treated as personal", () => {
    const few: QualityContext = { rows: rows.slice(0, 4), totalRows: 4 };
    const out = evaluateQualityTest(test({ kind: "unique", column_name: "email" }), few);
    expect(out.status).toBe("fail");
    expect(out.detail).not.toMatch(/e\.g\./);
    expect(out.detail).toContain("No examples are shown");
  });

  it("a column whose name sounds personal but whose values are numbers keeps its examples", () => {
    const out = evaluateQualityTest(
      test({ kind: "unique", column_name: "email_campaign_id" }),
      ctx,
    );
    expect(out.detail).toContain('— e.g. "7" ×2');
  });
});

describe("a finding on an ordinary column", () => {
  it("keeps its examples for the owner, and its brief has none", () => {
    const out = evaluateQualityTest(
      test({ kind: "accepted_values", column_name: "status", config: { values: ["shipped"] } }),
      ctx,
    );
    expect(out.detail).toBe('2 rows have an unexpected "status" — e.g. "lost".');
    expect(out.brief).toBe('2 rows have an unexpected "status".');
  });

  it("range keeps its examples in the detail only", () => {
    const out = evaluateQualityTest(
      test({ kind: "range", column_name: "amount", config: { min: 0, max: 100 } }),
      ctx,
    );
    expect(out.detail).toBe("1 rows fall outside 0–100 — e.g. 9999.");
    expect(out.brief).toBe("1 rows fall outside 0–100.");
  });

  it("a capped read notes it in both", () => {
    const out = evaluateQualityTest(
      test({ kind: "accepted_values", column_name: "status", config: { values: ["shipped"] } }),
      { ...ctx, capped: true, totalRows: 1000 },
    );
    expect(out.detail).toMatch(/checked the first 20 rows\)$/);
    expect(out.brief).toMatch(/checked the first 20 rows\)$/);
  });

  it("a passing check has no brief, and says so plainly", () => {
    const out = evaluateQualityTest(test({ kind: "unique", column_name: "amount" }), ctx);
    expect(out.status).toBe("pass");
    expect(out.brief).toBeUndefined();
    expect(out.detail).toBe('All 20 non-empty values in "amount" are distinct.');
  });
});

describe("the alert", () => {
  it("carries the brief, never the examples", () => {
    const status = test({
      id: "t2",
      kind: "accepted_values",
      column_name: "status",
      config: { values: ["shipped"] },
      severity: "warn",
    });
    const contact = test({ id: "t1", kind: "unique", column_name: "contact" });
    const bad = [status, contact].map((t) => ({ test: t, outcome: evaluateQualityTest(t, ctx) }));
    const text = qualityAlertLines(bad);
    expect(text).not.toMatch(NO_ADDRESS);
    expect(text).not.toMatch(/"lost"|e\.g\./);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain('(warn): 2 rows have an unexpected "status".');
    expect(text).toContain('2 rows share a duplicated "contact".');
  });

  it("falls back to the detail for findings that quote nothing", () => {
    const t = test({ kind: "not_null", column_name: "contact" });
    const outcome = {
      status: "fail" as const,
      failingRows: 3,
      totalRows: 20,
      detail: '3 empty values in "contact".',
    };
    expect(qualityAlertLines([{ test: t, outcome }])).toContain('3 empty values in "contact".');
  });

  it("is what the scheduled check sends", () => {
    const server = readFileSync("src/utils/bi/quality.server.ts", "utf8");
    const notify = server.slice(server.indexOf("async function notifyVerdictChange("));
    expect(notify).toContain("const lines = qualityAlertLines(bad);");
    expect(notify).not.toContain("outcome.detail");
  });
});
