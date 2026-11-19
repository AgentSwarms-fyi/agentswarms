// Everything that reads a dashboard's widgets reads EVERY page (R510).
//
// A bi_dashboards row keeps its content in `pages`; the top-level `widgets`
// only mirrors page 1. The scheduled refresh, catalog lineage, the impact
// check before a dataset or semantic model is deleted, and a metric's usage
// all read the mirror alone, so a widget on page 2 was never refreshed and
// whatever it read looked unused. Each fixture below puts the widget that
// matters on page 2 ONLY.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allDashboardWidgets,
  dashboardWidgetDoc,
  refreshedDocument,
  type WidgetResultRow,
} from "@/lib/biDashboards";
import { addDashboardLineage, type LineageIndex } from "@/lib/dataCatalog";
import { dashboardsUsingTable, mentionsTable } from "@/lib/datasetDependents";
import { metricUsageInDashboards } from "@/lib/metricsCatalog";
import { scanDashboardsForModel } from "@/lib/semanticDependents";

const overview = { id: "w1", kind: "chart", title: "Overview", sql: "SELECT 1 AS n", rows: [] };
const byRegion = {
  id: "w2",
  kind: "chart",
  title: "Orders by region",
  sql: "SELECT region, COUNT(*) AS n FROM orders GROUP BY region",
  rows: [],
};
const governed = {
  id: "w3",
  kind: "chart",
  title: "Revenue (governed)",
  source: { kind: "semantic", model: "sales_model", metrics: ["revenue"] },
  rows: [],
};

/** Two pages; the top-level list mirrors page 1, as the editor saves it. */
const twoPages = {
  id: "d1",
  name: "Sales pack",
  widgets: [overview],
  layout: [{ i: "w1", x: 0, y: 0, w: 6, h: 4 }],
  pages: [
    { id: "p1", name: "Summary", widgets: [overview], layout: [] },
    { id: "p2", name: "Detail", widgets: [byRegion, governed], layout: [] },
  ],
};

describe("a dashboard's widgets", () => {
  it("are every page's, with the mirror as page 1's own objects", () => {
    const doc = dashboardWidgetDoc<{ id: string }>(twoPages.pages, twoPages.widgets, []);
    expect(doc.all.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
    expect(doc.mirror).toBe(doc.pages![0].widgets);
    expect(allDashboardWidgets(twoPages).length).toBe(3);
  });

  it("are the top-level list for a dashboard from before pages", () => {
    const legacy = { widgets: [overview, byRegion], pages: [] };
    expect(allDashboardWidgets(legacy).length).toBe(2);
    const doc = dashboardWidgetDoc(legacy.pages, legacy.widgets, []);
    expect(doc.pages).toBeNull();
    expect(refreshedDocument(doc)).not.toHaveProperty("pages");
  });

  it("carry the stored results on every page, and are written back to pages and mirror", () => {
    const stored: WidgetResultRow[] = [
      {
        widget_id: "w2",
        columns: ["region", "n"],
        rows: [{ region: "EMEA", n: 4 }],
        truncated: false,
        refreshed_at: "2026-11-19T08:00:00Z",
      },
    ];
    const doc = dashboardWidgetDoc<{ id: string; rows?: unknown[] }>(
      twoPages.pages,
      twoPages.widgets,
      stored,
    );
    expect(doc.all.find((w) => w.id === "w2")!.rows).toEqual([{ region: "EMEA", n: 4 }]);
    const write = refreshedDocument(doc) as {
      widgets: { id: string; rows: unknown[] }[];
      pages: { id: string; widgets: { id: string; rows: unknown[] }[] }[];
    };
    // Rows live in bi_widget_results; the document keeps none.
    expect(write.pages[1].widgets.map((w) => [w.id, w.rows.length])).toEqual([
      ["w2", 0],
      ["w3", 0],
    ]);
    expect(write.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(write.widgets.map((w) => w.id)).toEqual(["w1"]);
  });
});

describe("what uses a dataset or a metric, on page 2 only", () => {
  it("the impact check before deleting a dataset finds it", () => {
    expect(dashboardsUsingTable([twoPages], "orders")).toEqual([{ id: "d1", name: "Sales pack" }]);
    expect(dashboardsUsingTable([twoPages], "customers")).toEqual([]);
    expect(mentionsTable("SELECT * FROM orders_archive", "orders")).toBe(false);
  });

  it("catalog lineage names the dashboard", () => {
    const index: LineageIndex = new Map();
    addDashboardLineage(index, [twoPages]);
    const used = index.get("name:orders")?.usedBy ?? [];
    expect(used.map((r) => [r.kind, r.id, r.detail])).toEqual([
      ["dashboard", "d1", "Orders by region"],
    ]);
  });

  it("a semantic model's dependents include it", () => {
    expect(scanDashboardsForModel([twoPages as never], "sales_model")).toEqual([
      { dashboardId: "d1", dashboardName: "Sales pack", widgets: ["Revenue (governed)"] },
    ]);
  });

  it("a metric's usage counts it", () => {
    const u = metricUsageInDashboards([twoPages], "sales_model", "revenue");
    expect(u.total).toBe(1);
    expect(u.dashboards[0].widgets).toEqual(["Revenue (governed)"]);
  });

  it("is what each reader asks the database for, and what the refresh walks", () => {
    const read = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");
    // The pure functions above only help if the rows they get carry `pages`.
    for (const f of [
      "src/lib/dataCatalog.ts",
      "src/utils/dataPrep.functions.ts",
      "src/utils/semantic.functions.ts",
      "src/routes/_authenticated/metrics.tsx",
    ]) {
      expect(read(f), f).toMatch(/from\("bi_dashboards"\)\.select\("id, name, widgets, pages"\)/);
    }
    const refresh = read("src/utils/bi/refresh.server.ts");
    expect(refresh).toMatch(/\.select\("id, user_id, name, widgets, pages, filters, updated_at"\)/);
    expect(refresh).toMatch(/dashboardWidgetDoc<WidgetJson>\(dash\.pages, dash\.widgets, stored\)/);
    expect(refresh).toMatch(/\.update\(\{ \.\.\.refreshedDocument\(doc\),/);
  });

  it("counts a widget once when the mirror repeats page 1", () => {
    const onPage1 = {
      ...twoPages,
      widgets: [governed],
      pages: [{ id: "p1", name: "Summary", widgets: [governed], layout: [] }],
    };
    expect(metricUsageInDashboards([onPage1], "sales_model", "revenue").total).toBe(1);
  });
});
