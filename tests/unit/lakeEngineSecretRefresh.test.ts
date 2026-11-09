// R465: the engine's store secret follows the credentials.
//
// The shared DuckDB engine holds the store's credentials in one secret,
// lakehouse_s3, built at boot. With fixed keys that is fine for ever. With the
// AWS chain the credentials are temporary: a secret left as it was would
// start failing every read the moment its session token lapsed, on every
// worker at once. So each connection checks the credentials in force (one
// already-resolved promise for fixed keys) and rebuilds the secret, and every
// customer key's copy of it, when they have changed.
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  creds: {
    accessKeyId: "ASIAONE",
    secretAccessKey: "secret-one",
    sessionToken: "token-one",
    expiresAt: 1_000 as number | null,
    mode: "chain" as "chain" | "keys" | "none",
    source: "test",
  },
  customerKeySyncs: [] as boolean[],
}));

vi.mock("@/utils/lakehouse/lakeCredentials.server", async (orig) => ({
  ...(await orig<typeof import("@/utils/lakehouse/lakeCredentials.server")>()),
  lakeCredentials: async () => ({ ...state.creds }),
}));
vi.mock("@/utils/lakehouse/customerKeyFiles.server", () => ({
  ensureCustomerKeySecrets: async (_c: unknown, force?: boolean) => {
    state.customerKeySyncs.push(Boolean(force));
  },
}));

const { refreshEngineSecretIfDue } = await import("@/utils/lakehouse/core.server");

afterEach(() => vi.unstubAllEnvs());

function fakeConnection() {
  const sql: string[] = [];
  return { sql, run: async (s: string) => (sql.push(s), undefined as never) };
}

describe("the engine's store secret", () => {
  it("is rebuilt, with the customer keys' copies, only when the credentials change", async () => {
    vi.stubEnv("LAKEHOUSE_CATALOG_URL", "postgres://lake:pw@db/lake");
    vi.stubEnv("LAKEHOUSE_DATA_URL", "s3://lake/main");
    const c = fakeConnection();

    // First sight in this process: built, with the session token.
    await refreshEngineSecretIfDue(c);
    expect(c.sql).toHaveLength(1);
    expect(c.sql[0]).toMatch(/^CREATE OR REPLACE SECRET lakehouse_s3 \(/);
    expect(c.sql[0]).toContain("SESSION_TOKEN 'token-one'");
    expect(state.customerKeySyncs).toEqual([true]);

    // Same credentials (the chain's cache): nothing is run.
    await refreshEngineSecretIfDue(c);
    await refreshEngineSecretIfDue(c);
    expect(c.sql).toHaveLength(1);

    // The chain hands out new ones five minutes before the old expire.
    state.creds = {
      ...state.creds,
      accessKeyId: "ASIATWO",
      secretAccessKey: "secret-two",
      sessionToken: "token-two",
      expiresAt: 2_000,
    };
    await refreshEngineSecretIfDue(c);
    expect(c.sql).toHaveLength(2);
    expect(c.sql[1]).toContain("KEY_ID 'ASIATWO'");
    expect(c.sql[1]).toContain("SESSION_TOKEN 'token-two'");
    expect(c.sql[1]).not.toContain("token-one");
    // Forced: the customer keys' secrets copy the store's credentials.
    expect(state.customerKeySyncs).toEqual([true, true]);
  });

  it("fixed keys are built once and never again", async () => {
    vi.stubEnv("LAKEHOUSE_CATALOG_URL", "postgres://lake:pw@db/lake");
    vi.stubEnv("LAKEHOUSE_DATA_URL", "s3://lake/main");
    state.creds = {
      accessKeyId: "AKIAFIXED",
      secretAccessKey: "fixed",
      sessionToken: undefined as unknown as string,
      expiresAt: null,
      mode: "keys",
      source: "test",
    };
    const c = fakeConnection();
    for (let i = 0; i < 5; i++) await refreshEngineSecretIfDue(c);
    expect(c.sql).toHaveLength(1);
    expect(c.sql[0]).not.toContain("SESSION_TOKEN");
  });

  it("runs on every connection the engine hands out", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    const body = src.slice(src.indexOf("export async function lakehouseConnection"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(
      /await c\.run\("USE lake;"\);\s*await refreshEngineSecretIfDue\(c\);/,
    );
  });
});
