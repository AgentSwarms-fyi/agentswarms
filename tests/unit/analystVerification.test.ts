// Verified answers. The whole value is in the invalidation: a mark that
// survives a change to what it vouched for is worse than no mark, because an
// unverified answer gets ordinary scepticism and a falsely verified one gets
// none.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  describeVerification,
  findPriorVerdict,
  fingerprintSteps,
  markTurn,
  normaliseQuestion,
  verificationStatus,
} from "@/lib/analystVerification";
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";

const step = (sql: string, model?: string): AnalystStep => ({
  goal: "g",
  sql,
  status: "done",
  ...(model ? { governed: { model } } : {}),
});

const turn = (question: string, steps: AnalystStep[]): AnalystTurn => ({
  question,
  steps,
  status: "done",
  answer: "a",
});

const AT = "2026-08-14T10:00:00.000Z";

describe("what a verdict is given about", () => {
  it("fingerprints the SQL and the governed model, ignoring whitespace", () => {
    const a = fingerprintSteps([step("SELECT  1\n  FROM t", "m")]);
    const b = fingerprintSteps([step("SELECT 1 FROM t", "m")]);
    expect(a).toBe(b);
  });

  it("distinguishes a different query, a different model, and a different order", () => {
    expect(fingerprintSteps([step("SELECT 1")])).not.toBe(fingerprintSteps([step("SELECT 2")]));
    expect(fingerprintSteps([step("SELECT 1", "m")])).not.toBe(
      fingerprintSteps([step("SELECT 1", "other")]),
    );
    expect(fingerprintSteps([step("SELECT 1"), step("SELECT 2")])).not.toBe(
      fingerprintSteps([step("SELECT 2"), step("SELECT 1")]),
    );
  });

  it("ignores the results and the write-up — same queries, same checked work", () => {
    // Re-verifying on every data refresh would make the mark meaningless.
    const t1 = { ...turn("q", [step("SELECT 1")]), answer: "one", rows: [{ x: 1 }] };
    const t2 = { ...turn("q", [step("SELECT 1")]), answer: "COMPLETELY different prose" };
    expect(fingerprintSteps(t1.steps)).toBe(fingerprintSteps(t2.steps));
  });
});

describe("recording a verdict", () => {
  it("pins verified to the steps it saw", () => {
    const t = markTurn({
      turn: turn("q", [step("SELECT 1")]),
      state: "verified",
      at: AT,
      by: "R",
    })!;
    expect(t.verification).toEqual({
      state: "verified",
      at: AT,
      by: "R",
      fingerprint: fingerprintSteps([step("SELECT 1")]),
    });
  });

  it("REFUSES to flag something wrong without saying why", () => {
    // A flag with no reason leaves the next reader where they started and
    // gives the analyst nothing to correct.
    const t = turn("q", [step("SELECT 1")]);
    expect(markTurn({ turn: t, state: "wrong", at: AT })).toBeNull();
    expect(markTurn({ turn: t, state: "wrong", note: "   ", at: AT })).toBeNull();
    expect(
      markTurn({ turn: t, state: "wrong", note: "APJ is double-counted", at: AT }),
    ).not.toBeNull();
  });

  it("refuses to vouch for a turn that never produced steps", () => {
    expect(markTurn({ turn: turn("q", []), state: "verified", at: AT })).toBeNull();
  });
});

describe("a verdict cannot outlive what it checked", () => {
  it("stays active while the steps are unchanged", () => {
    const t = markTurn({ turn: turn("q", [step("SELECT 1")]), state: "verified", at: AT })!;
    expect(verificationStatus(t).kind).toBe("active");
  });

  it("VOIDS when a step's SQL changes — the edit path", () => {
    const t = markTurn({ turn: turn("q", [step("SELECT 1")]), state: "verified", at: AT })!;
    const edited: AnalystTurn = { ...t, steps: [step("SELECT 1 WHERE x > 0")] };
    const status = verificationStatus(edited);
    expect(status.kind).toBe("void");
    // Shown, not hidden: the reader needs to know a verdict existed.
    expect(describeVerification(status)).toMatch(/no longer applies/);
  });

  it("VOIDS when a governed step loses its model — the self-correction path", () => {
    const t = markTurn({
      turn: turn("q", [step("SELECT 1", "sales_model")]),
      state: "verified",
      at: AT,
    })!;
    const corrected: AnalystTurn = { ...t, steps: [step("SELECT 1")] };
    expect(verificationStatus(corrected).kind).toBe("void");
  });

  it("reports none when there was never a verdict", () => {
    expect(verificationStatus(turn("q", [step("SELECT 1")]))).toEqual({ kind: "none" });
  });
});

