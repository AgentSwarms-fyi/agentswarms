// Warm endpoints served by KServe (R532), through the real serving module.
//
// The module runs against an in-memory table store, as in
// mlStopWhileDeploying.test.ts, with the cluster faked one level down: the
// KServe client keeps InferenceServices in a map. What is checked is the
// app's side of the bargain: one object per side of an endpoint, the
// platform left to scale it, nothing left running that no copy names, and
// demand counted even when no copy is up to answer it.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  rpcs: [] as { name: string; args: unknown }[],
  sessionsStarted: 0,
  cluster: new Map<string, { min: number; max: number; ready: boolean; version: string }>(),
  log: [] as string[],
  onApply: null as null | (() => Promise<void>),
  applyError: null as string | null,
  scoreThrows: false,
}));

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  let payload: Row = {};
  let returning = false;
  let head = false;
  let limit = Infinity;
  const run = async (): Promise<{ data: unknown; error: null; count?: number }> => {
    const rows = (db.tables[table] ??= []);
    if (op === "select") {
      const out = rows
        .filter((r) => filters.every((f) => f(r)))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return head ? { data: null, error: null, count: out.length } : { data: out, error: null };
    }
    if (op === "insert" || op === "upsert") {
      let row = op === "upsert" ? rows.find((r) => r.model_id === payload.model_id) : undefined;
      if (row) Object.assign(row, payload);
      else {
        row = { id: `${table}-${++db.seq}`, ...defaults(table), ...payload };
        rows.push(row);
      }
      return { data: returning ? [{ ...row }] : null, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") for (const r of hit) Object.assign(r, payload);
    else db.tables[table] = rows.filter((r) => !hit.includes(r));
    return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
  };
  const b = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (op === "select") head = Boolean(opts?.head);
      else returning = true;
      return b;
    },
    insert: (row: Row) => ((op = "insert"), (payload = row), b),
    upsert: (row: Row) => ((op = "upsert"), (payload = row), b),
    update: (patch: Row) => ((op = "update"), (payload = patch), b),
    delete: () => ((op = "delete"), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    is: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    limit: (n: number) => ((limit = n), b),
    single: async () => {
      const res = await run();
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      const res = await run();
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}

function defaults(table: string): Row {
  if (table === "ml_deployment_replicas") {
    return {
      session_id: null,
      endpoint: null,
      last_error: null,
      last_used_at: null,
      isvc_name: null,
      isvc_namespace: null,
    };
  }
  if (table === "ml_deployments") {
    return {
      min_replicas: 1,
      max_replicas: 1,
      keep_warm: false,
      idle_ttl_minutes: 15,
      request_count: 0,
      candidate_mode: "off",
      candidate_version_id: null,
      scale_checked_at: null,
      scale_checked_count: null,
      last_scaled_at: null,
    };
  }
  return {};
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => from(t),
    rpc: async (name: string, args: unknown) => {
      db.rpcs.push({ name, args });
      return { data: null, error: null };
    },
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({
    mlMaxDeploymentsPerUser: 5,
    mlMaxDeploymentsTotal: 10,
    mlServeMemLimitMb: 2048,
  }),
  getRuntimeSettings: async () => ({}),
}));
vi.mock("@/utils/notebookRuntime/egressApply.server", () => ({
  ensurePlatformEgress: async () => {},
}));
vi.mock("@/utils/notebookRuntime/sandboxAuth.server", () => ({
  sandboxToken: async () => "test-port-token",
  sandboxAuthHeaders: async () => ({ Authorization: "token test-port-token" }),
}));
vi.mock("@/utils/notebookRuntime/orchestrator", () => ({
  getOrchestrator: async () => ({ status: async () => ({ endpoint: null }) }),
  sandboxName: (id: string) => id,
}));
vi.mock("@/utils/notebookRuntime/service.server", () => ({
  startSession: async () => {
    db.sessionsStarted++;
    throw new Error("a sandbox was started for a KServe endpoint");
  },
  getSession: async () => null,
  stopSession: async () => {},
}));

// What mlScoreBundleFor (checked before any pod exists) imports beyond the
// tables: the environment a run gets, and the ETL prelude it leaves out.
vi.mock("@/utils/ml/train.server", () => ({
  mlTrainingEnv: async () => ({ env: { ML_ARTIFACT_URI: "s3://lake/ml-artifacts/x" } }),
}));
vi.mock("@/utils/etl/service.server", () => ({ etlPrelude: () => "# prelude\n" }));

