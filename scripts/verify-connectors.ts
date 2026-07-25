// Live connector verification harness.
//
// Exercises the REAL warehouse drivers (the same code the app runs) against
// your own credentials, so you can confirm each Data Source connector works
// end-to-end — connectivity, schema listing and a read query — before relying
// on it. This is how you "live-verify" a connector: the maintainers can't test
// against your Snowflake / Oracle / BigQuery / … , but you can, in one command.
//
// Usage:
//   npx vite-node scripts/verify-connectors.ts ./connectors.json
//
// `connectors.json` is a JSON array of WarehouseConfig objects — see
// connectors.example.json for the shape of each provider. It holds REAL
// credentials, so keep it out of version control (it is gitignored). Nothing
// in this script prints credential values.
import { readFileSync } from "node:fs";

import {
  executeWarehouseQuery,
  listWarehouseTables,
  testWarehouseConnection,
} from "../src/utils/warehouse/drivers.server";
import { WAREHOUSE_LABELS, type WarehouseConfig } from "../src/utils/warehouse/types";

function probeSql(provider: string): string {
  // Oracle has no bare `SELECT 1`; everything else does.
  return provider === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1";
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "connectors.json";
  let configs: WarehouseConfig[];
  try {
    configs = JSON.parse(readFileSync(path, "utf8")) as WarehouseConfig[];
  } catch (e) {
    console.error(`Could not read ${path}: ${(e as Error).message}`);
    console.error(
      "Pass a path to your config, e.g. connectors.json (see connectors.example.json).",
    );
    process.exit(1);
  }
  if (!Array.isArray(configs) || configs.length === 0) {
    console.error("Expected a non-empty JSON array of connector configs.");
    process.exit(1);
  }

  let failures = 0;
  for (const cfg of configs) {
    const label = WAREHOUSE_LABELS[cfg.provider] ?? cfg.provider;
    console.log(`\n▶ ${label} (${cfg.provider})`);

    // 1) Connectivity probe.
    try {
      const t0 = Date.now();
      await testWarehouseConnection(cfg);
      console.log(`  ✓ test connection (${Date.now() - t0}ms)`);
    } catch (e) {
      failures++;
      console.log(`  ✗ test connection: ${(e as Error).message}`);
      continue; // Nothing else will work if we can't connect.
    }

    // 2) Schema listing.
    try {
      const t0 = Date.now();
      const tables = await listWarehouseTables(cfg);
      const cols = tables.reduce((n, t) => n + t.columns.length, 0);
      console.log(
        `  ✓ list tables: ${tables.length} table(s), ${cols} column(s) (${Date.now() - t0}ms)`,
      );
    } catch (e) {
      failures++;
      console.log(`  ✗ list tables: ${(e as Error).message}`);
    }

    // 3) Read query (read-only enforcement is exercised by the driver).
    try {
      const t0 = Date.now();
      const res = await executeWarehouseQuery(cfg, probeSql(cfg.provider), 1);
      console.log(`  ✓ read query: ${res.row_count} row(s) (${Date.now() - t0}ms)`);
    } catch (e) {
      failures++;
      console.log(`  ✗ read query: ${(e as Error).message}`);
    }
  }

  console.log(
    `\n${failures === 0 ? "✓ All checks passed" : `✗ ${failures} check(s) failed`} across ${configs.length} connector(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
