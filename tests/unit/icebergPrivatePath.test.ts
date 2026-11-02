// R428 (private connectivity, Phase 3): an Iceberg catalog over a private path.
//
// DuckDB's iceberg extension calls a catalog's REST endpoint and token server
// itself, from the shared engine. A catalog may now require a private network
// path: it attaches only when both names resolve, from this server, to private
// addresses (a proxy is not counted: the engine reads the proxy settings from
// the environment itself), and every engine sync checks an attached catalog
// again, detaching one whose name has stopped resolving privately. The rule
// is a column (migration 20261104000000); until it runs, every catalog reads
// as not requiring it and a save that asks for it says which migration to
// apply. A path report says which way the engine would go, before saving.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const answers: Record<string, string[]> = {};
  const calls: Array<{
    table: string;
    op: string;
    payload?: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }> = [];
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    writeError: null as { code?: string; message?: string } | null,
    attachError: "",
  };
  const sqls: string[] = [];
  const conn = {
    run: async (sql: string) => {
      sqls.push(sql);
      if (state.attachError && sql.startsWith("ATTACH")) throw new Error(state.attachError);
      return { getRows: async () => [["sales"]] };
    },
    closeSync: () => undefined,
  };
  return { answers, calls, state, sqls, conn };
});

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = h.answers[host];
    if (!a) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

