// Models tracked on an MLflow server (R534): the rules a link must meet, the
// client's guards, and the sync against a fake MLflow server, through the real
// module with the database, the SSRF-guarded fetch and the model folder faked
// one level down.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Fakes ───────────────────────────────────────────────────────────────────

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONN = "33333333-3333-4333-8333-333333333333";
const MODEL = "44444444-4444-4444-8444-444444444444";
const V1 = "55555555-5555-4555-8555-555555555551";
const V2 = "55555555-5555-4555-8555-555555555552";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  audits: [] as { action: string; detail: Record<string, unknown> }[],
  calls: [] as {
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
    opts: Record<string, unknown>;
  }[],
  server: null as
    | null
    | ((
        method: string,
        path: string,
        body: unknown,
      ) => { status: number; json?: unknown; text?: string }),
  folderBuilds: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    const rows = () =>
      (state.tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        if (patch) {
          for (const r of rows()) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        }
        return b;
      },
      in: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Record<string, unknown>) => {
        patch = p;
        return b;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: rows(), error: null }),
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: { action: string; detail: Record<string, unknown> }) => state.audits.push(e),
}));
vi.mock("@/utils/providers/integrationConfig.server", () => ({
  // Decryption is not under test: the row's config is the resolved config.
  resolveIntegrationConfig: async (_u: string, _t: string, cfg: Record<string, unknown>) => cfg,
}));
vi.mock("@/utils/ml/mlflow.server", () => ({
  buildMlflowFolder: async () => {
    state.folderBuilds++;
    return {
      ok: true,
      folder: "m-v1",
      files: {
        MLmodel: new TextEncoder().encode("flavors: {}"),
        "model.joblib": new Uint8Array([1, 2, 3]),
        "code/agentswarms.json": new TextEncoder().encode("{}"),
      },
      exact: true,
      createdAt: new Date(),
    };
  },
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  safeFetch: async (url: string, init: RequestInit & Record<string, unknown>) => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>),
    );
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* raw */
      }
    }
    const path = `${u.pathname}${u.search}`;
    state.calls.push({
      method: String(init.method ?? "GET"),
      path,
      body,
      headers,
      opts: { maxRedirects: init.maxRedirects },
    });
    const out = state.server!(String(init.method ?? "GET"), path, body);
    return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status });
  },
}));

const lib = await import("@/lib/mlflowTracking");
const client = await import("@/utils/ml/mlflowClient.server");
const tracking = await import("@/utils/ml/mlflowTracking.server");

