#!/usr/bin/env node
// Install the DuckDB extensions the lakehouse engine loads, at IMAGE BUILD
// time, so no container ever downloads them at run time.
//
// Measured on a fresh container: the first lakehouse request on a worker
// spent 3.5 minutes fetching ~145 MB of extensions before it ran a single
// query, and every restart, redeploy and new replica paid it again — and an
// air-gapped install could not pay it at all. DuckDB's INSTALL is a no-op
// when the extension is already present for the running version, so baking
// them here makes the engine's own INSTALL instant and offline.
//
// Two passes, deliberately: every INSTALL first, then every LOAD. Once httpfs
// is loaded, DuckDB fetches further extensions through httpfs's own HTTP
// client, which fails in the slim image with "Problem with the SSL CA cert"
// (seen in the first build of this step: ducklake, postgres and httpfs baked,
// then azure, avro and iceberg all failed to download). The engine installs
// in the same order for the same reason. The LOAD pass proves each file is
// usable, not merely present.
//
// The list must match what src/utils/lakehouse/core.server.ts installs; a
// unit test pins the two together. Run as the user the app runs as (the
// cache lives under that user's home).
import { DuckDBInstance } from "@duckdb/node-api";

export const LAKEHOUSE_EXTENSIONS = ["ducklake", "postgres", "httpfs", "azure", "avro", "iceberg"];

const instance = await DuckDBInstance.create(":memory:");
const c = await instance.connect();
const failed = [];
for (const ext of LAKEHOUSE_EXTENSIONS) {
  try {
    await c.run(`INSTALL ${ext};`);
  } catch (e) {
    // Iceberg and avro are optional for the engine (it says so at boot);
    // the four the lakehouse cannot run without are not.
    failed.push(ext);
    console.warn(`could not install ${ext}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}
for (const ext of LAKEHOUSE_EXTENSIONS) {
  if (failed.includes(ext)) continue;
  try {
    await c.run(`LOAD ${ext};`);
    console.log(`baked ${ext}`);
  } catch (e) {
    failed.push(ext);
    console.warn(`installed but could not load ${ext}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}
const required = ["ducklake", "postgres", "httpfs", "azure"];
const missing = required.filter((e) => failed.includes(e));
if (missing.length) {
  console.error(`required extension(s) not baked: ${missing.join(", ")}`);
  process.exit(1);
}
const rows = await (
  await c.run(
    "SELECT extension_name, extension_version FROM duckdb_extensions() WHERE installed ORDER BY 1",
  )
).getRows();
console.log("installed:", rows.map((r) => `${r[0]}@${r[1]}`).join(", "));
process.exit(0);
