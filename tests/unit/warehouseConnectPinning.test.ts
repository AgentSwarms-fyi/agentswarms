// A wire-protocol driver connects only to an address that has just been
// checked (R425).
//
// R424 checked a database's host before the driver connected, but the driver
// (pg, mysql2, tedious) then resolved the name again itself: a resolver could
// answer the check with a safe address and the driver with the cloud metadata
// address. Each driver now resolves through guardedLookup
// (src/utils/warehouse/network.server.ts), which checks the addresses it
// hands the socket.
//
// The proof runs real drivers over real sockets. The names here (`*.pin.test`)
// resolve only through the mocked resolver, to a local server on 127.0.0.1:
// a driver that reaches the server resolved through the guarded lookup, since
// the system resolver cannot answer a `.test` name, and a driver refused by it
// never reaches the server at all.
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Answer = string[] | ((call: number) => string[]);
const answers: Record<string, Answer> = {};
const calls: Record<string, number> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const a = answers[host];
    const list = typeof a === "function" ? a(calls[host]) : a;
    if (!list)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const { guardedLookup, pgStream, mysqlStream, tdsConnector } =
  await import("@/utils/warehouse/network.server");
const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
const { closeAllPools, getPool } = await import("@/utils/warehouse/pool.server");
// Loaded here, not inside a test: a cold load of tedious or mysql2 on a slow
// disk can take longer than a test's timeout.
const { Client: PgClient } = await import("pg");
const mysql = await import("mysql2/promise");
const { Connection: TdsConnection } = await import("tedious");
type Cfg = Parameters<typeof executeWarehouseQuery>[0];

// ── A local server that counts the connections it is offered ─────────────────
let server: Server;
let port = 0;
let accepted = 0;
const open = new Set<NetSocket>();
beforeAll(async () => {
  server = createServer((s) => {
    accepted += 1;
    open.add(s);
    s.on("close", () => open.delete(s));
    s.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  for (const s of open) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  accepted = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(calls)) delete calls[k];
});
afterEach(async () => {
  await closeAllPools();
  delete process.env.WAREHOUSE_POOL;
});

/** The lookup's answer, as a promise: the error, or what it handed over. */
function look(requirePrivate: boolean, host: string, all = false) {
  return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
    guardedLookup(requirePrivate)(host, { all }, (err, address, family) =>
      resolve({ err, address, family }),
    ),
  );
}

