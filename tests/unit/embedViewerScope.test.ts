// Scoping an embedded dashboard to one viewer. Every failure here hands a
// customer another customer's numbers, or hides that fact behind a chart that
// looks fine: attributes unioned instead of intersected, a widget that cannot
// be scoped rendered anyway, a narrative about the owner's totals left beside
// one tenant's rows, or a missing attribute quietly meaning "no filter".
import { describe, expect, it } from "vitest";

import {
  describeViewerScope,
  scopePages,
  scopeWidget,
  scopeWidgets,
  scopeWidgetsForAi,
  viewerScopeFilters,
} from "@/lib/embedViewerScope";
import type { BiWidget } from "@/lib/biDashboards";

const chart = (over: Partial<BiWidget> = {}): BiWidget => ({
  id: "w1",
  kind: "chart",
  title: "Revenue by tenant",
  columns: ["tenant", "revenue"],
  rows: [
    { tenant: "acme", revenue: 100 },
    { tenant: "globex", revenue: 200 },
  ],
  ...over,
});

describe("turning attributes into filters", () => {
  it("builds one filter per REQUIRED attribute", () => {
    const r = viewerScopeFilters(["tenant"], { tenant: ["acme"] });
    expect(r).toEqual({ ok: true, filters: [{ column: "tenant", values: ["acme"] }] });
  });

  it("REFUSES when a required attribute is absent, naming it", () => {
    // The failure this exists to stop: a host typo means no filter is built,
    // and "no filter" renders as "everything".
    const r = viewerScopeFilters(["tenant"], { tenat: ["acme"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(["tenant"]);
      expect(r.reason).toContain("tenant");
    }
  });

  it("treats an empty value list as absent, not as a wildcard", () => {
    const r = viewerScopeFilters(["tenant"], { tenant: [] });
    expect(r.ok).toBe(false);
  });

  it("refuses when the embed requires a signed viewer but names no attributes", () => {
    // Otherwise a merely-valid token would unlock the whole dashboard:
    // authenticated mistaken for authorized.
    const r = viewerScopeFilters([], { tenant: ["acme"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("nothing to scope");
  });

  it("matches the attribute name case-insensitively", () => {
    const r = viewerScopeFilters(["Tenant"], { tenant: ["acme"] });
    expect(r.ok).toBe(true);
  });

  it("ignores attributes the embed did not ask for", () => {
    const r = viewerScopeFilters(["tenant"], { tenant: ["acme"], role: ["admin"] });
    expect(r.ok && r.filters).toEqual([{ column: "tenant", values: ["acme"] }]);
  });
});

describe("scoping a widget's rows", () => {
  it("keeps only the viewer's rows", () => {
    const s = scopeWidget(chart(), [{ column: "tenant", values: ["acme"] }]);
    expect(s.withheld).toBeUndefined();
    expect(s.widget.rows).toEqual([{ tenant: "acme", revenue: 100 }]);
  });

  it("INTERSECTS multiple attributes rather than unioning them", () => {
    // Grants union because holding two must not show less than holding one.
    // Attributes describe one person: an acme viewer in emea must not be
    // handed globex's emea rows just because the region matched.
    const w = chart({
      columns: ["tenant", "region", "revenue"],
      rows: [
        { tenant: "acme", region: "emea", revenue: 1 },
        { tenant: "acme", region: "apac", revenue: 2 },
        { tenant: "globex", region: "emea", revenue: 3 },
      ],
    });
    const s = scopeWidget(w, [
      { column: "tenant", values: ["acme"] },
      { column: "region", values: ["emea"] },
    ]);
    expect(s.widget.rows).toEqual([{ tenant: "acme", region: "emea", revenue: 1 }]);
  });

  it("honours a multi-valued attribute as an OR within that attribute", () => {
    const s = scopeWidget(chart(), [{ column: "tenant", values: ["acme", "globex"] }]);
    expect(s.widget.rows).toHaveLength(2);
  });

  it("matches the widget's column casing, whatever the warehouse returned", () => {
    const w = chart({ columns: ["TENANT", "REVENUE"], rows: [{ TENANT: "acme", REVENUE: 100 }] });
    const s = scopeWidget(w, [{ column: "tenant", values: ["acme"] }]);
    expect(s.withheld).toBeUndefined();
    expect(s.widget.rows).toHaveLength(1);
  });

  it("finds the column from the row keys, in their casing, when no column list was stored", () => {
    const w = chart({ columns: undefined, rows: [{ TeNaNt: "acme", revenue: 1 }] });
    expect(scopeWidget(w, [{ column: "tenant", values: ["acme"] }]).widget.rows).toHaveLength(1);
  });

  it("keeps 'no rows for you' distinct from 'cannot be scoped' on an EMPTY widget", () => {
    // An empty result still DECLARES its columns. Calling this withheld would
    // send the owner to fix a query that is already projecting what it should,
    // and calling it scoped-with-rows would be a lie in the other direction.
    const s = scopeWidget(chart({ rows: [] }), [{ column: "tenant", values: ["acme"] }]);
    expect(s.withheld).toBeUndefined();
    expect(s.widget.rows).toEqual([]);
  });

  it("reads the DECLARED column's casing when there are no rows to learn it from", () => {
    // The row-key fallback cannot fire here, so this is the only test that
    // measures the declared-columns lookup on its own.
    const s = scopeWidget(chart({ columns: ["TENANT", "REVENUE"], rows: [] }), [
      { column: "tenant", values: ["acme"] },
    ]);
    expect(s.withheld).toBeUndefined();
  });

  it("withholds an empty widget that declares no columns at all", () => {
    // Nothing states what it projects, so we cannot claim it was scoped.
    const s = scopeWidget(chart({ columns: [], rows: [] }), [
      { column: "tenant", values: ["acme"] },
    ]);
    expect(s.withheld).toContain("tenant");
  });

  it("WITHHOLDS a widget that aggregated the scope column away", () => {
    // The number already contains every tenant. No filter over these rows can
    // recover one tenant's share — only re-running the query can.
    const w = chart({
      title: "Revenue by month",
      columns: ["month", "revenue"],
      rows: [{ month: "2026-01", revenue: 300 }],
    });
    const s = scopeWidget(w, [{ column: "tenant", values: ["acme"] }]);
    expect(s.withheld).toContain("tenant");
    expect(s.widget.rows).toEqual([]);
  });

  it("distinguishes 'cannot be scoped' from 'you have no rows'", () => {
    // Both render as an empty chart. Only one of them means the owner has
    // something to fix, and only one of them is honest to call "no data".
    const noRows = scopeWidget(chart(), [{ column: "tenant", values: ["initech"] }]);
    expect(noRows.withheld).toBeUndefined();
    expect(noRows.widget.rows).toEqual([]);
  });

  it("withholds when ANY of several scope columns is missing", () => {
    const s = scopeWidget(chart(), [
      { column: "tenant", values: ["acme"] },
      { column: "region", values: ["emea"] },
    ]);
    expect(s.withheld).toContain("region");
  });

  it("DROPS the narrative, which described the owner's totals", () => {
    const w = chart({ narrative: "Revenue grew 12% to $300 across the business." });
    const s = scopeWidget(w, [{ column: "tenant", values: ["acme"] }]);
    expect(s.widget.narrative).toBeUndefined();
  });

  it("drops the narrative from a withheld widget too", () => {
    const w = chart({ columns: ["month"], rows: [{ month: "x" }], narrative: "Totals were $300." });
    expect(scopeWidget(w, [{ column: "tenant", values: ["a"] }]).widget.narrative).toBeUndefined();
  });

  it("leaves text and image widgets alone — they carry no result rows", () => {
    const t: BiWidget = { id: "t", kind: "text", title: "Note", text: "Hello" };
    expect(scopeWidget(t, [{ column: "tenant", values: ["acme"] }]).widget).toEqual(t);
  });

  it("changes nothing when there are no filters", () => {
    const w = chart({ narrative: "kept" });
    expect(scopeWidget(w, [])).toEqual({ widget: w });
  });
});

describe("scoping a dashboard", () => {
  const filters = [{ column: "tenant", values: ["acme"] }];

  it("carries the withheld reason onto the widget so the viewer sees it", () => {
    const out = scopeWidgets(
      [chart(), chart({ id: "w2", columns: ["month"], rows: [{ month: "x" }] })],
      filters,
    ) as BiWidget[];
    expect(out[0].withheld).toBeUndefined();
    expect(out[1].withheld).toContain("tenant");
  });

  it("scopes every page's widgets, not just the first page", () => {
    const pages = [
      { id: "p1", widgets: [chart()] },
      { id: "p2", widgets: [chart({ id: "w2" })] },
    ];
    const out = scopePages(pages, filters) as { widgets: BiWidget[] }[];
    expect(out[0].widgets[0].rows).toHaveLength(1);
    expect(out[1].widgets[0].rows).toHaveLength(1);
  });

  it("survives malformed widget arrays", () => {
    expect(scopeWidgets(null, filters)).toBeNull();
    expect(scopePages(undefined, filters)).toBeUndefined();
    expect((scopeWidgets([null, "x"], filters) as unknown[]).length).toBe(2);
  });
});

describe("the data the embedded AI analyst may read", () => {
  const filters = [{ column: "tenant", values: ["acme"] }];

  it("scopes the rows the model sees", () => {
    const out = scopeWidgetsForAi([chart()], filters);
    expect(out[0].rows).toEqual([{ tenant: "acme", revenue: 100 }]);
  });

  it("REMOVES a withheld widget instead of passing it empty", () => {
    // A leak with a friendlier voice is still a leak: the model must never be
    // handed numbers it may not scope, and an empty widget invites it to say
    // "there is no data" about data that exists.
    const out = scopeWidgetsForAi(
      [chart(), chart({ id: "w2", columns: ["month"], rows: [{ month: "x", revenue: 300 }] })],
      filters,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("w1");
  });

  it("passes everything through when the embed is not per-viewer", () => {
    expect(scopeWidgetsForAi([chart()], [])).toHaveLength(1);
  });
});

describe("telling the viewer what they are looking at", () => {
  it("states the scope, because a subset shown as a total is a wrong number", () => {
    expect(describeViewerScope([{ column: "tenant", values: ["acme"] }])).toBe(
      "Showing data for tenant = acme.",
    );
  });

  it("lists every attribute in force", () => {
    const msg = describeViewerScope([
      { column: "tenant", values: ["acme"] },
      { column: "region", values: ["emea", "apac"] },
    ]);
    expect(msg).toContain("tenant = acme");
    expect(msg).toContain("region = emea or apac");
  });

  it("says nothing when the embed is not scoped", () => {
    expect(describeViewerScope([])).toBeNull();
  });
});
