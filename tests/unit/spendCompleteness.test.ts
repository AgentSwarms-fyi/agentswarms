// A spend total that admits what it does not know.
//
// The row-level honesty already existed and never reached the numbers people
// look at. Measured: 116 calls to moonshotai/kimi-k3 carrying 132,117 tokens
// were each flagged `pricing_missing` and rendered "unpriced" on the Traces
// page — while the dashboard, the analytics KPI and the spend panel each
// showed a confident $0.00. A SUM cannot carry a per-row flag, so the total
// under-counted and looked authoritative doing it.
//
// The rule these tests pin: a figure built from incomplete inputs must say so
// where it is displayed, not only on the rows underneath it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatSpend, spendCaveat, sumSpend } from "@/lib/spendCompleteness";

describe("totalling what is known", () => {
  it("sums the priced rows", () => {
    expect(sumSpend([{ cost_usd: 1.5 }, { cost_usd: 2.25 }]).total).toBeCloseTo(3.75, 10);
  });

  it("counts unpriced rows without inventing an amount for them", () => {
    // Deliberately NOT extrapolating from the priced rows. A guess presented
    // beside measured figures is indistinguishable from them once it is in the
    // same total.
    const t = sumSpend([
      { cost_usd: 1, pricing_missing: "true" },
      { cost_usd: 2 },
      { cost_usd: 0, pricing_missing: "true" },
    ]);
    expect(t.total).toBe(3);
    expect(t.unpricedRows).toBe(2);
    expect(t.partial).toBe(true);
  });

  it("reads the flag as text AND as a boolean", () => {
    // Postgres `->>` returns the string "true"; a direct column read would give
    // a real boolean. Handling one spelling only would silently disable the
    // warning on whichever surface used the other.
    expect(sumSpend([{ cost_usd: 0, pricing_missing: "true" }]).partial).toBe(true);
    expect(sumSpend([{ cost_usd: 0, pricing_missing: true }]).partial).toBe(true);
  });

  it("does not treat other values as unpriced", () => {
    for (const v of ["false", false, null, undefined]) {
      expect(sumSpend([{ cost_usd: 1, pricing_missing: v as never }]).partial, String(v)).toBe(
        false,
      );
    }
  });

  it("ignores a non-finite cost rather than poisoning the total", () => {
    // One NaN row makes the whole month's spend NaN — including the number the
    // budget cap compares against.
    const t = sumSpend([{ cost_usd: 1 }, { cost_usd: Number.NaN }, { cost_usd: "abc" }]);
    expect(t.total).toBe(1);
  });

  it("handles an empty set as a complete zero", () => {
    // Nothing ran, so $0 is the whole truth and must not carry a caveat.
    const t = sumSpend([]);
    expect(t).toEqual({ total: 0, unpricedRows: 0, partial: false });
    expect(spendCaveat(t)).toBeNull();
  });
});

describe("saying it out loud", () => {
  it("marks a partial total", () => {
    // Same "+?" the Traces page already uses for a partial turn, so the two
    // surfaces do not teach different vocabularies for the same fact.
    expect(formatSpend(sumSpend([{ cost_usd: 12.3, pricing_missing: "true" }]))).toBe("$12.30+?");
  });

  it("leaves a complete total unmarked", () => {
    expect(formatSpend(sumSpend([{ cost_usd: 12.3 }]))).toBe("$12.30");
  });

  it("explains a partial total, naming how many calls are missing", () => {
    const caveat = spendCaveat(
      sumSpend([{ cost_usd: 0, pricing_missing: "true" }, { cost_usd: 1 }]),
    );
    expect(caveat).toContain("At least this much");
    expect(caveat).toContain("1 call");
  });

  it("pluralises, because a tooltip reading '2 call' looks like a bug", () => {
    const caveat = spendCaveat(
      sumSpend([
        { cost_usd: 0, pricing_missing: "true" },
        { cost_usd: 0, pricing_missing: "true" },
      ]),
    );
    expect(caveat).toContain("2 calls");
  });

  it("says nothing at all when nothing is missing", () => {
    // null rather than "", so a caller cannot render an always-present
    // explanation that says nothing — one that shows even when everything is
    // priced trains people to ignore it.
    expect(spendCaveat(sumSpend([{ cost_usd: 5 }]))).toBeNull();
  });

  it("tells the reader what to actually do about it", () => {
    const caveat = spendCaveat(sumSpend([{ cost_usd: 0, pricing_missing: "true" }]));
    expect(caveat).toContain("prices:refresh");
  });
});

// ── Who the money is attributed to ─────────────────────────────────────────
//
// Separate bug, found while verifying the above and fixed alongside it: the
// Team spend table crashed the WHOLE analytics page with "Cannot read
// properties of null (reading 'slice')". execution_traces.user_id is nullable
// by design — a headless run (deployed API key, schedule, evaluation, public
// embed) has no user to attribute to, and the trace is deliberately still
// written so the spend is counted. Measured here: 260 such calls, 93.9k
// tokens, $0.1036. The component handled "no email" but assumed an id.
describe("spend with no user to attribute it to", () => {
  const SRC = readFileSync("src/components/observability/TeamSpend.tsx", "utf8");

  it("does not dereference a null user_id", () => {
    // The exact crash. `u.user_id.slice(...)` must be reached only inside a
    // branch that has established the id exists.
    expect(SRC).not.toMatch(/\{u\.email \?\? \(\s*<span[\s\S]{0,200}\{u\.user_id\.slice/);
    expect(SRC).toMatch(/u\.user_id \?/);
  });

  it("distinguishes a deleted account from an unattributed run", () => {
    // Three states, and collapsing any two misreports who spent the money: a
    // live account, an account that is gone, and a run that never had one.
    expect(SRC).toContain("deleted user");
    expect(SRC).toContain("unattributed");
  });

  it("says the unattributed spend is still real", () => {
    // "unattributed" alone could be read as "not counted". It is counted.
    expect(SRC).toMatch(/spend is real and counted/i);
  });

  it("gives every row a stable key even without an id", () => {
    // key={null} makes React fall back to the index silently and reuse rows
    // across re-sorts.
    expect(SRC).toMatch(/key=\{u\.user_id \?\? `unattributed-\$\{i\}`\}/);
  });
});
