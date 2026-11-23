// What the tutorial checks read (R529): every query names the caller, and
// only what was made since the start counts, except the shipments table the
// forecast builds on, which may be older. An administrator's client can see
// other people's audit events; naming the caller is what keeps their imports
// out of this person's tutorial.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/lakehouse/core.server", () => ({
  lakehouseEnabled: () => true,
  lakehouseTableExists: vi.fn(async (_schema: string, table: string) => table === "shipments"),
}));
const grants = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => new Set<string>()));
vi.mock("@/utils/iam.server", () => ({ resolveGrantedResourceIds: grants }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { TUTORIAL_IDS } from "@/lib/tutorials";
import { hasModelAccess, loadTutorialRows } from "@/utils/tutorials/progress.server";

type Op = [string, unknown[]];
type Call = { table: string; ops: Op[] };

/** A client that records every call and answers each table with fixed rows. */
function fakeDb(data: Record<string, unknown[]>, counts: Record<string, number> = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const rec: Call = { table, ops: [] };
      calls.push(rec);
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: data[table] ?? [], error: null, count: counts[table] ?? 0 });
            }
            return (...args: unknown[]) => {
              rec.ops.push([String(prop), args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as never, calls };
}

const ROWS: Record<string, unknown[]> = {
  ai_analysts: [{ id: "a1", name: "Sales", source: { kind: "local", tables: [] } }],
  ai_analyst_threads: [{ id: "t1", analyst_id: "a1", title: "Q", a0: "EMEA.", a1: null, a2: null }],
  ai_analyst_schedules: [{ thread_id: "t1", enabled: true }],
  bi_dashboards: [{ id: "d1", name: "Sales", widgets: [], pages: null }],
  bi_schedules: [],
  saas_connections: [{ id: "s1", name: "GitHub", sync_schedule: "manual" }],
  user_data_tables: [{ id: "ds1", name: "github_cli_releases", saas_connection_id: "s1" }],
  audit_events: [
    { resource_name: "learn.shipments", detail: { source_dataset: "supply_shipments" } },
    { resource_name: "learn.gone", detail: { source_dataset: "supply_shipments" } },
    { resource_name: "learn.sales", detail: { source_dataset: "saas_sales" } },
  ],
  data_monitors: [
    {
      id: "m1",
      name: "Vol",
      source_kind: "lakehouse",
      schema_name: "learn",
      table_name: "shipments",
    },
  ],
  data_monitor_runs: [],
  ml_models: [{ id: "f1", name: "F", task: "forecast", source: {}, production_version_id: null }],
  ml_model_versions: [],
  swarms: [{ id: "s1", name: "Copy", nodes: [] }],
  swarm_runs: [{ id: "r1", swarm_id: "s1", swarm_snapshot: {}, status: "completed" }],
  approvals: [],
};

const SINCE = "2026-11-23T10:00:00.000Z";
const has = (c: Call, op: string, ...args: unknown[]) =>
  c.ops.some(([o, a]) => o === op && JSON.stringify(a) === JSON.stringify(args));

describe("loadTutorialRows", () => {
  it.each(TUTORIAL_IDS)("%s reads only the caller's own rows", async (id) => {
    const { db, calls } = fakeDb(ROWS);
    await loadTutorialRows(db, "u1", id, SINCE);
    expect(calls.length, id).toBeGreaterThan(0);
    for (const c of calls) expect(has(c, "eq", "user_id", "u1"), `${id}: ${c.table}`).toBe(true);
  });

  it("counts things made since the start, where the start applies", async () => {
    for (const id of TUTORIAL_IDS) {
      const { db, calls } = fakeDb(ROWS);
      await loadTutorialRows(db, "u1", id, SINCE);
      const first = calls[0];
      // The first read of every tutorial is the thing its first step makes.
      if (id === "forecast") continue;
      expect(has(first, "gte", "created_at", SINCE), `${id}: ${first.table}`).toBe(true);
    }
  });

  it("builds a forecast on a shipments table made at any time, if it is still there", async () => {
    const { db, calls } = fakeDb(ROWS);
    const rows = await loadTutorialRows(db, "u1", "forecast", SINCE);
    const audit = calls.find((c) => c.table === "audit_events")!;
    expect(has(audit, "eq", "action", "lakehouse.import")).toBe(true);
    expect(audit.ops.some(([o]) => o === "gte")).toBe(false);
    expect(rows.tutorial === "forecast" && rows.tables).toEqual(["learn.shipments"]);
    const models = calls.find((c) => c.table === "ml_models")!;
    expect(has(models, "gte", "created_at", SINCE)).toBe(true);
  });

  it("watches only shipments brought in since the start", async () => {
    const { db, calls } = fakeDb(ROWS);
    const rows = await loadTutorialRows(db, "u1", "lake_watch", SINCE);
    const audit = calls.find((c) => c.table === "audit_events")!;
    expect(has(audit, "gte", "created_at", SINCE)).toBe(true);
    expect(rows.tutorial === "lake_watch" && rows.imports).toEqual([
      { table: "learn.shipments", source: "supply_shipments" },
    ]);
  });

  it("leaves out a sync's staging dataset, and reads dashboards only once one synced", async () => {
    const { db, calls } = fakeDb(ROWS);
    await loadTutorialRows(db, "u1", "rest_api", SINCE);
    const sets = calls.find((c) => c.table === "user_data_tables")!;
    expect(has(sets, "not", "name", "like", "__upload_%")).toBe(true);
    const dash = calls.find((c) => c.table === "bi_dashboards")!;
    expect(has(dash, "gte", "created_at", SINCE)).toBe(true);

    const none = fakeDb({ ...ROWS, user_data_tables: [] });
    await loadTutorialRows(none.db, "u1", "rest_api", SINCE);
    expect(none.calls.some((c) => c.table === "bi_dashboards")).toBe(false);
  });

  it("reads a conversation as its first answers, not its stored rows", async () => {
    const { db, calls } = fakeDb(ROWS);
    const rows = await loadTutorialRows(db, "u1", "ask_analyst", SINCE);
    const threads = calls.find((c) => c.table === "ai_analyst_threads")!;
    const select = String(threads.ops.find(([o]) => o === "select")![1][0]);
    expect(select).not.toMatch(/(^|, )turns(,|$)/);
    expect(rows.tutorial === "ask_analyst" && rows.threads[0].turns).toEqual([
      { answer: "EMEA." },
      { answer: null },
      { answer: null },
    ]);
  });
});

describe("hasModelAccess", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
    grants.mockClear();
  });

  it("is the server's key, the caller's own, or one shared with them", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    expect(await hasModelAccess(fakeDb({}).db, "u1")).toBe(true);

    delete process.env.OPENROUTER_API_KEY;
    const own = fakeDb({}, { provider_credentials: 1 });
    expect(await hasModelAccess(own.db, "u1")).toBe(true);
    for (const c of own.calls) expect(has(c, "eq", "user_id", "u1"), c.table).toBe(true);

    expect(await hasModelAccess(fakeDb({}).db, "u1")).toBe(false);
    grants.mockResolvedValueOnce(new Set(["cred-1"]));
    expect(await hasModelAccess(fakeDb({}).db, "u1")).toBe(true);
  });
});
