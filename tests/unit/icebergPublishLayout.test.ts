// Publishing to Iceberg as a chosen format and partition spec, upserting by
// key, the attach that honours "read with the lakehouse's own credentials",
// and the names catalogs really use (R457).
import { describe, expect, it } from "vitest";

import {
  ICEBERG_NAMESPACE,
  ICEBERG_TABLE,
  defaultIcebergCatalog,
  duplicateKeysSql,
  icebergAttachSql,
  icebergLayoutError,
  icebergLayoutSql,
  icebergMergeSql,
  icebergPublishSql,
  keyable,
  upsertKeyError,
  v3OnlyColumns,
} from "@/utils/lakehouse/iceberg";

const columns = [
  { name: "id", type: "BIGINT" },
  { name: "ts", type: "TIMESTAMP" },
  { name: "region", type: "VARCHAR" },
  { name: "amount", type: "DOUBLE" },
];

describe("names catalogs use", () => {
  it("takes a hyphen in a namespace or a table, and refuses a dot and anything to inject", () => {
    expect(ICEBERG_NAMESPACE.test("sales-prod")).toBe(true);
    expect(ICEBERG_TABLE.test("daily-metrics")).toBe(true);
    // A nested namespace: the engine on DuckDB 1.5 cannot list it (see iceberg.ts).
    expect(ICEBERG_NAMESPACE.test("finance.eu")).toBe(false);
    expect(ICEBERG_NAMESPACE.test('x"; DROP')).toBe(false);
    expect(ICEBERG_NAMESPACE.test("-leading")).toBe(false);
  });
});

describe("the attach", () => {
  const cfg = {
    ...defaultIcebergCatalog(),
    name: "rig",
    endpoint: "http://catalog:8181",
    warehouse: "",
  };
  it("asks for vended credentials only when the catalog is to vend them", () => {
    expect(icebergAttachSql("ice_x", { ...cfg, storage: "vended" })).not.toContain(
      "ACCESS_DELEGATION_MODE",
    );
    expect(icebergAttachSql("ice_x", { ...cfg, storage: "lakehouse" })).toContain(
      "ACCESS_DELEGATION_MODE 'none'",
    );
  });
});

describe("a publish layout", () => {
  it("puts the partition spec before the format version, the only order the engine parses", () => {
    expect(
      icebergLayoutSql({
        formatVersion: 3,
        partition: [
          { column: "ts", transform: "month" },
          { column: "id", transform: "bucket", width: 8 },
          { column: "region", transform: "truncate", width: 2 },
        ],
      }),
    ).toBe(
      ` PARTITIONED BY (month("ts"), bucket(8, "id"), truncate(2, "region")) WITH ('format-version' = 3)`,
    );
    expect(icebergLayoutSql({ formatVersion: 2, partition: [] })).toBe(
      " WITH ('format-version' = 2)",
    );
    expect(icebergLayoutSql(undefined)).toBe("");
  });

  it("refuses what the catalog would answer with a bare HTTP 500, in words", () => {
    const withVariant = [...columns, { name: "payload", type: "VARIANT" }];
    expect(v3OnlyColumns(withVariant)).toEqual(["payload"]);
    expect(icebergLayoutError({ formatVersion: 2, partition: [] }, withVariant)).toBe(
      "payload is a type only Iceberg format v3 holds; publish as v3.",
    );
    expect(icebergLayoutError({ formatVersion: 3, partition: [] }, withVariant)).toBeNull();
  });

  it("checks each transform against its column", () => {
    const err = (key: Parameters<typeof icebergLayoutError>[0]["partition"][number]) =>
      icebergLayoutError({ formatVersion: 2, partition: [key] }, columns);
    expect(err({ column: "region", transform: "day" })).toContain("needs a date or a timestamp");
    expect(err({ column: "amount", transform: "bucket", width: 4 })).toContain(
      "cannot hash double",
    );
    expect(err({ column: "amount", transform: "truncate", width: 4 })).toContain("takes text");
    expect(err({ column: "id", transform: "bucket" })).toContain("bucket count");
    expect(err({ column: "nope", transform: "identity" })).toContain('no column "nope"');
    expect(err({ column: "ts", transform: "hour" })).toBeNull();
  });

  it("writes the table as the layout says, staged and swapped on a replace", () => {
    const layout = {
      formatVersion: 3 as const,
      partition: [{ column: "ts", transform: "day" as const }],
    };
    const plan = icebergPublishSql({
      alias: "ice_x",
      namespace: "pub",
      table: "orders",
      sourceSchema: "analytics",
      sourceTable: "orders",
      mode: "replace",
      columns,
      staging: "orders__publishing_ab",
      retired: "orders__replaced_ab",
      layout,
    });
    expect(plan[1]).toBe(
      `CREATE TABLE "ice_x"."pub"."orders__publishing_ab" ("id" BIGINT, "ts" TIMESTAMP, "region" VARCHAR, "amount" DOUBLE) PARTITIONED BY (day("ts")) WITH ('format-version' = 3);`,
    );
  });
});

