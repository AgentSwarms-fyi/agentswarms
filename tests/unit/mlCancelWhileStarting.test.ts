// A Cancel pressed while an ML job's sandbox was starting (R308, sweep 10).
//
// FOUND IN R308. A training job and a prediction are inserted "queued", and
// starting their sandboxes takes seconds; the model page offers Cancel on the
// queued job meanwhile. The cancel - already held to the live statuses -
// found no session to stop; the start then wrote "running" over it. Driven:
// a training job cancelled while "Starting the sandbox…" trained anyway, and
// came back as succeeded, with its version a promotable candidate.
//
// The real startTrainingJob, startPrediction and their cancels run here
// against an in-memory table, with the moment of the start in the test's hands.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  nextId: 1,
  /** Runs while startSession is "starting" a sandbox. */
  whileStarting: null as null | (() => Promise<void>),
  /** A table whose next update to "running" answers with an error. */
  failRunningWrite: null as string | null,
  /** startSession throws: the workers could not start at all. */
  failStart: false,
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
    if (op === "update" && patch.status === "running" && db.failRunningWrite === table) {
      db.failRunningWrite = null;
      return { data: null, error: { message: "R308 injected: the write did not land" } };
    }
    let out: Row[];
    if (op === "insert") {
      out = inserting.map((r) => ({ id: `${table}-${db.nextId++}`, ...r }));
      rows().push(...out);
    } else {
      out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of out) Object.assign(r, patch);
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
    order: () => b,
    limit: () => b,
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
    if (db.failStart) throw new Error("R308 injected: the runtime is down");
    const id = `session-${++db.sessions}`;
    db.tables.notebook_runtime_sessions ??= [];
    db.tables.notebook_runtime_sessions.push({ id, user_id: "user-1", status: "starting" });
    await db.whileStarting?.();
    return { session: { id, user_id: "user-1", status: "starting" }, token: "t", gatewayUrl: "" };
  },
  stopSession: async (s: { id: string }) => void db.stopped.push(s.id),
  refreshSession: async (s: unknown) => s,
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({
    mlMaxConcurrentTrainingsPerUser: 5,
    mlTrainWorkers: 1,
    mlTrainMemLimitMb: 1024,
    mlTrainTimeBudgetMinutes: 5,
    mlTrainGpus: 0,
  }),
  getRuntimeSettings: async () => ({ maxSessionsPerUser: 5 }),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => [{ name: "analytics" }],
  catalogUrlToLibpq: (u: string) => u,
  lakehouseConfig: () => ({ dataUrl: "s3://lake" }),
  lakehouseSnapshotId: async () => null,
  lakehouseTableExists: async () => true,
  runLakehouseStatement: async () => ({ columns: [], rows: [] }),
}));
vi.mock("@/utils/notebookRuntime/egressApply.server", () => ({
  ensurePlatformEgress: async () => ({ applied: true }),
}));
vi.mock("@/utils/etl/service.server", () => ({
  etlPrelude: () => "",
  scrubSecrets: (s: string) => s,
}));
vi.mock("@/utils/provenance/decision.server", () => ({ beginDecision: () => {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: async () => {} }));

const { startTrainingJob, cancelMlJob } = await import("@/utils/ml/train.server");
const { startPrediction, cancelPrediction } = await import("@/utils/ml/predict.server");
const { createAndTrainVersion } = await import("@/utils/ml/api.server");

const model = {
  id: "model-1",
  user_id: "user-1",
  name: "r308",
  task: "classification",
  source: { schema: "analytics", table: "revenue_facts" },
  production_version_id: "version-0",
} as never;
const training = { id: "version-1", version: 6, status: "training", config: {} } as never;
const ready = {
  id: "version-0",
  version: 5,
  status: "ready",
  artifact_uri: "s3://lake/m/5",
  artifact_sha256: "a".repeat(64),
} as never;

const predictArgs = {
  model,
  version: ready,
  userId: "user-1",
  input: { kind: "rows" as const, rows: [{ x: 1 }] },
  output: { kind: "return" },
  kind: "rows",
  via: "page",
} as never;

const job = () => db.tables.ml_training_jobs[0];
const prediction = () => db.tables.ml_predictions[0];

beforeEach(() => {
  db.tables = { ml_model_versions: [{ id: "version-1", status: "training" }] };
  db.nextId = 1;
  db.whileStarting = null;
  db.failRunningWrite = null;
  db.failStart = false;
  db.stopped = [];
  db.sessions = 0;
});

describe("a training job cancelled while its workers start", () => {
  it("stays cancelled, its version too, and the worker that came up is stopped", async () => {
    db.whileStarting = async () => {
      expect(job().status).toBe("queued");
      expect(await cancelMlJob(String(job().id), "user-1")).toBe(true);
    };
    const out = await startTrainingJob({ model, version: training });
    expect(job().status).toBe("cancelled");
    expect(db.tables.ml_model_versions[0].status).toBe("cancelled");
    expect(db.stopped).toEqual(["session-1"]);
    expect(out).toEqual({
      ok: false,
      error:
        "The training job was cancelled while its workers were starting, so they were stopped and nothing trained.",
    });
  });

  it("an uninterrupted start takes its workers", async () => {
    const out = await startTrainingJob({ model, version: training });
    expect(out).toEqual({ ok: true, jobId: job().id });
    expect(job()).toMatchObject({ status: "running", session_id: "session-1" });
    expect(db.stopped).toEqual([]);
  });
});

describe("a prediction cancelled while its sandbox starts", () => {
  it("stays cancelled, and the sandbox that came up is stopped", async () => {
    db.whileStarting = async () => {
      expect(prediction().status).toBe("queued");
      expect(await cancelPrediction(String(prediction().id), "user-1")).toBe(true);
    };
    const out = await startPrediction(predictArgs);
    expect(prediction().status).toBe("cancelled");
    expect(db.stopped).toEqual(["session-1"]);
    expect(out).toEqual({
      ok: false,
      error:
        "The prediction was cancelled while its sandbox was starting, so it was stopped and nothing ran.",
    });
  });

  it("an uninterrupted start takes its sandbox", async () => {
    const out = await startPrediction(predictArgs);
    expect(out).toMatchObject({ ok: true, predictionId: prediction().id });
    expect(prediction()).toMatchObject({ status: "running", session_id: "session-1" });
    expect(db.stopped).toEqual([]);
  });

  it("a start whose write did not land stops its sandbox and says so", async () => {
    db.failRunningWrite = "ml_predictions";
    const out = await startPrediction(predictArgs);
    expect(db.stopped).toEqual(["session-1"]);
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toContain(
      "The prediction's sandbox started but could not be recorded",
    );
  });
});

describe("the version a training job was for", () => {
  // Driven in R308's after: the job stayed cancelled, but createAndTrainVersion
  // turned its version to "failed" over the cancel.
  it("stays cancelled when its job was cancelled while the workers started", async () => {
    db.tables = {};
    db.whileStarting = async () => {
      expect(await cancelMlJob(String(job().id), "user-1")).toBe(true);
    };
    const out = await createAndTrainVersion(model, {} as never, 7);
    expect(out.ok).toBe(false);
    expect(db.tables.ml_model_versions[0].status).toBe("cancelled");
  });

  it("is failed when its workers could not start at all", async () => {
    db.tables = {};
    db.failStart = true;
    const out = await createAndTrainVersion(model, {} as never, 7);
    expect(out.ok).toBe(false);
    expect(db.tables.ml_model_versions[0].status).toBe("failed");
  });
});
