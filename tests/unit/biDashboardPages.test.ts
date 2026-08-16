// "Add to dashboard" must put the widget where the dashboard actually reads it.
//
// A dashboard row stores `pages` (the source of truth) AND top-level
// `widgets`/`layout`, which only MIRROR page 1. appendWidgetToDashboard wrote
// the mirror alone, so on any dashboard that had ever been saved with pages the
// widget was invisible — parsePages returns the stored pages and ignores the
// top level — and the builder's next save rebuilt the mirror from pages,
// discarding it permanently. Silent data loss, reported as "the chart isn't
// there".
//
// These tests pin the invariant: after an append, what parsePages returns for
// page 1 and what the top-level mirror holds must agree, and must contain the
// new widget.

import { describe, expect, it } from "vitest";

import {
  appendWidgetToPages,
  dashboardSize,
  makeEmptyPage,
  parseLayout,
  parsePages,
  parseWidgets,
  widgetFromSemantic,
  type BiPage,
  type Json,
} from "@/lib/biDashboards";

function semanticWidget(title: string) {
  return widgetFromSemantic({
    title,
    model: "saas",
    metrics: ["total_discount"],
    dimensions: ["country"],
    chartType: "bar",
    columns: ["country", "total_discount"],
    rows: [{ country: "US", total_discount: 12 }],
    sql: 'SELECT "Country" AS country, SUM("Discount") AS total_discount FROM saas_sales',
  });
}

describe("appendWidgetToPages", () => {
  it("adds the widget to page 1 and to the mirror", () => {
    const pages: BiPage[] = [makeEmptyPage("Page 1")];
    const w = semanticWidget("Discount by country");
    const out = appendWidgetToPages(pages, w);

    expect(out.pages[0].widgets.map((x) => x.id)).toEqual([w.id]);
    expect(out.widgets.map((x) => x.id)).toEqual([w.id]);
    // The mirror must be page 1, not a separate list that can drift.
    expect(out.widgets).toEqual(out.pages[0].widgets);
    expect(out.layout).toEqual(out.pages[0].layout);
  });

  it("gives the widget a layout slot, so it is placed rather than hidden", () => {
    const out = appendWidgetToPages([makeEmptyPage("Page 1")], semanticWidget("A"));
    expect(out.layout).toHaveLength(1);
    expect(out.layout[0].i).toBe(out.widgets[0].id);
  });

  it("keeps existing widgets on page 1", () => {
    const first = semanticWidget("First");
    const start = appendWidgetToPages([makeEmptyPage("Page 1")], first);
    const second = semanticWidget("Second");
    const out = appendWidgetToPages(start.pages, second);

    expect(out.pages[0].widgets.map((w) => w.title)).toEqual(["First", "Second"]);
    expect(out.layout).toHaveLength(2);
  });

  it("does not disturb other pages", () => {
    const pages: BiPage[] = [makeEmptyPage("Page 1"), makeEmptyPage("Page 2")];
    const other = pages[1];
    const out = appendWidgetToPages(pages, semanticWidget("A"));

    expect(out.pages).toHaveLength(2);
    expect(out.pages[1]).toEqual(other);
    expect(out.pages[1].widgets).toHaveLength(0);
  });

  it("does not mutate the pages it was given", () => {
    const pages: BiPage[] = [makeEmptyPage("Page 1")];
    appendWidgetToPages(pages, semanticWidget("A"));
    expect(pages[0].widgets).toHaveLength(0);
  });

  it("copes with a dashboard that has no pages yet", () => {
    const out = appendWidgetToPages([], semanticWidget("A"));
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].widgets).toHaveLength(1);
  });
});

