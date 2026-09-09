// Layout optimisation: clustered rewrites in key order, the per-file
// statistics that say what a lookup opens, and the advisor over both.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  adviseLayout,
  bucketCount,
  columnLayout,
  cutsStatement,
  filteredColumns,
  formatBytes,
  keyLiteral,
  rangeValue,
  rewriteStatements,
  type FileRange,
} from "@/utils/lakehouse/layout";

const rd = (p: string) => readFileSync(p, "utf8");

const range = (id: number, min: string | null, max: string | null, nulls = 0): FileRange => ({
  file_id: id,
  rows: 100,
  bytes: 1000,
  min,
  max,
  nulls,
});

describe("what a lookup opens", () => {
  it("files spanning the whole domain are all opened; disjoint ranges open one", () => {
    const whole = columnLayout("k", "INTEGER", [
      range(1, "0", "1000"),
      range(2, "0", "1000"),
      range(3, "0", "1000"),
      range(4, "0", "1000"),
    ]);
    expect(whole.touched).toBe(4);
    expect(whole.skip).toBe(0);
    const ranged = columnLayout("k", "INTEGER", [
      range(1, "0", "252"),
      range(2, "253", "502"),
      range(3, "503", "751"),
      range(4, "752", "1000"),
    ]);
    expect(ranged.touched).toBe(1);
    expect(ranged.skip).toBe(1);
  });

  it("compares in the column's own type: 9 < 10 for numbers, and dates by time", () => {
    // As text "10" < "9"; as numbers the two files are disjoint.
    const num = columnLayout("k", "BIGINT", [range(1, "1", "9"), range(2, "10", "20")]);
    expect(num.touched).toBe(1);
    expect(rangeValue("10", "BIGINT")).toBe(10);
    expect(rangeValue("2024-02-01", "DATE")).toBe(Date.parse("2024-02-01"));
    const dates = columnLayout("d", "DATE", [
      range(1, "2024-01-01", "2024-01-31"),
      range(2, "2024-02-01", "2024-02-29"),
    ]);
    expect(dates.touched).toBe(1);
    // Strings stay strings.
    expect(rangeValue("abc", "VARCHAR")).toBe("abc");
  });

  it("a file without a range cannot be ruled out, and one file has no skip ratio", () => {
    const withNull = columnLayout("k", "INTEGER", [
      range(1, "0", "10"),
      range(2, "11", "20"),
      range(3, null, null, 100),
    ]);
    expect(withNull.touched).toBe(2.33);
    expect(withNull.nulls).toBe(100);
    expect(columnLayout("k", "INTEGER", [range(1, "0", "10")]).skip).toBeNull();
  });
});

describe("the rewrite", () => {
  it("is one transaction: each range copied aside in key order, deleted, and inserted back", () => {
    const stmts = rewriteStatements({
      schema: "analytics",
      table: "orders",
      keys: ["order_date", "customer"],
      keyType: "DATE",
      cuts: ["2024-04-01", "2024-07-01"],
    });
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[stmts.length - 1]).toBe("COMMIT");
    // Three ranges from two cuts, plus the null range: four triples.
    const creates = stmts.filter((s) => s.startsWith("CREATE OR REPLACE TEMP TABLE"));
    expect(creates).toHaveLength(4);
    expect(creates[0]).toContain(
      `WHERE "order_date" < '2024-04-01'::DATE ORDER BY "order_date", "customer"`,
    );
    expect(creates[1]).toContain(
      `WHERE "order_date" >= '2024-04-01'::DATE AND "order_date" < '2024-07-01'::DATE`,
    );
    expect(creates[2]).toContain(`WHERE "order_date" >= '2024-07-01'::DATE ORDER BY`);
    expect(creates[3]).toContain(`WHERE "order_date" IS NULL ORDER BY "customer"`);
    // Copy, delete, insert — in that order, for every range.
    const i = stmts.indexOf(creates[0]);
    expect(stmts[i + 1]).toBe(
      `DELETE FROM "analytics"."orders" WHERE "order_date" < '2024-04-01'::DATE`,
    );
    expect(stmts[i + 2]).toBe(
      `INSERT INTO "analytics"."orders" SELECT * FROM _agentswarms_cluster`,
    );
    expect(stmts).toContain("DROP TABLE IF EXISTS _agentswarms_cluster");
  });

  it("no cuts means one sorted range; repeated cuts collapse; numbers stay unquoted", () => {
    const one = rewriteStatements({
      schema: "a",
      table: "t",
      keys: ["k"],
      keyType: "INTEGER",
      cuts: [],
    });
    expect(one.filter((s) => s.startsWith("CREATE"))).toHaveLength(2);
    expect(one[1]).toContain(`WHERE "k" IS NOT NULL ORDER BY "k"`);
    const dup = rewriteStatements({
      schema: "a",
      table: "t",
      keys: ["k"],
      keyType: "INTEGER",
      cuts: ["5", "5", "9"],
    });
    expect(dup.filter((s) => s.startsWith("CREATE"))).toHaveLength(4);
    expect(dup[1]).toContain(`WHERE "k" < 5 ORDER BY`);
    expect(keyLiteral("42", "BIGINT")).toBe("42");
    expect(keyLiteral("it's", "VARCHAR")).toBe("'it''s'::VARCHAR");
    // A non-numeric value in a numeric column is still quoted and cast, never injected.
    expect(keyLiteral("1 OR 1=1", "INTEGER")).toBe("'1 OR 1=1'::INTEGER");
  });

  it("splits the first key at row-count quantiles, one range per target-sized file", () => {
    expect(bucketCount(0, 1000)).toBe(1);
    expect(bucketCount(1000, 0)).toBe(1);
    expect(bucketCount(500, 128 * 1024 * 1024)).toBe(1);
    expect(bucketCount(1_000_000, 300_000)).toBe(4);
    expect(cutsStatement("a", "t", "k", 4)).toBe(
      `SELECT unnest(quantile_disc("k", [0.250000, 0.500000, 0.750000])::VARCHAR[]) AS cut FROM "a"."t" WHERE "k" IS NOT NULL`,
    );
  });
});

