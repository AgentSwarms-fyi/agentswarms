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

describe("the reason the search failed reaches the reader", () => {
  it("puts the provider's own explanation in the planner prompt", () => {
    const out = contextBlock({
      ...base,
      webAttempted: true,
      web: [],
      webNote:
        "DuckDuckGo returned no summary. For richer results, link the Firecrawl connector in Integrations.",
    });
    expect(out).toContain("Reason: DuckDuckGo returned no summary");
    expect(out).toContain("ATTEMPTED AND RETURNED NOTHING");
  });

  it("still reads correctly when no reason was captured", () => {
    const out = contextBlock({ ...base, webAttempted: true, web: [] });
    expect(out).toContain("ATTEMPTED AND RETURNED NOTHING.");
    expect(out).not.toContain("Reason:");
    expect(out).not.toContain("undefined");
  });

  it("carries the note out of gatherWebResearch instead of dropping it", () => {
    // `note` and `error` are what the search stack emits to explain an empty
    // result. Parsing only results/abstract/related threw both away.
    expect(GATHER).toMatch(/note\?:\s*string \| null;/);
    expect(GATHER).toMatch(/error\?:\s*string \| null;/);
    // Whitespace-tolerant: prettier wraps this expression.
    expect(GATHER).toMatch(/parsed\.error\s*\|\|\s*parsed\.note/);
    expect(GATHER).toContain("webNote");
  });

  it("shows the reason in the toast, not just a generic message", () => {
    expect(PLAYGROUND).toContain("ctx.context.webNote ??");
  });
});

describe("doc-gen runs the web tools with the agent's own configuration", () => {
  it("forwards the agent's web_search and web_browse config", () => {
    // Without these, runWebSearch defaults provider to "firecrawl_builtin", so
    // its "firecrawl_custom" branch never fires and an agent whose Firecrawl
    // key lives on the agent record silently falls through to DuckDuckGo.
    expect(GATHER).toContain("cfg?.search");
    expect(GATHER).toContain("cfg?.browse");
    expect(GATHER).toContain("search: agentToolConfigs?.web_search");
    expect(GATHER).toContain("browse: agentToolConfigs?.web_browse");
  });

  it("loads the agent config BEFORE the web tools run, not after", () => {
    // The whole defect: this load existed, but sat below gatherWebResearch
    // serving only the SQL allow-list, so the web tools ran unconfigured.
    const load = GATHER.indexOf("agentToolConfigs =");
    const use = GATHER.indexOf("await gatherWebResearch(");
    expect(load).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(load).toBeLessThan(use);
  });

  it("reads the agent row once and reuses it for the SQL allow-list", () => {
    // Two fetches of the same row is how the two configs drifted apart.
    expect(GATHER.match(/\.from\("agents"\)/g) ?? []).toHaveLength(1);
    expect(GATHER).toContain("agentToolConfigs?.sql_query?.table_names");
  });
});

describe("retrieval is not treated as verification", () => {
  const withResearch = {
    ...base,
    webAttempted: true,
    web: [
      { title: "OCI Price List", url: "https://www.oracle.com/cloud/price-list/", content: "x" },
    ],
  };

  it("forbids citing a source for a figure it does not state", () => {
    // The failure this exists for: the price list renders its rate cells in the
    // browser, so the scrape holds the table with every price blank — and the
    // workbook quoted $0.025/OCPU-hour "per current OCI Price List Compute
    // table" anyway.
    const out = contextBlock(withResearch);
    expect(out).toContain("a figure is SOURCED only if it appears in the text above");
    expect(out).toMatch(/MUST NOT attribute it to any of these pages/i);
    expect(out).toMatch(/Never cite a source for a figure it does not state/i);
    expect(out).toMatch(/table present and the cells empty/i);
  });

  it("says none of that when there was no research to misattribute", () => {
    expect(contextBlock(base)).not.toContain("a figure is SOURCED only if");
    expect(contextBlock({ ...base, webAttempted: true, web: [] })).not.toContain(
      "a figure is SOURCED only if",
    );
  });

  it("stops re-truncating the excerpt the fetcher already chose", () => {
    // The fetcher picks a 3500-char passage BECAUSE it holds the figures.
    // Cutting it to 2000 here, from the front, threw that away.
    const long = "A".repeat(3000) + "$0.03 per OCPU-hour" + "B".repeat(400);
    const out = contextBlock({
      ...base,
      webAttempted: true,
      web: [{ title: "p", url: "u", content: long }],
    });
    expect(out).toContain("$0.03 per OCPU-hour");
  });
});

describe("doc-gen searches for the subject and keeps the part that answers it", () => {
  it("does not send the whole instruction as the search query", () => {
    expect(GATHER).toContain("searchQueryFromPrompt(prompt)");
    expect(GATHER).not.toContain("query: prompt.slice(0, 300)");
  });

  it("selects the relevant passage instead of the first N characters", () => {
    expect(GATHER).toContain("relevantExcerpt(body, query, WEB_PAGE_CHARS)");
    expect(GATHER).not.toContain("body.slice(0, WEB_PAGE_CHARS)");
  });
});

describe("the flag is set where the search decision is made", () => {
  it("records that research was attempted, not just what it returned", () => {
    expect(GATHER).toContain("const webAttempted = WEB_CUE.test(data.prompt);");
    // The returned context must carry BOTH signals — that research was wanted,
    // and why it came back empty.
    expect(GATHER).toMatch(/ok:\s*true,\s*context:\s*\{[^}]*webAttempted[^}]*\}/);
    expect(GATHER).toMatch(/ok:\s*true,\s*context:\s*\{[^}]*webNote[^}]*\}/);
  });

  it("warns the person who asked, not only the model", () => {
    // The document is told not to fabricate sources. Someone about to forward a
    // priced BoQ to a customer needs to hear it too.
    expect(PLAYGROUND).toContain("ctx.context.webAttempted && !ctx.context.web?.length");
    expect(PLAYGROUND).toContain("Web research found nothing");
  });
});
