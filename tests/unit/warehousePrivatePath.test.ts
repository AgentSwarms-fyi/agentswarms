// Databases and warehouses over private paths (private connectivity, Phase 3,
// R424).
//
// Two checks before a connection is opened (src/utils/warehouse/network.server.ts):
//
//   - The always-refused addresses for the wire-protocol databases (the
//     Postgres, MySQL and SQL Server families). Their drivers open TCP
//     themselves, so none of safeFetch's checks reached them: a Postgres
//     connection could be aimed at the cloud metadata address, by name or by a
//     name resolving there. Private networks stay allowed.
//   - The connection's own "require a private network path" rule: a wire
//     protocol is always direct, so the proxy does not count for it; an
//     HTTPS engine's calls may leave through the proxy, which does.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const { assertWarehouseNetwork, warehousePath } = await import("@/utils/warehouse/network.server");
const { isWireProtocol, WAREHOUSE_PRIVATE_PATH_HINT } =
  await import("@/utils/warehouse/destinations");
const { WAREHOUSE_LABELS } = await import("@/utils/warehouse/types");
type Cfg = Parameters<typeof assertWarehouseNetwork>[0];

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(() => {
  delete process.env.HTTPS_PROXY;
  delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
});

const pg = (over: Record<string, unknown> = {}) =>
  ({
    provider: "postgres",
    host: "db.corp.test",
    database: "app",
    username: "u",
    password: "p",
    ...over,
  }) as unknown as Cfg;
const snowflake = (over: Record<string, unknown> = {}) =>
  ({
    provider: "snowflake",
    account: "xy12345",
    token: "t",
    warehouse: "w",
    database: "d",
    ...over,
  }) as unknown as Cfg;

describe("which engines are wire protocols", () => {
  it("the Postgres, MySQL and SQL Server families; not the HTTPS engines", () => {
    for (const p of ["postgres", "cockroachdb", "mysql", "mariadb", "sqlserver"]) {
      expect(isWireProtocol({ provider: p } as never), p).toBe(true);
    }
    for (const p of ["snowflake", "bigquery", "databricks", "redshift", "trino", "oracle"]) {
      expect(isWireProtocol({ provider: p } as never), p).toBe(false);
    }
  });

  it("every engine says how it is reached privately", () => {
    expect(Object.keys(WAREHOUSE_PRIVATE_PATH_HINT).sort()).toEqual(
      Object.keys(WAREHOUSE_LABELS).sort(),
    );
    expect(WAREHOUSE_PRIVATE_PATH_HINT.snowflake).toMatch(/\.privatelink/);
  });
});

describe("the always-refused addresses, for a wire protocol", () => {
  it("refuses the metadata address, by literal and by a name resolving there", async () => {
    await expect(assertWarehouseNetwork(pg({ host: "169.254.169.254" }))).rejects.toThrow();
    answers["sneaky.corp.test"] = ["169.254.169.254"];
    await expect(assertWarehouseNetwork(pg({ host: "sneaky.corp.test" }))).rejects.toThrow();
  });

  it("allows a private database, the normal case, with no rule set", async () => {
    answers["db.corp.test"] = ["10.0.4.7"];
    await expect(assertWarehouseNetwork(pg())).resolves.toBeUndefined();
  });

  it("keeps private databases allowed under the deployment's private-network block, as for every connector", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    answers["db.corp.test"] = ["10.0.4.7"];
    await expect(assertWarehouseNetwork(pg())).resolves.toBeUndefined();
    await expect(assertWarehouseNetwork(pg({ host: "169.254.169.254" }))).rejects.toThrow();
  });

  it("says a name does not resolve, rather than letting the driver hang on it", async () => {
    await expect(assertWarehouseNetwork(pg({ host: "nowhere.test" }))).rejects.toThrow(
      /nowhere\.test/,
    );
  });

  it("refuses a name that does not resolve here even with a proxy set: the driver never uses it", async () => {
    // A proxied fetch may leave resolution to the proxy; the Postgres driver
    // would resolve the name again itself, and could get the metadata address.
    process.env.HTTPS_PROXY = "http://proxy.corp.test:3128";
    await expect(assertWarehouseNetwork(pg({ host: "nowhere.test" }))).rejects.toThrow(
      /nowhere\.test/,
    );
  });

  it("leaves the built-in lakehouse alone, the rule included", async () => {
    const lake = { provider: "lakehouse", require_private: true } as unknown as Cfg;
    await expect(assertWarehouseNetwork(lake)).resolves.toBeUndefined();
    expect(await warehousePath(lake)).toBeUndefined();
  });
});

