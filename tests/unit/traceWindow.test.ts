// The analytics header, and what it may claim about a paged read.
//
// Module 21 of the adversarial pass. The page requested .limit(2000), the
// PostgREST max-rows setting silently capped the response at 1,000, and the
// header told the user "1,000 traces over the last 30 days" for an account
// holding 2,731 — with spend, tokens, agent count and a 32%-biased average
// latency all inheriting the truncation.
import { describe, expect, it } from "vitest";
import {
  pageTraces,
  traceCountHeadline,
  traceKpiQualifier,
  windowComplete,
} from "@/lib/traceWindow";

describe("windowComplete", () => {
  it("is complete when every matching row was fetched", () => {
    expect(windowComplete({ fetched: 2731, total: 2731 })).toBe(true);
  });

  it("is incomplete when the fetch stopped short of the count", () => {
    // THE finding: 1,000 rows standing in for 2,731.
    expect(windowComplete({ fetched: 1000, total: 2731 })).toBe(false);
  });

  it("tolerates a count that shrank between the two reads", () => {
    // Rows deleted between the count query and the page read: fetched can
    // exceed total. That is still complete data, not a truncation.
    expect(windowComplete({ fetched: 100, total: 98 })).toBe(true);
  });

  it("treats an empty account as complete", () => {
    expect(windowComplete({ fetched: 0, total: 0 })).toBe(true);
  });
});

describe("traceCountHeadline", () => {
  it("states the population when the data is whole", () => {
    expect(traceCountHeadline({ fetched: 2731, total: 2731 })).toBe(
      "2,731 traces over the last 30 days",
    );
  });

  it("states only what is on screen when the data is capped", () => {
    // "N traces over the last 30 days" is a statement about the account; a
    // capped read is only entitled to a statement about itself.
    expect(traceCountHeadline({ fetched: 5000, total: 12345 })).toBe(
      "showing the most recent 5,000 of 12,345 traces from the last 30 days",
    );
  });

  it("never lets the fetched number impersonate the total", () => {
    const capped = traceCountHeadline({ fetched: 1000, total: 2731 });
    expect(capped).toContain("1,000");
    expect(capped).toContain("2,731");
    expect(capped).not.toBe("1,000 traces over the last 30 days");
  });
});

describe("traceKpiQualifier", () => {
  it("says nothing when the totals are whole", () => {
    expect(traceKpiQualifier({ fetched: 2731, total: 2731 })).toBeNull();
  });

  it("marks partial totals as covering only the fetched window", () => {
    expect(traceKpiQualifier({ fetched: 5000, total: 12345 })).toContain("5,000");
  });
});

describe("pageTraces", () => {
  const makeSource = (total: number) => {
    // A fake table of `total` rows; records every range asked for.
    const calls: Array<[number, number]> = [];
    const fetchPage = async (offset: number, pageSize: number) => {
      calls.push([offset, pageSize]);
      const rows = Array.from(
        { length: Math.max(0, Math.min(pageSize, total - offset)) },
        (_, i) => offset + i,
      );
      return { rows };
    };
    return { fetchPage, calls };
  };

  it("fetches every row across multiple pages", async () => {
    // The finding: 2,731 rows behind a 1,000-row cap. Paging must get them all.
    const { fetchPage } = makeSource(2731);
    const rows = await pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 });
    expect(rows.length).toBe(2731);
  });

  it("stops as soon as a short page proves the end", async () => {
    const { fetchPage, calls } = makeSource(2731);
    await pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 });
    // 1000, 1000, 731 (short) → three reads, no fourth.
    expect(calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
    ]);
  });

  it("asks once more when the last full page lands exactly on the boundary", async () => {
    const { fetchPage, calls } = makeSource(2000);
    await pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 });
    // A full page at 1000 could be the end or a coincidence; the extra read
    // returning 0 rows is what proves it.
    expect(calls.map((c) => c[0])).toEqual([0, 1000, 2000]);
  });

  it("never exceeds the row ceiling", async () => {
    const { fetchPage, calls } = makeSource(1_000_000);
    const rows = await pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 });
    expect(rows.length).toBe(5000);
    expect(calls.length).toBe(5); // 5 pages, then the ceiling stops it
  });

  it("aborts the whole load when a page errors rather than summing a fragment", async () => {
    // A half-fetched window totalled as if whole is the original defect in a
    // different disguise. The error must propagate.
    let calls = 0;
    const fetchPage = async () => {
      calls += 1;
      if (calls === 2) throw new Error("permission denied");
      return { rows: Array.from({ length: 1000 }, (_, i) => i) };
    };
    await expect(pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 })).rejects.toThrow(
      "permission denied",
    );
  });

  it("handles an empty account in a single read", async () => {
    const { fetchPage, calls } = makeSource(0);
    const rows = await pageTraces(fetchPage, { pageSize: 1000, maxRows: 5000 });
    expect(rows).toEqual([]);
    expect(calls).toEqual([[0, 1000]]);
  });
});
