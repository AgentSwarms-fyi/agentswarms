// The catalog's crawl classifies the tables it profiles from their sampled
// values, not their names alone (R521).
import { describe, expect, it, vi } from "vitest";

const sample = vi.hoisted(() => ({
  rows: Array.from({ length: 20 }, (_, i) => ({
    contact: `person${i}@example.com`,
    email_campaign_id: 7000 + i,
    first_name: ["Ada", "Alan"][i % 2],
    phone: String(4155550100 + i),
    region: "EU",
  })),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/warehouse/drivers.server", () => ({
  listWarehouseTables: async () => [
    {
      schema: "crm",
      name: "customers",
      columns: ["contact", "email_campaign_id", "first_name", "phone", "region"].map((name) => ({
        name,
        type: "text",
      })),
    },
    {
      schema: "crm",
      name: "unprofiled",
      columns: [{ name: "email", type: "text" }],
    },
  ],
  // The preview read returns the sample for the first table only; the row
  // estimate and the second table's preview return nothing.
  executeWarehouseQuery: async (_c: unknown, sql: string) => ({
    rows: /customers/.test(sql) && /limit/i.test(sql) ? sample.rows : [],
  }),
}));

const { crawlWarehouse } = await import("@/utils/catalog/crawler.server");

describe("a profiled table is classified from its values", () => {
  it("finds what values show, drops what they contradict, keeps what they cannot show", async () => {
    const { assets } = await crawlWarehouse({ provider: "postgres" } as never);
    const customers = assets.find((a) => a.name === "customers")!;
    const col = (n: string) => customers.columns.find((c) => c.name === n)!;

    // A column named for nothing personal, full of addresses.
    expect(col("contact")).toMatchObject({
      pii: true,
      pii_kind: "email",
      pii_evidence: "20 of 20 values are email addresses.",
    });
    // Named for email, holding numbers: the name was wrong.
    expect(col("email_campaign_id").pii).toBeUndefined();
    expect(col("email_campaign_id").pii_kind).toBeUndefined();
    // Values cannot show a person's name or a bare-digit phone number; the name stands.
    expect(col("first_name")).toMatchObject({ pii: true, pii_kind: "person_name" });
    expect(col("phone")).toMatchObject({ pii: true, pii_kind: "phone" });
    expect(col("region").pii).toBeUndefined();
    expect(customers.pii).toBe(true);
    // The profile is still taken.
    expect(col("contact").distinct_count).toBe(20);
  });

  it("a table the crawl did not profile is classified by name, and says so", async () => {
    const { assets } = await crawlWarehouse({ provider: "postgres" } as never);
    const t = assets.find((a) => a.name === "unprofiled")!;
    expect(t.columns[0]).toMatchObject({
      pii: true,
      pii_kind: "email",
      pii_evidence: "Its name suggests email addresses.",
    });
    expect(t.pii).toBe(true);
  });
});
