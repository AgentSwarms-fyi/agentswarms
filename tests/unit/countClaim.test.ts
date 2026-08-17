// Derived stat badges, and what they may claim about a read that failed.
//
// Module 19 of the adversarial pass. /mcp printed "0 connected" and "0 tools
// available" for an account with a connected server exposing seven tools,
// because both numbers are derived from rows that never arrived and neither is
// the row count any earlier rule watched.
import { describe, expect, it } from "vitest";
import { countLabels } from "@/lib/countClaim";
import { UNKNOWN_COUNT } from "@/lib/listClaim";

const OK = { loaded: true, error: null };
const FAILED = { loaded: true, error: "permission denied for table mcp_servers" };
const PENDING = { loaded: false, error: null };

describe("countLabels", () => {
  it("prints the numbers a successful read supports", () => {
    expect(countLabels(OK, { connected: 1, tools: 7 })).toEqual({ connected: "1", tools: "7" });
  });

  it("prints an honest zero when the read succeeded and there is nothing", () => {
    // The whole difficulty of this defect: zero is also a correct answer, so
    // the fix has to keep it sayable.
    expect(countLabels(OK, { connected: 0, tools: 0 })).toEqual({ connected: "0", tools: "0" });
  });

  it("withholds every count when the read failed", () => {
    expect(countLabels(FAILED, { connected: 1, tools: 7 })).toEqual({
      connected: UNKNOWN_COUNT,
      tools: UNKNOWN_COUNT,
    });
  });

  it("withholds a count the read failed on even when it computed to zero", () => {
    // THE finding. A failed read leaves the rows at [], so every derived count
    // computes to 0 — which is exactly what made it invisible.
    expect(countLabels(FAILED, { connected: 0, tools: 0 })).toEqual({
      connected: UNKNOWN_COUNT,
      tools: UNKNOWN_COUNT,
    });
  });

  it("withholds counts before the read returns", () => {
    expect(countLabels(PENDING, { connected: 0, tools: 0 })).toEqual({
      connected: UNKNOWN_COUNT,
      tools: UNKNOWN_COUNT,
    });
  });

  it("never admits the failure in one badge and prints a number in another", () => {
    // They come from the same rows, so they are true together or unknown
    // together. This is the reason the helper takes them all at once.
    const labels = countLabels(FAILED, { a: 0, b: 5, c: 12 });
    expect(new Set(Object.values(labels))).toEqual(new Set([UNKNOWN_COUNT]));
  });

  it("keeps every key it was given", () => {
    expect(Object.keys(countLabels(OK, { a: 1, b: 2, c: 3 }))).toEqual(["a", "b", "c"]);
  });

  it("handles a read with no counts at all without inventing any", () => {
    expect(countLabels(FAILED, {})).toEqual({});
  });
});
