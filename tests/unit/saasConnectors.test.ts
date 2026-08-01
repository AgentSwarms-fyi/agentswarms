// Stripe and Shopify: the flattening and the cursor handling.
//
// These are the two things that decide whether a synced dataset is usable and
// complete, and both fail SILENTLY when wrong — a nested object becomes one
// "[object Object]" column, and a mishandled cursor stops early or loops for
// ever. Neither needs a network to test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { flattenRecord, isoifyTimestamps, unixToIso } from "@/utils/saas/flatten";
import { normaliseInstanceUrl } from "@/utils/saas/salesforce.server";
import { normaliseShopDomain, nextPageUrl } from "@/utils/saas/shopify.server";
import { connectorFor } from "@/utils/saas/sync.server";
import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";

describe("flattenRecord", () => {
  it("flattens a nested object into usable columns", () => {
    // The whole point: without this, `billing` is one "[object Object]" column.
    expect(flattenRecord({ id: "ch_1", billing: { address: { country: "GB" } } })).toEqual({
      id: "ch_1",
      billing_address_country: "GB",
    });
  });

  it("joins with underscores, not dots", () => {
    // `customer.email` reads as a table qualifier in SQL and needs quoting in
    // every dialect.
    const out = flattenRecord({ customer: { email: "a@b.c" } });
    expect(Object.keys(out)).toEqual(["customer_email"]);
  });

  it("stores an array as JSON plus a count, not as exploded columns", () => {
    // Exploding line_items_0_*, line_items_1_* makes the column set depend on
    // the widest row in the sample, so two syncs of one source can disagree
    // about the schema.
    const out = flattenRecord({ line_items: [{ sku: "a" }, { sku: "b" }] });
    expect(out.line_items_count).toBe(2);
    expect(JSON.parse(String(out.line_items))).toHaveLength(2);
    expect(Object.keys(out)).toEqual(["line_items", "line_items_count"]);
  });

  it("preserves null rather than stringifying it", () => {
    // "null" in a numeric column would make the whole column infer as text.
    expect(flattenRecord({ amount: null }).amount).toBeNull();
  });

  it("keeps false and 0, which a truthiness check would lose", () => {
    const out = flattenRecord({ paid: false, amount: 0 });
    expect(out.paid).toBe(false);
    expect(out.amount).toBe(0);
  });

  it("stores an object deeper than the cap as JSON instead of dropping it", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const out = flattenRecord(deep, { maxDepth: 2 });
    // Something is recorded for the branch — losing data silently is worse
    // than an awkward column.
    expect(Object.keys(out).length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).toContain("1");
  });

  it("keeps an empty object as a column rather than letting it vanish", () => {
    // Otherwise the column exists only for rows where it happens to be filled.
    expect(flattenRecord({ metadata: {} }).metadata).toBe("{}");
  });

  it("stops at the key cap instead of producing an unusable dataset", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) wide[`k${i}`] = i;
    expect(Object.keys(flattenRecord(wide, { maxKeys: 50 })).length).toBeLessThanOrEqual(50);
  });
});

describe("unixToIso", () => {
  it("converts Stripe's seconds to ISO", () => {
    expect(unixToIso(1785600167)).toBe("2026-08-01T16:02:47.000Z");
  });

  it("refuses anything that is not a finite number", () => {
    // A null result means "leave the original alone" to the caller.
    expect(unixToIso(null)).toBeNull();
    expect(unixToIso("1785600167")).toBeNull();
    expect(unixToIso(Number.NaN)).toBeNull();
  });
});

describe("isoifyTimestamps", () => {
  it("converts only the declared fields", () => {
    // Declared, not guessed: a name-based rule converts `trial_end` correctly
    // and `quantity` disastrously.
    const out = isoifyTimestamps({ created: 1785600167, quantity: 1785600167 }, ["created"]);
    expect(out.created).toBe("2026-08-01T16:02:47.000Z");
    expect(out.quantity).toBe(1785600167);
  });

  it("leaves a declared field alone when it is not a usable timestamp", () => {
    // Stripe returns null for e.g. canceled_at on a live subscription.
    expect(isoifyTimestamps({ canceled_at: null }, ["canceled_at"]).canceled_at).toBeNull();
  });

  it("does not invent a field that was absent", () => {
    expect("ended_at" in isoifyTimestamps({ id: "x" }, ["ended_at"])).toBe(false);
  });
});

