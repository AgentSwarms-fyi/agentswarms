// A catalog source's crawl is claimed (R315).
//
// FOUND IN R315 (sweep 10's last open row). "Crawl now" checked the status it
// had read and then crawled, so two presses, or a press and the schedule, both
// passed the check and crawled the source twice: two crawls of the warehouse,
// two audit entries, the same changes announced twice. runCrawl now moves the
// source to "crawling" only from another status, or from a claim a dead crawl
// left behind (CATALOG_CRAWL_LEASE_MINUTES), the way R313 claims a
// knowledge-base sync.
//
// runCrawl runs here for real over an in-memory table store, with the
// warehouse driver faked and able to hold a crawl open while a second starts.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  listed: 0,
  audits: [] as string[],
  /** Holds the warehouse listing until released, so a second crawl can start meanwhile. */
  hold: null as null | Promise<void>,
}));

/** PostgREST's `or`: comma-separated `column.op.value`, values optionally quoted. */
function orFilter(expr: string): (r: Row) => boolean {
  const parts = expr.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  const tests = parts.map((p) => {
    const [col, op, ...rest] = p.split(".");
    const raw = rest.join(".");
    const v = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    return (r: Row) => {
      const x = String(r[col] ?? "");
      if (op === "neq") return x !== v;
      if (op === "lt") return x < v;
      if (op === "eq") return x === v;
      throw new Error(`fake or(): no ${op}`);
    };
  });
  return (r) => tests.some((t) => t(r));
}

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "upsert" | "delete" | "insert" = "select";
  let payload: Row | Row[] = {};
  let returning = false;
  const run = async (): Promise<{ data: unknown; error: null }> => {
    const rows = (db.tables[table] ??= []);
    const hit = () => rows.filter((r) => filters.every((f) => f(r)));
    if (op === "select") return { data: hit().map((r) => ({ ...r })), error: null };
    if (op === "update") {
      const h = hit();
      for (const r of h) Object.assign(r, payload);
      return { data: returning ? h.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "upsert" || op === "insert") {
      for (const p of Array.isArray(payload) ? payload : [payload]) {
        const same = rows.find((r) => r.source_id === p.source_id && r.fqn === p.fqn);
        if (same && op === "upsert") Object.assign(same, p);
        else rows.push({ id: `${table}-${++db.seq}`, ...p });
      }
      return { data: null, error: null };
    }
    const h = hit();
    db.tables[table] = rows.filter((r) => !h.includes(r));
    return { data: null, error: null };
  };
  const b = {
    select: () => ((returning = op !== "select"), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    upsert: (p: Row | Row[]) => ((op = "upsert"), (payload = p), b),
    insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
    delete: () => ((op = "delete"), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    lte: (k: string, v: unknown) => (filters.push((r) => String(r[k]) <= String(v)), b),
    or: (expr: string) => (filters.push(orFilter(expr)), b),
    order: () => b,
    limit: () => b,
    maybeSingle: async () => {
      const res = await run();
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => from(t) },
}));
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: { action: string }) => db.audits.push(e.action),
}));
vi.mock("@/utils/warehouse/drivers.server", () => ({
  listWarehouseTables: async () => {
    db.listed++;
    if (db.hold) await db.hold;
    return [{ schema: "public", name: "orders", columns: [{ name: "id", type: "integer" }] }];
  },
  executeWarehouseQuery: async () => ({ columns: [], rows: [] }),
}));

const { runCrawl, CrawlAlreadyRunning } = await import("@/utils/catalog/crawler.server");

const SOURCE = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const sourceRow = {
  id: SOURCE,
  user_id: "user-1",
  name: "r315 warehouse",
  kind: "warehouse",
  connection_id: "conn-1",
  crawl_schedule: "manual",
  last_crawl_at: null,
};
type Source = Parameters<typeof runCrawl>[1];
const crawl = () =>
  runCrawl(
    "user-1",
    { ...sourceRow, status: "ready" } as unknown as Source,
    async () => ({ provider: "postgres" }) as never,
    async () => {
      throw new Error("no object storage here");
    },
  );
const source = () => db.tables.catalog_sources[0];
const until = async (done: () => boolean) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};

beforeEach(() => {
  db.seq = 0;
  db.listed = 0;
  db.audits = [];
  db.hold = null;
  db.tables = {
    catalog_sources: [{ ...sourceRow, status: "ready", updated_at: new Date().toISOString() }],
    catalog_assets: [],
  };
});

describe("Crawl now pressed while a crawl of the same source runs", () => {
  it("does not crawl, says one is running, and leaves the first to finish", async () => {
    let release = () => {};
    db.hold = new Promise<void>((r) => (release = r));
    const first = crawl();
    await until(() => db.listed === 1);

    await expect(crawl()).rejects.toBeInstanceOf(CrawlAlreadyRunning);
    expect(db.listed).toBe(1);
    expect(source().status).toBe("crawling");

    release();
    const stats = await first;
    expect(stats.assets).toBe(1);
    expect(source().status).toBe("ready");
    expect(db.audits).toEqual(["catalog.crawl"]);
  });

  it("is not recorded as a failure on the source", async () => {
    let release = () => {};
    db.hold = new Promise<void>((r) => (release = r));
    const first = crawl();
    await until(() => db.listed === 1);
    await expect(crawl()).rejects.toThrow(/already running/);
    expect(source().last_error ?? null).toBe(null);
    release();
    await first;
  });
});

describe("a claim left behind", () => {
  it("by a crawl that died is taken over once the lease has passed", async () => {
    Object.assign(source(), {
      status: "crawling",
      updated_at: new Date(Date.now() - 61 * 60_000).toISOString(),
    });
    await expect(crawl()).resolves.toMatchObject({ assets: 1 });
    expect(source().status).toBe("ready");
  });

  it("within the lease is still a crawl running", async () => {
    Object.assign(source(), {
      status: "crawling",
      updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await expect(crawl()).rejects.toBeInstanceOf(CrawlAlreadyRunning);
    expect(db.listed).toBe(0);
  });
});

describe("the callers", () => {
  it("the schedule does not announce a crawl that was already running as failed", () => {
    const src = readFileSync("src/utils/catalog/schedule.server.ts", "utf8");
    const i = src.indexOf("} catch (e) {");
    expect(src.slice(i, i + 200)).toContain("if (e instanceof CrawlAlreadyRunning) continue;");
  });
});