describe("require a private network path", () => {
  it("a wire protocol: private passes, public is refused with the database's advice", async () => {
    answers["db.corp.test"] = ["10.0.4.7"];
    await expect(assertWarehouseNetwork(pg({ require_private: true }))).resolves.toBeUndefined();
    answers["db.corp.test"] = ["52.95.110.1"];
    const seen: string[] = [];
    await expect(
      assertWarehouseNetwork(pg({ require_private: true }), (d) => seen.push(d)),
    ).rejects.toThrow(/private network path/);
    expect(seen[0]).toMatch(/52\.95\.110\.1/);
    expect(seen[0]).toMatch(/VPN/);
    expect(seen[0]).not.toMatch(/proxy/);
  });

  it("a wire protocol never uses the proxy, so the proxy does not make it private", async () => {
    process.env.HTTPS_PROXY = "http://proxy.corp.test:3128";
    answers["db.corp.test"] = ["52.95.110.1"];
    await expect(assertWarehouseNetwork(pg({ require_private: true }))).rejects.toThrow(
      /private network path/,
    );
  });

  it("an HTTPS engine: leaving through the proxy counts; direct and public does not", async () => {
    answers["xy12345.snowflakecomputing.com"] = ["52.95.110.1"];
    await expect(assertWarehouseNetwork(snowflake({ require_private: true }))).rejects.toThrow(
      /proxy/,
    );
    process.env.HTTPS_PROXY = "http://proxy.corp.test:3128";
    await expect(
      assertWarehouseNetwork(snowflake({ require_private: true })),
    ).resolves.toBeUndefined();
  });

  it("checks the host the driver builds: a PrivateLink account", async () => {
    answers["xy12345.us-east-1.privatelink.snowflakecomputing.com"] = ["10.9.8.7"];
    await expect(
      assertWarehouseNetwork(
        snowflake({ account: "xy12345.us-east-1.privatelink", require_private: true }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("the path a test reports", () => {
  it("direct to the database's address, private or public", async () => {
    answers["db.corp.test"] = ["10.0.4.7"];
    expect(await warehousePath(pg())).toBe("direct to 10.0.4.7 (private)");
  });
});

// ── Where it is wired ────────────────────────────────────────────────────────
const rd = (p: string) => readFileSync(p, "utf8");

describe("every connection passes the check", () => {
  it("queries, tests and table listings, before the driver is chosen", () => {
    const d = rd("src/utils/warehouse/drivers.server.ts");
    const run = d.slice(d.indexOf("export async function executeWarehouseQuery"));
    const check = run.indexOf("await assertWarehouseNetwork(config);");
    expect(check).toBeGreaterThan(run.indexOf('if (config.provider === "lakehouse")'));
    expect(check).toBeLessThan(run.indexOf("const family = PROVIDER_FAMILY[config.provider];"));
  });

  it("Test connection audits a refusal and returns the path", () => {
    const f = rd("src/utils/warehouse.functions.ts");
    expect(f).toContain('action: "warehouse.private_path.refused"');
    expect(f).toMatch(/const path = await warehousePath\(conn\.config\);/);
    // The rule survives each engine's own schema, which strips unknown keys.
    expect(f).toMatch(
      /EngineConfigSchema\.and\(\s*z\.object\(\{ require_private: z\.boolean\(\)\.optional\(\) \}\)/,
    );
  });

  it("an ETL run checks its connections before it starts", () => {
    const etl = rd("src/utils/etl/service.server.ts");
    const db = etl.slice(
      etl.indexOf("const databaseEnv = async"),
      etl.indexOf("const graph = normalizeGraph"),
    );
    expect(db).toContain("await assertWarehouseNetwork(conn.config);");
  });

  it("the form sends the rule and shows the path", () => {
    const ui = rd("src/components/integrations/WarehousesTab.tsx");
    expect(ui).toContain("(config as Record<string, unknown>).require_private = true;");
    expect(ui.match(/Reached \$\{(test|res)\.path\}\./g)).toHaveLength(2);
  });
});
