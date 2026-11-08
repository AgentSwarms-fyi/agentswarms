// Iceberg on the Spark engine (R459): what a Spark session is told about a
// catalog, the maintenance statements the upkeep panel runs, the programs a
// sandbox runs, and the seal that keeps a job's plan the one the server made.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: async () => {} }));

import { defaultIcebergCatalog, type IcebergCatalogConfig } from "@/utils/lakehouse/iceberg";
import {
  compileIcebergMaintenance,
  describeMaintenanceResult,
  icebergMaintenanceSql,
  icebergSparkCatalog,
  icebergSparkConf,
  icebergSparkTableRef,
  maintenanceError,
  maintenanceSummary,
} from "@/utils/lakehouse/icebergSpark";
import { compileSparkQuery } from "@/utils/lakehouse/sparkQueryCodegen";

const { canonicalJson, sealMatches, sealWith } =
  await import("@/utils/lakehouse/sparkQuery.server");

const ID = "e28efd4c-b248-4bcc-9ba4-e4b140e32ee0";
const CAT = icebergSparkCatalog(ID);
const cfg = (over: Partial<IcebergCatalogConfig>): IcebergCatalogConfig => ({
  ...defaultIcebergCatalog(),
  name: "local_rest",
  endpoint: "http://192.168.1.85:8181/",
  warehouse: "s3://iceberg/",
  ...over,
});
const conf = (c: IcebergCatalogConfig) => Object.fromEntries(icebergSparkConf(CAT, c, 0));

describe("a catalog, as a Spark session is told it", () => {
  it("is named the way the lakehouse engine attaches it", () => {
    expect(CAT).toBe("ice_e28efd4cb2484bcc9ba4e4b140e32ee0");
    expect(() => icebergSparkCatalog("x'); drop")).toThrow();
  });

  it("is a REST catalog with S3 FileIO, read fresh by every job", () => {
    const c = conf(cfg({}));
    expect(c[`spark.sql.catalog.${CAT}`]).toBe('"org.apache.iceberg.spark.SparkCatalog"');
    expect(c[`spark.sql.catalog.${CAT}.type`]).toBe('"rest"');
    expect(c[`spark.sql.catalog.${CAT}.uri`]).toBe('"http://192.168.1.85:8181"');
    expect(c[`spark.sql.catalog.${CAT}.warehouse`]).toBe('"s3://iceberg/"');
    expect(c[`spark.sql.catalog.${CAT}.io-impl`]).toBe('"org.apache.iceberg.aws.s3.S3FileIO"');
    expect(c[`spark.sql.catalog.${CAT}.cache-enabled`]).toBe('"false"');
  });

  it("asks for vended credentials, or reads with the lakehouse's own keys", () => {
    const vended = conf(cfg({ storage: "vended" }));
    expect(vended[`spark.sql.catalog.${CAT}.header.X-Iceberg-Access-Delegation`]).toBe(
      '"vended-credentials"',
    );
    expect(vended[`spark.sql.catalog.${CAT}.s3.access-key-id`]).toBeUndefined();
    const own = conf(cfg({ storage: "lakehouse" }));
    expect(own[`spark.sql.catalog.${CAT}.header.X-Iceberg-Access-Delegation`]).toBeUndefined();
    expect(own[`spark.sql.catalog.${CAT}.s3.access-key-id`]).toBe(
      'os.environ["ETL_ICEBERG_0_S3_KEY_ID"]',
    );
  });

  it("takes every credential from the environment, never from the program text", () => {
    const bearer = conf(cfg({ auth_type: "bearer", token_secret: "ICE_TOKEN" }));
    expect(bearer[`spark.sql.catalog.${CAT}.token`]).toBe('os.environ["ETL_ICEBERG_0_TOKEN"]');
    const oauth = conf(
      cfg({ auth_type: "oauth2", client_id_secret: "A", client_secret_secret: "B" }),
    );
    expect(oauth[`spark.sql.catalog.${CAT}.credential`]).toBe(
      'os.environ["ETL_ICEBERG_0_CREDENTIAL"]',
    );
    // No server URI saved: the catalog's own token endpoint, as the
    // lakehouse engine asks it (R458), and the scope Polaris grants.
    expect(oauth[`spark.sql.catalog.${CAT}.oauth2-server-uri`]).toBe(
      '"http://192.168.1.85:8181/v1/oauth/tokens"',
    );
    expect(oauth[`spark.sql.catalog.${CAT}.scope`]).toBe('"PRINCIPAL_ROLE:ALL"');
    const named = conf(
      cfg({
        auth_type: "oauth2",
        client_id_secret: "A",
        client_secret_secret: "B",
        oauth2_server_uri: "https://idp.example.com/token",
      }),
    );
    expect(named[`spark.sql.catalog.${CAT}.oauth2-server-uri`]).toBe(
      '"https://idp.example.com/token"',
    );
  });

  it("names a table with backticks, and refuses a name the rules do not admit", () => {
    expect(icebergSparkTableRef(CAT, "sales-prod", "daily-metrics")).toBe(
      `${CAT}.\`sales-prod\`.\`daily-metrics\``,
    );
    expect(() => icebergSparkTableRef(CAT, "a`b", "t")).toThrow();
    expect(() => icebergSparkTableRef(CAT, "a.b", "t")).toThrow();
    expect(() => icebergSparkTableRef(CAT, "ns", "t' OR 1=1")).toThrow();
  });
});

