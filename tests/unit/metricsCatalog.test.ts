// The metric catalog. Its whole job is helping someone decide whether to
// TRUST a metric, so every failure mode here is a trust claim that isn't true:
// calling a metric certified when only its model was validated, printing
// "never updated" when the answer is actually unknown, or reporting "unused"
// from a scan that never looked at half the places a metric can be used.
import { describe, expect, it } from "vitest";

import {
  catalogSummary,
  dataFreshness,
  describeCertification,
  describeFreshness,
  describeUsage,
  flattenMetrics,
  matchesQuery,
  metricUsageInDashboards,
  qualifiedName,
  type CatalogMetric,
} from "@/lib/metricsCatalog";
import type { SemanticModelRow } from "@/lib/metricsCatalog";

const model = (over: Partial<SemanticModelRow> = {}): SemanticModelRow => ({
  id: "m1",
  name: "sales_model",
  label: "Sales",
  status: "certified",
  // The stored shape: source is FLAT, not nested. Tests use it because that
  // is what every caller holds.
  source_kind: "data_table",
  source_table: "orders",
  metrics: [{ name: "revenue", label: "Revenue", agg: "sum", sql: "amount" }],
  ...over,
});

const metric = (over: Partial<CatalogMetric> = {}): CatalogMetric => ({
  model: "sales_model",
  status: "certified",
  name: "revenue",
  label: "Revenue",
  agg: "sum",
  synonyms: [],
  ...over,
});

describe("flattening every model's metrics", () => {
  it("carries the model context each metric needs", () => {
    const [m] = flattenMetrics([model()]);
    expect(m.model).toBe("sales_model");
    expect(m.modelLabel).toBe("Sales");
    expect(m.status).toBe("certified");
    expect(m.name).toBe("revenue");
  });

  it("defaults a model with no status to draft, not to certified", () => {
    // Absent governance must never read as passed governance.
    const [m] = flattenMetrics([model({ status: undefined })]);
    expect(m.status).toBe("draft");
  });

  it("sorts by label so the list reads alphabetically", () => {
    const out = flattenMetrics([
      model({
        metrics: [
          { name: "z_first", label: "Zebra", agg: "sum" },
          { name: "a_second", label: "Apple", agg: "sum" },
        ],
      }),
    ]);
    expect(out.map((m) => m.label)).toEqual(["Apple", "Zebra"]);
  });

  it("surfaces a derived metric's formula", () => {
    const [m] = flattenMetrics([
      model({
        metrics: [{ name: "aov", agg: "derived", sql: "{revenue} / NULLIF({orders}, 0)" }],
      }),
    ]);
    expect(m.formula).toContain("{revenue}");
  });

  it("does not treat a plain sum's column as a formula", () => {
    const [m] = flattenMetrics([model()]);
    expect(m.formula).toBeUndefined();
  });

  it("survives a model with no metrics", () => {
    expect(flattenMetrics([model({ metrics: [] })])).toEqual([]);
  });
});

describe("finding a metric", () => {
  it("matches on synonyms — the reason they are declared", () => {
    const m = metric({ name: "net_revenue", label: "Net revenue", synonyms: ["bookings"] });
    expect(matchesQuery(m, "bookings")).toBe(true);
  });

  it("matches name, label, description and model", () => {
    const m = metric({ description: "excludes refunds", modelLabel: "Sales" });
    expect(matchesQuery(m, "refunds")).toBe(true);
    expect(matchesQuery(m, "sales")).toBe(true);
  });

  it("is case-insensitive on BOTH sides", () => {
    // The query is lowercased before comparing, so a mixed-case query against
    // a lowercase field passes even without folding the haystack. Only a
    // mixed-case FIELD proves the haystack is folded too — here the label is
    // the only place the word appears.
    const m = metric({ name: "nrm", label: "Net Revenue Margin", model: "x", modelLabel: "X" });
    expect(matchesQuery(m, "MARGIN")).toBe(true);
    expect(matchesQuery(m, "margin")).toBe(true);
  });

  it("returns everything for an empty query", () => {
    expect(matchesQuery(metric(), "   ")).toBe(true);
  });

  it("does not match something absent", () => {
    expect(matchesQuery(metric(), "margin")).toBe(false);
  });
});