describe("what queries filter on", () => {
  const cols = ["order_date", "customer", "status", "net_usd"];
  it("finds bare and qualified columns before a comparison, after the first WHERE/ON", () => {
    expect(
      filteredColumns(
        `SELECT * FROM analytics.orders o WHERE o.order_date >= '2024-01-01' AND status IN ('paid')`,
        "orders",
        cols,
      ),
    ).toEqual(["order_date", "status"]);
    expect(
      filteredColumns(
        `SELECT count(*) FROM "analytics"."orders" JOIN c ON c.id = orders.customer WHERE net_usd BETWEEN 1 AND 2`,
        "orders",
        cols,
      ),
    ).toEqual(["customer", "net_usd"]);
  });
  it("ignores statements over other tables, and columns only projected", () => {
    expect(filteredColumns(`SELECT * FROM payments WHERE status = 'x'`, "orders", cols)).toEqual(
      [],
    );
    expect(filteredColumns(`SELECT status, order_date FROM orders`, "orders", cols)).toEqual([]);
    // "reorders" is not "orders".
    expect(filteredColumns(`SELECT * FROM reorders WHERE status = 'x'`, "orders", cols)).toEqual(
      [],
    );
  });
});

describe("the advice", () => {
  const four = (min: string, max: string) => [
    range(1, min, max),
    range(2, min, max),
    range(3, min, max),
    range(4, min, max),
  ];
  it("recommends clustering by the column queries filter on when its files overlap", () => {
    const out = adviseLayout({
      files: 4,
      bytes: 4_000_000,
      targetBytes: 1_000_000,
      columns: [
        columnLayout("order_date", "DATE", four("2024-01-01", "2024-12-31")),
        columnLayout("status", "VARCHAR", four("a", "z")),
      ],
      filtered: { order_date: 12, status: 3 },
      cluster: [],
      filesSinceRewrite: 0,
      keepClustered: false,
    });
    expect(out[0].kind).toBe("cluster");
    expect(out[0].columns).toEqual(["order_date"]);
    expect(out[0].detail).toMatch(/12 queries this week/);
    expect(out[0].detail).toMatch(/opens 4 of 4 files/);
  });

  it("does not recommend a column nobody filters on, and says so when the layout is fine", () => {
    const fine = adviseLayout({
      files: 4,
      bytes: 4_000_000,
      targetBytes: 1_000_000,
      columns: [
        columnLayout("order_date", "DATE", [
          range(1, "2024-01-01", "2024-03-31"),
          range(2, "2024-04-01", "2024-06-30"),
          range(3, "2024-07-01", "2024-09-30"),
          range(4, "2024-10-01", "2024-12-31"),
        ]),
        columnLayout("status", "VARCHAR", four("a", "z")),
      ],
      filtered: { order_date: 5 },
      cluster: ["order_date"],
      filesSinceRewrite: 0,
      keepClustered: true,
    });
    expect(fine).toHaveLength(1);
    expect(fine[0].kind).toBe("ok");
    // With no history at all, a date column is suggested, tentatively.
    const quiet = adviseLayout({
      files: 4,
      bytes: 4_000_000,
      targetBytes: 1_000_000,
      columns: [columnLayout("order_date", "DATE", four("2024-01-01", "2024-12-31"))],
      filtered: {},
      cluster: [],
      filesSinceRewrite: 0,
      keepClustered: false,
    });
    expect(quiet[0].kind).toBe("cluster");
    expect(quiet[0].title).toMatch(/Consider clustering by order_date/);
  });

  it("asks for a rewrite when files landed since the last one, and flags small files", () => {
    const grew = adviseLayout({
      files: 6,
      bytes: 6_000_000,
      targetBytes: 1_000_000,
      columns: [],
      filtered: {},
      cluster: ["k"],
      filesSinceRewrite: 2,
      keepClustered: true,
    });
    expect(grew[0].kind).toBe("recluster");
    expect(grew[0].detail).toMatch(/hourly maintenance pass/);
    const small = adviseLayout({
      files: 20,
      bytes: 20_000,
      targetBytes: 128 * 1024 * 1024,
      columns: [],
      filtered: {},
      cluster: [],
      filesSinceRewrite: 0,
      keepClustered: false,
    });
    expect(small[0].kind).toBe("compact");
    expect(formatBytes(20_000)).toBe("20 KB");
    expect(formatBytes(5_000)).toBe("4.9 KB");
    expect(formatBytes(128 * 1024 * 1024)).toBe("128 MB");
  });
});