describe("Shopify cursor handling", () => {
  it("takes the next URL verbatim from the Link header", () => {
    // The page_info token must go back unchanged; rebuilding the URL from
    // parts drops parameters Shopify expects to see returned.
    const link =
      '<https://x.myshopify.com/admin/api/2024-10/orders.json?limit=250&page_info=abc123>; rel="next"';
    expect(nextPageUrl(link)).toBe(
      "https://x.myshopify.com/admin/api/2024-10/orders.json?limit=250&page_info=abc123",
    );
  });

  it("picks next when previous is listed first", () => {
    const link = '<https://x/prev>; rel="previous", <https://x/next>; rel="next"';
    expect(nextPageUrl(link)).toBe("https://x/next");
  });

  it("returns null on the last page, which has only a previous link", () => {
    // Getting this wrong loops for ever on the final page.
    expect(nextPageUrl('<https://x/prev>; rel="previous"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl("")).toBeNull();
  });
});

describe("normaliseShopDomain", () => {
  it("accepts the bare domain", () => {
    expect(normaliseShopDomain("acme.myshopify.com")).toBe("acme.myshopify.com");
  });

  it("strips the scheme and path people paste from the admin bar", () => {
    expect(normaliseShopDomain("https://acme.myshopify.com/admin/products")).toBe(
      "acme.myshopify.com",
    );
  });

  it("expands a bare shop name", () => {
    expect(normaliseShopDomain("acme")).toBe("acme.myshopify.com");
  });

  it("is case-insensitive, since domains are", () => {
    expect(normaliseShopDomain("ACME.myshopify.com")).toBe("acme.myshopify.com");
  });

  it("rejects a non-Shopify domain rather than producing a 404 later", () => {
    expect(() => normaliseShopDomain("acme.example.com")).toThrow(/myshopify/i);
    expect(() => normaliseShopDomain("")).toThrow();
  });
});

describe("normaliseInstanceUrl", () => {
  it("keeps a My Domain origin", () => {
    expect(normaliseInstanceUrl("https://acme.my.salesforce.com")).toBe(
      "https://acme.my.salesforce.com",
    );
  });

  it("adds the scheme people omit", () => {
    expect(normaliseInstanceUrl("acme.my.salesforce.com")).toBe("https://acme.my.salesforce.com");
  });

  it("strips the path pasted from the address bar", () => {
    // A path here would be carried into every API call.
    expect(normaliseInstanceUrl("https://acme.my.salesforce.com/lightning/o/Account/list")).toBe(
      "https://acme.my.salesforce.com",
    );
  });

  it("accepts force.com, which sandboxes and communities use", () => {
    expect(normaliseInstanceUrl("https://acme--dev.sandbox.my.salesforce.com")).toContain(
      "salesforce.com",
    );
    expect(normaliseInstanceUrl("https://acme.force.com")).toBe("https://acme.force.com");
  });

  it("rejects a non-Salesforce host rather than failing later with a 404", () => {
    expect(() => normaliseInstanceUrl("https://acme.example.com")).toThrow(/Salesforce domain/i);
    expect(() => normaliseInstanceUrl("")).toThrow();
  });
});

describe("the connector registry covers every provider", () => {
  it("has a connector and a label for each", () => {
    for (const p of SAAS_PROVIDERS) {
      expect(() => connectorFor(p), `${p} has no connector`).not.toThrow();
      expect(SAAS_LABELS[p]?.length, `${p} has no label`).toBeGreaterThan(0);
    }
  });

  it("includes every source shipped so far", () => {
    for (const p of ["google_sheets", "stripe", "shopify", "hubspot", "salesforce"]) {
      expect(SAAS_PROVIDERS).toContain(p);
    }
  });
});

describe("the CRM connectors avoid their respective foot-guns", () => {
  const sfSrc = readFileSync("src/utils/saas/salesforce.server.ts", "utf8");
  const hsSrc = readFileSync("src/utils/saas/hubspot.server.ts", "utf8");

  it("Salesforce excludes compound and binary fields from the SELECT", () => {
    // address/location are aggregates of other queryable fields and base64 is
    // a document body. ONE of them in the field list makes the entire query
    // fail with MALFORMED_QUERY — so a whole object silently yields nothing.
    for (const t of ["address", "location", "base64"]) {
      expect(sfSrc, `${t} must be filtered out of the SOQL field list`).toContain(`"${t}"`);
    }
  });

  it("Salesforce uses the instance_url the token response returns", () => {
    // Sandboxes and My Domain redirects hand back a different host from the
    // one used to log in; using the configured one breaks those.
    expect(sfSrc).toContain("body.instance_url");
  });

  it("Salesforce drops the per-record attributes envelope", () => {
    // It is metadata about the response, not data — two useless columns on
    // every dataset otherwise.
    expect(sfSrc).toMatch(/attributes: _drop|attributes:\s*_/);
  });

  it("HubSpot requests properties explicitly", () => {
    // Without naming them, HubSpot returns a handful of defaults — a dataset
    // with four columns from a CRM holding two hundred, looking like it worked.
    expect(hsSrc).toContain('params.set("properties"');
    expect(hsSrc).toContain("/crm/v3/properties/");
  });

  it("HubSpot keeps the record id alongside its properties", () => {
    // The id sits BESIDE `properties`, not inside it, and is the only stable
    // join key.
    expect(hsSrc).toMatch(/id: r\.id/);
  });
});