// A small MLflow: experiments by name, runs, artifacts, a registry and aliases.
function mlflowServer(opts: { artifactUri?: (runId: string) => string; failOn?: string } = {}) {
  const exps = new Map<string, string>();
  const runs = new Map<
    string,
    { experiment_id: string; status: string; params: Record<string, string>; metrics: number }
  >();
  const uploads: string[] = [];
  const registered = new Map<string, { versions: string[] }>();
  const aliases = new Map<string, string>();
  let n = 0;
  const handler = (method: string, path: string, body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (opts.failOn && path.startsWith(opts.failOn))
      return { status: 500, json: { error_code: "INTERNAL_ERROR", message: "boom" } };
    if (method === "GET" && path.startsWith("/api/2.0/mlflow/experiments/get-by-name")) {
      const name = new URLSearchParams(path.split("?")[1]).get("experiment_name")!;
      const id = exps.get(name);
      return id
        ? { status: 200, json: { experiment: { experiment_id: id, lifecycle_stage: "active" } } }
        : { status: 404, json: { error_code: "RESOURCE_DOES_NOT_EXIST", message: "no" } };
    }
    if (path === "/api/2.0/mlflow/experiments/create") {
      const id = String(exps.size + 1);
      exps.set(String(b.name), id);
      return { status: 200, json: { experiment_id: id } };
    }
    if (path === "/api/2.0/mlflow/runs/create") {
      const id = `run${++n}`.padEnd(32, "0");
      runs.set(id, {
        experiment_id: String(b.experiment_id),
        status: "RUNNING",
        params: {},
        metrics: 0,
      });
      const uri = opts.artifactUri
        ? opts.artifactUri(id)
        : `mlflow-artifacts:/${b.experiment_id}/${id}/artifacts`;
      return {
        status: 200,
        json: {
          run: {
            info: {
              run_id: id,
              experiment_id: b.experiment_id,
              artifact_uri: uri,
              lifecycle_stage: "active",
            },
          },
        },
      };
    }
    if (method === "GET" && path.startsWith("/api/2.0/mlflow/runs/get")) {
      const id = new URLSearchParams(path.split("?")[1]).get("run_id")!;
      const r = runs.get(id);
      if (!r) return { status: 404, json: { error_code: "RESOURCE_DOES_NOT_EXIST" } };
      const uri = opts.artifactUri
        ? opts.artifactUri(id)
        : `mlflow-artifacts:/${r.experiment_id}/${id}/artifacts`;
      return {
        status: 200,
        json: {
          run: {
            info: {
              run_id: id,
              experiment_id: r.experiment_id,
              artifact_uri: uri,
              lifecycle_stage: "active",
            },
          },
        },
      };
    }
    if (path === "/api/2.0/mlflow/runs/log-batch") {
      const r = runs.get(String(b.run_id))!;
      for (const p of (b.params as { key: string; value: string }[]) ?? []) {
        if (r.params[p.key] !== undefined && r.params[p.key] !== p.value) {
          return {
            status: 400,
            json: {
              error_code: "INVALID_PARAMETER_VALUE",
              message: "Changing param values is not allowed",
            },
          };
        }
        r.params[p.key] = p.value;
      }
      r.metrics += ((b.metrics as unknown[]) ?? []).length;
      return { status: 200, json: {} };
    }
    if (path === "/api/2.0/mlflow/runs/update") {
      runs.get(String(b.run_id))!.status = String(b.status);
      return { status: 200, json: {} };
    }
    if (method === "PUT" && path.startsWith("/api/2.0/mlflow-artifacts/artifacts/")) {
      uploads.push(decodeURIComponent(path.slice("/api/2.0/mlflow-artifacts/artifacts/".length)));
      return { status: 200, json: {} };
    }
    if (path === "/api/2.0/mlflow/registered-models/create") {
      if (registered.has(String(b.name)))
        return { status: 400, json: { error_code: "RESOURCE_ALREADY_EXISTS" } };
      registered.set(String(b.name), { versions: [] });
      return { status: 200, json: {} };
    }
    if (path === "/api/2.0/mlflow/model-versions/create") {
      const m = registered.get(String(b.name))!;
      m.versions.push(String(b.source));
      return { status: 200, json: { model_version: { version: String(m.versions.length) } } };
    }
    if (method === "GET" && path.startsWith("/api/2.0/mlflow/model-versions/get")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const m = registered.get(q.get("name")!);
      return m && Number(q.get("version")) <= m.versions.length
        ? { status: 200, json: { model_version: {} } }
        : { status: 404, json: { error_code: "RESOURCE_DOES_NOT_EXIST" } };
    }
    if (path === "/api/2.0/mlflow/registered-models/alias") {
      if (method === "POST") aliases.set(`${b.name}@${b.alias}`, String(b.version));
      else aliases.delete(`${b.name}@${b.alias}`);
      return { status: 200, json: {} };
    }
    return {
      status: 404,
      json: { error_code: "ENDPOINT_NOT_FOUND", message: `no route ${method} ${path}` },
    };
  };
  return { handler, exps, runs, uploads, registered, aliases };
}

