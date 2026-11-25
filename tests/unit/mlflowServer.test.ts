// MLflow export and import in the app (R533), through the real module, with
// the lake, the database and the job start faked one level down.
//
// Export: the owner gets the folder MLflow loads, with the version's own
// artifact, checked against its digest, and nothing else does. Import: the
// app reads only the zip's listing and MLmodel, stages the model file under
// the model's own prefix, and starts a job; it refuses in words anything it
// could not score, before staging anything.
import { createHash } from "node:crypto";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  versions: [] as Record<string, unknown>[],
  puts: [] as { key: string; bytes: Buffer; kms: unknown }[],
  updates: [] as { patch: Record<string, unknown>; id: unknown }[],
  audits: [] as { action: string; detail: Record<string, unknown> }[],
  started: [] as {
    config: Record<string, unknown>;
    version: number;
    opts: Record<string, unknown>;
  }[],
  artifact: Buffer.from("fitted-pipeline"),
}));

const OWNER = "owner-1";
const MODEL = {
  id: "5f1c2a9e-7b1d-4e55-9a10-6c2b8d4e1f77",
  user_id: OWNER,
  name: "Churn · next 30 days",
  task: "classification",
  target_column: "churned",
};

vi.mock("@/utils/ml/access.server", () => ({
  loadModelForUser: async (id: string, userId: string) => {
    if (id !== MODEL.id || userId !== OWNER) throw new Error("Model not found");
    return {
      model: { ...MODEL, task: (globalThis as { __task?: string }).__task ?? MODEL.task },
      shared: false,
    };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const table = () => {
    const f: [string, unknown][] = [];
    const rows = () => db.versions.filter((r) => f.every(([k, v]) => r[k] === v));
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (f.push([k, v]), b),
      order: () => b,
      limit: () => b,
      update: (patch: Record<string, unknown>) => ({
        eq: async (_k: string, id: unknown) => (db.updates.push({ patch, id }), { error: null }),
      }),
      maybeSingle: async () => ({
        data: [...rows()].sort((x, y) => (y.version as number) - (x.version as number))[0] ?? null,
        error: null,
      }),
    };
    return b;
  };
  return { supabaseAdmin: { from: () => table() } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: { action: string; detail: Record<string, unknown> }) => db.audits.push(e),
}));
vi.mock("@/utils/ml/experimentArtifacts.server", () => ({
  lakeTarget: async () => ({ bucket: "lakehouse", target: { bucket: "lakehouse" } }),
}));
vi.mock("@/utils/lakehouse/presign.server", () => ({
  presignS3: (a: { key: string }) => `https://lake.test/${a.key}`,
  s3PutObject: async (_t: unknown, key: string, bytes: Buffer, o: { kmsKeyId?: unknown }) => {
    db.puts.push({ key, bytes, kms: o.kmsKeyId });
    return { sha256: "", bytes: bytes.length };
  },
}));
vi.mock("@/utils/lakehouse/customerKeyFiles.server", () => ({
  lakeObjectKmsKey: async () => "arn:aws:kms:us-east-1:111122223333:key/test-key",
}));
vi.mock("@/utils/ml/serve.server", () => ({
  mlScoreBundleFor: async () => ({
    code: "# program",
    env: {},
    config: { mode: "predict", model_id: MODEL.id, version: 3, artifact_sha256: "x" },
  }),
}));
vi.mock("@/utils/ml/api.server", () => ({
  createAndTrainVersion: async (
    _m: unknown,
    config: Record<string, unknown>,
    version: number,
    opts: Record<string, unknown>,
  ) => {
    db.started.push({ config, version, opts });
    return { ok: true, jobId: "job-1", versionId: "version-new" };
  },
}));
vi.stubGlobal("fetch", async (url: string) =>
  url.startsWith("https://lake.test/")
    ? new Response(new Uint8Array(db.artifact), { status: 200 })
    : new Response(null, { status: 404 }),
);

const { exportMlflowZip, importMlflowZip, exportFolderName } =
  await import("@/utils/ml/mlflow.server");