describe("where a metric is used", () => {
  const dash = (widgets: unknown) => [{ id: "d1", name: "Exec", widgets }];

  it("finds the widgets that ask for THIS metric", () => {
    const u = metricUsageInDashboards(
      dash([
        {
          title: "Revenue trend",
          source: { kind: "semantic", model: "sales_model", metrics: ["revenue"] },
        },
      ]),
      "sales_model",
      "revenue",
    );
    expect(u.total).toBe(1);
    expect(u.dashboards[0].widgets).toEqual(["Revenue trend"]);
  });

  it("does not count a widget on the same model but a DIFFERENT metric", () => {
    // The whole point of metric-level usage: model-level would say "used".
    const u = metricUsageInDashboards(
      dash([
        {
          title: "Orders",
          source: { kind: "semantic", model: "sales_model", metrics: ["orders"] },
        },
      ]),
      "sales_model",
      "revenue",
    );
    expect(u.total).toBe(0);
  });

  it("does not count the same metric name on a different model", () => {
    const u = metricUsageInDashboards(
      dash([
        { title: "X", source: { kind: "semantic", model: "other_model", metrics: ["revenue"] } },
      ]),
      "sales_model",
      "revenue",
    );
    expect(u.total).toBe(0);
  });

  it("ignores non-semantic widgets and malformed shapes", () => {
    expect(
      metricUsageInDashboards(
        dash([{ title: "SQL", sql: "SELECT 1" }, {}, { source: {} }]),
        "sales_model",
        "revenue",
      ).total,
    ).toBe(0);
    expect(metricUsageInDashboards([{ id: "d", name: "n", widgets: null }], "m", "x").total).toBe(
      0,
    );
  });

  it("NEVER says unused — it says what was searched", () => {
    // An analyst thread, an embed or a saved query can reference a metric
    // without appearing in this scan. Deprecating something because a page
    // said "unused" is the outcome this wording exists to prevent.
    const msg = describeUsage({ dashboards: [], total: 0 });
    expect(msg).not.toMatch(/unused/i);
    expect(msg).toContain("not scanned");
  });

  it("counts widgets and dashboards when there are some", () => {
    expect(
      describeUsage({ dashboards: [{ id: "a", name: "A", widgets: ["w1", "w2"] }], total: 2 }),
    ).toBe("2 widgets across 1 dashboard");
  });
});

describe("what certification actually covers", () => {
  it("says the MODEL passed validation, not the metric", () => {
    // "Certified metric" claims an individual review nobody performed.
    const msg = describeCertification("certified");
    expect(msg).toContain("model");
    expect(msg).not.toMatch(/^Certified$/);
  });

  it("warns loudly on a deprecated model", () => {
    expect(describeCertification("deprecated")).toContain("DEPRECATED");
  });

  it("calls a draft a draft", () => {
    expect(describeCertification("draft")).toContain("not yet validated");
  });
});