// The cluster, one level down from the serving module.
vi.mock("@/utils/ml/kserve.server", async () => {
  const lib = await import("@/lib/kserve");
  const settings = () => lib.kserveConfigFrom(process.env);
  return {
    kserveSettings: settings,
    applyInferenceService: async (a: {
      name: string;
      minReplicas: number;
      maxReplicas: number;
      labels: Record<string, string>;
    }) => {
      if (db.onApply) {
        const hook = db.onApply;
        db.onApply = null;
        await hook();
      }
      if (db.applyError) return db.applyError;
      db.log.push(`apply ${a.name}`);
      db.cluster.set(a.name, {
        min: a.minReplicas,
        max: a.maxReplicas,
        ready: true,
        version: a.labels["agentswarms.dev/version"],
      });
      return null;
    },
    resizeInferenceService: async (a: { name: string; min: number; max: number }) => {
      const o = db.cluster.get(a.name);
      if (o) Object.assign(o, { min: a.min, max: a.max });
      db.log.push(`resize ${a.name} ${a.min}-${a.max}`);
      return null;
    },
    predictorEndpoint: (_c: unknown, name: string) => `http://${name}-predictor.serving.svc`,
    predictorHeaders: async () => ({ "X-Port-Token": "test-port-token" }),
    readInferenceService: async (_ns: string, name: string) => {
      const o = db.cluster.get(name);
      return o
        ? {
            exists: true,
            ready: o.ready,
            reason: null,
            url: null,
            pods: { ready: 1, total: 1, reason: null },
          }
        : { exists: false };
    },
    deleteInferenceService: async (_ns: string, name: string) => {
      db.log.push(`delete ${name}`);
      db.cluster.delete(name);
      return null;
    },
    predictorLogLine: async () => null,
    listManagedInferenceServices: async () =>
      [...db.cluster.keys()].map((name) => ({ name, createdAt: "2026-01-01T00:00:00Z" })),
  };
});

vi.stubGlobal("fetch", async (url: string) => {
  const host = new URL(url).hostname;
  const name = host.replace(/-predictor\..*$/, "");
  if (!db.cluster.get(name)?.ready) throw new Error("no endpoints available");
  if (url.endsWith("/score")) {
    if (db.scoreThrows) throw new Error("the request timed out");
    return new Response(JSON.stringify({ columns: ["label"], sample: [["yes"]] }), { status: 200 });
  }
  return new Response(JSON.stringify({ ready: true }), { status: 200 });
});

process.env.ML_SERVING_BACKEND = "kserve";
process.env.KSERVE_SCORER_IMAGE = "scorer:1";
process.env.KSERVE_NAMESPACE = "serving";
process.env.KSERVE_APP_URL = "http://app.test";

const serve = await import("@/utils/ml/serve.server");
const { isvcName } = await import("@/lib/kserve");

type Model = Parameters<typeof serve.ensureDeployment>[0]["model"];
type Version = Parameters<typeof serve.ensureDeployment>[0]["version"];
const MODEL_ID = "3f0c2a9e-7b1d-4e55-9a10-6c2b8d4e1f77";
const model = { id: MODEL_ID, name: "churn", task: "classification" } as Model;
const v1 = {
  id: "version-1",
  version: 1,
  status: "ready",
  artifact_uri: `s3://lake/ml-artifacts/${MODEL_ID}/v1/model.joblib`,
  artifact_sha256: "abc",
} as Version;
const v2 = { ...v1, id: "version-2", version: 2 } as Version;
const NAME = isvcName(MODEL_ID, "primary");

const deploy = (version: Version = v1) =>
  serve.ensureDeployment({ model, version, userId: "user-1", waitMs: 5_000 });
const endpoint = () => db.tables.ml_deployments?.find((r) => r.model_id === MODEL_ID);
const copies = () => db.tables.ml_deployment_replicas ?? [];
const live = () => copies().filter((r) => r.status === "starting" || r.status === "ready");

beforeEach(() => {
  db.tables = {};
  db.seq = 0;
  db.rpcs = [];
  db.sessionsStarted = 0;
  db.cluster.clear();
  db.log = [];
  db.onApply = null;
  db.applyError = null;
  db.scoreThrows = false;
  // What the start checks before any pod exists: the bundle every pod will ask for.
  db.tables.ml_models = [
    {
      id: MODEL_ID,
      user_id: "user-1",
      name: "churn",
      task: "classification",
      target_column: "label",
    },
  ];
  db.tables.ml_model_versions = [v1, v2].map((v) => ({ ...v, model_id: MODEL_ID }));
});

