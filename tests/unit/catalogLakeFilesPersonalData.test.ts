// Lake files in the catalog are checked for personal data from their values,
// not their column names alone (R555).
//
// The object store is faked at its two edges (the listing and the reads); the
// grouping, the CSV inference and the classifier are the real ones. What is
// held: a CSV or JSON file is judged from the sample the crawl already reads;
// a Parquet file from the first rows of its text columns, and its other
// columns by name; the values are never stored; an unchanged file keeps the
// verdict its values gave rather than being judged by name again; a file
// crawled before this was read once more; a format whose values are not read
// is not re-read for it.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  objects: [] as Array<{ key: string; size: number; last_modified: string }>,
  csv: "",
  sampled: [] as string[],
  described: [] as string[],
  textRead: [] as Array<{ key: string; columns: string[] }>,
  parquetColumns: [] as Array<{ name: string; type: string }>,
  parquetText: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/catalog/objectStore.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/catalog/objectStore.server")>()),
  listObjectsCapped: async () => ({ objects: h.objects, capped: false }),
  sampleObject: async (_cfg: unknown, key: string) => {
    h.sampled.push(key);
    return Buffer.from(h.csv, "utf8");
  },
}));
vi.mock("@/utils/catalog/objectStoreRead.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/catalog/objectStoreRead.server")>()),
  describeObject: async (_cfg: unknown, key: string) => {
    h.described.push(key);
    return h.parquetColumns;
  },
  sampleTextColumns: async (_cfg: unknown, key: string, columns: { name: string }[]) => {
    h.textRead.push({ key, columns: columns.map((c) => c.name) });
    return h.parquetText;
  },
  countObjectRows: async () => 20,
  countParquetRows: async () => null,
}));

const { crawlObjectStorage } = await import("@/utils/catalog/crawler.server");
const { isTextType, TEXT_SAMPLE_COLUMNS, TEXT_SAMPLE_ROWS } =
  await import("@/utils/catalog/objectStoreRead.server");

const CFG = { provider: "minio", bucket: "lake" } as never;
const OLD = "2026-11-01T00:00:00.000Z";
const SINCE = "2026-11-20T00:00:00.000Z";

const csvRows = Array.from(
  { length: 20 },
  (_, i) => `${i},person${i}@example.com,${7000 + i},${["Ada", "Alan"][i % 2]},EU`,
);
const CSV = ["id,contact,email_campaign_id,first_name,region", ...csvRows].join("\n") + "\n";

const col = (asset: { columns: Array<Record<string, unknown>> }, name: string) =>
  asset.columns.find((c) => c.name === name)!;

beforeEach(() => {
  h.sampled = [];
  h.described = [];
  h.textRead = [];
  h.csv = CSV;
  h.objects = [{ key: "crm/contacts.csv", size: 2048, last_modified: OLD }];
  h.parquetColumns = [
    { name: "user_contact", type: "VARCHAR" },
    { name: "amount", type: "DOUBLE" },
    { name: "email", type: "BIGINT" },
  ];
  h.parquetText = Array.from({ length: 30 }, (_, i) => ({ user_contact: `u${i}@example.com` }));
});

describe("a CSV file", () => {
  it("is judged from the sample the crawl reads, which is not stored", async () => {
    const { assets } = await crawlObjectStorage(CFG);
    const a = assets.find((x) => x.fqn.includes("crm"))!;
    // A column named for nothing personal, full of addresses.
    expect(col(a, "contact")).toMatchObject({
      pii: true,
      pii_kind: "email",
      pii_evidence: "20 of 20 values are email addresses.",
      pii_from_values: true,
    });
    // Named for email, holding numbers: the values say no, and that is kept.
    expect(col(a, "email_campaign_id").pii).toBeUndefined();
    expect(col(a, "email_campaign_id").pii_from_values).toBe(true);
    // Values cannot show a person's name: the name stands.
    expect(col(a, "first_name")).toMatchObject({ pii: true, pii_kind: "person_name" });
    expect(a.pii).toBe(true);
    expect(a.metadata).toMatchObject({ pii_values_read: true });
    for (const c of a.columns) expect(c).not.toHaveProperty("values");
    expect(JSON.stringify(a)).not.toContain("person3@example.com");
  });

  it("keeps what its values showed when it is unchanged and not read again", async () => {
    const first = (await crawlObjectStorage(CFG)).assets[0];
    h.sampled = [];
    const prior = new Map([
      [
        first.fqn,
        {
          columns: first.columns,
          row_count: first.row_count,
          row_count_estimated: false,
          pii_values_read: true,
        },
      ],
    ]);
    const again = (await crawlObjectStorage(CFG, prior, SINCE)).assets[0];
    expect(h.sampled).toEqual([]);
    expect(col(again, "contact")).toMatchObject({ pii: true, pii_kind: "email" });
    // Not flagged by its name again.
    expect(col(again, "email_campaign_id").pii).toBeUndefined();
    expect(again.metadata).toMatchObject({ pii_values_read: true });
  });

  it("is read once more when the last crawl judged it by names alone", async () => {
    const byName = [
      { name: "contact", type: "string" },
      { name: "email_campaign_id", type: "number", pii: true, pii_kind: "email" },
    ];
    const prior = new Map([["crm/*.csv", { columns: byName, row_count: 20 } as never]]);
    const fqn = (await crawlObjectStorage(CFG)).assets[0].fqn;
    h.sampled = [];
    const again = (await crawlObjectStorage(CFG, new Map([[fqn, prior.get("crm/*.csv")!]]), SINCE))
      .assets[0];
    expect(h.sampled).toEqual(["crm/contacts.csv"]);
    expect(col(again, "contact").pii).toBe(true);
    expect(col(again, "email_campaign_id").pii).toBeUndefined();
    expect(again.metadata).toMatchObject({ pii_values_read: true });
  });
});

