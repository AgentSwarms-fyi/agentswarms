// Sending a version to a real MLflow tracking server (R534): the real sync and
// the real client over HTTP to whatever MLFLOW_TRACKING_TEST_URL names, with
// only the database and the model folder faked. Opt-in like every
// integration test:
//
//   docker run -d --name mlflow-test -p 127.0.0.1:15050:5000 ghcr.io/mlflow/mlflow:v3.18.0 \
//     mlflow server --host 0.0.0.0 --port 5000 --backend-store-uri sqlite:////tmp/m.db \
//     --artifacts-destination /tmp/artifacts --allowed-hosts "*"
//   MLFLOW_TRACKING_TEST_URL=http://127.0.0.1:15050 npx vitest run \
//     --config vitest.integration.config.ts tests/integration/mlflowTracking.test.ts
//
// MLFLOW_TEST_EXPORT_DIR may name an unzipped export from the app (the folder
// holding MLmodel): it is uploaded as the model, so the registered version
// can then be loaded with mlflow.pyfunc.load_model("models:/<name>@production").
// Without it a small stand-in folder is uploaded. The unit file
// (tests/unit/mlflowTracking.test.ts) holds the rules against a fake server;
// this proves the protocol: the paths, payloads and error codes MLflow answers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

const URL_ = process.env.MLFLOW_TRACKING_TEST_URL;
const EXPORT_DIR = process.env.MLFLOW_TEST_EXPORT_DIR;
const RUN = Date.now().toString(36);
const MODEL = "44444444-4444-4444-8444-444444444444";
const V1 = "55555555-5555-4555-8555-555555555551";
const V2 = "55555555-5555-4555-8555-555555555552";
const CONN = "33333333-3333-4333-8333-333333333333";
const OWNER = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  imported: [] as { bytes: Uint8Array; source: unknown }[],
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
      order: () => b,
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
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/providers/integrationConfig.server", () => ({
  resolveIntegrationConfig: async (_u: string, _t: string, cfg: Record<string, unknown>) => cfg,
}));
vi.mock("@/utils/ml/mlflow.server", () => ({
  buildMlflowFolder: async () => ({
    ok: true,
    folder: "m",
    files: folder(),
    exact: true,
    createdAt: new Date(),
  }),
  importMaxBytes: () => 500 * 1024 * 1024,
  // R535: the import from a server hands its two files here.
  importMlflowZip: async (a: { bytes: Uint8Array; source: unknown }) => {
    state.imported.push(a);
    return { ok: true, versionId: "v-new", version: 3, jobId: "job-1" };
  },
}));

function folder(): Record<string, Uint8Array> {
  if (!EXPORT_DIR) {
    return {
      MLmodel: new TextEncoder().encode("artifact_path: model\nflavors: {}\n"),
      "README.md": new TextEncoder().encode("stand-in"),
    };
  }
  const out: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(EXPORT_DIR, p).replace(/\\/g, "/")] = new Uint8Array(readFileSync(p));
    }
  };
  walk(EXPORT_DIR);
  return out;
}

function seed() {
  const v = (id: string, n: number) => ({
    id,
    model_id: MODEL,
    user_id: OWNER,
    version: n,
    status: "ready",
    algorithm: "lightgbm",
    metrics: { f1_macro: 0.58, accuracy: 0.952, log_loss: 0.346 },
    feature_schema: [{ name: "net_usd", dtype: "numeric", role: "feature" }],
    config: { time_budget_minutes: 3, tuning: "none", validation_fraction: 0.2 },
    artifact_sha256: "e".repeat(64),
    training_rows: 668,
    training_sampled: false,
    training_snapshot_id: 786,
    decision_threshold: n === 1 ? 0.3 : null,
    positive_label: n === 1 ? "2" : null,
    trained_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    tracking: null,
  });
  state.tables = {
    ml_models: [
      {
        id: MODEL,
        user_id: OWNER,
        name: "threshold_probe (payment_rows)",
        task: "classification",
        target_column: "payment_rows",
        source: { schema: "analytics", table: "revenue_facts" },
        production_version_id: V1,
        tracking: {
          integration_id: CONN,
          experiment: `agentswarms/contract-${RUN}`,
          registered_model: `threshold_probe_${RUN}`,
          alias: "production",
          enabled: true,
        },
      },
    ],
    ml_model_versions: [v(V1, 1), v(V2, 2)],
    integrations: [
      {
        id: CONN,
        user_id: OWNER,
        type: "mlflow",
        is_active: true,
        config: { tracking_uri: URL_, auth: "none" },
      },
    ],
  };
}

