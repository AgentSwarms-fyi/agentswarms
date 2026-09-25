// A "read-only" Iceberg mount that took writes, and a removal that took them away.
//
// FOUND IN R111. An Iceberg mount is a schema of views, and the mount dialog
// calls it read-only, but the statement guard refused writes only through a
// data-lake mount. Driven: a second catalog on the same endpoint, "r111_rest",
// mounted namespace r107 as ice_r111. The Query editor ran CREATE TABLE
// ice_r111.r111_written and read its row back. Removing r111_rest ("Its 1
// mounted schema(s) go with it. Tables in the catalog itself are
// untouched.") then dropped the schema with CASCADE, and the DuckLake
// catalog shows the table ended in the same snapshot. ML batch scoring had
// its own copy of the rule, with the same gap, and its "Output schema
// (yours)" picker offered all eight ice_* mounts.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SCHEMAS = [
  { id: "s1", name: "analytics", user_id: "owner", description: null },
  {
    id: "s2",
    name: "ice_r111",
    user_id: "owner",
    description: 'Iceberg mount of "r111_rest" · r107',
    iceberg_catalog_id: "cat-1",
    iceberg_namespace: "r107",
  },
  { id: "s3", name: "lake_orders", user_id: "owner", description: null, lake_source_id: "src-1" },
];

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["insert", "select", "eq", "limit", "order", "update", "in"]) {
    chain[m] = () => chain;
  }
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return {
    supabaseAdmin: {
      rpc: async () => ({ data: SCHEMAS, error: null }),
      from: () => chain,
    },
  };
});

const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("writing through an Iceberg mount", () => {
  it("refuses CREATE TABLE in the mount's schema", async () => {
    await expect(
      runLakehouseStatement(
        "owner",
        "CREATE TABLE ice_r111.r111_written AS SELECT 1 AS id, 'written into a read-only mount' AS note",
      ),
    ).rejects.toThrow(/"ice_r111" is a read-only Iceberg mount/);
  });

  it("refuses INSERT and DROP there too", async () => {
    await expect(
      runLakehouseStatement("owner", "INSERT INTO ice_r111.r107_pub VALUES (9, 'x')"),
    ).rejects.toThrow(/read-only Iceberg mount/);
    await expect(runLakehouseStatement("owner", "DROP VIEW ice_r111.r107_pub")).rejects.toThrow(
      /read-only Iceberg mount/,
    );
  });

  it("names the way a table does get into the catalog", async () => {
    await expect(
      runLakehouseStatement("owner", "CREATE TABLE ice_r111.t AS SELECT 1"),
    ).rejects.toThrow(/Publish to Iceberg puts a table into the catalog/);
  });

  it("still refuses a data-lake mount as before", async () => {
    await expect(
      runLakehouseStatement("owner", "CREATE TABLE lake_orders.t AS SELECT 1"),
    ).rejects.toThrow(/read-only data-lake mount/);
  });
});

describe("the other writers and pickers", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("ML batch scoring refuses an Iceberg mount as its output", () => {
    const api = read("src/utils/ml/api.server.ts");
    expect(api).toMatch(
      /out\.user_id !== userId \|\| out\.lake_source_id \|\| out\.iceberg_catalog_id/,
    );
  });

  it("the ML output pickers offer only schemas that can take a table", () => {
    const fns = read("src/utils/ml.functions.ts");
    expect(fns).toContain(
      "writableSchemas: r.schemas.filter((s) => s.writable).map((s) => s.name)",
    );
    const tables = read("src/utils/lakehouse/tables.server.ts");
    expect(tables).toContain(
      "writable: s.user_id === userId && !s.lake_source_id && !s.iceberg_catalog_id",
    );
    const batch = read("src/components/ml/PredictionsPanel.tsx");
    expect(batch).toContain("setOutSchemas(r.writableSchemas)");
    expect(batch).toMatch(/\(outSchemas \?\? \[outSchema\]\)\.map/);
    const sched = read("src/components/ml/SchedulesPanel.tsx");
    expect(sched).toContain("setOutSchemas(r.writableSchemas)");
    expect(sched).toMatch(/\{outSchemas\.map\(\(s\) =>/);
  });

  it("Save as view offers no mount of either kind", () => {
    const page = read("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toMatch(/sch\.owned && !sch\.lake_source_id && !sch\.iceberg_catalog_id/);
  });
});

describe("removing a catalog", () => {
  const fns = readFileSync("src/utils/icebergCatalogs.functions.ts", "utf8");
  const del = fns.slice(
    fns.indexOf("export const icebergCatalogDelete"),
    fns.indexOf("export const icebergNamespacesList"),
  );
  const server = readFileSync("src/utils/lakehouse/iceberg.server.ts", "utf8");

  it("looks for tables of the owner's inside each mount before dropping anything", () => {
    const check = del.indexOf("await mountForeignTables(m.name)");
    const drop = del.indexOf("await dropIcebergMountSchema(");
    expect(check).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(check);
    expect(del.slice(check, drop)).toMatch(/if \(held\.length\) \{\s*return \{\s*ok: false/);
  });

  it("refuses when it cannot check, or cannot list the mounts", () => {
    expect(del).toMatch(/if \(mountsErr\) return \{ ok: false/);
    expect(del).toMatch(
      /catch \(e\) \{\s*return \{\s*ok: false,\s*error: `Not removed: could not check/,
    );
  });

  it("counts real tables only, since a mount holds views", () => {
    expect(server).toMatch(
      /SELECT table_name FROM duckdb_tables\(\) WHERE database_name = 'lake' `/,
    );
  });
});