describe("deploying on KServe", () => {
  it("makes one InferenceService for the endpoint and starts no sandbox", async () => {
    const res = await deploy();
    expect(res).toMatchObject({ ok: true, endpoint: `http://${NAME}-predictor.serving.svc` });
    expect(endpoint()?.status).toBe("ready");
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      status: "ready",
      isvc_name: NAME,
      isvc_namespace: "serving",
      session_id: null,
      role: "primary",
    });
    expect(db.cluster.get(NAME)).toMatchObject({ min: 1, max: 1 });
    expect(db.sessionsStarted).toBe(0);
    expect(db.log).toEqual([`apply ${NAME}`]);
  });

  it("gives Kubernetes the endpoint's range instead of starting copies itself", async () => {
    await deploy();
    db.tables.ml_deployments[0].min_replicas = 2;
    db.tables.ml_deployments[0].max_replicas = 6;
    db.tables.ml_deployments[0].status = "stopped";
    await deploy();
    await new Promise((r) => setTimeout(r, 50));
    // One row however many pods: the copies are the cluster's.
    expect(live()).toHaveLength(1);
    expect(db.cluster.get(NAME)).toMatchObject({ min: 2, max: 6 });

    db.tables.ml_deployments[0].max_replicas = 9;
    expect(await serve.resizeKserveEndpoint(MODEL_ID)).toBe(null);
    expect(db.cluster.get(NAME)).toMatchObject({ min: 2, max: 9 });
  });

  it("replaces the object on a new version, deleting the old one before applying", async () => {
    await deploy(v1);
    db.log = [];
    const res = await deploy(v2);
    expect(res.ok).toBe(true);
    // The old object is gone before one of the same name is applied.
    expect(db.log).toEqual([`delete ${NAME}`, `apply ${NAME}`]);
    expect(live()).toHaveLength(1);
    expect(live()[0].version_id).toBe("version-2");
    expect(db.cluster.get(NAME)?.version).toBe("2");
  });

  it("says why when the cluster refuses, and leaves nothing behind", async () => {
    db.applyError = "This cluster has no KServe (the InferenceService API was not found).";
    const res = await deploy();
    expect(res).toEqual({ ok: false, error: db.applyError });
    expect(endpoint()?.status).toBe("failed");
    expect(endpoint()?.last_error).toMatch(/no KServe/);
    expect(live()).toHaveLength(0);
    expect(db.cluster.size).toBe(0);
  });

  it("fails before any pod exists when the app could not serve the model", async () => {
    // What every pod would ask for is checked first: here the version's row is
    // gone, so a pod would be refused its model and never become ready.
    db.tables.ml_model_versions = [];
    const res = await deploy();
    expect(res).toEqual({ ok: false, error: "Model version not found for this session" });
    expect(db.log).toEqual([]);
    expect(db.cluster.size).toBe(0);
    expect(endpoint()?.status).toBe("failed");
  });

  it("takes the object down again when Stop is pressed while it is applied", async () => {
    db.onApply = async () => {
      expect(await serve.undeploy(MODEL_ID, "user-1")).toEqual({ ok: true });
    };
    const res = await deploy();
    expect(res).toEqual({ ok: false, error: serve.STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(live()).toHaveLength(0);
    expect(db.cluster.size).toBe(0);
  });

  it("deletes the object on Stop", async () => {
    await deploy();
    expect(await serve.undeploy(MODEL_ID, "user-1")).toEqual({ ok: true });
    expect(db.cluster.size).toBe(0);
    expect(copies()[0].status).toBe("stopped");
  });
});

describe("serving on KServe", () => {
  const score = () =>
    serve.scoreWarm({ model, version: v1, userId: "user-1", rows: [{ tenure: 3 }] });

  it("scores through the predictor and counts the request", async () => {
    await deploy();
    const res = await score();
    expect(res).toMatchObject({ ok: true, columns: ["label"] });
    expect(db.rpcs.map((r) => r.name)).toContain("increment_ml_deployment_use");
  });

  it("does not tear the endpoint down because one request failed", async () => {
    await deploy();
    db.scoreThrows = true;
    expect(await score()).toBe(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(live()).toHaveLength(1);
    expect(db.cluster.has(NAME)).toBe(true);
  });

  it("is left to Kubernetes by the app's scaler", async () => {
    await deploy();
    Object.assign(db.tables.ml_deployments[0], {
      min_replicas: 1,
      max_replicas: 5,
      request_count: 10_000,
      scale_checked_count: 0,
      scale_checked_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await serve.autoscaleDeployments()).toEqual({ scaled: 0 });
    expect(live()).toHaveLength(1);
    expect(db.sessionsStarted).toBe(0);
    // The reading is still taken, so a later rate is honest.
    expect(db.tables.ml_deployments[0].scale_checked_count).toBe(10_000);
  });
});

describe("demand with no copy up", () => {
  it("is counted, so an endpoint scaled to zero is scaled back up", async () => {
    await deploy();
    // Every copy gone (a sandbox endpoint at its minimum of 0 looks the same).
    for (const r of copies()) r.status = "stopped";
    db.rpcs = [];
    expect(
      await serve.scoreWarm({ model, version: v1, userId: "user-1", rows: [{ tenure: 3 }] }),
    ).toBe(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.rpcs).toEqual([
      { name: "increment_ml_deployment_use", args: { p_id: endpoint()?.id } },
    ]);
  });
});

describe("the orphan sweep", () => {
  it("deletes only objects no live copy names", async () => {
    await deploy();
    db.cluster.set("ml-ffffffffffffffffffff", {
      min: 1,
      max: 1,
      ready: true,
      version: "1",
    });
    expect(await serve.reapOrphanInferenceServices()).toBe(1);
    expect([...db.cluster.keys()]).toEqual([NAME]);
  });

  it("never deletes an object a newer copy names when an older one retires", async () => {
    await deploy();
    // A second live row naming the same object: a redeploy's new copy.
    db.tables.ml_deployment_replicas.push({
      ...copies()[0],
      id: "replica-newer",
      status: "starting",
    });
    expect(await serve.undeploy(MODEL_ID, "user-1")).toEqual({ ok: true });
    // The first retirement saw the newer copy and left the object; the last
    // one, with nothing else naming it, deleted it.
    expect(db.log.filter((l) => l.startsWith("delete"))).toEqual([`delete ${NAME}`]);
  });
});
