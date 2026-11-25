// The MLflow model format (R533): what an export writes, and what an import
// may be. Pure; the I/O is mlflowServer.test.ts.
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  MLFLOW_LOADER_MODULE,
  dtypeFromMlflow,
  mlmodelYaml,
  pythonEnvYaml,
  readMlmodel,
  requirementsFor,
  safeModelPath,
  signatureInputs,
} from "@/lib/mlflowFormat";
import { MLFLOW_TASKS, importedFlavor } from "@/lib/mlflowTasks";

const SCHEMA = [
  { name: "net_usd", dtype: "numeric", role: "feature" },
  { name: "region", dtype: "categorical", role: "feature" },
  { name: "signed_up_on", dtype: "datetime", role: "feature" },
  { name: "is_trial", dtype: "boolean", role: "feature" },
  { name: "plan", dtype: "categorical", role: "target" },
  { name: "order_id", dtype: "numeric", role: "dropped" },
];

describe("an export", () => {
  it("signs the feature columns, in order, none required", () => {
    expect(JSON.parse(signatureInputs(SCHEMA))).toEqual([
      { type: "double", name: "net_usd", required: false },
      { type: "string", name: "region", required: false },
      { type: "datetime", name: "signed_up_on", required: false },
      { type: "boolean", name: "is_trial", required: false },
    ]);
  });

  it("writes an MLmodel that loads through our loader, with its signature and provenance", () => {
    const text = mlmodelYaml({
      modelUuid: "abc",
      createdAt: new Date("2026-11-24T10:00:00Z"),
      python: "3.12.7",
      schema: SCHEMA,
      metadata: { source: "agentswarms", version: 3, artifact_sha256: "f".repeat(64) },
    });
    const doc = yaml.load(text) as {
      flavors: { python_function: Record<string, unknown> };
      signature: { inputs: string };
      metadata: Record<string, unknown>;
      utc_time_created: string;
    };
    expect(doc.flavors.python_function).toEqual({
      loader_module: MLFLOW_LOADER_MODULE,
      code: "code",
      data: "model.joblib",
      env: { conda: "conda.yaml", virtualenv: "python_env.yaml" },
      python_version: "3.12.7",
    });
    expect(JSON.parse(doc.signature.inputs)).toHaveLength(4);
    expect(doc.metadata).toMatchObject({ source: "agentswarms", version: 3 });
    expect(doc.utc_time_created).toBe("2026-11-24 10:00:00.000");
    // And it reads back as ours.
    const back = readMlmodel(text);
    expect(back).toMatchObject({
      ok: true,
      plan: { kind: "agentswarms", modelFile: "model.joblib" },
    });
  });

  it("pins exactly the libraries a version was trained with, and says when it cannot", () => {
    const exact = requirementsFor({
      python: "3.12.7",
      "scikit-learn": "1.6.1",
      lightgbm: "4.6.0",
      numpy: "2.2.4",
      pandas: "2.2.3",
      joblib: "1.4.2",
      scipy: "1.15.2",
    });
    expect(exact.exact).toBe(true);
    expect(exact.text).toContain("scikit-learn==1.6.1\n");
    expect(exact.text).toContain("lightgbm==4.6.0\n");

    const unknown = requirementsFor(null);
    expect(unknown.exact).toBe(false);
    expect(unknown.text).toContain("scikit-learn>=1.4\n");
    // A version string that is not one is never written into a pin.
    const odd = requirementsFor({ "scikit-learn": "1.6.1; rm -rf /" });
    expect(odd.exact).toBe(false);
    expect(odd.text).not.toContain("rm -rf");
    expect(yaml.load(pythonEnvYaml("3.12"))).toEqual({
      python: "3.12",
      build_dependencies: ["pip"],
      dependencies: ["-r requirements.txt"],
    });
  });
});

