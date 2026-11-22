// Search over your own work: what matches, and what comes first.
//
// The fault this started from: Ctrl/⌘-K with "sales" typed said "No results
// found" on an account with a dataset called saas_sales and an analyst named
// after it — the palette listed pages only, and compared whole strings.
import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "@/lib/appNav";
import type { ObjectEntry } from "@/lib/objectKinds";
import {
  countByKind,
  foldText,
  matchRanges,
  mergeEntries,
  queryTokens,
  rankObjects,
  scoreMatch,
  wordsOf,
} from "@/lib/objectSearch";
import { createTitle, FEATURED_CREATE, paletteResults } from "@/lib/paletteSearch";
import { readPageIntent, withoutPageIntent } from "@/lib/pageIntent";

const entry = (over: Partial<ObjectEntry> & Pick<ObjectEntry, "kind" | "name">): ObjectEntry => ({
  id: over.name,
  mine: true,
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

describe("the words of a name", () => {
  it("split on separators and on camelCase, lower-cased and without accents", () => {
    expect(wordsOf("saas_sales")).toEqual(["saas", "sales"]);
    expect(wordsOf("SalesByRegion")).toEqual(["sales", "by", "region"]);
    expect(wordsOf("Q3 sales-review (EMEA)")).toEqual(["q3", "sales", "review", "emea"]);
    expect(wordsOf("HTTPServer v2")).toEqual(["http", "server", "v2"]);
    expect(foldText("Résumé")).toBe("resume");
    expect(queryTokens("  __ -- ")).toEqual([]);
  });
});

describe("how close a name is", () => {
  it("ranks an exact name over a prefix, a word start, text inside a word, then the description", () => {
    const exact = scoreMatch("sales", "Sales");
    const prefix = scoreMatch("sales", "Sales by region");
    const word = scoreMatch("sales", "saas_sales");
    const inside = scoreMatch("ales", "saas_sales");
    const detail = scoreMatch("sales", "Revenue", "monthly sales by plan");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(detail);
    expect(detail).toBeGreaterThan(0);
    // The separators typed do not matter: it is the same name.
    expect(scoreMatch("saas sales", "saas_sales")).toBe(exact);
  });

  it("puts a whole word ahead of the start of a longer one", () => {
    // Found in the app: "sales" listed the Salesforce dashboard above the
    // "Sales performance 2026" workbook.
    expect(scoreMatch("sales", "Sales performance 2026")).toBeGreaterThan(
      scoreMatch("sales", "Salesforce"),
    );
    expect(scoreMatch("sales", "Q1 sales")).toBeGreaterThan(scoreMatch("sales", "Q1 salesforce"));
    // Still a match, and still ahead of text inside a word.
    expect(scoreMatch("sales", "Salesforce")).toBeGreaterThan(scoreMatch("ales", "Wholesales"));
  });

  it("needs every word typed, and scores by the weakest of them", () => {
    expect(scoreMatch("sales forecast", "Sales by region")).toBe(0);
    const weak = scoreMatch("sales forecast", "Sales by region", "a forecast for Q4");
    expect(weak).toBe(scoreMatch("forecast", "Revenue", "a forecast for Q4"));
    expect(scoreMatch("", "anything")).toBe(0);
    expect(scoreMatch("resume", "Résumé parser")).toBeGreaterThan(0);
  });
});

describe("ranking", () => {
  const entries: ObjectEntry[] = [
    entry({ kind: "dataset", name: "saas_sales", updatedAt: "2026-10-01T00:00:00Z" }),
    entry({ kind: "ai_analyst", name: "saas_sales analyst", updatedAt: "2026-11-10T00:00:00Z" }),
    entry({ kind: "dashboard", name: "Sales", updatedAt: "2026-01-01T00:00:00Z" }),
    entry({ kind: "dashboard", name: "Churn", detail: "feeds the sales review" }),
    entry({ kind: "agent", name: "Support triage" }),
  ];

  it("finds a name by a word inside it, best match first, newest among equals", () => {
    const got = rankObjects(entries, "sales").map((e) => e.name);
    expect(got).toEqual(["Sales", "saas_sales analyst", "saas_sales", "Churn"]);
  });

  it("keeps to the kinds asked for, counts each kind, and matches nothing for nothing", () => {
    const only = rankObjects(entries, "sales", { kinds: new Set(["dashboard"]) });
    expect(only.map((e) => e.name)).toEqual(["Sales", "Churn"]);
    expect(Object.fromEntries(countByKind(rankObjects(entries, "sales")))).toEqual({
      dashboard: 2,
      ai_analyst: 1,
      dataset: 1,
    });
    expect(rankObjects(entries, "   ")).toEqual([]);
    expect(rankObjects(entries, "sales", { limit: 2 })).toHaveLength(2);
  });

  it("joins lists without repeating an object", () => {
    const a = [entry({ kind: "dataset", name: "orders" })];
    const b = [
      entry({ kind: "dataset", name: "orders" }),
      entry({ kind: "report", name: "orders" }),
    ];
    expect(mergeEntries(a, b).map((e) => e.kind)).toEqual(["dataset", "report"]);
  });
});

describe("what is shown as matched", () => {
  it("is the first place each word is found, merged where they touch", () => {
    expect(matchRanges("sales", "saas_sales")).toEqual([[5, 10]]);
    expect(matchRanges("sa sales", "sales")).toEqual([[0, 5]]);
    expect(matchRanges("q3 review", "Q3 sales review")).toEqual([
      [0, 2],
      [9, 15],
    ]);
    expect(matchRanges("zzz", "sales")).toEqual([]);
    // Folding changed the length, so positions would be wrong: mark nothing.
    expect(matchRanges("resume", "Résumé")).toEqual([]);
  });
});

describe("the palette's contents", () => {
  const entries: ObjectEntry[] = Array.from({ length: 12 }, (_, i) =>
    entry({ kind: "dashboard", name: `Sales ${i}`, id: `d${i}` }),
  );

  it("is a menu with nothing typed: every page, and a short list to create", () => {
    const r = paletteResults({ query: "", entries, navGroups: NAV_GROUPS });
    expect(r.searching).toBe(false);
    expect(r.objects).toEqual([]);
    expect(r.pages).toHaveLength(NAV_GROUPS.flatMap((g) => g.items).length);
    expect(r.create.map((a) => a.kind)).toEqual([...FEATURED_CREATE]);
  });

  it("lists your work first when something is typed, and says how many more there are", () => {
    const r = paletteResults({ query: "sales", entries, navGroups: NAV_GROUPS });
    expect(r.searching).toBe(true);
    expect(r.objects).toHaveLength(8);
    expect(r.objectTotal).toBe(12);
  });

  it("finds a thing to start by what it is, and a page by its name or its group", () => {
    const create = (q: string) =>
      paletteResults({ query: q, entries: [], navGroups: NAV_GROUPS }).create.map((a) => a.kind);
    // The dashboard first; an embed, whose description mentions dashboards, after.
    expect(create("new dash")[0]).toBe("dashboard");
    expect(create("new dash")).not.toContain("agent");
    expect(create("report")[0]).toBe("report");
    expect(create("new").length).toBeGreaterThan(15);
    // Abbreviations keep their capitals: it read "New ai analyst".
    const titles = paletteResults({ query: "new", entries: [], navGroups: NAV_GROUPS }).create.map(
      createTitle,
    );
    expect(titles).toContain("New AI analyst");
    expect(titles).toContain("New ML model");
    expect(titles).toContain("New SQL model");
    expect(titles).toContain("New MCP server");
    expect(titles).toContain("New knowledge base");
    expect(titles).toContain("New dashboard");
    const pages = paletteResults({ query: "lake", entries: [], navGroups: NAV_GROUPS }).pages;
    expect(pages.map((p) => p.title)).toContain("Lakehouse");
    const byGroup = paletteResults({ query: "observability", entries: [], navGroups: NAV_GROUPS });
    expect(byGroup.pages.map((p) => p.title)).toContain("Audit Log");
  });
});

describe("what a link asks of a list page", () => {
  it("is read from the address in either spelling", () => {
    expect(readPageIntent({ open: "abc" })).toEqual({ open: "abc" });
    // The router parses search values as JSON: digits arrive as a number.
    expect(readPageIntent({ open: 42, new: "1" })).toEqual({ open: "42", new: 1 });
    expect(readPageIntent({ new: 1 })).toEqual({ new: 1 });
    expect(readPageIntent({ new: true })).toEqual({ new: 1 });
    expect(readPageIntent({ open: "", new: 0, other: "x" })).toEqual({});
    expect(readPageIntent({ open: "x".repeat(401) })).toEqual({});
  });

  it("is taken out once acted on, leaving the page's own settings", () => {
    expect(withoutPageIntent({ open: "a", new: 1, view: "canvas" })).toEqual({ view: "canvas" });
  });
});
