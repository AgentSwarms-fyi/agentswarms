// Asked for a bill of quantities priced from "current Oracle Cloud pricing for
// AMD E5 compute instances", the generator produced a workbook with unit prices
// of $108.04 / $216.08 / $572.32, a derivation sheet, a disclaimer, and a sheet
// headed "Sources (cite when presenting)" listing oracle.com URLs.
//
// No web search had returned anything. gatherDocContext ran one — the prompt
// matched the cue — and got back an empty array, because no search provider is
// configured and the DuckDuckGo fallback yields nothing for a 300-character
// instruction. contextBlock skips `web` when it is empty, so the planner saw a
// prompt asking for live pricing and no research, and filled the gap from
// memory. Every number and every citation in that workbook was invented, and
// nothing in the document or the UI said so.
//
// "No research was needed" and "research ran and found nothing" must not be the
// same empty array.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contextBlock } from "@/lib/docGen/plan";
import type { DocContext } from "@/utils/docGen.functions";

const GATHER = readFileSync("src/utils/docGen.functions.ts", "utf8");
const PLAYGROUND = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

const base: DocContext = { kb: [], tables: [] };

describe("a search that found nothing is not the same as a search nobody wanted", () => {
  it("tells the planner when research was attempted and came back empty", () => {
    const out = contextBlock({ ...base, webAttempted: true, web: [] });
    expect(out).toContain("ATTEMPTED AND RETURNED NOTHING");
    // The two instructions that actually prevent the observed failure.
    expect(out).toMatch(/do NOT cite URLs you did not receive/i);
    expect(out).toMatch(/not present remembered or estimated numbers as sourced/i);
  });

  it("says nothing when the prompt never asked for research", () => {
    // A pure data-table document must not be lectured about sources it never
    // needed — that noise would push real context out of the 18k budget.
    const out = contextBlock({ ...base, webAttempted: false });
    expect(out).not.toContain("ATTEMPTED AND RETURNED NOTHING");
    expect(contextBlock(base)).not.toContain("ATTEMPTED AND RETURNED NOTHING");
  });

  it("says nothing when research actually returned results", () => {
    const out = contextBlock({
      ...base,
      webAttempted: true,
      web: [{ title: "OCI Pricing", url: "https://example.test/p", content: "$0.025 per OCPU" }],
    });
    expect(out).not.toContain("ATTEMPTED AND RETURNED NOTHING");
    // ...and the real research still reaches the planner.
    expect(out).toContain("$0.025 per OCPU");
    expect(out).toContain("https://example.test/p");
  });

  it("still fits the context budget when the warning is added", () => {
    const big: DocContext = {
      kb: Array.from({ length: 40 }, (_, i) => ({ name: `doc${i}`, snippet: "x".repeat(900) })),
      tables: [],
      webAttempted: true,
      web: [],
    };
    expect(contextBlock(big).length).toBeLessThanOrEqual(18000);
  });
});

describe("the flag is set where the search decision is made", () => {
  it("records that research was attempted, not just what it returned", () => {
    expect(GATHER).toContain("const webAttempted = WEB_CUE.test(data.prompt);");
    expect(GATHER).toContain("return { ok: true, context: { kb, tables, web, webAttempted } };");
  });

  it("warns the person who asked, not only the model", () => {
    // The document is told not to fabricate sources. Someone about to forward a
    // priced BoQ to a customer needs to hear it too.
    expect(PLAYGROUND).toContain("ctx.context.webAttempted && !ctx.context.web?.length");
    expect(PLAYGROUND).toContain("Web research found nothing");
  });
});
