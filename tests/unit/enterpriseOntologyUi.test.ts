// What the Enterprise Ontology screens offer and how they label it, found
// wanting in the first live UI round and pinned here:
//   - Metrics offered "Order → Shipment → Order", a step straight back over
//     the link just taken, which only reaches the properties already listed.
//   - Ask suggested "Orders by Customer email": an e-mail (a confidential,
//     pattern-checked identifier) is not something anyone groups by.
//   - Monthly metrics were labelled 2024-01-01 instead of Jan 2024.
//   - Keys were printed as quantities: Order 1,063.
import { describe, expect, it } from "vitest";

import { suggestQuestions } from "@/components/ontology/AskTab";
import { groupOptions } from "@/components/ontology/MetricsTab";
import { formatPeriod, formatValue, looksLikeIdentifier } from "@/components/ontology/theme";
import { sampleSpec } from "@/lib/ontology/sample";

const spec = sampleSpec("ontology_sample");

describe("metric groupings", () => {
  it("never walks straight back over the link it came by", () => {
    const vias = new Set(groupOptions(spec, "Order").map((o) => o.via));
    expect(vias).toContain("Order → Customer");
    expect(vias).toContain("Order → Shipment");
    expect(vias).not.toContain("Order → Shipment → Order");
    expect([...vias].some((v) => /^Order → (\w+) → Order$/.test(v))).toBe(false);
  });

  it("still offers two steps out when the second step goes somewhere new", () => {
    const vias = new Set(groupOptions(spec, "OrderLine").map((o) => o.via));
    expect(vias).toContain("OrderLine → Order → Customer");
    expect(vias).toContain("OrderLine → Product → Supplier");
  });
});

describe("suggested questions", () => {
  it("group by a category people compare, never an e-mail or a coded format", () => {
    const qs = suggestQuestions(spec);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.some((q) => /email/i.test(q))).toBe(false);
    expect(qs.some((q) => /country/i.test(q))).toBe(false);
    expect(qs.some((q) => /segment/i.test(q))).toBe(true);
  });
});

describe("period labels", () => {
  it("names a period the way people do", () => {
    expect(formatPeriod("2024-01-01", "month")).toBe("Jan 2024");
    expect(formatPeriod("2025-07-01", "quarter")).toBe("Q3 2025");
    expect(formatPeriod("2025-01-01", "year")).toBe("2025");
    expect(formatPeriod("2024-03-04", "day")).toBe("4 Mar 2024");
    expect(formatPeriod("2024-03-04", "week")).toBe("Week of 4 Mar 2024");
    // A timestamp and a missing value.
    expect(formatPeriod("2024-12-01 00:00:00", "month")).toBe("Dec 2024");
    expect(formatPeriod(null, "month")).toBe("—");
    expect(formatPeriod("not a date", "month")).toBe("not a date");
  });
});

describe("keys print as labels, not quantities", () => {
  it("knows an identifier column by its name", () => {
    for (const n of ["id", "order_id", "customer_ID", "line_no", "sku_code", "order_number"])
      expect(looksLikeIdentifier(n), n).toBe(true);
    for (const n of ["quantity", "total_amount", "idle_minutes", "valid"])
      expect(looksLikeIdentifier(n), n).toBe(false);
  });

  it("prints a plain number without grouping, and a quantity with it", () => {
    expect(formatValue(1063, { plain: true })).toBe("1063");
    expect(formatValue(51063)).toMatch(/^51.063$/);
    expect(formatValue(null, { plain: true })).toBe("—");
  });
});
