// The analytics header, and what it may claim about a paged read.
//
// Module 21 of the adversarial pass. The page requested .limit(2000), the
// PostgREST max-rows setting silently capped the response at 1,000, and the
// header told the user "1,000 traces over the last 30 days" for an account
// holding 2,731 — with spend, tokens, agent count and a 32%-biased average
// latency all inheriting the truncation.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runStepsCaveat,
  catalogueCaveat,
  catalogueCount,
  countHeadline,
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

describe("traceCountHeadline range labels (module 23)", () => {
  it("names the active range instead of assuming 30 days", () => {
    // /traces has a 1d/7d/30d/90d switch; a headline hardcoding "30 days"
    // would be wrong three quarters of the time.
    expect(traceCountHeadline({ fetched: 80, total: 80 }, "the last day")).toBe(
      "80 traces over the last day",
    );
    expect(traceCountHeadline({ fetched: 1000, total: 2774 }, "the last 90 days")).toBe(
      "showing the most recent 1,000 of 2,774 traces from the last 90 days",
    );
  });

  it("defaults to the last 30 days so the analytics header is unchanged", () => {
    expect(traceCountHeadline({ fetched: 2731, total: 2731 })).toBe(
      "2,731 traces over the last 30 days",
    );
  });
});

describe("getExecutionTraces carries the true total (tripwire)", () => {
  // Source tripwire, not a behavioral proof: the fn runs under createServerFn
  // with supabaseAdmin, so executing it here would test mocks. A mutation run
  // showed `total: traces.length` (the capped page presented as the
  // population) survives every behavioral test — this pins the two lines that
  // make the response honest. It can be dodged by a determined refactor; its
  // job is to make the dodge visible in review, not impossible.
  it("head-counts the same filter and returns count, not page length", () => {
    const src = readFileSync(resolve("src/utils/traceLog.functions.ts"), "utf8");
    expect(src).toMatch(/count:\s*"exact",\s*head:\s*true/);
    expect(src).toMatch(/total:\s*count\s*\?\?\s*traces\.length/);
  });
});

describe("the same sentence for a list that is not traces (module 22)", () => {
  // Swarm Observability had the identical defect this module exists for:
  // `.limit(200)` and then "N swarm runs · auto-deleted after 30 days" — a
  // statement about the ACCOUNT made by a read that only saw the first page.
  // The noun is a parameter so the two Observability pages cannot end up
  // describing the same situation in different words.
  const RUNS = { one: "swarm run", many: "swarm runs" };

  it("claims the total when the window holds everything", () => {
    expect(countHeadline({ fetched: 42, total: 42 }, RUNS)).toBe(
      "42 swarm runs over the last 30 days",
    );
  });

  it("says most-recent-of when the read was capped", () => {
    expect(countHeadline({ fetched: 200, total: 1312 }, RUNS)).toBe(
      "showing the most recent 200 of 1,312 swarm runs from the last 30 days",
    );
  });

  it("never implies completeness it does not have", () => {
    const capped = countHeadline({ fetched: 200, total: 1312 }, RUNS);
    // The failure this prevents is the bare "200 swarm runs" that reads as the
    // whole account. Any capped sentence must name BOTH numbers.
    expect(capped).toContain("200");
    expect(capped).toContain("1,312");
    expect(capped.startsWith("200 swarm runs")).toBe(false);
  });

  it("uses the singular only for exactly one", () => {
    expect(countHeadline({ fetched: 1, total: 1 }, RUNS)).toBe("1 swarm run over the last 30 days");
    expect(countHeadline({ fetched: 0, total: 0 }, RUNS)).toBe(
      "0 swarm runs over the last 30 days",
    );
  });

  it("takes the range label like its sibling does", () => {
    expect(countHeadline({ fetched: 3, total: 3 }, RUNS, "the last 7 days")).toBe(
      "3 swarm runs over the last 7 days",
    );
  });

  it("is what Swarm Observability actually renders", () => {
    // Source-anchored: the helper being correct is half of it, the page asking
    // the database for the exact total is the other half.
    const src = readFileSync("src/routes/_authenticated/analytics_.observability.tsx", "utf8");
    expect(src).toContain('.select("id", { count: "exact", head: true })');
    // The RENDERED branch, not the mere presence of the call: a mutant that
    // put `${runs.length} swarm runs` in front of it left "countHeadline("
    // in the file and printed the bare row count anyway.
    expect(src).toContain("            : countHeadline(");
    expect(src).toContain('{ one: "swarm run", many: "swarm runs" }');
    // A failed count must not fail the page, but then the label may only claim
    // what it holds.
    expect(src).toContain("setExactTotal(countError ? rows.length : (exact ?? rows.length));");
    // And the list itself says when it is cut.
    expect(src).toContain("Only the most recent");
  });
});