function builder(table: string) {
  const call = {
    table,
    op: "select",
    payload: undefined as Record<string, unknown> | undefined,
    filters: [] as Array<[string, unknown]>,
  };
  h.calls.push(call);
  const result = () => {
    if (call.op === "select") {
      return {
        data: h.state.rows.filter((r) => call.filters.every(([k, v]) => r[k] === v)),
        error: null,
      };
    }
    if (h.state.writeError) return { data: null, error: h.state.writeError };
    return {
      data: call.op === "insert" ? { id: "99999999-2222-4333-8444-555555555555" } : null,
      error: null,
    };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    not: () => b,
    insert: (p: Record<string, unknown>) => ((call.op = "insert"), (call.payload = p), b),
    update: (p: Record<string, unknown>) => ((call.op = "update"), (call.payload = p), b),
    eq: (k: string, v: unknown) => (call.filters.push([k, v]), b),
    single: async () => result(),
    maybeSingle: async () => {
      const r = result();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/secrets.server", () => ({ resolveSecretRefs: vi.fn() }));
vi.mock("@/utils/lakehouse/core.server", () => ({
  lakehouseConnection: async () => h.conn,
  icebergExtensionAvailable: () => true,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      middleware: () => b,
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => async (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));

import { auditEvent } from "@/utils/audit.server";
import {
  icebergCatalogCreate,
  icebergCatalogNetworkPath,
  icebergCatalogSetRequirePrivate,
} from "@/utils/icebergCatalogs.functions";
import {
  assertIcebergUrlsAllowed,
  configOf,
  ensureIcebergCatalogs,
  explainMissingIcebergCatalog,
  type IcebergCatalogRow,
} from "@/utils/lakehouse/iceberg.server";
import type { IcebergCatalogConfig } from "@/utils/lakehouse/iceberg";

type Fn = (o: { data: unknown }) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
const create = icebergCatalogCreate as unknown as Fn;
const networkPath = icebergCatalogNetworkPath as unknown as Fn;
const setRule = icebergCatalogSetRequirePrivate as unknown as Fn;
const audit = vi.mocked(auditEvent);

const CFG: IcebergCatalogConfig = {
  name: "lake_cat",
  endpoint: "http://catalog.corp.test:8181/catalog",
  warehouse: "wh",
  auth_type: "none",
  token_secret: "",
  client_id_secret: "",
  client_secret_secret: "",
  oauth2_server_uri: "",
  storage: "vended",
  require_private: true,
};

const REFUSED_PUBLIC =
  'The Iceberg catalog "lake_cat" is set to require a private network path, but catalog.corp.test ' +
  "resolves to a public address (203.0.113.9) from this server, so the call was not sent. Check the " +
  "catalog's private DNS zone, or the route to it over the VPN or peering link. A proxy does not " +
  "count here: the lakehouse engine decides itself whether to use one.";

beforeEach(() => {
  for (const k of Object.keys(h.answers)) delete h.answers[k];
  h.answers["catalog.corp.test"] = ["10.0.12.34"];
  h.answers["auth.corp.test"] = ["10.0.12.35"];
  h.calls.length = 0;
  h.sqls.length = 0;
  h.state.rows = [];
  h.state.writeError = null;
  h.state.attachError = "";
  audit.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const writes = (op: string) => h.calls.filter((c) => c.table === "iceberg_catalogs" && c.op === op);

describe("the rule, at every attach", () => {
  it("passes a catalog whose names resolve privately, under BLOCK_PRIVATE_NETWORK_FETCH too", async () => {
    vi.stubEnv("BLOCK_PRIVATE_NETWORK_FETCH", "true");
    await expect(assertIcebergUrlsAllowed(CFG)).resolves.toBeUndefined();
  });

  it("refuses a public endpoint, in words, and tells the audit hook", async () => {
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    const heard: string[] = [];
    await expect(assertIcebergUrlsAllowed(CFG, (d) => heard.push(d))).rejects.toThrow(
      REFUSED_PUBLIC,
    );
    expect(heard).toEqual([REFUSED_PUBLIC]);
  });

  it("refuses a name with any public address among its answers", async () => {
    h.answers["catalog.corp.test"] = ["10.0.12.34", "203.0.113.9"];
    await expect(assertIcebergUrlsAllowed(CFG)).rejects.toThrow(
      /public address \(203\.0\.113\.9\)/,
    );
  });

  it("checks the OAuth2 token server too", async () => {
    h.answers["auth.corp.test"] = ["198.51.100.7"];
    const cfg = {
      ...CFG,
      auth_type: "oauth2" as const,
      oauth2_server_uri: "http://auth.corp.test/token",
    };
    await expect(assertIcebergUrlsAllowed(cfg)).rejects.toThrow(
      /but auth\.corp\.test resolves to a public address \(198\.51\.100\.7\)/,
    );
  });

  it("does not count a proxy: the engine decides itself whether to use one", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp.test:3128");
    vi.stubEnv("HTTP_PROXY", "http://proxy.corp.test:3128");
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    await expect(assertIcebergUrlsAllowed(CFG)).rejects.toThrow(REFUSED_PUBLIC);
  });

  it("without the rule, a public catalog attaches as before", async () => {
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    await expect(
      assertIcebergUrlsAllowed({ ...CFG, require_private: false }),
    ).resolves.toBeUndefined();
  });

  it("the metadata address is refused with or without the rule", async () => {
    h.answers["catalog.corp.test"] = ["169.254.169.254"];
    for (const require_private of [true, false]) {
      await expect(assertIcebergUrlsAllowed({ ...CFG, require_private })).rejects.toThrow(
        /Iceberg catalog endpoint: .*(metadata|link-local)/i,
      );
    }
  });

  it("a row from before the migration reads as not requiring it", () => {
    const row = { ...CFG, id: "x", user_id: "u1" } as unknown as IcebergCatalogRow;
    delete (row as Record<string, unknown>).require_private;
    expect(configOf(row).require_private).toBe(false);
    expect(configOf({ ...row, require_private: true }).require_private).toBe(true);
  });
});

describe("every engine sync checks an attached catalog again", () => {
  const row = (id: string, require_private: boolean) => ({
    ...CFG,
    id,
    user_id: "u1",
    name: "lake_cat",
    token_secret: null,
    client_id_secret: null,
    client_secret_secret: null,
    oauth2_server_uri: null,
    is_active: true,
    last_error: null,
    require_private,
  });

  it("detaches a catalog whose name stops resolving privately, says why, audits it", async () => {
    const id = "aaaaaaaa-2222-4333-8444-555555555555";
    h.state.rows = [row(id, true)];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(h.sqls.some((s) => s.startsWith("ATTACH IF NOT EXISTS 'wh' AS \"ice_aaaaaaaa"))).toBe(
      true,
    );

    h.sqls.length = 0;
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(h.sqls).toEqual(['DETACH DATABASE IF EXISTS "ice_aaaaaaaa222243338444555555555555";']);
    const recorded = writes("update").map((c) => c.payload?.last_error);
    expect(recorded).toEqual([REFUSED_PUBLIC]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lakehouse.iceberg.private_path.refused",
        resourceName: "lake_cat",
        detail: { reason: REFUSED_PUBLIC },
      }),
    );

    // And it stays detached: an ordinary sync waits for the retry backoff...
    audit.mockClear();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 20_000);
    await ensureIcebergCatalogs(h.conn as never);
    expect(audit).not.toHaveBeenCalled();
    // ...and a forced one is refused again, before the engine is asked.
    h.sqls.length = 0;
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(h.sqls.filter((s) => s.startsWith("ATTACH"))).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);

    // Once the name resolves privately again, the next forced sync attaches it.
    h.answers["catalog.corp.test"] = ["10.0.12.34"];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(h.sqls.filter((s) => s.startsWith("ATTACH"))).toHaveLength(1);
    clock.mockRestore();
  });

  // FOUND IN R428's second UI round: a query on a mount of a catalog the sync
  // had detached answered `Catalog "ice_…" does not exist!`, naming neither the
  // catalog nor the rule. The statement's retry now asks for the reason.
  it("a statement that meets the detached catalog hears which one and why", async () => {
    const id = "dddddddd-2222-4333-8444-555555555555";
    const missing = 'Binder Error: Catalog "ice_dddddddd222243338444555555555555" does not exist!';
    h.state.rows = [row(id, true)];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(explainMissingIcebergCatalog(missing, "u1")).toBeNull();

    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(explainMissingIcebergCatalog(missing, "u1")).toBe(
      `This statement reads the Iceberg catalog "lake_cat", which is not attached: ${REFUSED_PUBLIC}`,
    );
    // Someone reading a shared mount hears the name, not the endpoint.
    expect(explainMissingIcebergCatalog(missing, "u2")).toBe(
      'This statement reads the Iceberg catalog "lake_cat", which is not attached on this server; its owner can see why under Lakehouse → Iceberg.',
    );
    // Another catalog's alias, or another error, is left to the engine's words.
    expect(
      explainMissingIcebergCatalog(
        'Binder Error: Catalog "ice_eeeeeeee222243338444555555555555" does not exist!',
        "u1",
      ),
    ).toBeNull();
    expect(
      explainMissingIcebergCatalog("Catalog Error: Table with name x does not exist!", "u1"),
    ).toBeNull();

    // Attached again: no reason is left to give.
    h.answers["catalog.corp.test"] = ["10.0.12.34"];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(explainMissingIcebergCatalog(missing, "u1")).toBeNull();
  });

  it("a catalog that did not attach gives the engine's reason", async () => {
    const id = "ffffffff-2222-4333-8444-555555555555";
    h.state.rows = [row(id, false)];
    h.state.attachError = "IO Error: Could not connect to catalog.corp.test: connection refused";
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(
      explainMissingIcebergCatalog(
        'Binder Error: Catalog "ice_ffffffff222243338444555555555555" does not exist!',
        "u1",
      ),
    ).toBe(
      'This statement reads the Iceberg catalog "lake_cat", which is not attached: IO Error: Could not connect to catalog.corp.test: connection refused',
    );
  });

  it("the query retries through it after the forced sync", () => {
    const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    const retry = core.slice(core.indexOf("await ice.ensureIcebergCatalogs(conn, true);"));
    expect(retry.slice(0, 400)).toContain(
      "ice.explainMissingIcebergCatalog((again as Error).message, userId)",
    );
  });

  it("leaves a catalog without the rule attached when its name turns public", async () => {
    const id = "bbbbbbbb-2222-4333-8444-555555555555";
    h.state.rows = [row(id, false)];
    await ensureIcebergCatalogs(h.conn as never, true);
    h.sqls.length = 0;
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    await ensureIcebergCatalogs(h.conn as never, true);
    expect(h.sqls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("adding a catalog", () => {
  const add = (config: Partial<IcebergCatalogConfig>) =>
    create({ data: { access_token: "t", config: { ...CFG, ...config } } });

  it("with the rule and a public endpoint: refused before anything is saved", async () => {
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    const r = await add({});
    // Refused before anything was sent: not "The catalog did not answer".
    expect(r).toEqual({ ok: false, error: REFUSED_PUBLIC });
    expect(writes("insert")).toEqual([]);
    expect(h.sqls.filter((s) => s.startsWith("ATTACH"))).toEqual([]);
  });

  it("a metadata endpoint is refused in its own words, not as a catalog that did not answer", async () => {
    h.answers["catalog.corp.test"] = ["169.254.169.254"];
    const r = await add({ require_private: false });
    expect(r.error).toMatch(
      /^Iceberg catalog endpoint: Refusing to fetch link-local\/metadata address/,
    );
    expect(h.sqls.filter((x) => x.startsWith("ATTACH"))).toEqual([]);
  });

  it("a catalog the engine could not reach still says it did not answer", async () => {
    h.state.attachError = "IO Error: Could not connect to server";
    expect(await add({})).toEqual({
      ok: false,
      error: "The catalog did not answer: IO Error: Could not connect to server",
    });
    expect(writes("insert")).toEqual([]);
  });

  it("with the rule and a private endpoint: saved with it", async () => {
    const r = await add({});
    expect(r.ok).toBe(true);
    expect(writes("insert")[0].payload).toMatchObject({ name: "lake_cat", require_private: true });
  });

  it("without the rule: the column is not named, so a database before the migration saves it", async () => {
    await add({ require_private: false });
    expect(writes("insert")[0].payload).not.toHaveProperty("require_private");
  });

  it("with the rule, before the migration: says which migration to apply", async () => {
    h.state.writeError = {
      code: "PGRST204",
      message:
        "Could not find the 'require_private' column of 'iceberg_catalogs' in the schema cache",
    };
    expect(await add({})).toEqual({
      ok: false,
      error:
        "Require a private network path needs the database migration " +
        "20261104000000_iceberg_catalog_require_private. Apply it, or add the catalog without the rule.",
    });
  });
});

describe("turning the rule on or off for a saved catalog", () => {
  const ID = "cccccccc-2222-4333-8444-555555555555";
  beforeEach(() => {
    h.state.rows = [{ ...CFG, id: ID, user_id: "u1", require_private: false }];
  });
  const toggle = (on: boolean) =>
    setRule({ data: { access_token: "t", id: ID, require_private: on } });

  it("on, while the endpoint resolves publicly: refused with the reason, nothing changed", async () => {
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    expect(await toggle(true)).toEqual({ ok: false, error: REFUSED_PUBLIC });
    expect(writes("update")).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lakehouse.iceberg.private_path.refused", resourceId: ID }),
    );
  });

  it("on, when it resolves privately: saved, and the change is audited", async () => {
    expect(await toggle(true)).toEqual({ ok: true });
    expect(writes("update")[0].payload).toEqual({ require_private: true });
    expect(writes("update")[0].filters).toEqual([
      ["id", ID],
      ["user_id", "u1"],
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lakehouse.iceberg.network_rule",
        detail: { require_private: true },
      }),
    );
  });

  it("off: saved without a check", async () => {
    h.answers["catalog.corp.test"] = ["203.0.113.9"];
    expect(await toggle(false)).toEqual({ ok: true });
    expect(writes("update")[0].payload).toEqual({ require_private: false });
  });

  it("someone else's catalog is not found", async () => {
    h.state.rows = [{ ...CFG, id: ID, user_id: "u2" }];
    expect(await toggle(true)).toEqual({ ok: false, error: "Catalog not found" });
  });

  it("before the migration: says which migration to apply", async () => {
    h.state.writeError = { code: "42703", message: 'column "require_private" does not exist' };
    expect((await toggle(false)).error).toMatch(
      /^Require a private network path needs the database migration 20261104000000/,
    );
  });
});

describe("the path report", () => {
  const report = (endpoint: string, oauth2_server_uri = "") =>
    networkPath({ data: { access_token: "t", endpoint, oauth2_server_uri } });

  it("says where each name resolves, private or public", async () => {
    h.answers["auth.corp.test"] = ["198.51.100.7"];
    expect(
      await report("http://catalog.corp.test:8181/catalog", "http://auth.corp.test/token"),
    ).toEqual({
      ok: true,
      lines: [
        { label: "endpoint", summary: "direct to 10.0.12.34 (private)", private: true },
        { label: "OAuth2 server URI", summary: "direct to 198.51.100.7 (public)", private: false },
      ],
    });
  });

  it("notes a proxy rather than assuming the engine uses it", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.corp.test:3128");
    const r = await report("http://catalog.corp.test:8181/catalog");
    expect(r.lines).toEqual([
      {
        label: "endpoint",
        summary:
          "direct to 10.0.12.34 (private); with a proxy set, the engine uses it unless NO_PROXY names the host",
        private: true,
      },
    ]);
  });

  it("refuses the metadata address and a name that does not resolve, and asks for an endpoint", async () => {
    h.answers["catalog.corp.test"] = ["169.254.169.254"];
    expect((await report("http://catalog.corp.test/catalog")).error).toMatch(
      /^Iceberg catalog endpoint: .*(metadata|link-local)/i,
    );
    expect((await report("http://nowhere.corp.test/catalog")).error).toMatch(
      /nowhere\.corp\.test does not resolve from this server/,
    );
    expect(await report("")).toEqual({ ok: false, error: "Enter the REST endpoint first." });
  });
});