const { readMlmodel, signatureDecision } = await import("@/lib/mlflowFormat");
const { MLFLOW_LOADER_PY } = await import("@/utils/ml/mlflowLoader");
const { TRAIN_PY } = await import("@/utils/ml/pyTrain");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function version(extra: Record<string, unknown> = {}) {
  return {
    id: "version-3",
    model_id: MODEL.id,
    version: 3,
    status: "ready",
    algorithm: "lightgbm",
    artifact_uri: `s3://lakehouse/ml-artifacts/${MODEL.id}/v3/model.joblib`,
    artifact_sha256: sha(db.artifact),
    feature_schema: [
      { name: "tenure", dtype: "numeric", role: "feature" },
      { name: "plan", dtype: "categorical", role: "feature" },
      { name: "churned", dtype: "categorical", role: "target" },
    ],
    config: {
      runtime: {
        python: "3.12.7",
        "scikit-learn": "1.6.1",
        lightgbm: "4.6.0",
        numpy: "2.2.4",
        pandas: "2.2.3",
        joblib: "1.4.2",
        scipy: "1.15.2",
      },
    },
    ...extra,
  };
}

beforeEach(() => {
  db.versions = [version()];
  db.puts = [];
  db.updates = [];
  db.audits = [];
  db.started = [];
  db.artifact = Buffer.from("fitted-pipeline");
  db.versions = [version()];
  delete (globalThis as { __task?: string }).__task;
  delete process.env.ML_IMPORT_MAX_MB;
});

