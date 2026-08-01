// Every warehouse provider must be wired up end to end.
//
// A connector registry fails in a specific, quiet way: a provider is added to
// the picker but not to the driver dispatch, or to the driver but not to the
// zod schema. Nothing fails at build time. The user picks it, fills in a form,
// clicks Test, and gets a crash from deep inside the query path — or worse, a
// config that saves cleanly and only fails weeks later on a scheduled refresh.
//
// So these assert the WIRING, across every provider at once, rather than
// testing any one connector. A new provider that is only half-added fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FAMILY_DEFAULT_PORT,
  HOST_PORT_PROVIDERS,
  PROVIDER_FAMILY,
  WAREHOUSE_LABELS,
  WAREHOUSE_PROVIDERS,
  type WarehouseProvider,
} from "@/utils/warehouse/types";

const driversSrc = readFileSync("src/utils/warehouse/drivers.server.ts", "utf8");

/**
 * The body of one exported function.
 *
 * The two switches in this file — query dispatch and schema listing — both
 * contain `case "<provider>":`, so a whole-file search is satisfied by either.
 * A first version of these tests did exactly that and passed with the ClickHouse
 * dispatch case deleted. Scoping is the difference between a test and a
 * decoration.
 */
function bodyOf(name: string): string {
  const start = driversSrc.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`${name} not found in drivers.server.ts`);
  const next = driversSrc.indexOf("\nexport ", start + 1);
  return driversSrc.slice(start, next < 0 ? undefined : next);
}

const dispatchSrc = bodyOf("executeWarehouseQuery");
const listSrc = bodyOf("listWarehouseTables");
const functionsSrc = readFileSync("src/utils/warehouse.functions.ts", "utf8");
const tabSrc = readFileSync("src/components/integrations/WarehousesTab.tsx", "utf8");

describe("the provider list is internally consistent", () => {
  it("lists every provider in the union exactly once", () => {
    expect(new Set(WAREHOUSE_PROVIDERS).size).toBe(WAREHOUSE_PROVIDERS.length);
  });

  it("gives every provider a family", () => {
    for (const p of WAREHOUSE_PROVIDERS) {
      expect(PROVIDER_FAMILY[p], `${p} has no wire family`).toBeDefined();
    }
  });

  it("gives every provider a human label", () => {
    for (const p of WAREHOUSE_PROVIDERS) {
      expect(WAREHOUSE_LABELS[p]?.length, `${p} has no label`).toBeGreaterThan(0);
    }
  });

  it("keeps PROVIDER_FAMILY and the provider list in step", () => {
    // A provider in the family map but missing from the list is invisible in
    // the UI while looking wired up in code.
    expect(new Set(Object.keys(PROVIDER_FAMILY))).toEqual(new Set(WAREHOUSE_PROVIDERS));
  });

  it("assigns every host/port provider to a wire family with a default port", () => {
    for (const p of HOST_PORT_PROVIDERS) {
      const family = PROVIDER_FAMILY[p];
      expect(family, `${p} must not be its own protocol`).not.toBe("own");
      expect(
        FAMILY_DEFAULT_PORT[family as Exclude<typeof family, "own">],
        `${family} has no default port`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("every provider is reachable by the driver", () => {
  it("is routed by family or has its own case in executeWarehouseQuery", () => {
    // The dispatcher handles postgres/mysql/tds families up front; everything
    // else needs an explicit case. Reading the source is unusual in a test,
    // but the alternative is a live connection to twenty-two databases.
    const ownProviders = WAREHOUSE_PROVIDERS.filter((p) => PROVIDER_FAMILY[p] === "own");
    for (const p of ownProviders) {
      expect(
        dispatchSrc.includes(`case "${p}":`),
        `"${p}" has family "own" but no case in executeWarehouseQuery — it would throw ` +
          `"No driver for provider" the first time anyone selected it.`,
      ).toBe(true);
    }
  });

  it("routes each wire family to a driver", () => {
    for (const family of ["postgres", "mysql", "tds"] as const) {
      expect(
        dispatchSrc.includes(`family === "${family}"`),
        `family "${family}" is declared but never dispatched`,
      ).toBe(true);
    }
  });

  it("can browse schemas for every provider", () => {
    // listWarehouseTables throws a clear error rather than returning nothing,
    // but a provider reaching that branch is still a half-finished connector.
    const ownProviders = WAREHOUSE_PROVIDERS.filter((p) => PROVIDER_FAMILY[p] === "own");
    for (const p of ownProviders) {
      expect(listSrc.includes(`case "${p}":`), `"${p}" has no schema-listing query`).toBe(true);
    }
  });
});

describe("every provider is accepted by the API and offered by the UI", () => {
  it("appears in the zod config union", () => {
    // The union is what turns an unknown provider into a validation error
    // instead of a row that saves and fails at query time. HOST_PORT_PROVIDERS
    // are generated into it, so they are checked via that list.
    const generated = new Set<WarehouseProvider>(HOST_PORT_PROVIDERS);
    for (const p of WAREHOUSE_PROVIDERS) {
      if (generated.has(p)) continue;
      expect(
        functionsSrc.includes(`z.literal("${p}")`),
        `"${p}" is missing from ConfigSchema — saving it would be rejected.`,
      ).toBe(true);
    }
    expect(functionsSrc).toContain("HOST_PORT_PROVIDERS.map");
  });

  it("has connection-form metadata", () => {
    // PROVIDER_META is a total Record, so a missing entry is a type error —
    // but only if the provider is in the union, which is what this confirms.
    for (const p of WAREHOUSE_PROVIDERS) {
      expect(tabSrc.includes(`${p}:`), `"${p}" has no PROVIDER_META entry`).toBe(true);
    }
  });
});

describe("SQL Server and Synapse share the TDS driver", () => {
  it("both resolve to the tds family", () => {
    expect(PROVIDER_FAMILY.sqlserver).toBe("tds");
    expect(PROVIDER_FAMILY.azure_synapse).toBe("tds");
  });

  it("keeps ONE tedious code path, not two", () => {
    // The whole point of the family split. A second `new Connection(` would
    // mean a timeout or TLS fix landing in one and not the other.
    const connections = driversSrc.match(/new Connection\(/g) ?? [];
    expect(connections.length).toBe(1);
  });
});

describe("ClickHouse is read-only at the server, not just at the guard", () => {
  it("sends readonly=1 so the server refuses writes regardless of the SQL", () => {
    expect(driversSrc).toContain('url.searchParams.set("readonly", "1")');
  });

  it("treats an exception in a 200 body as a failure", () => {
    // ClickHouse raises errors mid-stream after the headers are sent; a 200
    // with an `exception` field is a failed query, and reading it as success
    // would surface a truncated result as a complete one.
    expect(driversSrc).toContain("json.exception");
  });

  it("refuses blocked hosts", () => {
    expect(driversSrc).toContain(
      'throw new Error("ClickHouse: refusing to connect to a blocked host")',
    );
  });
});