describe("a Parquet file", () => {
  beforeEach(() => {
    h.objects = [{ key: "events.parquet", size: 4096, last_modified: OLD }];
  });

  it("is judged from the first rows of its text columns, and the rest by name", async () => {
    const { assets } = await crawlObjectStorage(CFG);
    const a = assets[0];
    expect(h.textRead).toEqual([
      { key: "events.parquet", columns: ["user_contact", "amount", "email"] },
    ]);
    expect(col(a, "user_contact")).toMatchObject({
      pii: true,
      pii_kind: "email",
      pii_evidence: "30 of 30 values are email addresses.",
      pii_from_values: true,
    });
    // Not read (not text): its name decides, and says so.
    expect(col(a, "email")).toMatchObject({
      pii: true,
      pii_evidence: "Its name suggests email addresses.",
    });
    expect(col(a, "email").pii_from_values).toBeUndefined();
    expect(col(a, "amount").pii).toBeUndefined();
    expect(a.metadata).toMatchObject({ pii_values_read: true });
  });

  it("counts as read even when it has no text to read", async () => {
    h.parquetText = [];
    const a = (await crawlObjectStorage(CFG)).assets[0];
    expect(a.metadata).toMatchObject({ pii_values_read: true });
    expect(col(a, "user_contact").pii).toBeUndefined();
  });

  it("reads only text columns, a bounded few, and the first rows", () => {
    expect(["VARCHAR", "varchar", "TEXT", "STRING"].every(isTextType)).toBe(true);
    expect(isTextType("VARCHAR(255)")).toBe(true);
    // A list or struct of text holds arrays and objects the check skips.
    expect(
      ["BIGINT", "DOUBLE", "DATE", "VARCHAR[]", "STRUCT(a VARCHAR)", "BLOB"].some(isTextType),
    ).toBe(false);
    expect(TEXT_SAMPLE_ROWS).toBe(200);
    expect(TEXT_SAMPLE_COLUMNS).toBe(40);
    const src = readFileSync("src/utils/catalog/objectStoreRead.server.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function sampleTextColumns"));
    expect(fn).toContain(".filter((c) => isTextType(c.type)).slice(0, TEXT_SAMPLE_COLUMNS)");
    expect(fn).toContain('`"${c.name.replace(/"/g, \'""\')}"`');
    expect(fn).toContain(
      "`SELECT ${cols} FROM read_parquet(${lit(objectUrl(cfg, key))}) LIMIT ${TEXT_SAMPLE_ROWS}`",
    );
  });
});

describe("where the crawl remembers it", () => {
  it("reads the marker back from what the last crawl stored", () => {
    const src = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");
    expect(src).toContain("pii_values_read: parseAssetMetadata(e.metadata).pii_values_read,");
  });
});

describe("a format whose values are not read", () => {
  it("is not read again for it", async () => {
    h.objects = [{ key: "logs/a.orc", size: 4096, last_modified: OLD }];
    const first = (await crawlObjectStorage(CFG)).assets[0];
    h.described = [];
    const prior = new Map([[first.fqn, { columns: first.columns, row_count: 20 } as never]]);
    await crawlObjectStorage(CFG, prior, SINCE);
    expect(h.described).toEqual([]);
    expect(h.textRead).toEqual([]);
  });
});
