// A Stop pressed while a deploy is starting a model's warm endpoint (R311).
//
// FOUND IN R311. Deploy wrote every state of its start without asking whether
// the endpoint was still the one it had started. A Stop pressed while the
// copy's sandbox was being created found a copy with no session, so it stopped
// nothing; the start then recorded its session, marked the copy ready and the
// endpoint "ready", and the endpoint came back serving with its scorer running.
// A Stop pressed while the model loaded did stop the scorer, and the start then
// wrote "failed" over the Stop. Driven: two tabs, Deploy in one and Stop in the
// other while the badge read "starting".
//
// The serving module runs here for real against an in-memory table store, with
// the sandbox service, the orchestrator and the scorer's health check faked.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs before a write is applied; the write then lands on what the row holds. */
  before: null as null | ((table: string, op: string, row: Row) => Promise<void>),
  sessions: new Map<
    string,
    { id: string; user_id: string; status: string; error: string | null }
  >(),
  /** Runs while a sandbox is being created, before startSession answers. */
  onStart: null as null | (() => Promise<void>),
  /** Runs as a copy stops; sees the tables as they are at that moment. */
  onStop: null as null | ((sessionId: string) => void),
  /** Answers the scorer's health check; null means "healthy". */
  onHealth: null as null | ((sessionId: string) => Promise<{ status: number } | null>),
  healthChecks: 0,
}));

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  let payload: Row = {};
  let returning = false;
  let head = false;
  const run = async (): Promise<{ data: unknown; error: null; count?: number }> => {
    const rows = (db.tables[table] ??= []);
    if (op === "select") {
      const out = rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      return head ? { data: null, error: null, count: out.length } : { data: out, error: null };
    }
    if (db.before) await db.before(table, op, payload);
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
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
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
    return { session_id: null, endpoint: null, last_error: null, last_used_at: null };
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
    };
  }
  return {};
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => from(t) },
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
vi.mock("@/utils/notebookRuntime/orchestrator", () => ({
  getOrchestrator: async () => ({
    status: async (name: string) => ({ endpoint: `http://${name}:8080` }),
  }),
  sandboxName: (id: string) => id,
}));
vi.mock("@/utils/notebookRuntime/service.server", () => ({
  startSession: async ({ userId }: { userId: string }) => {
    const id = `session-${++db.seq}`;
    db.sessions.set(id, { id, user_id: userId, status: "running", error: null });
    if (db.onStart) await db.onStart();
    return { session: { ...db.sessions.get(id) } };
  },
  getSession: async (_userId: string, id: string) => {
    const s = db.sessions.get(id);
    return s ? { ...s } : null;
  },
  stopSession: async (s: { id: string }) => {
    db.onStop?.(s.id);
    const live = db.sessions.get(s.id);
    if (live) live.status = "stopped";
  },
}));

vi.stubGlobal("fetch", async (url: string) => {
  const sessionId = new URL(url).hostname;
  if (db.sessions.get(sessionId)?.status !== "running") throw new Error("not listening");
  db.healthChecks++;
  const answer = db.onHealth ? await db.onHealth(sessionId) : null;
  const status = answer?.status ?? 200;
  return { ok: status === 200, status, json: async () => ({}) };
});

const serve = await import("@/utils/ml/serve.server");
const { STOPPED_WHILE_STARTING, ensureDeployment, setCandidate, undeploy } = serve;

type Model = Parameters<typeof ensureDeployment>[0]["model"];
type Version = Parameters<typeof ensureDeployment>[0]["version"];
const model = { id: "model-1", name: "threshold_probe", task: "classification" } as Model;
const v1 = {
  id: "version-1",
  version: 1,
  status: "ready",
  artifact_uri: "s3://lake/models/model-1/v1.joblib",
  artifact_sha256: "abc",
} as Version;
const v2 = { ...v1, id: "version-2", version: 2 } as Version;