describe("export", () => {
  it("gives the owner the folder MLflow loads, with the version's own artifact", async () => {
    const out = await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const folder = exportFolderName(MODEL.name, 3);
    expect(folder).toBe("churn-next-30-days-v3");
    expect(out.filename).toBe(`${folder}-mlflow.zip`);
    const files = unzipSync(out.bytes);
    expect(Object.keys(files).sort()).toEqual(
      [
        "MLmodel",
        "README.md",
        "code/agentswarms.json",
        "code/agentswarms_mlflow.py",
        "code/agentswarms_program.py",
        "conda.yaml",
        "model.joblib",
        "python_env.yaml",
        "requirements.txt",
      ].map((f) => `${folder}/${f}`),
    );
    expect(Buffer.from(files[`${folder}/model.joblib`])).toEqual(db.artifact);
    expect(strFromU8(files[`${folder}/code/agentswarms_mlflow.py`])).toBe(MLFLOW_LOADER_PY);
    expect(strFromU8(files[`${folder}/code/agentswarms_program.py`])).toBe(TRAIN_PY);
    expect(JSON.parse(strFromU8(files[`${folder}/code/agentswarms.json`]))).toMatchObject({
      model_id: MODEL.id,
    });
    expect(readMlmodel(strFromU8(files[`${folder}/MLmodel`]))).toMatchObject({
      ok: true,
      plan: { kind: "agentswarms", features: [{ name: "tenure" }, { name: "plan" }] },
    });
    // Pinned to what it was trained with.
    expect(strFromU8(files[`${folder}/requirements.txt`])).toContain("scikit-learn==1.6.1\n");
    expect(db.audits).toEqual([
      expect.objectContaining({
        action: "ml.export",
        detail: expect.objectContaining({ format: "mlflow", library_versions_recorded: true }),
      }),
    ]);
  });

  it("says so when the version did not record what it was trained with", async () => {
    db.versions = [version({ config: {} })];
    const out = await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" });
    if (!out.ok) throw new Error(out.error);
    const files = unzipSync(out.bytes);
    const folder = exportFolderName(MODEL.name, 3);
    expect(strFromU8(files[`${folder}/requirements.txt`])).toContain("scikit-learn>=1.4");
    expect(strFromU8(files[`${folder}/README.md`])).toMatch(
      /before AgentSwarms recorded library versions/,
    );
  });

  it("carries the version's decision line, so it answers as the app does (UI test finding)", async () => {
    db.versions = [
      version({
        decision_threshold: 0.3,
        positive_label: "yes",
        feature_schema: [
          { name: "tenure", dtype: "numeric", role: "feature" },
          { name: "signed_up_on", dtype: "datetime", role: "feature" },
          { name: "churned", dtype: "categorical", role: "target" },
        ],
      }),
    ];
    const out = await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" });
    if (!out.ok) throw new Error(out.error);
    const files = unzipSync(out.bytes);
    const folder = exportFolderName(MODEL.name, 3);
    // In the config the program reads: the app sends it per request, so the
    // scorer's own config never held it.
    expect(JSON.parse(strFromU8(files[`${folder}/code/agentswarms.json`]))).toMatchObject({
      decision_threshold: 0.3,
      positive_label: "yes",
    });
    // As signature params, or MLflow drops what a caller passes.
    const yaml = (await import("js-yaml")).default;
    const doc = yaml.load(strFromU8(files[`${folder}/MLmodel`])) as {
      signature: { params: string };
      metadata: Record<string, unknown>;
    };
    expect(JSON.parse(doc.signature.params)).toEqual([
      { name: "decision_threshold", type: "double", default: 0.3, shape: null },
      { name: "positive_label", type: "string", default: "yes", shape: null },
    ]);
    expect(doc.metadata).toMatchObject({ decision_threshold: 0.3, positive_label: "yes" });
    const readme = strFromU8(files[`${folder}/README.md`]);
    expect(readme).toMatch(/answers "yes" when that class's probability is at least 0\.3/);
    // Date columns take datetimes: MLflow refuses date text under pandas 3.
    expect(readme).toContain('rows["signed_up_on"] = pd.to_datetime(rows["signed_up_on"])');
    expect(readme).not.toContain('rows["tenure"] = pd.to_datetime');
  });

  it("declares no decision params for a model that does not classify", async () => {
    (globalThis as { __task?: string }).__task = "regression";
    const out = await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" });
    if (!out.ok) throw new Error(out.error);
    const files = unzipSync(out.bytes);
    const folder = exportFolderName(MODEL.name, 3);
    const yaml = (await import("js-yaml")).default;
    const doc = yaml.load(strFromU8(files[`${folder}/MLmodel`])) as {
      signature: { params: unknown };
    };
    expect(doc.signature.params).toBeNull();
    expect(JSON.parse(strFromU8(files[`${folder}/code/agentswarms.json`]))).not.toHaveProperty(
      "decision_threshold",
    );
  });

  it("gives nothing to anyone but the owner", async () => {
    expect(
      await exportMlflowZip({ userId: "someone-else", modelId: MODEL.id, versionId: "version-3" }),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(db.audits).toEqual([]);
  });

  it("refuses an artifact whose bytes are not the ones recorded", async () => {
    db.artifact = Buffer.from("swapped");
    const out = await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" });
    expect(out).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringMatching(/does not match the digest/),
    });
    expect(db.audits).toEqual([]);
  });

  it("has nothing to export for a model answered from what it stored", async () => {
    (globalThis as { __task?: string }).__task = "forecast";
    expect(
      await exportMlflowZip({ userId: OWNER, modelId: MODEL.id, versionId: "version-3" }),
    ).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

const SKLEARN_MLMODEL = `flavors:
  python_function:
    loader_module: mlflow.sklearn
    model_path: model.pkl
  sklearn:
    pickled_model: model.pkl
    serialization_format: cloudpickle
    sklearn_version: 1.5.2
signature:
  inputs: '[{"type": "double", "name": "tenure"}, {"type": "string", "name": "plan"}]'
`;

function mlflowZip(files: Record<string, string | Uint8Array>) {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]),
    ),
  );
}