function seed(
  over: {
    tracking?: unknown;
    production?: string | null;
    connOwner?: string;
    connType?: string;
  } = {},
) {
  state.tables = {
    ml_models: [
      {
        id: MODEL,
        user_id: OWNER,
        name: "Churn (next 30 days)",
        task: "classification",
        target_column: "churned",
        source: { schema: "analytics", table: "customers" },
        production_version_id: over.production === undefined ? V1 : over.production,
        tracking:
          over.tracking === undefined
            ? {
                integration_id: CONN,
                experiment: "agentswarms/churn",
                registered_model: "churn",
                alias: "production",
                enabled: true,
              }
            : over.tracking,
      },
    ],
    ml_model_versions: [V1, V2].map((id, i) => ({
      id,
      model_id: MODEL,
      user_id: OWNER,
      version: i + 1,
      status: "ready",
      stage: i === 0 ? "production" : "candidate",
      algorithm: "lightgbm",
      metrics: {
        f1_macro: 0.58 + i / 100,
        accuracy: 0.95,
        confusion_matrix: { labels: [], matrix: [] },
      },
      feature_schema: [
        { name: "tenure", dtype: "numeric", role: "feature" },
        { name: "churned", dtype: "categorical", role: "target" },
      ],
      config: { time_budget_minutes: 3, tuning: "none", validation_fraction: 0.2 },
      artifact_uri: `s3://lakehouse/ml-artifacts/${MODEL}/v${i + 1}/model.joblib`,
      artifact_sha256: "a".repeat(64),
      training_rows: 668,
      training_sampled: false,
      training_snapshot_id: 786,
      decision_threshold: i === 0 ? 0.3 : null,
      positive_label: i === 0 ? "2" : null,
      trained_at: "2026-11-24T10:00:00Z",
      created_at: "2026-11-24T09:00:00Z",
      tracking: null,
    })),
    integrations: [
      {
        id: CONN,
        user_id: over.connOwner ?? OWNER,
        type: over.connType ?? "mlflow",
        is_active: true,
        config: {
          tracking_uri: "http://mlflow.internal:5000/",
          auth: "token",
          token: "test-token-abc",
        },
      },
    ],
  };
}

const version = (id: string) => state.tables.ml_model_versions.find((v) => v.id === id)!;

beforeEach(() => {
  state.audits = [];
  state.calls = [];
  state.folderBuilds = 0;
  seed();
});

// ── The rules ───────────────────────────────────────────────────────────────

describe("a tracking link", () => {
  it("takes MLflow's names and refuses the ones MLflow reserves or rejects", () => {
    const ok = {
      experiment: "agentswarms/churn",
      registered_model: "churn (30d)",
      alias: "production",
    };
    expect(lib.trackingProblem(ok)).toBeNull();
    expect(lib.trackingProblem({ ...ok, experiment: " " })).toMatch(/Name the MLflow experiment/);
    expect(lib.trackingProblem({ ...ok, registered_model: "a/b" })).toMatch(
      /no slash, colon or percent/,
    );
    expect(lib.trackingProblem({ ...ok, registered_model: "x:y" })).toMatch(/no slash/);
    expect(lib.trackingProblem({ ...ok, alias: "latest" })).toMatch(/reserves/);
    expect(lib.trackingProblem({ ...ok, alias: "v3" })).toMatch(/reserves/);
    expect(lib.trackingProblem({ ...ok, alias: "prod uction" })).toMatch(/letters, digits/);
  });

  it("defaults to names MLflow takes", () => {
    expect(lib.defaultExperiment("Churn (30 days)")).toBe("agentswarms/Churn (30 days)");
    expect(lib.defaultRegisteredModel("Rev/Region: 50%")).toBe("Rev-Region- 50-");
    expect(
      lib.trackingProblem({
        experiment: "e",
        registered_model: lib.defaultRegisteredModel("a/b:c%d"),
        alias: "production",
      }),
    ).toBeNull();
  });

  it("reads back only what it wrote, and nothing else", () => {
    expect(lib.parseModelTracking({ integration_id: "not-a-uuid" })).toBeNull();
    expect(
      lib.parseModelTracking({ integration_id: CONN, experiment: "e", registered_model: "r" }),
    ).toMatchObject({
      alias: "production",
      enabled: true,
    });
    expect(lib.parseVersionTracking({ run_id: "r", logged: "yes", evil: "x" })).toEqual({
      run_id: "r",
    });
  });

  it("links to a run only through an http(s) address and plain ids", () => {
    const t = { server: "http://mlflow.internal:5000", experiment_id: "3", run_id: "abc123" };
    expect(lib.runLink(t)).toBe("http://mlflow.internal:5000/#/experiments/3/runs/abc123");
    // The stored tracking is owner-writable: whatever is in it, a viewer's
    // click never runs script or carries credentials.
    expect(lib.runLink({ ...t, server: "javascript:alert(1)" })).toBeNull();
    expect(lib.runLink({ ...t, server: "data:text/html,x" })).toBeNull();
    expect(lib.runLink({ ...t, server: "http://user:pw@host" })).toBeNull();
    expect(lib.runLink({ ...t, run_id: "a/../b" })).toBeNull();
    expect(lib.runLink({ ...t, experiment_id: "1?x=" })).toBeNull();
  });
});