describe("an import", () => {
  // As MLflow 2.x writes it for mlflow.sklearn.save_model(..., signature=...).
  const SKLEARN = `artifact_path: model
flavors:
  python_function:
    env:
      conda: conda.yaml
      virtualenv: python_env.yaml
    loader_module: mlflow.sklearn
    model_path: model.pkl
    predict_fn: predict
    python_version: 3.11.9
  sklearn:
    code: null
    pickled_model: model.pkl
    serialization_format: cloudpickle
    sklearn_version: 1.5.2
mlflow_version: 2.17.2
model_size_bytes: 1234
model_uuid: 0f3c
signature:
  inputs: '[{"type": "double", "name": "net_usd", "required": true}, {"type": "string",
    "name": "region", "required": true}, {"type": "long", "name": "seats", "required": true}]'
  outputs: '[{"type": "long", "required": true}]'
  params: null
utc_time_created: '2026-11-01 09:00:00.000000'
`;

  it("takes a scikit-learn model, reading its columns from the signature", () => {
    expect(readMlmodel(SKLEARN)).toEqual({
      ok: true,
      plan: {
        kind: "sklearn",
        modelFile: "model.pkl",
        serialization: "cloudpickle",
        sklearnVersion: "1.5.2",
        features: [
          { name: "net_usd", dtype: "numeric" },
          { name: "region", dtype: "categorical" },
          { name: "seats", dtype: "numeric" },
        ],
        flavor: "sklearn",
      },
    });
  });

  it("takes one loading through mlflow.sklearn even without the sklearn flavor block", () => {
    const text =
      "flavors:\n  python_function:\n    loader_module: mlflow.sklearn\n    model_path: m/model.pkl\n";
    expect(readMlmodel(text)).toMatchObject({
      ok: true,
      plan: { kind: "sklearn", modelFile: "m/model.pkl", features: null },
    });
  });

  it("says, naming it, which flavors it cannot take", () => {
    const torch =
      "flavors:\n  python_function:\n    loader_module: mlflow.pytorch\n  pytorch:\n    model_data: data\n";
    const r = readMlmodel(torch);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/flavor is pytorch.*mlflow\.sklearn/);

    const skops = SKLEARN.replace(
      "serialization_format: cloudpickle",
      "serialization_format: skops",
    );
    expect(readMlmodel(skops)).toMatchObject({ ok: false });

    const tensor = SKLEARN.replace(
      /inputs: '[^']*'/s,
      `inputs: '[{"type": "tensor", "tensor-spec": {}}]'`,
    );
    expect(readMlmodel(tensor)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/tensors/),
    });

    expect(readMlmodel("artifact_path: model\n")).toMatchObject({ ok: false });
    expect(readMlmodel("flavors: [unclosed")).toMatchObject({ ok: false });
  });

  it("refuses a model file outside the folder, or anything that is not a plain path", () => {
    for (const bad of ["../model.pkl", "/etc/passwd", "a/../../b", "a//b", "C:\\x", ""]) {
      expect(safeModelPath(bad), bad).toBe(null);
      const text = `flavors:\n  sklearn:\n    pickled_model: '${bad}'\n    serialization_format: pickle\n`;
      expect(readMlmodel(text).ok, bad).toBe(false);
    }
    expect(safeModelPath("./model.pkl")).toBe("model.pkl");
  });

  it("builds nothing from YAML tags", () => {
    const tagged = "flavors: !!js/function 'function () {}'\n";
    expect(readMlmodel(tagged).ok).toBe(false);
  });

  it("maps MLflow's column types to this platform's", () => {
    expect(
      ["double", "float", "long", "integer", "boolean", "datetime", "string", "binary"].map(
        dtypeFromMlflow,
      ),
    ).toEqual([
      "numeric",
      "numeric",
      "numeric",
      "numeric",
      "boolean",
      "datetime",
      "categorical",
      "categorical",
    ]);
  });

  it("is offered for the tasks that score rows", () => {
    expect([...MLFLOW_TASKS]).toEqual(["classification", "regression", "clustering", "anomaly"]);
  });

  it("tells an imported version from a trained one, so the page does not say 'trained on 0 rows'", () => {
    expect(importedFlavor({ import: { format: "mlflow", flavor: "sklearn" } })).toBe("sklearn");
    expect(importedFlavor({ import: { format: "mlflow" } })).toBe("MLflow");
    expect(importedFlavor({ runtime: { python: "3.12" } })).toBeNull();
    expect(importedFlavor({ import: { format: "onnx", flavor: "x" } })).toBeNull();
    expect(importedFlavor(null)).toBeNull();
  });
});
