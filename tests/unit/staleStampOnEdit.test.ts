// An edit clears the result that vouched for what it replaced (R319).
//
// FOUND IN the sweep's "badge that outlives what it vouched for" row, fixed in
// R319. Two edits kept the last result:
//
// - a data monitor's changed rule kept the old rule's "ok" and value on its
//   card until the next scheduled run;
// - an app source re-saved with new credentials kept the old ones' test
//   result. The warehouse and provider saves already clear theirs.
//
// Neither path is reachable from a page today (the monitors page only pauses
// and resumes, and the Apps tab only creates), so both run here for real as
// server functions, over fakes that record the write.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAAS_CARDS } from "@/utils/saas/catalog";
import { SAAS_PROVIDERS } from "@/utils/saas/types";

const rec = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  writes: [] as { table: string; op: string; payload: Record<string, unknown> }[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

function table(name: string) {
  let op = "select";
  let payload: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
  b.update = (p: Record<string, unknown>) => ((op = "update"), (payload = p), b);
  b.insert = (p: Record<string, unknown>) => ((op = "insert"), (payload = p), b);
  const done = () => {
    if (op !== "select") rec.writes.push({ table: name, op, payload });
    return op === "select"
      ? { data: { ...rec.current }, error: null }
      : { data: null, error: null };
  };
  b.maybeSingle = async () => done();
  b.single = async () => {
    done();
    return { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
  };
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(done()).then(res);
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => table(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => table(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/providers/crypto.server", () => ({
  encryptJson: async () => "sealed",
  decryptJson: async () => ({}),
}));
vi.mock("@/utils/dataMonitors/run.server", () => ({
  nextMonitorRunAt: () => "2026-10-08T00:00:00.000Z",
  runDataMonitor: async () => ({}),
}));
vi.mock("@/utils/lakehouse/tables.server", () => ({ listLakehouseTablesForUser: async () => [] }));
vi.mock("@/utils/saas/sync.server", () => ({
  listSaasStreams: async () => [],
  nextSyncAt: () => null,
  runConnectionSync: async () => ({}),
}));

process.env.SUPABASE_URL = "http://supabase";
process.env.SUPABASE_PUBLISHABLE_KEY = "pk";

const { dataMonitorUpdate } = await import("@/utils/dataMonitors.functions");
const { saveSaasConnection } = await import("@/utils/saas.functions");

const MONITOR = "22222222-2222-4222-8222-222222222222";
type Call = (o: { data: Record<string, unknown> }) => Promise<unknown>;
const update = (fields: Record<string, unknown>) =>
  (dataMonitorUpdate as unknown as Call)({ data: { access_token: "t", id: MONITOR, ...fields } });
const written = () =>
  rec.writes.find((w) => w.table === "data_monitors" && w.op === "update")?.payload;

beforeEach(() => {
  rec.writes = [];
  rec.current = {
    id: MONITOR,
    user_id: "user-1",
    kind: "nulls",
    config: { max_null_pct: 5, column: "email" },
    schedule: "hourly",
    cron_expr: null,
    timezone: null,
    is_active: true,
    last_status: "ok",
    last_value: 0.4,
    last_message: "0.4% null",
    last_run_at: "2026-10-06T10:00:00.000Z",
    consecutive_alerts: 0,
  };
});

describe("a data monitor's rule changed", () => {
  it("clears the old rule's result and is due on the next pass", async () => {
    const before = Date.now();
    expect(await update({ config: { column: "phone", max_null_pct: 5 } })).toEqual({ ok: true });
    const w = written()!;
    expect(w).toMatchObject({
      config: { column: "phone", max_null_pct: 5 },
      last_status: null,
      last_value: null,
      last_message: null,
      last_run_at: null,
      consecutive_alerts: 0,
    });
    expect(Date.parse(String(w.next_run_at))).toBeGreaterThanOrEqual(before - 1000);
  });

  it("is not due when the monitor is paused", async () => {
    rec.current.is_active = false;
    await update({ config: { column: "phone", max_null_pct: 5 } });
    expect(written()).not.toHaveProperty("next_run_at");
    expect(written()).toMatchObject({ last_status: null });
  });

  it("the same rule sent back, in another key order, keeps its result", async () => {
    await update({ config: { column: "email", max_null_pct: 5 } });
    expect(written()).not.toHaveProperty("last_status");
  });

  it("a rename or a pause keeps its result", async () => {
    await update({ name: "emails filled in" });
    expect(written()).not.toHaveProperty("last_status");
    rec.writes = [];
    await update({ is_active: false });
    expect(written()).not.toHaveProperty("last_status");
  });
});

describe("an app source saved again", () => {
  const provider = SAAS_PROVIDERS[0];
  const config = {
    provider,
    ...Object.fromEntries(SAAS_CARDS[provider].fields.map((f) => [f.key, "x"])),
  };
  const save = (id?: string) =>
    (saveSaasConnection as unknown as Call)({
      data: { access_token: "t", ...(id ? { id } : {}), name: "crm", config, streams: ["s"] },
    });

  it("clears the test result of the credentials it replaced", async () => {
    await save("33333333-3333-4333-8333-333333333333");
    const w = rec.writes.find((x) => x.table === "saas_connections" && x.op === "update")!;
    expect(w.payload).toMatchObject({ last_test_status: null, last_test_error: null });
  });

  it("and a new one starts with none", async () => {
    await save();
    const w = rec.writes.find((x) => x.table === "saas_connections" && x.op === "insert")!;
    expect(w.payload).toMatchObject({ last_test_status: null, last_test_error: null });
  });
});