describe("maintenance", () => {
  const now = new Date("2026-11-08T12:00:00Z");

  it("is the Iceberg procedure the advice quotes", () => {
    // remove-dangling-deletes: measured in R459, a rewrite without it left
    // all 520 delete files listed after rewriting 832 data files into one.
    expect(icebergMaintenanceSql(CAT, "sales", "orders", { action: "compact" }, now)).toBe(
      `CALL ${CAT}.system.rewrite_data_files(table => '\`sales\`.\`orders\`', options => map('remove-dangling-deletes', 'true'))`,
    );
    expect(icebergMaintenanceSql(CAT, "sales", "orders", { action: "deletes" }, now)).toBe(
      `CALL ${CAT}.system.rewrite_data_files(table => '\`sales\`.\`orders\`', options => map('delete-file-threshold', '1', 'remove-dangling-deletes', 'true'))`,
    );
    expect(
      icebergMaintenanceSql(
        CAT,
        "sales",
        "orders",
        { action: "expire", older_than_days: 7, retain_last: 20 },
        now,
      ),
    ).toBe(
      `CALL ${CAT}.system.expire_snapshots(table => '\`sales\`.\`orders\`', older_than => TIMESTAMP '2026-11-01 12:00:00', retain_last => 20)`,
    );
  });

  it("bounds what expiry accepts", () => {
    expect(maintenanceError({ action: "expire", older_than_days: 0 })).toMatch(/1 to 3,650/);
    expect(maintenanceError({ action: "expire", older_than_days: 1.5 })).toMatch(/1 to 3,650/);
    expect(maintenanceError({ action: "expire", retain_last: 0 })).toMatch(/1 and 10,000/);
    expect(maintenanceError({ action: "expire", older_than_days: 30, retain_last: 5 })).toBeNull();
    expect(maintenanceError({ action: "orphans" as never })).toBe("Unknown maintenance.");
  });

  it("says what it does before it is confirmed, and that expiry cannot be undone", () => {
    expect(maintenanceSummary({ action: "compact" })).toMatch(/rows do not change/);
    expect(maintenanceSummary({ action: "expire", older_than_days: 1, retain_last: 3 })).toMatch(
      /older than 1 day, keeping at least the newest 3.*cannot be undone/,
    );
  });

  it("reads the procedure's own counters back in words", () => {
    const rewrite = [
      { name: "rewritten_data_files_count" },
      { name: "added_data_files_count" },
      { name: "rewritten_bytes_count" },
      { name: "failed_data_files_count" },
      { name: "removed_delete_files_count" },
    ];
    expect(describeMaintenanceResult("compact", rewrite, [[12, 1, 9000, 0, 1]])).toBe(
      "Rewrote 12 data files into 1 file, removing 1 delete file.",
    );
    expect(describeMaintenanceResult("compact", rewrite, [[0, 0, 0, 0, 0]])).toBe(
      "Nothing needed rewriting.",
    );
    const expire = [
      { name: "deleted_data_files_count" },
      { name: "deleted_position_delete_files_count" },
      { name: "deleted_equality_delete_files_count" },
      { name: "deleted_manifest_files_count" },
      { name: "deleted_manifest_lists_count" },
      { name: "deleted_statistics_files_count" },
    ];
    expect(describeMaintenanceResult("expire", expire, [[12, 1, 0, 13, 11, 0]])).toBe(
      "Expired snapshots: deleted 13 data or delete files and 24 metadata files.",
    );
    expect(describeMaintenanceResult("expire", expire, [[0, 0, 0, 0, 0, 0]])).toBe(
      "No snapshot was old enough to expire.",
    );
  });

  it("is a program that turns off substitution before the catalog's credentials are set", () => {
    const program = compileIcebergMaintenance({
      jobId: "j1",
      catalog: CAT,
      cfg: cfg({ auth_type: "bearer", token_secret: "ICE_TOKEN" }),
      sql: icebergMaintenanceSql(CAT, "sales", "orders", { action: "compact" }, now),
    });
    const off = program.indexOf("spark.conf.set('spark.sql.variable.substitute', 'false')");
    const token = program.indexOf(`spark.sql.catalog.${CAT}.token`);
    expect(off).toBeGreaterThan(0);
    expect(token).toBeGreaterThan(off);
    expect(program).toContain("spark.conf.set('spark.sql.session.timeZone', 'UTC')");
    expect(program).toContain("_connect_spark(_url)");
    expect(program).toContain("def entrypoint(inputs):");
  });
});