describe("the client", () => {
  it("calls only http(s) servers, with no credentials in the address", () => {
    expect(client.mlflowBase("https://mlflow.example.com/")).toBe("https://mlflow.example.com");
    expect(client.mlflowBase("http://host:5000/mlflow/")).toBe("http://host:5000/mlflow");
    expect(client.mlflowBase("https://u:p@mlflow.example.com")).toBeNull();
    expect(client.mlflowBase("file:///etc/passwd")).toBeNull();
    expect(client.mlflowBase("https://host/?q=1")).toBeNull();
  });

  it("signs in with a bearer token or a username and password", () => {
    expect(
      client.mlflowHeaders({ tracking_uri: "x", auth: "token", token: "Bearer t1" }).Authorization,
    ).toBe("Bearer t1");
    expect(
      client.mlflowHeaders({ tracking_uri: "x", auth: "basic", username: "ann", password: "pw" })
        .Authorization,
    ).toBe(`Basic ${Buffer.from("ann:pw").toString("base64")}`);
    expect(
      client.mlflowHeaders({ tracking_uri: "x", auth: "none", token: "t" }).Authorization,
    ).toBeUndefined();
  });

  it("uploads through the server only to a proxied artifact path, and only a safe one", () => {
    expect(client.proxiedArtifactPath("mlflow-artifacts:/1/abc/artifacts")).toBe("1/abc/artifacts");
    expect(client.proxiedArtifactPath("mlflow-artifacts://host:5000/1/abc/artifacts/")).toBe(
      "1/abc/artifacts",
    );
    expect(client.proxiedArtifactPath("s3://bucket/1/abc/artifacts")).toBeNull();
    expect(client.proxiedArtifactPath("mlflow-artifacts:/1/../../etc")).toBeNull();
    expect(client.proxiedArtifactPath("mlflow-artifacts:/")).toBeNull();
  });

  it("puts no id it did not check into a path", () => {
    expect(client.safeId("123", "x")).toBe("123");
    expect(() => client.safeId("../1", "run id")).toThrow(/unexpected run id/);
    expect(() => client.safeId(undefined, "run id")).toThrow();
  });
});

// ── The sync ────────────────────────────────────────────────────────────────