const deploy = () => ensureDeployment({ model, version: v1, userId: "user-1", waitMs: 10_000 });
const stop = async () => expect(await undeploy(model.id, "user-1")).toEqual({ ok: true });
const endpoint = () => db.tables.ml_deployments?.find((r) => r.model_id === model.id);
const copies = () => (db.tables.ml_deployment_replicas ?? []).map((r) => r.status);
const sessions = () => [...db.sessions.values()].map((s) => s.status);
const until = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};
/** Once, before the first write of this shape: the hook clears itself first. */
const beforeWrite = (
  table: string,
  op: string,
  when: (row: Row) => boolean,
  then: (row: Row) => Promise<void>,
) => {
  db.before = async (t, o, row) => {
    if (t !== table || o !== op || !when(row)) return;
    db.before = null;
    await then(row);
  };
};
const copy = (sessionId: string) =>
  db.tables.ml_deployment_replicas.find((r) => r.session_id === sessionId)!;
const v3 = { ...v1, id: "version-3", version: 3 } as Version;
/**
 * Another Deploy, a few milliseconds on. A start is told apart by its
 * `last_started_at`, to the millisecond, and a real deploy takes far longer
 * than that to write its own; this fake would write it in the same one.
 */
const deployAgain = async (version: Version) => {
  await new Promise((r) => setTimeout(r, 5));
  return ensureDeployment({ model, version, userId: "user-1", waitMs: 10_000 });
};

beforeEach(() => {
  db.tables = {};
  db.seq = 0;
  db.before = null;
  db.sessions.clear();
  db.onStart = null;
  db.onStop = null;
  db.onHealth = null;
  db.healthChecks = 0;
});

describe("a Stop pressed while a deploy is starting the endpoint", () => {
  it("while the copy's sandbox is being created: the endpoint stays stopped and nothing serves", async () => {
    db.onStart = async () => {
      db.onStart = null;
      await stop();
    };
    expect(await deploy()).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(copies()).toEqual(["stopped"]);
    expect(sessions()).toEqual(["stopped"]);
    // Stopped at once: the retired copy was not given the scorer, and the
    // scorer was not left loading a model for twenty seconds first.
    expect(db.tables.ml_deployment_replicas[0].session_id).toBe(null);
    expect(db.healthChecks).toBe(0);
  });

  it("while the scorer loads its model: the endpoint reads stopped, not failed", async () => {
    db.onHealth = async () => {
      db.onHealth = null;
      await stop();
      return { status: 503 };
    };
    expect(await deploy()).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(copies()).toEqual(["stopped"]);
    expect(sessions()).toEqual(["stopped"]);
  });

  it("before the copy was recorded, and the copy then fails: still stopped, not failed", async () => {
    beforeWrite("ml_deployment_replicas", "insert", () => true, stop);
    db.onHealth = async (sessionId) => {
      const s = db.sessions.get(sessionId)!;
      s.status = "failed";
      s.error = "KeyError: 'url'";
      return { status: 503 };
    };
    expect(await deploy()).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(sessions()).toEqual(["stopped"]);
  });

  it("before the copy was recorded, and the copy then comes up: it is stopped again", async () => {
    beforeWrite("ml_deployment_replicas", "insert", () => true, stop);
    expect(await deploy()).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(copies()).toEqual(["stopped"]);
    expect(sessions()).toEqual(["stopped"]);
  });

  it("between the copy coming up and the endpoint's ready stamp: the Stop stands", async () => {
    beforeWrite("ml_deployments", "update", (row) => row.status === "ready", stop);
    expect(await deploy()).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(copies()).toEqual(["stopped"]);
    expect(sessions()).toEqual(["stopped"]);
  });

  it("marks the endpoint stopped before it stops any copy, so a copy coming up sees the Stop", async () => {
    expect((await deploy()).ok).toBe(true);
    const seen: unknown[] = [];
    db.onStop = () => seen.push(endpoint()?.status);
    await stop();
    expect(seen).toEqual(["stopped"]);
  });
});