describe("import", () => {
  const go = (bytes: Uint8Array, userId = OWNER) =>
    importMlflowZip({ userId, modelId: MODEL.id, bytes, fileName: "churn.zip" });

  it("stages the model file under the model's own prefix and starts its job, opening nothing", async () => {
    const pkl = strToU8("pickled-estimator-bytes");
    const out = await go(
      mlflowZip({
        "churn/MLmodel": SKLEARN_MLMODEL,
        "churn/model.pkl": pkl,
        "churn/conda.yaml": "x",
      }),
    );
    expect(out).toEqual({ ok: true, versionId: "version-new", version: 4, jobId: "job-1" });
    expect(db.puts).toHaveLength(1);
    expect(db.puts[0].key).toMatch(
      new RegExp(`^ml-artifacts/${MODEL.id}/imports/[0-9a-f-]{36}/model\\.pkl$`),
    );
    expect(Buffer.from(db.puts[0].bytes)).toEqual(Buffer.from(pkl));
    // Under the owner's key, like everything else of theirs in the lake.
    expect(db.puts[0].kms).toMatch(/^arn:aws:kms:/);
    expect(db.started).toEqual([
      {
        version: 4,
        opts: { trigger: "import", external: true },
        config: expect.objectContaining({
          import: {
            format: "mlflow",
            kind: "sklearn",
            flavor: "sklearn",
            uri: `s3://lakehouse/${db.puts[0].key}`,
            sha256: sha(Buffer.from(pkl)),
            features: [
              { name: "tenure", dtype: "numeric" },
              { name: "plan", dtype: "categorical" },
            ],
            file_name: "churn.zip",
            serialization: "cloudpickle",
            sklearn_version: "1.5.2",
          },
        }),
      },
    ]);
    expect(db.audits.map((a) => a.action)).toEqual(["ml.import.started"]);
  });

  it("brings an export's decision line back with it, and sets none for a scikit-learn model", async () => {
    db.versions = [version({ decision_threshold: 0.3, positive_label: "yes" })];
    const exported = await exportMlflowZip({
      userId: OWNER,
      modelId: MODEL.id,
      versionId: "version-3",
    });
    if (!exported.ok) throw new Error(exported.error);
    const out = await go(exported.bytes);
    expect(out.ok).toBe(true);
    expect(db.updates).toEqual([
      { patch: { decision_threshold: 0.3, positive_label: "yes" }, id: "version-new" },
    ]);
    expect(db.audits.at(-1)).toMatchObject({
      action: "ml.import.started",
      detail: { decision_threshold: 0.3, positive_label: "yes" },
    });

    db.updates = [];
    await go(mlflowZip({ "churn/MLmodel": SKLEARN_MLMODEL, "churn/model.pkl": "p" }));
    expect(db.updates).toEqual([]);
  });

  it("reads the line from the signature's params, within the app's own bounds", () => {
    const sig = (params: unknown) => ({ inputs: "[]", params });
    const p = (t: unknown, l: unknown) =>
      JSON.stringify([
        { name: "decision_threshold", type: "double", default: t, shape: null },
        { name: "positive_label", type: "string", default: l, shape: null },
      ]);
    expect(signatureDecision(sig(p(0.3, "2")))).toEqual({ threshold: 0.3, positiveLabel: "2" });
    expect(signatureDecision(sig(p(0.7, null)))).toEqual({ threshold: 0.7, positiveLabel: null });
    // No line, or one the app would refuse to set.
    expect(signatureDecision(sig(p(null, "2")))).toBeNull();
    expect(signatureDecision(sig(p(1.5, "2")))).toBeNull();
    expect(signatureDecision(sig(p("0.3", "2")))).toBeNull();
    expect(signatureDecision(sig(null))).toBeNull();
    expect(signatureDecision(sig("not json"))).toBeNull();
    expect(signatureDecision(sig(p(0.3, "x".repeat(201))))).toEqual({
      threshold: 0.3,
      positiveLabel: null,
    });
  });

  // MLflow 3's default (R536): the model file is itself a zip, schema.json
  // describing the objects and .npy entries holding the arrays.
  const SKOPS_MLMODEL = SKLEARN_MLMODEL.replaceAll("model.pkl", "model.skops")
    .replace("serialization_format: cloudpickle", "serialization_format: skops")
    .replace(
      "sklearn_version: 1.5.2",
      "sklearn_version: 1.9.1\n    skops_trusted_types:\n    - sklearn.tree._tree.Tree\n    - builtins.eval",
    );
  const skopsFile = () =>
    zipSync({
      "schema.json": strToU8('{"__class__": "Pipeline", "__module__": "sklearn.pipeline"}'),
      "1.npy": new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]),
    });

  it("stages a skops file as it is, keeping what it asked to trust only as a record", async () => {
    const file = skopsFile();
    const out = await go(mlflowZip({ "churn/MLmodel": SKOPS_MLMODEL, "churn/model.skops": file }));
    expect(out.ok).toBe(true);
    expect(db.puts[0].key).toMatch(/\/imports\/[0-9a-f-]{36}\/model\.skops$/);
    expect(Buffer.from(db.puts[0].bytes)).toEqual(Buffer.from(file));
    expect(db.started[0].config).toMatchObject({
      import: {
        kind: "sklearn",
        flavor: "sklearn, skops",
        serialization: "skops",
        sklearn_version: "1.9.1",
        // What the file says; the sandbox never loads with it.
        skops_asked: ["sklearn.tree._tree.Tree", "builtins.eval"],
        sha256: sha(Buffer.from(file)),
      },
    });
    expect(db.audits.at(-1)).toMatchObject({
      action: "ml.import.started",
      detail: { flavor: "sklearn, skops", serialization: "skops" },
    });
  });

  it("refuses a file that says skops and is not, before staging it", async () => {
    for (const [file, why] of [
      // A pickle renamed model.skops. The sandbox would never unpickle it
      // (it opens a skops file only with skops); this says so before staging.
      [strToU8("\x80\x04\x95pickled"), /not a skops archive/],
      [zipSync({ "1.npy": new Uint8Array([1]) }), /no schema\.json/],
    ] as [Uint8Array, RegExp][]) {
      const out = await go(
        mlflowZip({ "churn/MLmodel": SKOPS_MLMODEL, "churn/model.skops": file }),
      );
      expect(out).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(why) });
    }
    expect(db.puts).toEqual([]);
    expect(db.started).toEqual([]);
  });

  it("takes a model folder at the top of the zip too", async () => {
    const out = await go(mlflowZip({ MLmodel: SKLEARN_MLMODEL, "model.pkl": "p" }));
    expect(out.ok).toBe(true);
  });

  it("refuses in words, before staging anything", async () => {
    const cases: [Uint8Array, RegExp][] = [
      [strToU8("not a zip at all"), /not a zip/],
      [mlflowZip({ "churn/model.pkl": "p" }), /no MLmodel file/],
      [
        mlflowZip({ "churn/MLmodel": SKLEARN_MLMODEL }),
        /names model\.pkl, which is not in the zip/,
      ],
      [
        mlflowZip({
          "m/MLmodel":
            "flavors:\n  pytorch:\n    model_data: data\n  python_function:\n    loader_module: mlflow.pytorch\n",
          "m/data": "x",
        }),
        /flavor is pytorch/,
      ],
      [
        mlflowZip({
          "m/MLmodel":
            "flavors:\n  sklearn:\n    pickled_model: ../../etc/passwd\n    serialization_format: pickle\n",
        }),
        /not a plain file inside the folder/,
      ],
    ];
    for (const [bytes, why] of cases) {
      const out = await go(bytes);
      expect(out, String(why)).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringMatching(why),
      });
    }
    expect(db.puts).toEqual([]);
    expect(db.started).toEqual([]);
  });

  it("refuses a zip above the limit", async () => {
    process.env.ML_IMPORT_MAX_MB = "1";
    const big = new Uint8Array(1_200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24; // not compressible
    const out = await go(
      zipSync({ "m/MLmodel": strToU8(SKLEARN_MLMODEL), "m/model.pkl": [big, { level: 0 }] }),
    );
    expect(out).toMatchObject({
      ok: false,
      status: 413,
      error: expect.stringMatching(/ML_IMPORT_MAX_MB/),
    });
    expect(db.puts).toEqual([]);
  });

  it("is the owner's only, and only for models that score rows", async () => {
    const zip = mlflowZip({ "m/MLmodel": SKLEARN_MLMODEL, "m/model.pkl": "p" });
    expect(await go(zip, "someone-else")).toMatchObject({ ok: false, status: 404 });
    (globalThis as { __task?: string }).__task = "recommendation";
    expect(await go(zip)).toMatchObject({ ok: false, status: 400 });
    expect(db.puts).toEqual([]);
  });
});