describe("sending a version", () => {
  it("makes the run, logs it, uploads the model, registers it and points the alias at production", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    const out = await tracking.syncVersionToMlflow(V1, "trained");
    expect(out.ok).toBe(true);
    const runId = [...s.runs.keys()][0];
    // The experiment was made by name, once.
    expect([...s.exps.keys()]).toEqual(["agentswarms/churn"]);
    // Params are how it was made; the line is a tag (params cannot change).
    const run = s.runs.get(runId)!;
    expect(run.params).toMatchObject({
      task: "classification",
      algorithm: "lightgbm",
      source_table: "analytics.customers",
      training_rows: "668",
    });
    expect(run.params).not.toHaveProperty("decision_threshold");
    expect(run.metrics).toBe(2); // scalars only: the confusion matrix is not a metric
    expect(run.status).toBe("FINISHED");
    // The model folder, under the run's `model` artifact.
    expect(s.uploads.sort()).toEqual(
      ["MLmodel", "code/agentswarms.json", "model.joblib"]
        .map((f) => `1/${runId}/artifacts/model/${f}`)
        .sort(),
    );
    // Registered from that artifact, and production's alias on it.
    expect(s.registered.get("churn")!.versions).toEqual([
      `mlflow-artifacts:/1/${runId}/artifacts/model`,
    ]);
    expect(s.aliases.get("churn@production")).toBe("1");
    expect(version(V1).tracking).toMatchObject({
      server: "http://mlflow.internal:5000",
      experiment_id: "1",
      run_id: runId,
      logged: true,
      artifacts: true,
      registered_model: "churn",
      registered_version: "1",
    });
    expect(state.audits.map((a) => a.action)).toEqual(["ml.mlflow.synced", "ml.mlflow.alias"]);
  });

  it("sends the token only to the tracking server, and never follows a redirect", async () => {
    state.server = mlflowServer().handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    expect(state.calls.length).toBeGreaterThan(5);
    for (const c of state.calls) {
      expect(c.headers.Authorization).toBe("Bearer test-token-abc");
      expect(c.opts.maxRedirects).toBe(0);
    }
  });

  it("sends a second version without moving the alias off production", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    await tracking.syncVersionToMlflow(V2, "trained");
    expect(s.registered.get("churn")!.versions).toHaveLength(2);
    expect(s.aliases.get("churn@production")).toBe("1");
  });

  it("sends again without a second run, a second upload or a second registered version", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    // The line moved here; sending again updates its tag, not its params.
    version(V1).decision_threshold = 0.45;
    const out = await tracking.syncVersionToMlflow(V1, "manual");
    expect(out.ok).toBe(true);
    expect(s.runs.size).toBe(1);
    expect(s.uploads).toHaveLength(3);
    expect(s.registered.get("churn")!.versions).toHaveLength(1);
    expect(state.folderBuilds).toBe(1);
  });

  it("joins a sync already running for the version instead of starting another", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    const [a, b] = await Promise.all([
      tracking.syncVersionToMlflow(V1, "trained"),
      tracking.syncVersionToMlflow(V1, "promoted"),
    ]);
    expect(a).toBe(b);
    expect(s.runs.size).toBe(1);
  });

  it("logs the run but neither uploads nor registers where the server keeps artifacts elsewhere", async () => {
    const s = mlflowServer({ artifactUri: (id) => `s3://team-bucket/mlruns/1/${id}/artifacts` });
    state.server = s.handler;
    const out = await tracking.syncVersionToMlflow(V1, "trained");
    expect(out.ok).toBe(true);
    expect(s.uploads).toEqual([]);
    expect(s.registered.size).toBe(0);
    expect(version(V1).tracking).toMatchObject({
      logged: true,
      note: expect.stringMatching(/not its model/),
    });
    expect(version(V1).tracking).not.toHaveProperty("artifacts");
  });

  it("says why it stopped, keeps the run for the retry, and the retry finishes in that run", async () => {
    const s = mlflowServer({ failOn: "/api/2.0/mlflow-artifacts" });
    state.server = s.handler;
    const out = await tracking.syncVersionToMlflow(V1, "trained");
    expect(out.ok).toBe(false);
    const t = version(V1).tracking as Record<string, unknown>;
    expect(t.error).toMatch(/Uploading .* failed: 500/);
    expect(t.run_id).toBe([...s.runs.keys()][0]);
    expect(state.audits.map((a) => a.action)).toEqual(["ml.mlflow.sync_failed"]);

    // The server recovers: the same run is finished, nothing is logged twice.
    const healthy = mlflowServer();
    healthy.exps.set("agentswarms/churn", "1");
    for (const [k, v] of s.runs) healthy.runs.set(k, v);
    state.server = healthy.handler;
    const again = await tracking.syncVersionToMlflow(V1, "manual");
    expect(again.ok).toBe(true);
    expect(healthy.runs.size).toBe(1);
    expect(version(V1).tracking).not.toHaveProperty("error");
  });

  it("sends nothing for a model that is not tracked, or whose link is turned off", async () => {
    state.server = mlflowServer().handler;
    seed({ tracking: null });
    expect(await tracking.syncVersionToMlflow(V1, "trained")).toEqual({
      ok: false,
      skipped: "not tracked",
    });
    seed({
      tracking: {
        integration_id: CONN,
        experiment: "e",
        registered_model: "r",
        alias: "production",
        enabled: false,
      },
    });
    expect(await tracking.syncVersionToMlflow(V1, "trained")).toEqual({
      ok: false,
      skipped: "not tracked",
    });
    expect(state.calls).toEqual([]);
  });

  it("uses only the model owner's own MLflow connection, whatever id the link holds", async () => {
    state.server = mlflowServer().handler;
    // The link is owner-writable: pointing it at someone else's connection
    // (or at a row of another type) finds nothing, and nothing is sent.
    seed({ connOwner: OTHER });
    const out = await tracking.syncVersionToMlflow(V1, "trained");
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/was removed/) });
    seed({ connType: "llm_gateway" });
    expect(await tracking.syncVersionToMlflow(V1, "trained")).toMatchObject({ ok: false });
    expect(state.calls).toEqual([]);
  });
});

