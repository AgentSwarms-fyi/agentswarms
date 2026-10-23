// A knowledge-base source's sync is claimed (R313).
//
// FOUND IN R313. Nothing claimed a sync: "Sync now" could run beside a
// scheduled sync or a second tab's. Both read the same documents and inserted
// the same new ones; the second hit their unique key and said "error" about a
// sync that had succeeded, and whichever finished last decided what the source
// read. Driven: Sync now pressed in two tabs on one website source.
//
// The connector engine and the URL and GitHub re-sync routes run here for real
// over an in-memory table store, with the connector and the embedder faked.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  listed: 0,
  fetched: [] as string[],
  /** Holds the connector's listing until released, so a second sync can start meanwhile. */
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
      if (op === "eq") return x === v;
      if (op === "neq") return x !== v;
      if (op === "lt") return x < v;
      throw new Error(`fake or(): no ${op}`);
    };
  });
  return (r) => tests.some((t) => t(r));
}

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row = {};
  let returning = false;
  const match = (r: Row) => filters.every((f) => f(r));
  const run = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
    const rows = (db.tables[table] ??= []);
    if (op === "select") return { data: rows.filter(match).map((r) => ({ ...r })), error: null };
    if (op === "insert") {
      if (
        table === "knowledge_documents" &&
        rows.some((r) => r.source_id === payload.source_id && r.external_id === payload.external_id)
      ) {
        return {
          data: null,
          error: {
            message:
              'duplicate key value violates unique constraint "idx_knowledge_documents_source_external"',
          },
        };
      }
      const row = { id: `${table}-${++db.seq}`, ...payload };
      rows.push(row);
      return { data: returning ? [{ ...row }] : null, error: null };
    }
    const hit = rows.filter(match);
    if (op === "update") {
      // The table's trigger keeps updated_at.
      for (const r of hit) Object.assign(r, payload, { updated_at: new Date().toISOString() });
    } else db.tables[table] = rows.filter((r) => !hit.includes(r));
    return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
  };
  const first = async () => {
    const res = await run();
    if (res.error) return { data: null, error: res.error };
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
  };
  const b = {
    select: () => ((returning = op !== "select"), b),
    insert: (row: Row) => ((op = "insert"), (payload = row), b),
    update: (patch: Row) => ((op = "update"), (payload = patch), b),
    delete: () => ((op = "delete"), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    or: (expr: string) => (filters.push(orFilter(expr)), b),
    single: first,
    maybeSingle: first,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}
const fakeClient = {
  from: (t: string) => from(t),
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
};

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/utils/providers/crypto.server", () => ({ decryptJson: async () => ({}) }));
vi.mock("@/utils/saas/sync.server", () => ({ nextSyncAt: () => null }));
vi.mock("@/utils/tools/embedTarget.server", () => ({ resolveEmbedArgs: async () => ({}) }));
vi.mock("@/utils/tools/embedding.server", () => ({ embedAndStoreDocuments: async () => {} }));
vi.mock("@/utils/kb/connectors.server", () => ({
  isConnectorKind: (k: string) => k === "web",
  KB_CONNECTORS: {
    web: {
      kind: "web",
      label: "Website",
      supportsAcl: false,
      credentialless: true,
      validate: () => null,
      listItems: async () => {
        db.listed++;
        if (db.hold) await db.hold;
        return {
          items: [
            { externalId: "https://example.com/", name: "https://example.com/", version: "v1" },
          ],
          skipped: [],
        };
      },
      fetchItem: async (_c: unknown, _k: unknown, item: { externalId: string }) => {
        db.fetched.push(item.externalId);
        return { text: "Example Domain", aclPrincipals: null };
      },
    },
  },
}));

const { syncKbSource } = await import("@/utils/kb/sync.server");
const { KB_SYNC_RUNNING } = await import("@/utils/kb/syncClaim.server");

const SOURCE = "0b9a7c3e-5d1f-4c2a-9e8b-7f6d5c4b3a21";
const KB = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const source = () => db.tables.kb_sources[0];
const sourceRow = {
  id: SOURCE,
  user_id: "user-1",
  knowledge_base_id: KB,
  kind: "web",
  label: "r313 example.com",
  config: { start_urls: ["https://example.com/"] },
  credentials: null,
  access_scope: "kb",
};
const sync = () => syncKbSource(fakeClient as never, { ...sourceRow });
const until = async (done: () => boolean) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};