describe("a catalogue rather than a time window (model registry)", () => {
  // The Model Registry read `.limit(2000)` and printed `models.length` as the
  // population. Two separate wrongs. The order is ALPHABETICAL by developer, so
  // truncation does not thin the list evenly — it deletes late-alphabet
  // developers outright, and they then never appear in the provider filter
  // either. And the 2,000 was fiction: PostgREST's max-rows on this deployment
  // is 1,000 — measured while writing this, a `limit=2000` against a 1,109-row
  // table returned exactly 1,000 — so the declared ceiling was twice the real
  // one, and nothing on the page could tell.
  const MODELS = { one: "live model", many: "live models" };

  it("states the count plainly when the catalogue is whole", () => {
    expect(catalogueCount({ fetched: 770, total: 770 }, MODELS)).toBe("770 live models");
  });

  it("says first-N-of-M when the read stopped short", () => {
    expect(catalogueCount({ fetched: 1000, total: 3412 }, MODELS)).toBe(
      "the first 1,000 of 3,412 live models",
    );
  });

  it("never lets the cap pass as the population", () => {
    const capped = catalogueCount({ fetched: 1000, total: 3412 }, MODELS);
    expect(capped).toContain("3,412");
    expect(capped.startsWith("1,000 live models")).toBe(false);
  });

  it("does not borrow the trace sentence's sense of order", () => {
    // "the most recent 1,000" would be a lie about an alphabetical list; that
    // is the whole reason this is a second sentence and not another noun.
    expect(catalogueCount({ fetched: 1000, total: 3412 }, MODELS)).not.toContain("most recent");
  });

  it("uses the singular only for exactly one", () => {
    expect(catalogueCount({ fetched: 1, total: 1 }, MODELS)).toBe("1 live model");
    expect(catalogueCount({ fetched: 0, total: 0 }, MODELS)).toBe("0 live models");
  });

  it("stays silent about filters when nothing was cut", () => {
    expect(catalogueCaveat({ fetched: 770, total: 770 }, MODELS)).toBeNull();
  });

  it("warns that a capped catalogue puts models beyond the filters", () => {
    const note = catalogueCaveat({ fetched: 1000, total: 3412 }, MODELS);
    // The filters and the search box are client-side over the rows in hand, so
    // the missing models are not one page away — they are unreachable here.
    expect(note).toContain("1,000");
    expect(note).toContain("2,412");
    expect(note).toContain("cannot be found from here");
  });
});