describe.skipIf(!URL_)("a real MLflow tracking server", () => {
  it("takes a version as a run with its model, registers it, and moves the alias with production", async () => {
    seed();
    const { syncVersionToMlflow, moveMlflowAlias } =
      await import("@/utils/ml/mlflowTracking.server");
    const { mlflowCall } = await import("@/utils/ml/mlflowClient.server");
    const conn = { tracking_uri: URL_!, auth: "none" };
    const name = `threshold_probe_${RUN}`;

    const first = await syncVersionToMlflow(V1, "trained");
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const t1 = state.tables.ml_model_versions[0].tracking as Record<string, string>;
    expect(t1).toMatchObject({
      logged: true,
      artifacts: true,
      registered_model: name,
      registered_version: "1",
    });

    // What MLflow itself now says about the run.
    const run = await mlflowCall<{
      run: { info: { status: string }; data: Record<string, { key: string; value: unknown }[]> };
    }>(conn, "GET", `/api/2.0/mlflow/runs/get?run_id=${t1.run_id}`);
    expect(run.run.info.status).toBe("FINISHED");
    const params = Object.fromEntries(run.run.data.params.map((p) => [p.key, p.value]));
    expect(params).toMatchObject({
      algorithm: "lightgbm",
      source_table: "analytics.revenue_facts",
      training_rows: "668",
    });
    const tags = Object.fromEntries(run.run.data.tags.map((p) => [p.key, p.value]));
    expect(tags).toMatchObject({
      "agentswarms.version": "1",
      "agentswarms.decision_threshold": "0.3",
    });
    expect(run.run.data.metrics.map((m) => m.key).sort()).toEqual([
      "accuracy",
      "f1_macro",
      "log_loss",
    ]);
    const listed = await mlflowCall<{ files?: { path: string }[] }>(
      conn,
      "GET",
      `/api/2.0/mlflow/artifacts/list?run_id=${t1.run_id}&path=model`,
    );
    expect((listed.files ?? []).map((f) => f.path)).toContain("model/MLmodel");
    const alias = await mlflowCall<{ model_version: { version: string } }>(
      conn,
      "GET",
      `/api/2.0/mlflow/registered-models/alias?name=${encodeURIComponent(name)}&alias=production`,
    );
    expect(alias.model_version.version).toBe("1");

    // Sending it again changes nothing in MLflow: same run, same registered version.
    const again = await syncVersionToMlflow(V1, "manual");
    expect(again).toMatchObject({
      ok: true,
      tracking: { run_id: t1.run_id, registered_version: "1" },
    });

    // v2 is sent, then promoted: the alias moves to it.
    expect(await syncVersionToMlflow(V2, "trained")).toMatchObject({ ok: true });
    state.tables.ml_models[0].production_version_id = V2;
    await moveMlflowAlias(MODEL);
    const moved = await mlflowCall<{ model_version: { version: string } }>(
      conn,
      "GET",
      `/api/2.0/mlflow/registered-models/alias?name=${encodeURIComponent(name)}&alias=production`,
    );
    expect(moved.model_version.version).toBe("2");
  });

  it("gives a registered version back, by alias, as the two files the import reads (R535)", async () => {
    const { importFromMlflowServer, listModelVersions, searchRegisteredModels } =
      await import("@/utils/ml/mlflowRegistry.server");
    const name = `threshold_probe_${RUN}`;
    const found = await searchRegisteredModels(OWNER, CONN, `probe_${RUN}`);
    expect(found).toMatchObject({
      ok: true,
      models: [{ name, aliases: [{ alias: "production" }] }],
    });
    const versions = await listModelVersions(OWNER, CONN, name);
    expect(versions.ok && versions.versions.map((v) => v.version)).toEqual(["2", "1"]);

    const out = await importFromMlflowServer({
      userId: OWNER,
      modelId: MODEL,
      integrationId: CONN,
      name,
      alias: "production",
    });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, from: `${name} v2` });
    const { unzipSync } = await import("fflate");
    const files = unzipSync(state.imported[0].bytes);
    const model = Object.keys(files)
      .filter((f) => f !== "model/SOURCE.txt")
      .sort();
    const sent = folder();
    const named = Object.keys(sent).find((f) => f.endsWith(".joblib") || f.endsWith(".pkl"));
    // What came back is exactly what was sent: MLmodel and the model file.
    expect(model).toEqual(["model/MLmodel", ...(named ? [`model/${named}`] : [])].sort());
    if (named)
      expect(Buffer.from(files[`model/${named}`]).equals(Buffer.from(sent[named]))).toBe(true);
    expect(state.imported[0].source).toMatchObject({
      registered_model: name,
      version: "2",
      alias: "production",
    });
  });

  it("answers an unknown experiment and a refused change in MLflow's own error codes", async () => {
    const { mlflowCall, MlflowError } = await import("@/utils/ml/mlflowClient.server");
    const conn = { tracking_uri: URL_!, auth: "none" };
    const err = await mlflowCall(
      conn,
      "GET",
      `/api/2.0/mlflow/experiments/get-by-name?experiment_name=nope-${RUN}`,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MlflowError);
    expect(err.code).toBe("RESOURCE_DOES_NOT_EXIST");
  });
});