describe("a SELECT over the caller's own Iceberg mount", () => {
  const program = compileSparkQuery({
    queryId: "q1",
    sql: "SELECT region, count(*) FROM ice_sales.orders JOIN sales.targets USING (region) GROUP BY 1",
    rowCap: 100,
    snapshot: 7,
    catalogs: [{ id: ID, cfg: cfg({}) }],
    tables: [
      {
        schema: "ice_sales",
        table: "orders",
        columns: [],
        dataFiles: [],
        deleteFiles: [],
        iceberg: {
          catalog_id: ID,
          namespace: "sales",
          table: "orders",
          snapshot_id: "7259124565828023429",
          location: "s3://iceberg/sales/orders",
        },
      },
      {
        schema: "sales",
        table: "targets",
        columns: [{ name: "region", type: "VARCHAR" }],
        dataFiles: ["s3://lakehouse/main/sales/targets/a.parquet"],
        deleteFiles: [],
      },
    ],
  });

  it("reads the mount from its catalog at the pinned snapshot, exactly", () => {
    expect(program).toContain(
      `_iceview("ice_sales__orders", "${CAT}.\`sales\`.\`orders\`", "7259124565828023429")`,
    );
    expect(program).toContain("' VERSION AS OF ' + snapshot_id");
    expect(program).not.toContain("'snapshot-id'");
  });

  it("reads a lakehouse table beside it from its files, as before", () => {
    expect(program).toContain('_view("sales__targets"');
  });

  it("turns substitution off before the user's statement can run", () => {
    const off = program.indexOf("spark.conf.set('spark.sql.variable.substitute', 'false')");
    expect(off).toBeGreaterThan(program.indexOf("def entrypoint(inputs):"));
    expect(off).toBeLessThan(program.indexOf("_df = spark.sql(_q)"));
    expect(off).toBeLessThan(program.indexOf(`spark.sql.catalog.${CAT}`));
  });

  it("refuses a table whose catalog the plan does not carry", () => {
    expect(() =>
      compileSparkQuery({
        queryId: "q2",
        sql: "SELECT 1 FROM ice_sales.orders",
        rowCap: 1,
        snapshot: null,
        tables: [
          {
            schema: "ice_sales",
            table: "orders",
            columns: [],
            dataFiles: [],
            deleteFiles: [],
            iceberg: {
              catalog_id: ID,
              namespace: "sales",
              table: "orders",
              snapshot_id: null,
              location: null,
            },
          },
        ],
      }),
    ).toThrow(/No catalog configured/);
  });
});

