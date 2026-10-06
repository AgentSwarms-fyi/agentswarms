// A Cancel pressed while an ETL run's sandbox was starting (R307, sweep 10).
//
// FOUND IN R307. Starting a sandbox takes seconds, and the run is "queued"
// meanwhile, with Cancel on it. The cancel found no session to stop and wrote
// "cancelled"; the start then wrote "running" over it, and the run went on to
// succeed - driven: the list said Cancelled, a fresh read said Succeeded. The
// cancel's own write had the same hole the other way: not held to the status
// it read, and stopping the session it read rather than the one the row held.
//
// The real startEtlRun and cancelEtlRun run here against an in-memory table,
// with the start's and the cancel's moments in the hands of the test.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  nextId: 1,
  /** Runs while startSession is "starting" the sandbox. */
  whileStarting: null as null | (() => Promise<void>),
  /** Runs (and is awaited) just before an update of etl_runs to "cancelled" is applied. */
  beforeCancelWrite: null as null | (() => unknown),
  /** Runs once an update of etl_runs to "running" has landed on a row. */
  afterRunningWrite: null as null | (() => void),
  stopped: [] as string[],
  sessions: 0,
}));

function from(table: string) {
  const rows = () => (db.tables[table] ??= []);
  let op: "select" | "insert" | "update" = "select";
  let patch: Row = {};
  let inserting: Row[] = [];
  const filters: ((r: Row) => boolean)[] = [];
  let single: "maybe" | "one" | null = null;
  let count = false;
  let head = false;
  const run = async () => {
    let out: Row[];
    if (op === "insert") {
      out = inserting.map((r) => ({ id: `${table}-${db.nextId++}`, ...r }));
      rows().push(...out);
    } else {
      if (op === "update" && table === "etl_runs" && patch.status === "cancelled") {
        await db.beforeCancelWrite?.();
      }
      out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of out) Object.assign(r, patch);
      if (op === "update" && table === "etl_runs" && patch.status === "running" && out.length) {
        db.afterRunningWrite?.();
      }
    }
    // A read is a snapshot, as from Postgres: later writes do not reach it.
    out = out.map((r) => ({ ...r }));
    if (count) return { data: head ? null : out, count: out.length, error: null };
    if (single === "maybe") return { data: out[0] ?? null, error: null };
    if (single === "one") {
      return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "none" } };
    }
    return { data: out, error: null };
  };
  const b = {
    select: (_c?: string, o?: { count?: string; head?: boolean }) => {
      if (o?.count) count = true;
      if (o?.head) head = true;
      return b;
    },
    insert: (v: Row | Row[]) => ((op = "insert"), (inserting = Array.isArray(v) ? v : [v]), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    neq: () => b,
    not: () => b,
    or: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    maybeSingle: () => ((single = "maybe"), b),
    single: () => ((single = "one"), b),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from, rpc: async () => ({ data: null, error: null }) },
}));
vi.mock("@/utils/notebookRuntime/service.server", () => ({
  startSession: async () => {
    const id = `session-${++db.sessions}`;
    await db.whileStarting?.();
    return { session: { id, user_id: "user-1", status: "starting" }, token: "t", gatewayUrl: "" };
  },
  stopSession: async (s: { id: string }) => void db.stopped.push(s.id),
  getSession: async (_u: string, id: string) => ({ id, user_id: "user-1" }),
  internalAppUrl: () => "http://app.test",
  noProxyList: () => "",
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ etlMaxConcurrentRunsPerUser: 10 }),
}));
vi.mock("@/utils/notebookRuntime/egressApply.server", () => ({
  ensurePlatformEgress: async () => ({ applied: true }),
  platformEgressHosts: async () => [],
}));
vi.mock("@/utils/etl/sparkCluster.server", () => ({
  releaseSparkCluster: async () => {},
  sparkClusterSettings: async () => ({ provider: "none" }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: async () => {} }));
vi.mock("@/utils/secrets.server", () => ({
  resolveSecretRefs: async (_u: string, s: string) => s,
}));

const { startEtlRun, cancelEtlRun } = await import("@/utils/etl/service.server");

const pipeline = {
  id: "pipe-1",
  user_id: "user-1",
  name: "r307",
  mode: "code",
  source_code: "print(1)",
  graph: null,
  engine: null,
  schedule: "manual",
  allow_concurrent: true,
  retry_count: 0,
  default_params: null,
  secret_refs: "",
  dest_catalog_source_id: null,
  timeout_minutes: 30,
} as never;

const theRun = () => db.tables.etl_runs[0];

beforeEach(() => {
  db.tables = { etl_pipelines: [{ id: "pipe-1", user_id: "user-1" }] };
  db.nextId = 1;
  db.whileStarting = null;
  db.beforeCancelWrite = null;
  db.afterRunningWrite = null;
  db.stopped = [];
  db.sessions = 0;
});

describe("a Cancel pressed while the run's sandbox is starting", () => {
  it("stays cancelled, and the sandbox that came up after it is stopped", async () => {
    db.whileStarting = async () => {
      expect(theRun().status).toBe("queued");
      expect(await cancelEtlRun(String(theRun().id), "user-1")).toEqual({ ok: true });
    };
    const out = await startEtlRun(pipeline, "manual");
    expect(theRun().status).toBe("cancelled");
    expect(theRun().session_id ?? null).toBeNull();
    expect(db.stopped).toEqual(["session-1"]);
    expect(out).toEqual({
      ok: false,
      error:
        "The run was cancelled while its sandbox was starting, so the sandbox was stopped and nothing ran.",
    });
  });

  it("a start that is not interrupted still takes its sandbox", async () => {
    const out = await startEtlRun(pipeline, "manual");
    expect(out).toEqual({ ok: true, runId: theRun().id });
    expect(theRun()).toMatchObject({ status: "running", session_id: "session-1" });
    expect(db.stopped).toEqual([]);
  });
});

describe("a cancel that the run moves under", () => {
  it("stops the sandbox whose start landed after the cancel read the run", async () => {
    let landed = () => {};
    const startLanded = new Promise<void>((r) => (landed = r));
    db.afterRunningWrite = () => landed();
    let cancelling: Promise<unknown> = Promise.resolve();
    db.whileStarting = async () => {
      // The cancel reads the run while it is still queued, with no session,
      // and its write waits until the start's own write has landed.
      db.beforeCancelWrite = () => startLanded;
      cancelling = cancelEtlRun(String(theRun().id), "user-1");
      await new Promise((r) => setTimeout(r, 0));
    };
    const out = await startEtlRun(pipeline, "manual");
    expect(out).toEqual({ ok: true, runId: theRun().id });
    expect(await cancelling).toEqual({ ok: true });
    expect(theRun()).toMatchObject({ status: "cancelled", session_id: "session-1" });
    // Stopped by the cancel: the start won the row, so it did not stop it.
    expect(db.stopped).toEqual(["session-1"]);
  });

  it("does not turn a run that finished in between into a cancelled one", async () => {
    await startEtlRun(pipeline, "manual");
    db.beforeCancelWrite = () => Object.assign(theRun(), { status: "succeeded" });
    const out = await cancelEtlRun(String(theRun().id), "user-1");
    expect(out).toEqual({ ok: false, error: "That run is not running." });
    expect(theRun().status).toBe("succeeded");
    expect(db.stopped).toEqual([]);
  });
});