describe("matching a question to a prior verdict", () => {
  it("ignores case, punctuation and spacing, and nothing else", () => {
    expect(normaliseQuestion("  Which REGION sold most?? ")).toBe("which region sold most");
    // Deliberately crude: anything cleverer starts matching questions that
    // merely resemble each other, and a verdict shown against the wrong
    // question is a false claim that someone checked it.
    expect(normaliseQuestion("which regions sold most")).not.toBe(
      normaliseQuestion("which region sold most"),
    );
  });

  it("finds the most recent ACTIVE verdict", () => {
    const older = markTurn({
      turn: turn("Which region sold most?", [step("SELECT 1")]),
      state: "verified",
      at: "2026-08-01T00:00:00.000Z",
    })!;
    const newer = markTurn({
      turn: turn("which region sold most", [step("SELECT 1")]),
      state: "wrong",
      note: "excludes returns",
      at: "2026-08-10T00:00:00.000Z",
    })!;
    const hit = findPriorVerdict("Which region sold most?", [
      { id: "t1", title: "Old", turns: [older] },
      { id: "t2", title: "New", turns: [newer] },
    ])!;
    // A later "actually this is wrong" must beat an earlier "verified".
    expect(hit.verification.state).toBe("wrong");
    expect(hit.threadId).toBe("t2");
  });

  it("never offers a VOIDED verdict — that would vouch for different SQL", () => {
    const marked = markTurn({
      turn: turn("q", [step("SELECT 1")]),
      state: "verified",
      at: AT,
    })!;
    const changed: AnalystTurn = { ...marked, steps: [step("SELECT 2")] };
    expect(findPriorVerdict("q", [{ id: "t", title: "T", turns: [changed] }])).toBeNull();
  });

  it("returns null for an unasked question, an empty one, or no threads", () => {
    const marked = markTurn({ turn: turn("q", [step("SELECT 1")]), state: "verified", at: AT })!;
    const threads = [{ id: "t", title: "T", turns: [marked] }];
    expect(findPriorVerdict("something else", threads)).toBeNull();
    expect(findPriorVerdict("   ", threads)).toBeNull();
    expect(findPriorVerdict("q", [])).toBeNull();
  });
});

describe("what the badge and the report say", () => {
  it("names the verdict, who gave it and when", () => {
    const t = markTurn({
      turn: turn("q", [step("SELECT 1")]),
      state: "verified",
      at: AT,
      by: "rimo",
    })!;
    expect(describeVerification(verificationStatus(t))).toBe("Verified by rimo on 2026-08-14.");
  });

  it("carries the reason on a flag, because that is the useful part", () => {
    const t = markTurn({
      turn: turn("q", [step("SELECT 1")]),
      state: "wrong",
      note: "APJ double-counted",
      at: AT,
    })!;
    expect(describeVerification(verificationStatus(t))).toBe(
      "Flagged as wrong on 2026-08-14. APJ double-counted",
    );
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeVerification({ kind: "none" })).toBe("");
  });
});

describe("the wiring", () => {
  const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");

  it("keeps the verdict on the turn, next to the answer it judges", () => {
    const type = lib.slice(lib.indexOf("export type AnalystTurn = {"));
    expect(type.slice(0, type.indexOf("\n};"))).toMatch(/verification\?: TurnVerification;/);
  });
});

describe("the wiring, and the claims it must not overstate", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
  const pdf = readFileSync("src/lib/biPdf.ts", "utf8");

  it("offers verify/flag only when there is no ACTIVE verdict", () => {
    // Re-marking an already-verified turn is noise; re-marking a VOIDED one
    // is the whole point, so the buttons come back when it voids.
    expect(page).toMatch(/\{status\.kind !== "active" && \(/);
    expect(page).toContain("Mark verified");
    expect(page).toContain("Flag as wrong");
  });

  it("refuses a flag with no reason, in the UI as well as the module", () => {
    const fn = page.slice(page.indexOf("const verifyTurn = useCallback("));
    const body = fn.slice(0, fn.indexOf("/**"));
    expect(body).toMatch(/state === "wrong" && !note/);
    expect(body).toMatch(/A flag needs a reason/);
  });

  it("stamps who and when from the session, not from the turn", () => {
    const fn = page.slice(page.indexOf("const verifyTurn = useCallback("));
    const body = fn.slice(0, fn.indexOf("/**"));
    expect(body).toContain("by: user?.email ?? undefined");
    expect(body).toContain("at: new Date().toISOString()");
  });

  it("OFFERS a prior verdict without answering from it", () => {
    // The data has moved since the check; re-using the old answer would turn
    // a one-time check into a standing claim.
    expect(page).toContain("findPriorVerdict(question, threads)");
    expect(page).toMatch(/Asking again re-runs the queries against\s*\n?\s*today/);
    // No path that substitutes the old answer for a new run.
    expect(page).not.toMatch(/setThread\([^)]*priorVerdict/);
  });

  it("carries the verdict into the report, voided ones included", () => {
    expect(pdf).toContain("verificationStatus(turn)");
    expect(pdf).toContain("describeVerification(vstatus)");
    expect(pdf).toMatch(/if \(vstatus\.kind !== "none"\)/);
  });
});
