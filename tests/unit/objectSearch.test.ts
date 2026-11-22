// Search over your own work: what matches, and what comes first.
//
// The fault this started from: Ctrl/⌘-K with "sales" typed said "No results
// found" on an account with a dataset called saas_sales and an analyst named
// after it — the palette listed pages only, and compared whole strings.
import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "@/lib/appNav";
import type { ObjectEntry } from "@/lib/objectKinds";
import { starredFirst, type MarkMap } from "@/lib/objectMarks";
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
import { createTitle, FEATURED_CREATE, paletteResults, SECTION_ORDER } from "@/lib/paletteSearch";
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

describe("which section of the palette comes first", () => {
  const order = (query: string, entries: ObjectEntry[] = []) =>
    paletteResults({ query, entries, navGroups: NAV_GROUPS }).order;
  // An agent that only MENTIONS a knowledge base, and one named after sales.
  const mine = [
    entry({ kind: "agent", name: "RAG eval", detail: "Answers from the knowledge base" }),
    entry({ kind: "dashboard", name: "Sales performance 2026" }),
  ];

  it("is your work, then what you could start, then pages", () => {
    expect([...SECTION_ORDER]).toEqual(["objects", "create", "pages"]);
    expect(order("")).toEqual(["objects", "create", "pages"]);
    expect(order("sales", mine)).toEqual(["objects", "create", "pages"]);
    // Part of a page's name is not its name: "lake" keeps the usual order.
    expect(order("lake", mine)).toEqual(["objects", "create", "pages"]);
    expect(order("knowledge", mine)).toEqual(["objects", "create", "pages"]);
  });

  it("is the pages when a page is named in full, so Enter opens that page", () => {
    // It opened the agent whose description mentions a knowledge base.
    const r = paletteResults({ query: "Knowledge Base", entries: mine, navGroups: NAV_GROUPS });
    expect(r.order[0]).toBe("pages");
    expect(r.pages[0].title).toBe("Knowledge Base");
    // The agent is still listed, after it.
    expect(r.objects.map((o) => o.name)).toContain("RAG eval");
    expect(r.order).toEqual(["pages", "objects", "create"]);
    // However it is typed.
    expect(order("knowledge base", mine)[0]).toBe("pages");
    expect(order("  LAKEHOUSE ", mine)[0]).toBe("pages");
  });

  it("is still your work when something of yours has that very name", () => {
    const named = [...mine, entry({ kind: "dataset", name: "Lakehouse" })];
    // Both are named in full: yours first, the page straight after it.
    expect(order("lakehouse", named)).toEqual(["objects", "pages", "create"]);
  });

  it("finds a renamed page by the name it used to have", () => {
    const r = paletteResults({ query: "model registry", entries: [], navGroups: NAV_GROUPS });
    expect(r.pages.map((p) => p.title)).toContain("AI Model Catalog");
    // The old name typed in full names the page in full: it leads, ahead of an
    // agent that only mentions a model registry. Enter opened that agent.
    const mentions = [
      ...mine,
      entry({ kind: "agent", name: "Predictive Analyst", detail: "Uses the model registry" }),
    ];
    const old = paletteResults({
      query: "Model Registry",
      entries: mentions,
      navGroups: NAV_GROUPS,
    });
    expect(old.order).toEqual(["pages", "objects", "create"]);
    expect(old.pages[0].title).toBe("AI Model Catalog");
    expect(old.objects.map((o) => o.name)).toContain("Predictive Analyst");
    // Part of the old name finds it without reordering anything.
    const part = paletteResults({ query: "registry", entries: mentions, navGroups: NAV_GROUPS });
    expect(part.pages.map((p) => p.title)).toContain("AI Model Catalog");
    expect(part.order).toEqual(["objects", "create", "pages"]);
    // The group and the old name together still find it.
    const both = paletteResults({
      query: "integrations registry",
      entries: [],
      navGroups: NAV_GROUPS,
    });
    expect(both.pages.map((p) => p.title)).toEqual(["AI Model Catalog"]);
    // By its new name it is named in full, and leads.
    const now = paletteResults({ query: "ai model catalog", entries: mine, navGroups: NAV_GROUPS });
    expect(now.order[0]).toBe("pages");
    expect(now.pages[0].url).toBe("/model-registry");
  });

  it("is the thing to start when that is what was named in full", () => {
    const r = paletteResults({ query: "new dashboard", entries: mine, navGroups: NAV_GROUPS });
    expect(r.order[0]).toBe("create");
    expect(r.create[0].kind).toBe("dashboard");
  });
});

describe("the palette and what you starred or opened (R515)", () => {
  const at = (d: number) => `2026-11-${String(d).padStart(2, "0")}T09:00:00.000Z`;
  const mine = [
    entry({ kind: "dashboard", name: "Sales overview", id: "d1", updatedAt: at(1) }),
    entry({ kind: "dashboard", name: "Sales by region", id: "d2", updatedAt: at(9) }),
    entry({ kind: "agent", name: "Support", id: "a1", updatedAt: at(2) }),
    entry({ kind: "dataset", name: "orders", id: "t1", updatedAt: at(3) }),
  ];
  const marks: MarkMap = new Map([
    ["dashboard:d1", { kind: "dashboard", id: "d1", starredAt: at(5), openedAt: at(6) }],
    ["agent:a1", { kind: "agent", id: "a1", starredAt: null, openedAt: at(8) }],
    ["dataset:t1", { kind: "dataset", id: "t1", starredAt: null, openedAt: at(7) }],
  ]);

  it("opens on where you were: favourites, then what was opened last", () => {
    const r = paletteResults({ query: "", entries: mine, navGroups: NAV_GROUPS, marks });
    expect(r.favourites.map((e) => e.name)).toEqual(["Sales overview"]);
    // Newest opening first; the favourite is not listed twice.
    expect(r.recent.map((e) => e.name)).toEqual(["Support", "orders"]);
    // Still a menu: every page is there under it.
    expect(r.pages).toHaveLength(NAV_GROUPS.flatMap((g) => g.items).length);
  });

  it("offers neither to someone with no marks, and neither once something is typed", () => {
    const none = paletteResults({ query: "", entries: mine, navGroups: NAV_GROUPS });
    expect(none.favourites).toEqual([]);
    expect(none.recent).toEqual([]);
    const typed = paletteResults({ query: "sales", entries: mine, navGroups: NAV_GROUPS, marks });
    expect(typed.favourites).toEqual([]);
    expect(typed.recent).toEqual([]);
  });

  it("puts a favourite ahead of a match that is just as good, never a better one", () => {
    // Both start with the word typed. Unmarked, the newer one leads.
    const plain = paletteResults({ query: "sales", entries: mine, navGroups: NAV_GROUPS });
    expect(plain.objects.map((e) => e.name)).toEqual(["Sales by region", "Sales overview"]);
    const starred = paletteResults({ query: "sales", entries: mine, navGroups: NAV_GROUPS, marks });
    expect(starred.objects.map((e) => e.name)).toEqual(["Sales overview", "Sales by region"]);
    // "Sales by region" typed in full outranks the favourite that only starts with it.
    const exact = paletteResults({
      query: "sales by region",
      entries: mine,
      navGroups: NAV_GROUPS,
      marks,
    });
    expect(exact.objects[0].name).toBe("Sales by region");
    // The helper leaves an order with no ties and no stars exactly as it was.
    const ranked = [
      { kind: "agent" as const, id: "x", score: 800 },
      { kind: "agent" as const, id: "y", score: 600 },
    ];
    expect(starredFirst(ranked, new Map())).toEqual(ranked);
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
