// Importing from an MLflow server's registry (R535): through the real module,
// with the database, the SSRF-guarded fetch and the zip import faked one
// level down. The import reads two files (MLmodel and the model file it
// names), counts what arrives against the limit, refuses what it cannot
// read, and hands the zip import exactly those two files.
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONN = "33333333-3333-4333-8333-333333333333";
const MODEL = "44444444-4444-4444-8444-444444444444";

const SKLEARN_MLMODEL = `artifact_path: model
flavors:
  python_function:
    loader_module: mlflow.sklearn
    model_path: model.pkl
  sklearn:
    pickled_model: model.pkl
    serialization_format: cloudpickle
    sklearn_version: 1.9.1
signature:
  inputs: '[{"type": "double", "name": "net_usd"}, {"type": "string", "name": "region"}]'
`;

const state = vi.hoisted(() => ({
  connOwner: "",
  urls: [] as string[],
  files: {} as Record<string, string | Uint8Array>,
  versions: [] as { version: string; status: string; aliases: string[]; run_id?: string }[],
  downloadUri: "",
  imported: [] as { bytes: Uint8Array; fileName: string; source: unknown }[],
  maxBytes: 500 * 1024 * 1024,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = () => {
    const f: [string, unknown][] = [];
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => (f.push([k, v]), b),
      maybeSingle: async () => {
        const row = {
          id: CONN,
          user_id: state.connOwner,
          type: "mlflow",
          is_active: true,
          config: { tracking_uri: "http://mlflow.internal:5000", auth: "none" },
        };
        return {
          data: f.every(([k, v]) => (row as Record<string, unknown>)[k] === v) ? row : null,
          error: null,
        };
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/providers/integrationConfig.server", () => ({
  resolveIntegrationConfig: async (_u: string, _t: string, cfg: Record<string, unknown>) => cfg,
}));
vi.mock("@/utils/ml/mlflow.server", () => ({
  importMaxBytes: () => state.maxBytes,
  importMlflowZip: async (a: { bytes: Uint8Array; fileName: string; source: unknown }) => {
    state.imported.push(a);
    return { ok: true, versionId: "v-new", version: 15, jobId: "job-1" };
  },
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  safeFetch: async (url: string) => {
    state.urls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    const q = u.searchParams;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (p === "/api/2.0/mlflow/registered-models/search") {
      return json({
        registered_models: [
          {
            name: "churn",
            aliases: [{ alias: "production", version: "3" }],
            latest_versions: [{ version: "4" }],
          },
          { name: "bad/name\u0007", aliases: [] },
        ],
        filter_seen: q.get("filter"),
      });
    }
    if (p === "/api/2.0/mlflow/model-versions/search") {
      // As MLflow 3.18 answers: no aliases on the versions.
      return json({
        model_versions: state.versions.map(({ aliases: _a, ...v }) => ({ name: "churn", ...v })),
      });
    }
    if (p === "/api/2.0/mlflow/registered-models/get") {
      return json({
        registered_model: {
          name: "churn",
          aliases: state.versions.flatMap((v) =>
            v.aliases.map((alias) => ({ alias, version: v.version })),
          ),
        },
      });
    }
    if (p === "/api/2.0/mlflow/registered-models/alias") {
      return q.get("alias") === "production"
        ? json({ model_version: { version: "3" } })
        : json({ error_code: "RESOURCE_DOES_NOT_EXIST", message: "no alias" }, 404);
    }
    if (p === "/api/2.0/mlflow/model-versions/get") {
      const v = state.versions.find((x) => x.version === q.get("version"));
      return v ? json({ model_version: v }) : json({ error_code: "RESOURCE_DOES_NOT_EXIST" }, 404);
    }
    if (p === "/api/2.0/mlflow/model-versions/get-download-uri") {
      return json({ artifact_uri: state.downloadUri });
    }
    if (p.startsWith("/api/2.0/mlflow-artifacts/artifacts/")) {
      const rel = decodeURIComponent(p.slice("/api/2.0/mlflow-artifacts/artifacts/".length));
      const f = state.files[rel];
      return f === undefined
        ? new Response("no", { status: 404 })
        : new Response(f, { status: 200 });
    }
    return json({ error_code: "ENDPOINT_NOT_FOUND" }, 404);
  },
}));

const reg = await import("@/utils/ml/mlflowRegistry.server");

const ROOT = "2/models/m-abc/artifacts";

beforeEach(() => {
  state.connOwner = OWNER;
  state.urls = [];
  state.imported = [];
  state.maxBytes = 500 * 1024 * 1024;
  state.downloadUri = `mlflow-artifacts:/${ROOT}`;
  state.versions = [
    { version: "3", status: "READY", aliases: ["production"], run_id: "a".repeat(32) },
    { version: "4", status: "PENDING_REGISTRATION", aliases: [] },
  ];
  state.files = {
    [`${ROOT}/MLmodel`]: SKLEARN_MLMODEL,
    [`${ROOT}/model.pkl`]: new Uint8Array([7, 7, 7]),
    [`${ROOT}/conda.yaml`]: "never read",
  };
});

const go = (extra: { version?: string; alias?: string } = {}) =>
  reg.importFromMlflowServer({
    userId: OWNER,
    modelId: MODEL,
    integrationId: CONN,
    name: "churn",
    ...extra,
  });

describe("importing from an MLflow server", () => {
  it("reads MLmodel and the file it names, nothing else, and hands the zip import exactly those", async () => {
    const out = await go({ version: "3" });
    expect(out).toMatchObject({ ok: true, version: 15, from: "churn v3" });
    const read = state.urls
      .filter((u) => u.includes("mlflow-artifacts"))
      .map((u) => decodeURIComponent(new URL(u).pathname));
    expect(read).toEqual([
      `/api/2.0/mlflow-artifacts/artifacts/${ROOT}/MLmodel`,
      `/api/2.0/mlflow-artifacts/artifacts/${ROOT}/model.pkl`,
    ]);
    const files = unzipSync(state.imported[0].bytes);
    expect(Object.keys(files).sort()).toEqual([
      "model/MLmodel",
      "model/SOURCE.txt",
      "model/model.pkl",
    ]);
    expect([...files["model/model.pkl"]]).toEqual([7, 7, 7]);
    expect(strFromU8(files["model/MLmodel"])).toBe(SKLEARN_MLMODEL);
    // Where it came from goes with it.
    expect(state.imported[0].source).toEqual({
      server: "http://mlflow.internal:5000",
      registered_model: "churn",
      version: "3",
      run_id: "a".repeat(32),
    });
  });

  it("takes a version by alias, and says the alias", async () => {
    const out = await go({ alias: "production" });
    expect(out).toMatchObject({ ok: true, from: "churn v3" });
    expect(state.imported[0].source).toMatchObject({ version: "3", alias: "production" });
  });

  it("refuses a version MLflow has not finished registering", async () => {
    expect(await go({ version: "4" })).toMatchObject({
      ok: false,
      status: 409,
      error: "Version 4 of churn is pending registration in MLflow, not ready.",
    });
    expect(state.imported).toEqual([]);
  });

  it("refuses, in words, a model kept where this app does not read", async () => {
    state.downloadUri = "s3://team-bucket/mlruns/2/models/m-abc/artifacts";
    const out = await go({ version: "3" });
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect((out as { error: string }).error).toMatch(
      /keeps that model in s3:, which this app does not read/,
    );
    expect(state.urls.some((u) => u.includes("mlflow-artifacts"))).toBe(false);
  });

  it("refuses an MLmodel that names a file outside its folder, before reading it", async () => {
    state.files[`${ROOT}/MLmodel`] = SKLEARN_MLMODEL.replace(/model\.pkl/g, "../../../etc/passwd");
    const out = await go({ version: "3" });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(state.urls.filter((u) => u.includes("mlflow-artifacts"))).toHaveLength(1);
  });

  it("stops reading a model file larger than the import limit", async () => {
    state.maxBytes = 2;
    const out = await go({ version: "3" });
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(
      /model\.pkl is larger than the 0 MB import limit/,
    );
    expect(state.imported).toEqual([]);
  });

  it("uses only the caller's own MLflow connection", async () => {
    state.connOwner = OTHER;
    expect(await go({ version: "3" })).toMatchObject({
      ok: false,
      status: 404,
      error: "That MLflow connection is not one of yours.",
    });
    expect(state.urls).toEqual([]);
  });
});

describe("browsing the registry", () => {
  it("keeps the search inside its string: no quote from the caller reaches the filter", async () => {
    await reg.searchRegisteredModels(OWNER, CONN, "chu' OR name LIKE '%");
    const filter = new URL(state.urls[0]).searchParams.get("filter");
    expect(filter).toBe("name ILIKE '%chu OR name LIKE %%'");
  });

  it("keeps underscores, which model names are full of", async () => {
    await reg.searchRegisteredModels(OWNER, CONN, "threshold_probe");
    expect(new URL(state.urls[0]).searchParams.get("filter")).toBe(
      "name ILIKE '%threshold_probe%'",
    );
  });

  it("lists only names it can show, with their aliases", async () => {
    const out = await reg.searchRegisteredModels(OWNER, CONN, "");
    expect(out).toEqual({
      ok: true,
      models: [
        {
          name: "churn",
          description: null,
          aliases: [{ alias: "production", version: "3" }],
          latest: "4",
        },
      ],
    });
  });

  it("lists a model's versions newest first, with their aliases and unsafe run ids dropped", async () => {
    state.versions.push({ version: "5", status: "READY", aliases: [], run_id: "../x" });
    const out = await reg.listModelVersions(OWNER, CONN, "churn");
    expect(out.ok && out.versions.map((v) => [v.version, v.aliases, v.run_id])).toEqual([
      ["5", [], null],
      ["4", [], null],
      // The alias comes from the registered model: the version search leaves it out.
      ["3", ["production"], "a".repeat(32)],
    ]);
  });
});