describe("freshness of the data behind a metric", () => {
  const tables = [{ name: "orders", data_loaded_at: "2026-08-14T00:00:00.000Z" }];

  it("reads the underlying table's load time", () => {
    expect(dataFreshness("sales_model", [model()], tables)).toBe("2026-08-14T00:00:00.000Z");
  });

  it("matches the table name case-insensitively", () => {
    const m = model({ source_table: "ORDERS" });
    expect(dataFreshness("sales_model", [m], tables)).toBe("2026-08-14T00:00:00.000Z");
  });

  it("returns null for a warehouse model rather than guessing", () => {
    // The warehouse's table is refreshed by the warehouse; we do not know when.
    const m = model({ source_kind: "warehouse" });
    expect(dataFreshness("sales_model", [m], tables)).toBeNull();
  });

  it("returns null when the table is not among the ones we can see", () => {
    expect(dataFreshness("sales_model", [model()], [])).toBeNull();
  });

  it("renders null as nothing — the caller must not print 'never'", () => {
    // "Never updated" and "we don't know" look identical on screen and mean
    // opposite things to someone deciding whether to trust a number.
    expect(describeFreshness(null, Date.now())).toBeNull();
  });

  it("renders an age a person reads", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    expect(describeFreshness("2026-08-14T11:30:00.000Z", now)).toBe("30 min ago");
    expect(describeFreshness("2026-08-14T06:00:00.000Z", now)).toBe("6h ago");
    expect(describeFreshness("2026-08-11T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("refuses a future timestamp rather than printing a negative age", () => {
    const now = Date.parse("2026-08-14T12:00:00.000Z");
    expect(describeFreshness("2026-09-01T00:00:00.000Z", now)).toBeNull();
  });
});

describe("the catalog header", () => {
  it("counts metrics by status and distinct models", () => {
    const s = catalogSummary([
      metric({ status: "certified" }),
      metric({ name: "b", status: "draft" }),
      metric({ name: "c", status: "deprecated", model: "other" }),
    ]);
    expect(s).toEqual({ total: 3, certified: 1, draft: 1, deprecated: 1, models: 2 });
  });

  it("handles an empty layer", () => {
    expect(catalogSummary([])).toEqual({
      total: 0,
      certified: 0,
      draft: 0,
      deprecated: 0,
      models: 0,
    });
  });
});

// ── Adversarial pass, module 11 ─────────────────────────────────────────────

describe("the qualified name the catalog itself publishes is searchable", () => {
  // MEASURED IN THE UI. Every card prints `saas_sales_model.total_sales` as the
  // metric's identifier, and typing that exact string returned nothing — then
  // the empty state said "a metric with no match here genuinely has none of
  // these words", which was false about the one name the page had just shown.
  const m = metric({ model: "saas_sales_model", name: "total_sales", label: "Total Sales" });

  it("matches the model.name form", () => {
    expect(matchesQuery(m, "saas_sales_model.total_sales")).toBe(true);
  });

  it("still matches each half on its own", () => {
    // The old behaviour, which was never wrong — only incomplete.
    expect(matchesQuery(m, "saas_sales_model")).toBe(true);
    expect(matchesQuery(m, "total_sales")).toBe(true);
  });

  it("matches a partial qualified name, the way a paste often arrives", () => {
    expect(matchesQuery(m, "saas_sales_model.")).toBe(true);
    expect(matchesQuery(m, ".total_sales")).toBe(true);
    expect(matchesQuery(m, "model.total")).toBe(true);
  });

  it("does not match a qualified name from a different model", () => {
    // The point is to find THIS metric, not to make every dotted string match.
    expect(matchesQuery(m, "hr_roster_model.total_sales")).toBe(false);
  });

  it("is the same string the card renders", () => {
    expect(qualifiedName(m)).toBe("saas_sales_model.total_sales");
  });
});

describe("a cut-short scan is not a clean one", () => {
  // PostgREST caps a response at 1000 rows silently (lib/pagedSelect). The
  // truncation only ever REMOVES references, so it always pushes toward "no
  // widget uses this" — the one direction that gets a metric deprecated, which
  // this file's own header names as the expensive mistake.
  const none = { dashboards: [], total: 0 };
  const some = { dashboards: [{ id: "d1", name: "Sales", widgets: ["Revenue"] }], total: 1 };

  it("refuses to report a clean absence when the scan was truncated", () => {
    const s = describeUsage(none, true);
    expect(s).toMatch(/cut short/i);
    expect(s).toMatch(/unknown/i);
  });

  it("reports a real absence plainly when the scan was complete", () => {
    const s = describeUsage(none, false);
    expect(s).toMatch(/No dashboard widget references it/);
    expect(s).not.toMatch(/cut short/i);
  });

  it("keeps a truncated positive result, but as a floor", () => {
    // A partial scan can still PROVE use; it just cannot prove the count.
    const s = describeUsage(some, true);
    expect(s).toMatch(/1 widget across 1 dashboard/);
    expect(s).toMatch(/there may be more/i);
  });

  it("defaults to the complete-scan wording, so callers cannot forget", () => {
    expect(describeUsage(none)).toBe(describeUsage(none, false));
  });
});