beforeEach(() => {
  db.seq = 0;
  db.listed = 0;
  db.fetched = [];
  db.hold = null;
  db.tables = {
    knowledge_bases: [{ id: KB, user_id: "user-1" }],
    kb_sources: [{ ...sourceRow, status: "ok", error: null, updated_at: new Date().toISOString() }],
    knowledge_documents: [],
  };
});

describe("Sync now pressed while a sync of the same source runs", () => {
  it("does not start, says one is running, and leaves the first to finish", async () => {
    let release = () => {};
    db.hold = new Promise<void>((r) => (release = r));
    const first = sync();
    await until(() => db.listed === 1);

    const second = await sync();
    expect(second).toMatchObject({ ok: false, status: "running", error: KB_SYNC_RUNNING });
    expect(db.listed).toBe(1);
    expect(source().status).toBe("syncing");

    release();
    expect(await first).toMatchObject({ ok: true, status: "ok" });
    expect(source()).toMatchObject({ status: "ok", error: null });
    expect(db.tables.knowledge_documents).toHaveLength(1);
  });

  it("is answered 409 by the route, which the page shows as an error", () => {
    const route = readFileSync("src/routes/api/kb/sources.sync.ts", "utf8");
    expect(route).toContain('outcome.status === "running"');
    expect(
      route.slice(route.indexOf('outcome.status === "running"'), route.indexOf("207;")),
    ).toContain("409");
  });
});

describe("a claim left behind", () => {
  it("by a sync that died is taken over once the lease has passed", async () => {
    Object.assign(source(), {
      status: "syncing",
      updated_at: new Date(Date.now() - 61 * 60_000).toISOString(),
    });
    expect(await sync()).toMatchObject({ ok: true, status: "ok" });
    expect(source().status).toBe("ok");
  });

  it("within the lease is still a sync running", async () => {
    Object.assign(source(), {
      status: "syncing",
      updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(await sync()).toMatchObject({ status: "running" });
    expect(db.listed).toBe(0);
  });
});

describe("the URL and GitHub re-syncs", () => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";

  // The routes' first import takes seconds (the embedding stack); a full run
  // under load must not charge that to the first test's time limit (R305).
  beforeAll(async () => {
    await import("@/routes/api/kb/ingest-url");
    await import("@/routes/api/kb/ingest-github");
  }, 120_000);

  const post = async (path: string, body: Row) => {
    const { Route } = (await import(path)) as {
      Route: {
        options: {
          server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
        };
      };
    };
    return Route.options.server.handlers.POST({
      request: new Request("http://app.test/api", {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  };

  it.each([
    ["@/routes/api/kb/ingest-url", { url: "https://example.com/" }],
    ["@/routes/api/kb/ingest-github", { repo: "octo/hello" }],
  ])("%s does not start while a sync runs, and says so", async (path, extra) => {
    source().status = "syncing";
    const fetched = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetched);
    try {
      const res = await post(path, { knowledge_base_id: KB, source_id: SOURCE, ...extra });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: KB_SYNC_RUNNING });
      expect(fetched).not.toHaveBeenCalled();
      expect(source().status).toBe("syncing");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a source that is not the caller's is not found, not running", async () => {
    source().user_id = "someone-else";
    const res = await post("@/routes/api/kb/ingest-url", {
      knowledge_base_id: KB,
      source_id: SOURCE,
      url: "https://example.com/",
    });
    expect(res.status).toBe(404);
  });
});
