// The Iceberg statements against Apache Polaris (R458): OAuth2 client
// credentials and credentials the catalog vends, which R457 could only test
// against the reference fixture. The engine here has NO storage secret of its
// own, so every file it reads or writes goes through what Polaris vended; a
// test that passed on the lakehouse's own key would prove nothing.
//
// Skipped unless POLARIS_TEST_ENDPOINT, _WAREHOUSE, _CLIENT_ID and
// _CLIENT_SECRET name a catalog whose storage config vends (on a MinIO-style
// store, Polaris 1.8 also needs "kmsUnavailable": true, measured: without it
// the store's STS refuses Polaris's session policy over a KMS resource). Writes
// only into the namespace it creates, and drops it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultIcebergCatalog,
  icebergAttachSql,
  icebergMergeSql,
  icebergPublishSql,
  icebergSecretSql,
} from "@/utils/lakehouse/iceberg";

const ENDPOINT = process.env.POLARIS_TEST_ENDPOINT;
const WAREHOUSE = process.env.POLARIS_TEST_WAREHOUSE;
const CLIENT_ID = process.env.POLARIS_TEST_CLIENT_ID;
const CLIENT_SECRET = process.env.POLARIS_TEST_CLIENT_SECRET;
const alias = `ice_${"0".repeat(31)}2`;
const COLUMNS = [
  { name: "id", type: "BIGINT" },
  { name: "region", type: "VARCHAR" },
  { name: "amount", type: "DECIMAL(23,1)" },
];
const ns = `r458_${Date.now().toString(36)}`;

describe.skipIf(!ENDPOINT || !WAREHOUSE || !CLIENT_ID || !CLIENT_SECRET)("Apache Polaris", () => {
  let c: DuckDBConnection;
  let dir = "";
  const one = async (sql: string) =>
    Number(Object.values((await c.runAndReadAll(sql)).getRowObjectsJson()[0] ?? {})[0]);
  const cfg = () => ({
    ...defaultIcebergCatalog(),
    name: "polaris",
    endpoint: ENDPOINT!,
    warehouse: WAREHOUSE!,
    auth_type: "oauth2" as const,
    client_id_secret: "POLARIS_CLIENT_ID",
    client_secret_secret: "POLARIS_CLIENT_SECRET",
    storage: "vended" as const,
  });

  beforeAll(async () => {
    const db = await DuckDBInstance.create(":memory:");
    c = await db.connect();
    await c.run("LOAD iceberg; LOAD httpfs; LOAD ducklake;");
    // A lakehouse table to publish from, in a local DuckLake.
    dir = mkdtempSync(join(tmpdir(), "polaris-src-")).replace(/\\/g, "/");
    await c.run(`ATTACH 'ducklake:${dir}/cat.ducklake' AS lake (DATA_PATH '${dir}/data/')`);
    await c.run("CREATE SCHEMA lake.s");
    await c.run(
      "CREATE TABLE lake.s.orders AS SELECT i::BIGINT AS id, ['eu','us'][i % 2 + 1] AS region, (i * 2.5)::DECIMAL(23,1) AS amount FROM range(1, 201) r(i)",
    );
    const secret = icebergSecretSql(alias, cfg(), {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    await c.run(secret!);
    await c.run(icebergAttachSql(alias, cfg()));
    await c.run(`CREATE SCHEMA ${alias}.${ns}`);
  }, 120_000);

  afterAll(async () => {
    try {
      await c?.run(`DROP TABLE IF EXISTS ${alias}.${ns}.orders`);
      await c?.run(`DROP SCHEMA IF EXISTS ${alias}.${ns}`);
    } catch {
      /* the namespace is the rig's to remove */
    }
    c?.closeSync();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("has no storage credential of its own, so a file read can only use what Polaris vends", async () => {
    expect(await one("SELECT count(*) FROM duckdb_secrets() WHERE type = 's3'")).toBe(0);
  });

  it("signs in with OAuth2 client credentials and publishes a table as v3, partitioned", async () => {
    const plan = icebergPublishSql({
      alias,
      namespace: ns,
      table: "orders",
      sourceSchema: "s",
      sourceTable: "orders",
      mode: "create",
      columns: COLUMNS,
      layout: { formatVersion: 3, partition: [{ column: "region", transform: "identity" }] },
    });
    for (const sql of plan) await c.run(sql);
    expect(await one(`SELECT count(*) FROM ${alias}.${ns}.orders`)).toBe(200);
    expect(await one(`SELECT sum(amount)::DOUBLE FROM ${alias}.${ns}.orders`)).toBe(50250);
  });

  it("upserts by key in one commit, and reads the table at its earlier snapshot", async () => {
    // Snapshot ids pass 2^53: read as text, as the app does, never as a number.
    const first = String(
      Object.values(
        (
          await c.runAndReadAll(
            `SELECT min(snapshot_id)::VARCHAR FROM iceberg_snapshots("${alias}"."${ns}".orders)`,
          )
        ).getRowObjectsJson()[0]!,
      )[0],
    );
    await c.run(
      "CREATE TABLE lake.s.changes AS SELECT * FROM (VALUES (1, 'eu', 999.0), (500, 'us', 1.0)) t(id, region, amount)",
    );
    await c.run(
      icebergMergeSql({
        alias,
        namespace: ns,
        table: "orders",
        sourceSchema: "s",
        sourceTable: "changes",
        columns: COLUMNS,
        keys: ["id"],
      }),
    );
    expect(await one(`SELECT count(*) FROM ${alias}.${ns}.orders`)).toBe(201);
    expect(await one(`SELECT amount::DOUBLE FROM ${alias}.${ns}.orders WHERE id = 1`)).toBe(999);
    expect(await one(`SELECT count(*) FROM ${alias}.${ns}.orders AT (VERSION => ${first})`)).toBe(
      200,
    );
  });

  it("is refused with the catalog's own words when the client secret is wrong", async () => {
    // The engine asks for a token when the secret is made, so that is where it fails.
    const bad = `ice_${"0".repeat(31)}3`;
    await expect(
      (async () => {
        await c.run(
          icebergSecretSql(bad, cfg(), { client_id: CLIENT_ID, client_secret: "wrong" })!,
        );
        await c.run(icebergAttachSql(bad, cfg()));
      })(),
    ).rejects.toThrow(/OAuth2 token request failed \(Unauthorized_401\)/);
  });
});