describe("the wiring", () => {
  it("the server reads DuckLake's own per-file statistics, and the default file size is a knob", () => {
    const srv = rd("src/utils/lakehouse/layout.server.ts");
    expect(srv).toContain("ducklake_file_column_stats");
    expect(srv).toContain("ducklake_data_file");
    expect(srv).toContain("end_snapshot IS NULL");
    expect(srv).toContain("process.env.LAKEHOUSE_CLUSTER_FILE_BYTES");
    // A failed statement rolls the whole rewrite back; the table is untouched.
    expect(srv).toContain('await c.run("ROLLBACK")');
    expect(srv).toContain("Rewrite rolled back:");
    // Rows still inlined get files first, so the rewrite sees the whole table.
    expect(srv).toContain("ducklake_flush_inlined_data('lake', table_name =>");
  });

  it("the server functions refuse mounts, cap keys at four, and audit", () => {
    const fns = rd("src/utils/lakehouse.functions.ts");
    const slice = fns.slice(fns.indexOf("export const rewriteLakehouseLayout"));
    expect(slice).toContain("schemaRow.lake_source_id || schemaRow.iceberg_catalog_id");
    expect(slice).toContain("z.array(z.string().regex(TABLE_NAME)).min(1).max(4)");
    expect(slice).toContain('action: "lakehouse.layout.rewrite"');
    expect(slice).toContain('action: "lakehouse.layout.clear"');
    expect(fns).toContain("clustered_by: await import");
  });

  it("maintenance merges only unclustered tables and re-clusters kept ones before expiring snapshots", () => {
    const core = rd("src/utils/lakehouse/core.server.ts");
    const fn = core.slice(core.indexOf("export async function runLakehouseMaintenance"));
    const order = [
      "flush_inlined",
      "merge_files",
      "recluster",
      "expire_snapshots",
      "cleanup_files",
    ];
    let last = -1;
    for (const step of order) {
      const at = fn.indexOf(`"${step}"`);
      expect(at, `${step} missing`).toBeGreaterThan(last);
      last = at;
    }
    expect(fn).toContain("layout.mergeUnclusteredTables(c)");
    expect(fn).toContain("layout.reclusterDueTables(c)");
    const srv = rd("src/utils/lakehouse/layout.server.ts");
    expect(srv).toContain("if (clustered.has(`${schema}.${table}`)) continue;");
    expect(srv).toContain("if (stats.since === 0) continue;");
  });

  it("the migration keeps the keys per table, and the UI, docs and README carry the surface", () => {
    const sql = rd("supabase/migrations/20260890000000_lakehouse_layouts.sql");
    expect(sql).toContain("CREATE TABLE public.lakehouse_table_layouts");
    expect(sql).toContain("UNIQUE (schema_name, table_name)");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("keep_clustered boolean NOT NULL DEFAULT false");
    const page = rd("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain('clustered by {detail.clustered_by.join(", ")}');
    expect(page).toContain("Keep clustered");
    expect(page).toContain("Rewrite now");
    expect(page).toContain("Forget layout");
    expect(rd("docs/LAKEHOUSE.md")).toContain("**Clustering.**");
    expect(rd("docs/LAKEHOUSE.md")).toContain("LAKEHOUSE_CLUSTER_FILE_BYTES");
    expect(rd("src/routes/docs.lakehouse.tsx")).toContain("Layout");
    expect(rd("README.md")).toMatch(/clustering\s+with\s+a\s+layout\s+advisor/);
    expect(rd("CHANGELOG.md")).toContain("### Clustering and a layout advisor");
  });
});