describe("an upsert", () => {
  it("is one MERGE in one transaction, matching keys null-safely", () => {
    const sql = icebergMergeSql({
      alias: "ice_x",
      namespace: "pub",
      table: "orders",
      sourceSchema: "analytics",
      sourceTable: "orders",
      columns,
      keys: ["id"],
    });
    expect(sql.startsWith("BEGIN TRANSACTION; MERGE INTO")).toBe(true);
    expect(sql).toContain(`ON t."id" IS NOT DISTINCT FROM s."id"`);
    expect(sql).toContain(`UPDATE SET "ts" = s."ts", "region" = s."region", "amount" = s."amount"`);
    expect(sql).not.toContain(`"id" = s."id",`);
    expect(sql.endsWith("COMMIT;")).toBe(true);
  });

  it("with every column a key, only inserts what is new", () => {
    const sql = icebergMergeSql({
      alias: "a",
      namespace: "n",
      table: "t",
      sourceSchema: "s",
      sourceTable: "t",
      columns: [{ name: "k", type: "INT" }],
      keys: ["k"],
    });
    expect(sql).not.toContain("WHEN MATCHED");
    expect(sql).toContain("WHEN NOT MATCHED THEN INSERT");
  });

  it("counts source keys that appear twice, which would make the merge ambiguous", () => {
    expect(duplicateKeysSql("analytics", "orders", ["id", "region"])).toBe(
      `SELECT count(*)::BIGINT FROM (SELECT "id", "region" FROM "lake"."analytics"."orders" GROUP BY ALL HAVING count(*) > 1)`,
    );
  });

  // The dialog offered a VARIANT column as a key until the UI showed it.
  it("takes plain values as keys, never a document, a nested value or a geometry", () => {
    const cols = [
      ...columns,
      { name: "payload", type: "VARIANT" },
      { name: "attrs", type: "STRUCT(a INTEGER)" },
      { name: "tags", type: "VARCHAR[]" },
      { name: "props", type: "MAP(VARCHAR, VARCHAR)" },
      { name: "doc", type: "JSON" },
      { name: "shape", type: "GEOMETRY" },
    ];
    for (const t of [
      "BIGINT",
      "VARCHAR",
      "DATE",
      "TIMESTAMP WITH TIME ZONE",
      "DECIMAL(12,2)",
      "UUID",
    ]) {
      expect(keyable(t), t).toBe(true);
    }
    for (const name of ["payload", "attrs", "tags", "props", "doc", "shape"]) {
      expect(upsertKeyError(["id", name], cols), name).toMatch(/cannot be a key/);
    }
    expect(upsertKeyError(["id", "region"], cols)).toBeNull();
    expect(upsertKeyError([], cols)).toMatch(/at least one key/);
    expect(upsertKeyError(["nope"], cols)).toMatch(/not a column/);
  });
});