describe("what the dashboard reads back", () => {
  it("finds the widget after a round trip through parsePages — the actual bug", () => {
    // A dashboard saved by the builder: `pages` is populated, so parsePages
    // ignores the top-level fallback entirely.
    const existing = semanticWidget("Already here");
    const saved = appendWidgetToPages([makeEmptyPage("Page 1")], existing);

    const added = semanticWidget("Discount by country");
    const after = appendWidgetToPages(saved.pages, added);

    // Persist exactly what appendWidgetToDashboard writes, then read it back
    // the way the dashboard route does.
    const reread = parsePages(
      after.pages as unknown as Json,
      parseWidgets(after.widgets as unknown as Json),
      parseLayout(after.layout as unknown as Json, after.widgets),
    );

    expect(reread[0].widgets.map((w) => w.title)).toEqual(["Already here", "Discount by country"]);
  });

  it("would have failed before: writing only the mirror loses the widget", () => {
    // Reproduces the old behaviour — top-level updated, `pages` left stale.
    const saved = appendWidgetToPages([makeEmptyPage("Page 1")], semanticWidget("Already here"));
    const added = semanticWidget("Discount by country");
    const mirrorOnly = [...saved.widgets, added];

    const reread = parsePages(
      saved.pages as unknown as Json, // stale — the old code never updated this
      parseWidgets(mirrorOnly as unknown as Json),
      [],
    );

    expect(reread[0].widgets.map((w) => w.title)).toEqual(["Already here"]);
    expect(reread[0].widgets.some((w) => w.id === added.id)).toBe(false);
  });
});

// ── Adversarial pass, module 12 ─────────────────────────────────────────────

describe("how big a dashboard actually is", () => {
  // The counting version of the bug this file already guards. The BI Workspace
  // card read `parseWidgets(row.widgets)` — the page-1 MIRROR — and called it
  // the dashboard's widget count.
  //
  // MEASURED: "Formula 1 Analytics" holds 7 + 4 + 4 + 0 = 15 widgets across
  // four pages, and its card said "7 widgets". The other ten projects on that
  // account have a single page, so the count was right by accident everywhere
  // it was checked. The bias is the same shape as every truncation defect
  // here: never too high, always too low, and it only goes wrong once someone
  // adds pages — the thing that makes a dashboard substantial.
  const w = (title: string) => ({ id: title, kind: "text", title, text: "" }) as unknown as Json;

  const row = (pages: Array<{ id: string; name: string; widgets: unknown[] }>) => ({
    widgets: (pages[0]?.widgets ?? []) as Json,
    layout: [] as unknown as Json,
    pages: pages as unknown as Json,
  });

  it("counts widgets across every page, not just page 1", () => {
    const r = row([
      { id: "p1", name: "2025 Season", widgets: [w("a"), w("b"), w("c")] },
      { id: "p2", name: "Champions", widgets: [w("d"), w("e")] },
      { id: "p3", name: "Dynasties", widgets: [w("f")] },
    ]);
    expect(dashboardSize(r)).toEqual({ widgets: 6, pages: 3 });
  });

  it("counts an empty trailing page as a page with no widgets", () => {
    // Formula 1 had exactly this: a "Page 4" someone added and never filled.
    const r = row([
      { id: "p1", name: "One", widgets: [w("a")] },
      { id: "p2", name: "Two", widgets: [] },
    ]);
    expect(dashboardSize(r)).toEqual({ widgets: 1, pages: 2 });
  });

  it("agrees with the mirror on a single-page dashboard", () => {
    // The case that was right by accident, and must stay right.
    const r = row([{ id: "p1", name: "Page 1", widgets: [w("a"), w("b")] }]);
    expect(dashboardSize(r)).toEqual({ widgets: 2, pages: 1 });
    expect(parseWidgets(r.widgets)).toHaveLength(2);
  });

  it("falls back to the top-level mirror for a pre-multi-page dashboard", () => {
    // Rows saved before `pages` existed have none, and parsePages collapses
    // them to one page. Reporting 0 widgets for those would be the same defect
    // pointing the other way.
    const legacy = {
      widgets: [w("a"), w("b"), w("c")] as unknown as Json,
      layout: [] as unknown as Json,
    };
    expect(dashboardSize(legacy)).toEqual({ widgets: 3, pages: 1 });
  });

  it("reports an empty dashboard as empty, not as one phantom page of content", () => {
    expect(
      dashboardSize({ widgets: [] as unknown as Json, layout: [] as unknown as Json }),
    ).toEqual({ widgets: 0, pages: 1 });
  });
});