describe("the guarded lookup", () => {
  it("hands over exactly the addresses it checked, one or all", async () => {
    answers["db.pin.test"] = ["10.0.4.7", "10.0.4.8"];
    expect(await look(false, "db.pin.test")).toEqual({
      err: null,
      address: "10.0.4.7",
      family: 4,
    });
    const all = await look(false, "db.pin.test", true);
    expect(all.err).toBeNull();
    expect(all.address).toEqual([
      { address: "10.0.4.7", family: 4 },
      { address: "10.0.4.8", family: 4 },
    ]);
  });

  it("refuses a name resolving to the metadata address, alone or among private ones", async () => {
    answers["evil.pin.test"] = ["169.254.169.254"];
    const r = await look(false, "evil.pin.test");
    expect(r.err?.message).toBe(
      "Refusing to connect to link-local/metadata address: 169.254.169.254 (resolved from evil.pin.test)",
    );
    answers["mixed.pin.test"] = ["10.0.4.7", "169.254.169.254"];
    expect((await look(false, "mixed.pin.test", true)).err?.message).toMatch(/169\.254\.169\.254/);
  });

  it("without the rule, a public address passes; with it, it is refused with the database's advice", async () => {
    answers["pub.pin.test"] = ["52.95.110.1"];
    expect((await look(false, "pub.pin.test")).err).toBeNull();
    const r = await look(true, "pub.pin.test");
    expect(r.err?.name).toBe("PrivatePathRequiredError");
    expect(r.err?.message).toMatch(/require a private network path.*52\.95\.110\.1.*VPN/);
    answers["priv.pin.test"] = ["10.0.4.7"];
    expect((await look(true, "priv.pin.test")).err).toBeNull();
  });

  it("passes a resolver failure through as it is", async () => {
    const r = await look(false, "nowhere.pin.test");
    expect((r.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

// ── Each driver connects through it ──────────────────────────────────────────

/** Settle a driver's connect, whatever it reports. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "connected";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("each driver resolves through the guarded lookup", () => {
  it("pg", async () => {
    const connect = () =>
      new PgClient({
        host: "db.pin.test",
        port,
        user: "u",
        password: "p",
        database: "d",
        stream: pgStream(guardedLookup(false)),
        connectionTimeoutMillis: 5_000,
      }).connect();
    answers["db.pin.test"] = ["127.0.0.1"];
    await outcome(connect());
    expect(accepted).toBe(1);
    answers["db.pin.test"] = ["169.254.169.254"];
    expect(await outcome(connect())).toMatch(/Refusing to connect to link-local\/metadata/);
    expect(accepted).toBe(1);
  });

  it("mysql2", async () => {
    const connect = () =>
      mysql.createConnection({
        host: "db.pin.test",
        port,
        user: "u",
        password: "p",
        stream: mysqlStream(guardedLookup(false)),
        connectTimeout: 5_000,
      });
    answers["db.pin.test"] = ["127.0.0.1"];
    await outcome(connect());
    expect(accepted).toBe(1);
    answers["db.pin.test"] = ["169.254.169.254"];
    expect(await outcome(connect())).toMatch(/Refusing to connect to link-local\/metadata/);
    expect(accepted).toBe(1);
  });

  it("tedious, which hands its connector the host and port it would connect to", async () => {
    const connect = () =>
      new Promise<string>((resolve) => {
        const c = new TdsConnection({
          server: "db.pin.test",
          authentication: { type: "default", options: { userName: "u", password: "p" } },
          options: {
            port,
            encrypt: false,
            connectTimeout: 5_000,
            connector: tdsConnector(guardedLookup(false)),
          },
        });
        c.on("connect", (err) => {
          c.close();
          resolve(err ? err.message : "connected");
        });
        c.on("error", (err) => resolve(err.message));
        c.connect();
      });
    answers["db.pin.test"] = ["127.0.0.1"];
    await connect();
    expect(accepted).toBe(1);
    answers["db.pin.test"] = ["169.254.169.254"];
    expect(await connect()).toMatch(/Refusing to connect to link-local\/metadata/);
    expect(accepted).toBe(1);
  });
});

// ── The rebinding the check could not see ────────────────────────────────────

describe("a name that answers the check safely and the driver with the metadata address", () => {
  // The pre-check (assertWarehouseNetwork) resolves the name once; the driver
  // resolves it again. The first answer is the local server, every later one
  // the metadata address.
  const rebinding = (host: string) => {
    answers[host] = (call) => (call === 1 ? ["127.0.0.1"] : ["169.254.169.254"]);
  };
  const cases: [string, Record<string, unknown>][] = [
    ["Postgres", { provider: "postgres", database: "d" }],
    ["MySQL", { provider: "mysql", database: "d" }],
    ["SQL Server", { provider: "sqlserver", database: "d", ssl: "disable" }],
  ];
  for (const pooled of [true, false]) {
    for (const [label, cfg] of cases) {
      it(`${label}, ${pooled ? "pooled" : "one connection per query"}: refused before it connects`, async () => {
        if (!pooled) process.env.WAREHOUSE_POOL = "off";
        const host = `rebind-${label.replace(/\W/g, "").toLowerCase()}-${pooled}.pin.test`;
        rebinding(host);
        const config = {
          ...cfg,
          host,
          port: String(port),
          username: "u",
          password: `p-${pooled}`,
        } as unknown as Cfg;
        expect(await outcome(executeWarehouseQuery(config, "select 1"))).toMatch(
          /Refusing to connect to link-local\/metadata address: 169\.254\.169\.254/,
        );
        expect(calls[host]).toBeGreaterThanOrEqual(2);
        expect(accepted).toBe(0);
      });
    }
  }
});

describe("a pool keeps the connection's rule", () => {
  it("a pool built for a connection that requires a private path refuses a public address", async () => {
    answers["pub-pool.pin.test"] = ["203.0.113.10"];
    const pool = (await getPool("postgres", {
      host: "pub-pool.pin.test",
      port,
      database: "d",
      username: "u",
      password: "rule",
      require_private: true,
    })) as import("pg").Pool;
    expect(await outcome(pool.query("select 1"))).toMatch(/require a private network path/);
  });

  it("the rule is part of the pool key, so turning it on builds a new pool", async () => {
    const cfg = { host: "db.pin.test", port, database: "d", username: "u", password: "k" };
    const open = await getPool("postgres", cfg);
    const strict = await getPool("postgres", { ...cfg, require_private: true });
    expect(strict).not.toBe(open);
  });
});

// ── Where it is wired ────────────────────────────────────────────────────────
describe("every wire-protocol socket is built with the connection's lookup", () => {
  const drivers = readFileSync("src/utils/warehouse/drivers.server.ts", "utf8");
  const pools = readFileSync("src/utils/warehouse/pool.server.ts", "utf8");
  it("the drivers' one-connection paths", () => {
    expect(drivers).toContain("connector: tdsConnector(connectionLookup(cfg)),");
    expect(drivers).toContain("stream: pgStream(connectionLookup(config)),");
    expect(drivers).toContain("stream: mysqlStream(connectionLookup(config)),");
  });
  it("both pools", () => {
    expect(pools).toContain("stream: pgStream(connectionLookup(cfg)),");
    expect(pools).toContain("stream: mysqlStream(connectionLookup(cfg)),");
  });
});