describe("what the model registry actually reads and renders", () => {
  const fn = readFileSync("src/utils/modelRegistry.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/model-registry.tsx", "utf8");

  it("asks how many rows the table holds before reading any", () => {
    expect(fn).toContain('.select("id", { count: "exact", head: true })');
  });

  it("pages instead of trusting a single .limit()", () => {
    // The bug was not the number 2,000, it was believing it. PostgREST caps
    // every response at max-rows regardless of what .limit() asks for.
    // Anchored on a CHAINED CALL, not the token: the comment above the new
    // read names `.limit(2000)` to explain why it went, and a substring
    // assertion would have been satisfied by that prose forever.
    expect(fn).not.toMatch(/^\s*\.limit\(/m);
    expect(fn).toContain("pageTraces<RegistryModel>");
    expect(fn).toContain("const PAGE = 1000;");
  });

  it("makes the ceiling an env knob, not a constant", () => {
    expect(fn).toContain('envInt("MODEL_REGISTRY_MAX_ROWS", 5000)');
    // And that the knob reaches the loop. Declaring MAX_ROWS and then passing
    // PAGE would leave the env call sitting in the file doing nothing.
    expect(fn).toContain("{ pageSize: PAGE, maxRows: MAX_ROWS }");
  });

  it("orders by a unique column last so paging cannot skip or repeat", () => {
    // developer + display_name is not unique across modalities; a page boundary
    // inside a tie is how .range() paging loses rows.
    expect(fn).toContain('.order("id", { ascending: true })');
  });

  it("lets a failed count degrade to the rows in hand", () => {
    expect(fn).toContain("total: countError ? models.length : (count ?? models.length),");
  });

  it("renders the catalogue sentence and the filter caveat", () => {
    // Presence is not use: both have to reach the page, and the headline must
    // stop promising coverage it no longer has.
    expect(page).toContain("catalogueCount(registryWindow, MODEL_NOUN)");
    expect(page).toContain("catalogueCaveat(registryWindow, MODEL_NOUN)");
    expect(page).toContain("{cappedCaveat && (");
    expect(page).toContain('{wholeCatalogue ? " across all major providers" : ""}');
  });
});

describe("a run whose header is whole and whose list is not", () => {
  // /analytics/observability/$runId read swarm_run_steps and swarm_run_edges
  // with no bound, so past the server's cap the timeline, the data-flow list
  // and the DAG on the canvas were a prefix. A DAG drawn from a prefix is not a
  // smaller graph, it is a WRONG one: edges arriving from nodes that are not
  // there.
  //
  // The header is the opposite case. total_cost_usd, total_tokens_* and
  // step_count are columns on the run row, written by the executor, so they
  // describe the whole run however much detail came back — verified against
  // this deployment, where step_count matched the actual row count on all seven
  // runs checked. Without saying which half is partial, the page simply looks
  // like it does not add up.

  it("says nothing when every step came back", () => {
    expect(runStepsCaveat({ fetched: 28, total: 28 })).toBeNull();
  });

  it("names both numbers when the list is a prefix", () => {
    const note = runStepsCaveat({ fetched: 1000, total: 1400 });
    expect(note).toContain("1,000");
    expect(note).toContain("1,400");
  });

  it("says which half of the page is still trustworthy", () => {
    // The point of the sentence: the reader is looking at a header that
    // disagrees with the list under it, and one of them is right.
    const note = runStepsCaveat({ fetched: 1000, total: 1400 });
    expect(note).toContain("canvas");
    expect(note).toContain("cover all of it");
  });
});

/** How many times `needle` appears in `hay` — for anchors that must hold on
 *  every one of several symmetric sites, not just somewhere. */
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("what the run detail page actually reads", () => {
  const page = readFileSync(
    "src/routes/_authenticated/analytics_.observability.$runId.tsx",
    "utf8",
  );

  it("pages both tables by cursor instead of reading them unbounded", () => {
    expect(page).toContain('.from("swarm_run_steps")');
    expect(page).toContain('.from("swarm_run_edges")');
    expect(page).toContain("scanRows<Step>(pageSteps,");
    expect(page).toContain("scanRows<Edge>(pageEdges,");
    // COUNTED, not merely present. There are two pagers here, and a mutation
    // run showed that removing the cursor from one of them left the other's
    // copy of the same line sitting in the file, happily satisfying a
    // toContain. An anchor a sibling can satisfy checks nothing — the same
    // failure as an anchor a comment can satisfy, one symmetry along.
    expect(occurrences(page, 'q = q.gt("id", after)')).toBe(2);
    expect(occurrences(page, "{ maxRows: RUN_ROW_SCAN_MAX }")).toBe(2);
  });

  it("pages by a unique key and sorts for display separately", () => {
    // Two steps of one run can share a start instant, so started_at is not a
    // paging key — ordering by it and paging by offset would drop rows.
    expect(occurrences(page, '.order("id", { ascending: true })')).toBe(2);
    expect(page).toMatch(/sort\(\(a, b\) => Date\.parse\(a\.started_at\)/);
  });

  it("renders the caveat it computes", () => {
    // Presence is not use, for the seventh time this session.
    expect(page).toContain("const stepsCaveat = runStepsCaveat({");
    // Reflow-proof: prettier decides whether a short JSX guard stays on one
    // line, and it collapsed this one the first time it saw it.
    expect(page).toMatch(/\{stepsCaveat && </);
  });

  it("does not report absence it has not established", () => {
    expect(page).toContain('{loadError ? "The steps of this run could not be read."');
    expect(page).toContain('{loadError ? "The data flow of this run could not be read."');
    expect(page).toContain("This run could not be read");
    // And the error actually reaches that state. Three branches reading
    // `loadError` are decoration if the catch never sets it.
    expect(page).toMatch(/catch \(err\) \{[\s\S]*?setLoadError\(err/);
  });

  it("is enrolled in the failed-read registry, not guarded only from here", () => {
    // failedReadClaims.test.ts keeps the list of pages that must not report a
    // failed read as an empty account, and enforces the contract for each. A
    // page that satisfies it belongs in that list — otherwise the next person
    // to touch this one gets no warning from the guard built for exactly this.
    const registry = readFileSync("tests/unit/failedReadClaims.test.ts", "utf8");
    expect(registry).toContain(
      'file: "src/routes/_authenticated/analytics_.observability.$runId.tsx"',
    );
  });

  it("marks the data-flow count when the scan stopped early", () => {
    expect(page).toMatch(/\{edgesComplete \? "" : "\+"\}\)/);
  });
});