describe("the alias", () => {
  it("follows a promotion to a version already registered", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    await tracking.syncVersionToMlflow(V2, "trained");
    state.tables.ml_models[0].production_version_id = V2;
    await tracking.moveMlflowAlias(MODEL);
    expect(s.aliases.get("churn@production")).toBe("2");
  });

  it("sends a promoted version that was never sent, and points the alias at it", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    state.tables.ml_models[0].production_version_id = V2;
    await tracking.moveMlflowAlias(MODEL);
    expect(s.runs.size).toBe(1);
    expect(s.aliases.get("churn@production")).toBe("1");
    expect(version(V2).tracking).toMatchObject({ registered_version: "1" });
  });

  it("is taken away when production has nothing registered, rather than naming an old version", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    expect(s.aliases.get("churn@production")).toBe("1");
    state.tables.ml_models[0].production_version_id = null;
    await tracking.moveMlflowAlias(MODEL);
    expect(s.aliases.has("churn@production")).toBe(false);
  });
});

describe("where the alias points, said on the model", () => {
  const link = () => state.tables.ml_models[0].tracking as Record<string, unknown>;

  it("records the registered version it was moved to", async () => {
    state.server = mlflowServer().handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    expect(link().alias_version).toBe("1");
    expect(link()).not.toHaveProperty("alias_error");
  });

  it("says why a move failed instead of leaving MLflow on the old version silently, and clears it once moved", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    await tracking.syncVersionToMlflow(V2, "trained");
    // The server refuses the alias while v2 is promoted here.
    state.server = mlflowServer({ failOn: "/api/2.0/mlflow/registered-models/alias" }).handler;
    state.tables.ml_models[0].production_version_id = V2;
    const out = await tracking.moveMlflowAlias(MODEL);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/boom/) });
    expect(link()).toMatchObject({
      alias_version: "1",
      alias_error: expect.stringMatching(/boom/),
    });
    expect(state.audits.map((a) => a.action)).toContain("ml.mlflow.alias_failed");

    state.server = s.handler;
    expect(await tracking.moveMlflowAlias(MODEL)).toMatchObject({ ok: true, version: "2" });
    expect(link().alias_version).toBe("2");
    expect(link()).not.toHaveProperty("alias_error");
    expect(link()).not.toHaveProperty("alias_failed_at");
  });

  it("says so when the connection behind the link is gone", async () => {
    state.server = mlflowServer().handler;
    state.tables.integrations = [];
    const out = await tracking.moveMlflowAlias(MODEL);
    expect(out).toMatchObject({ ok: false });
    expect(link().alias_error).toMatch(/was removed/);
  });
});

describe("sending every version", () => {
  it("sends the unsent ones, oldest first, once each", async () => {
    const s = mlflowServer();
    state.server = s.handler;
    await tracking.syncVersionToMlflow(V1, "trained");
    const out = await tracking.syncModelToMlflow(MODEL, "linked");
    expect(out).toEqual({ sent: 1, failed: 0, left: 0 });
    expect(s.runs.size).toBe(2);
  });
});