describe("the plan's seal", () => {
  const secret = "s".repeat(64);
  const row = {
    id: "5f0c0f0e-1111-4222-8333-944445555666",
    user_id: "u-1",
    sql: "SELECT * FROM sales.orders",
    tables: [
      {
        schema: "sales",
        table: "orders",
        columns: [{ name: "id", type: "BIGINT" }],
        dataFiles: ["s3://lakehouse/u-1/sales/orders/a.parquet"],
        deleteFiles: [],
      },
    ],
    snapshot: 41,
    row_cap: 10_000,
  };
  const seal = sealWith(secret, row);

  it("holds for the row as recorded, and for it read back with keys reordered", () => {
    expect(sealMatches(secret, row, seal)).toBe(true);
    const readBack = JSON.parse(JSON.stringify(row)) as typeof row;
    readBack.tables = readBack.tables.map((t) => ({
      deleteFiles: t.deleteFiles,
      dataFiles: t.dataFiles,
      table: t.table,
      columns: t.columns,
      schema: t.schema,
    }));
    expect(sealMatches(secret, { ...readBack, snapshot: "41" as never }, seal)).toBe(true);
  });

  it("breaks when the files, the statement, the cap, the owner or the id change", () => {
    const other = structuredClone(row);
    other.tables[0].dataFiles = ["s3://lakehouse/u-2/sales/orders/a.parquet"];
    expect(sealMatches(secret, other, seal)).toBe(false);
    expect(sealMatches(secret, { ...row, sql: "SELECT 1 FROM sales.orders" }, seal)).toBe(false);
    expect(sealMatches(secret, { ...row, row_cap: 100_000 }, seal)).toBe(false);
    expect(sealMatches(secret, { ...row, user_id: "u-2" }, seal)).toBe(false);
    expect(sealMatches(secret, { ...row, id: "5f0c0f0e-1111-4222-8333-944445555667" }, seal)).toBe(
      false,
    );
    expect(sealMatches(secret, { ...row, snapshot: 40 }, seal)).toBe(false);
  });

  it("is refused when it is absent, malformed, or made with another secret", () => {
    expect(sealMatches(secret, row, null)).toBe(false);
    expect(sealMatches(secret, row, "abc")).toBe(false);
    expect(sealMatches(secret, row, sealWith("t".repeat(64), row))).toBe(false);
  });

  it("canonical JSON is key-order free and keeps nulls", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe(
      canonicalJson({ a: [{ c: "x", d: null }], b: 1 }),
    );
  });

  it("is checked before a program or an env is built, and rides in the session's inputs", () => {
    const src = readFileSync("src/utils/lakehouse/sparkQuery.server.ts", "utf8");
    const bundle = src.slice(src.indexOf("export async function sparkQueryBundleFor"));
    const env = src.slice(src.indexOf("export async function sparkQueryEnvFor"));
    expect(bundle.slice(0, 400)).toContain("const sealed = await loadSealed(stash, userId);");
    expect(env.slice(0, 400)).toContain("const sealed = await loadSealed(stash, userId);");
    expect(src).toContain("inputs: { [SPARK_QUERY_KEY]: { query_id: id, seal } },");
    // Sealed from the plan in hand, never from the row read back.
    expect(src).toContain("seal = await sealPlan({ id: row.id, user_id: userId, ...plan });");
  });

  it("the migration leaves users read-only on their Spark jobs", () => {
    const sql = readFileSync(
      "supabase/migrations/20261112000000_spark_jobs_server_written.sql",
      "utf8",
    );
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Users manage their own Spark queries" ON public.lakehouse_spark_queries;',
    );
    expect(sql).toMatch(
      /CREATE POLICY "Users read their own Spark queries"\s+ON public\.lakehouse_spark_queries FOR SELECT/,
    );
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.lakehouse_spark_queries FROM authenticated;",
    );
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/FOR ALL/);
  });
});

describe("who may run what", () => {
  const src = readFileSync("src/utils/lakehouse/sparkQuery.server.ts", "utf8");
  const start = src.slice(src.indexOf("export async function startIcebergMaintenance"));

  it("maintenance is the catalog owner's only, bounded, and on Spark", () => {
    expect(start).toContain("const problem = maintenanceError(args.maintenance);");
    expect(start).toContain("if (schema.user_id !== userId) {");
    expect(start).toContain('.eq("user_id", userId)');
    expect(start).toContain("await assertSparkForQueries();");
  });

  it("a catalog's credentials pass the same URL checks an attach makes", () => {
    const ice = readFileSync("src/utils/lakehouse/iceberg.server.ts", "utf8");
    const fn = ice.slice(ice.indexOf("export async function icebergSparkCredentials"));
    expect(fn.slice(0, 600)).toContain(
      "await assertIcebergUrlsAllowed(cfg, auditRefusal(userId, cfg));",
    );
  });

  it("a job that reads no lakehouse file is handed no lakehouse key", () => {
    expect(src).toContain(
      "if (!tables.some((t) => t.dataFiles.length || t.deleteFiles.length)) {\n    return withSpark(env, secretValues, storedUrl);",
    );
  });
});
