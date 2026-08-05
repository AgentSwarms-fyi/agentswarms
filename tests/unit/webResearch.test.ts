// A BoQ asked for live Oracle Cloud pricing. The search was fixed so it ran and
// returned six results, two of them scraped from oracle.com — and the workbook
// STILL quoted $0.025 per OCPU-hour, attributed to "the current OCI Price List
// Compute table". That page really was fetched. It really does not contain that
// number.
//
// Measured, both ends of the pipe:
//
//   query sent      : the entire 300-char instruction, so the results were a
//                     YouTube video and a GPU-pricing blog. Searching the
//                     SUBJECT alone returned Oracle's own E5/E6 announcement,
//                     which does carry the per-OCPU rate.
//   text delivered  : each scraped page cut to 3500 chars, then to 2000 again in
//                     the planner prompt, always from the FRONT — which on a
//                     vendor page is navigation and marketing. The Oracle blog
//                     post arrived at the planner with no currency figure in it.
//
// So the model was asked for a sourced rate and handed pages with no rates in
// them. These tests pin the two deterministic halves of the fix.
import { describe, expect, it } from "vitest";

import { relevantExcerpt, searchQueryFromPrompt } from "@/utils/webResearch";

describe("searchQueryFromPrompt keeps the subject, drops the errand", () => {
  it("reduces the real failing request to something searchable", () => {
    const q = searchQueryFromPrompt(
      "Web-search the current Oracle Cloud (OCI) pricing for AMD E5 compute instances, " +
        "then build a bill of quantities for an example on-prem to OCI sizing exercise: " +
        "line items with quantity, unit price and line totals, plus a monthly and annual roll-up summary.",
    );
    expect(q).toBe("the current Oracle Cloud (OCI) pricing for AMD E5 compute instances");
    // The deliverables are what made the query useless — none may survive.
    expect(q).not.toMatch(/bill of quantities|roll-up|line items|sizing exercise/i);
  });

  it("strips the leading imperative however it is phrased", () => {
    for (const lead of [
      "Web-search ",
      "web search for ",
      "Search the web for ",
      "Look up ",
      "Please find ",
      "Research ",
    ]) {
      expect(searchQueryFromPrompt(`${lead}Oracle Cloud E5 pricing`)).toBe(
        "Oracle Cloud E5 pricing",
      );
    }
  });

  it("cuts at 'and build' as well as 'then'", () => {
    expect(searchQueryFromPrompt("Find Azure VM pricing and build a comparison deck")).toBe(
      "Azure VM pricing",
    );
  });

  it("leaves a prompt that is already a topic alone", () => {
    const topic = "Oracle Cloud OCI AMD E5 compute instance pricing per OCPU hour";
    expect(searchQueryFromPrompt(topic)).toBe(topic);
  });

  it("falls back rather than searching for a fragment", () => {
    // Stripping the imperative leaves "it" — useless. Better to search the
    // original than to send two characters to a search engine.
    const q = searchQueryFromPrompt("Look up it");
    expect(q).toBe("Look up it");
    expect(searchQueryFromPrompt("")).toBe("");
  });

  it("bounds the query length", () => {
    expect(searchQueryFromPrompt("Oracle ".repeat(200)).length).toBeLessThanOrEqual(160);
  });
});

describe("relevantExcerpt finds the figures instead of the navigation", () => {
  /** A vendor page in the real shape: chrome first, rate table last. */
  function vendorPage(): string {
    const chrome =
      "Skip to content. Oracle. Products Industries Resources Customers Partners " +
      "Developers Company Contact Sales. Cookie preferences. Sign in to Oracle Cloud. " +
      "Why Oracle Cloud Infrastructure delivers better price performance for every " +
      "workload, from the smallest test instance to the largest enterprise database. ";
    const filler = "Customers choose OCI for consistent performance and simple pricing. ".repeat(
      60,
    );
    const rates =
      "Compute pricing: VM.Standard.E5.Flex is billed at $0.03 per OCPU-hour and " +
      "$0.002 per GB-hour of memory. Block Volume storage is $0.0255 per GB-month.";
    return chrome + filler + rates;
  }

  it("returns the rate table, which head-truncation always missed", () => {
    const page = vendorPage();
    const query = "the current Oracle Cloud (OCI) pricing for AMD E5 compute instances";

    // Precondition: the old behaviour genuinely could not see the rates.
    expect(page.slice(0, 2000)).not.toContain("$0.03");

    const excerpt = relevantExcerpt(page, query, 2000);
    expect(excerpt).toContain("$0.03 per OCPU-hour");
    expect(excerpt).toContain("$0.002 per GB-hour");
    expect(excerpt.length).toBeLessThanOrEqual(2000 + 2); // plus ellipses
  });

  it("returns short pages untouched", () => {
    const short = "VM.Standard.E5.Flex costs $0.03 per OCPU-hour.";
    expect(relevantExcerpt(short, "E5 pricing", 3500)).toBe(short);
  });

  it("prefers figures over a page that merely repeats the product name", () => {
    const nameSpam = "E5 E5 E5 flexible shape overview. ".repeat(80);
    const withRates = "Pricing table: E5 OCPU $0.03 per hour, memory $0.002 per GB per hour.";
    const excerpt = relevantExcerpt(nameSpam + withRates, "E5 pricing OCPU", 400);
    expect(excerpt).toContain("$0.03");
  });

  it("marks that it is an excerpt so nothing reads as the whole page", () => {
    const excerpt = relevantExcerpt(vendorPage(), "E5 pricing OCPU hour", 300);
    expect(excerpt.startsWith("…") || excerpt.endsWith("…")).toBe(true);
  });

  it("degrades to the head when nothing in the page matches at all", () => {
    const unrelated = "x".repeat(5000);
    const out = relevantExcerpt(unrelated, "Oracle E5 pricing", 100);
    expect(out).toBe("x".repeat(100));
  });

  it("never opens mid-word", () => {
    const page = vendorPage();
    const excerpt = relevantExcerpt(page, "E5 pricing OCPU hour", 500);
    const firstWord = excerpt.replace(/^…/, "").split(/\s/)[0];
    expect(page).toContain(firstWord);
  });
});