describe("a deploy nobody stops", () => {
  it("serves", async () => {
    const res = await deploy();
    expect(res.ok).toBe(true);
    expect(endpoint()?.status).toBe("ready");
    expect(copies()).toEqual(["ready"]);
    expect(sessions()).toEqual(["running"]);
  });

  it("whose copy fails on its own still says why, and the endpoint reads failed", async () => {
    db.onHealth = async (sessionId) => {
      const s = db.sessions.get(sessionId)!;
      s.status = "failed";
      s.error = "KeyError: 'url'";
      return { status: 503 };
    };
    expect(await deploy()).toEqual({ ok: false, error: "KeyError: 'url'" });
    expect(endpoint()?.status).toBe("failed");
    expect(copies()).toEqual(["failed"]);
  });

  it("is not marked failed by an earlier deploy of the same endpoint that failed meanwhile", async () => {
    // Deploy A's copy is recorded only after deploy B has started the endpoint
    // again, so B's sweep of old copies never saw it. A's copy then fails while
    // B's is still loading: A's "failed" belongs to A's start, not to B's.
    let second: ReturnType<typeof deploy> | null = null;
    let firstDone = false;
    let firstCopyStartedAt: unknown;
    beforeWrite(
      "ml_deployment_replicas",
      "insert",
      () => true,
      async (row) => {
        firstCopyStartedAt = row.last_started_at;
        const firstStartedAt = endpoint()?.last_started_at;
        second = deployAgain(v1);
        await until(() => endpoint()?.last_started_at !== firstStartedAt);
      },
    );
    db.onHealth = async (sessionId) => {
      if (copy(sessionId).last_started_at === firstCopyStartedAt) {
        const s = db.sessions.get(sessionId)!;
        s.status = "failed";
        s.error = "the first copy failed";
        return { status: 503 };
      }
      await until(() => firstDone);
      return null;
    };
    const first = await deploy();
    firstDone = true;
    expect(first).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect((await second!)?.ok).toBe(true);
    expect(endpoint()?.status).toBe("ready");
    expect(copies().sort()).toEqual(["failed", "ready"]);
  });

  it("is not stamped ready by an earlier deploy whose copy came up as it started", async () => {
    // Deploy A's copy is up; before A stamps the endpoint ready, deploy B
    // (another version) retires A's copy and starts the endpoint again. A's
    // stamp belongs to A's start: landing on B's would call the endpoint ready
    // while B's copy was still loading, and B, finding it so, would give up.
    let second: ReturnType<typeof deploy> | null = null;
    let firstDone = false;
    beforeWrite(
      "ml_deployments",
      "update",
      (row) => row.status === "ready",
      async () => {
        // B's model is still loading when A's stamp is written.
        db.onHealth = async () => {
          await until(() => firstDone);
          return null;
        };
        second = deployAgain(v3);
        await until(() => endpoint()?.version_id === v3.id);
      },
    );
    const first = await deploy();
    firstDone = true;
    expect(first).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect((await second!)?.ok).toBe(true);
    expect(endpoint()?.status).toBe("ready");
    expect(endpoint()?.version_id).toBe(v3.id);
    expect(copies().sort()).toEqual(["ready", "stopped"]);
  });
});

describe("a candidate copy", () => {
  it("that comes up after the endpoint was stopped is stopped again, not named", async () => {
    expect((await deploy()).ok).toBe(true);
    beforeWrite("ml_deployment_replicas", "insert", (row) => row.role === "candidate", stop);
    const res = await setCandidate({ model, userId: "user-1", version: v2, mode: "shadow" });
    expect(res).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("stopped");
    expect(endpoint()?.candidate_version_id).toBe(null);
    expect(copies()).toEqual(["stopped", "stopped"]);
    expect(sessions()).toEqual(["stopped", "stopped"]);
  });

  it("that comes up after the endpoint was deployed again is stopped, not named", async () => {
    expect((await deploy()).ok).toBe(true);
    beforeWrite(
      "ml_deployment_replicas",
      "insert",
      (row) => row.role === "candidate",
      async () => {
        expect((await deployAgain(v3)).ok).toBe(true);
      },
    );
    const res = await setCandidate({ model, userId: "user-1", version: v2, mode: "shadow" });
    expect(res).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(endpoint()?.status).toBe("ready");
    expect(endpoint()?.version_id).toBe(v3.id);
    expect(endpoint()?.candidate_version_id).toBe(null);
    expect(copies().sort()).toEqual(["ready", "stopped", "stopped"]);
  });

  it("replaced by another candidate while it started is not marked ready", async () => {
    // The replacing call lists the first candidate before its sandbox is on
    // the row, so it stops no sandbox, and marks the copy stopped after the
    // sandbox is recorded. The copy's own start must not then call it ready.
    // Its model loads after that mark, as a real load (twenty seconds) does.
    expect((await deploy()).ok).toBe(true);
    let replacing: ReturnType<typeof setCandidate> | null = null;
    let marking = false;
    db.onStart = async () => {
      db.onStart = null;
      const first = db.tables.ml_deployment_replicas.find((r) => r.role === "candidate")!;
      const firstSession = [...db.sessions.keys()].at(-1);
      db.onHealth = async (sessionId) => {
        if (sessionId === firstSession) await until(() => first.status === "stopped");
        return null;
      };
      beforeWrite(
        "ml_deployment_replicas",
        "update",
        (row) => row.status === "stopped",
        async () => {
          marking = true;
          await until(() => first.session_id !== null);
        },
      );
      replacing = setCandidate({ model, userId: "user-1", version: v3, mode: "shadow" });
      await until(() => marking);
    };
    const res = await setCandidate({ model, userId: "user-1", version: v2, mode: "shadow" });
    expect(res).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(await replacing!).toEqual({ ok: true });
    expect(endpoint()?.candidate_version_id).toBe(v3.id);
    const candidates = db.tables.ml_deployment_replicas.filter((r) => r.role === "candidate");
    expect(candidates.map((r) => [r.version_id, r.status])).toEqual([
      [v2.id, "stopped"],
      [v3.id, "ready"],
    ]);
    expect(db.sessions.get(candidates[0].session_id as string)?.status).toBe("stopped");
  });
});

describe("a candidate copy replaced while its model loads", () => {
  it("says it was stopped, not that its sandbox failed", async () => {
    // The replacing call finds the sandbox on the row and stops it, so the
    // load ends in "the sandbox stopped". That is the replacement's doing.
    expect((await deploy()).ok).toBe(true);
    let replacing: ReturnType<typeof setCandidate> | null = null;
    db.onHealth = async () => {
      db.onHealth = null;
      replacing = setCandidate({ model, userId: "user-1", version: v3, mode: "shadow" });
      await until(() => copies().filter((s) => s === "stopped").length === 1);
      return { status: 503 };
    };
    const res = await setCandidate({ model, userId: "user-1", version: v2, mode: "shadow" });
    expect(res).toEqual({ ok: false, error: STOPPED_WHILE_STARTING });
    expect(await replacing!).toEqual({ ok: true });
    expect(endpoint()?.candidate_version_id).toBe(v3.id);
  });
});

describe("the page that pressed Deploy", () => {
  it("shows what the endpoint holds after a deploy that did not serve", () => {
    const panel = readFileSync("src/components/ml/DeploymentPanel.tsx", "utf8");
    const deployFn = panel.slice(panel.indexOf("async function deploy()"));
    const failed = deployFn.slice(
      deployFn.indexOf("if (!res.ok) {"),
      deployFn.indexOf("toast.success("),
    );
    expect(failed).toContain("toast.error(res.error);");
    expect(failed).toContain("await load();");
  });
});
