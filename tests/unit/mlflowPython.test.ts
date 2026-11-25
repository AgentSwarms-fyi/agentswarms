// The Python side of MLflow import and export (R533), run by a real Python.
//
// The exported loader (agentswarms_mlflow.py) against a stand-in scoring
// program, and the training program's own import mode (_import_model in
// TRAIN_PY) against stand-in estimators. pandas, joblib and scikit-learn are
// stood in for, so this runs without the ML stack; the whole path, with the
// real libraries and real MLflow, is driven end to end in the runtime image
// (docs/UI_TEST_RESULTS.md, R533).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MLFLOW_LOADER_PY } from "@/utils/ml/mlflowLoader";
import { TRAIN_PY } from "@/utils/ml/pyTrain";

const python = ["python3", "python", "py"].find(
  (c) => spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0,
);

const STUB_PANDAS = `
class DataFrame:
    def __init__(self, data=None, columns=None):
        self.data = data
        self.columns = columns
    def to_dict(self, orient="records"):
        return [dict(zip(self.columns, r)) for r in self.data]
`;

const STUB_JOBLIB = `
import pickle
def dump(obj, f, compress=None):
    pickle.dump(obj, f)
def load(f):
    return pickle.load(f)
`;

const STUB_ESTIMATORS = `
class Clf:
    classes_ = [1, 2, 3]
    feature_names_in_ = ["a", "b"]
    def predict(self, X):
        return [1 for _ in X]
    def predict_proba(self, X):
        return [[1.0, 0.0, 0.0] for _ in X]

class Bare:
    def predict(self, X):
        return [0 for _ in X]

class NoPredict:
    pass

class Iso:
    feature_names_in_ = ["a"]
    def predict(self, X):
        return [1 for _ in X]

class Pipe:
    def __init__(self):
        self.steps = [("prep", object()), ("model", Clf())]
        self.classes_ = [1, 2, 3]
    def predict(self, X):
        return [1 for _ in X]
`;

const STUB_PROGRAM = `
import hashlib
import pickle

def _fetch_artifact(uri):
    raise RuntimeError("the program fetched the artifact over the network")

def _download_artifact(cfg):
    blob = _fetch_artifact(cfg["artifact_uri"])
    if hashlib.sha256(blob).hexdigest() != cfg["artifact_sha256"]:
        raise RuntimeError("Artifact digest mismatch")
    return pickle.loads(blob)

def _predict(cfg, warnings):
    art = _download_artifact(cfg)
    rows = cfg["input"]["rows"]
    return {"columns": ["n_fields", "threshold", "algorithm"],
            "sample": [[len(r), cfg.get("decision_threshold"), art["algorithm"]] for r in rows]}
`;

function run(dir: string, script: string) {
  writeFileSync(path.join(dir, "driver.py"), script);
  const r = spawnSync(python!, [path.join(dir, "driver.py")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe.skipIf(!python)("the exported loader", () => {
  it("scores through the program's own _predict, checking the artifact's digest on load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mlflow-loader-"));
    writeFileSync(path.join(dir, "pandas.py"), STUB_PANDAS);
    writeFileSync(path.join(dir, "agentswarms_mlflow.py"), MLFLOW_LOADER_PY);
    writeFileSync(path.join(dir, "agentswarms_program.py"), STUB_PROGRAM);
    const out = run(
      dir,
      `
import hashlib, json, os, pickle, sys
here = os.path.dirname(os.path.abspath(__file__))
blob = pickle.dumps({"algorithm": "lightgbm"})
with open(os.path.join(here, "model.joblib"), "wb") as f:
    f.write(blob)
def config(sha):
    with open(os.path.join(here, "agentswarms.json"), "w") as f:
        json.dump({"artifact_uri": "s3://lake/ml-artifacts/m/v3/model.joblib", "artifact_sha256": sha}, f)
config(hashlib.sha256(blob).hexdigest())
import agentswarms_mlflow as loader
import agentswarms_program as program
original = program._download_artifact
m = loader._load_pyfunc(os.path.join(here, "model.joblib"))
a = m.predict([{"x": 1, "y": 2}, {"x": 3}])
import pandas as pd
b = m.predict(pd.DataFrame([[1, 2]], columns=["x", "y"]), params={"decision_threshold": 0.7})
restored = program._download_artifact is original
config("0" * 64)
try:
    loader._load_pyfunc(os.path.join(here, "model.joblib"))
    tampered = "loaded"
except RuntimeError as e:
    tampered = str(e)
print(json.dumps({"a": [a.columns, a.data], "b": b.data, "restored": restored, "tampered": tampered}))
`,
    );
    expect(out.a).toEqual([
      ["n_fields", "threshold", "algorithm"],
      [
        [2, null, "lightgbm"],
        [1, null, "lightgbm"],
      ],
    ]);
    // The decision line passed as an MLflow param reaches the program.
    expect(out.b).toEqual([[2, 0.7, "lightgbm"]]);
    expect(out.restored).toBe(true);
    expect(out.tampered).toMatch(/digest mismatch/);
  }, 60_000);
});

describe.skipIf(!python)("the training program's import mode", () => {
  it("checks, loads and wraps a scikit-learn model, and refuses what it cannot score", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mlflow-import-"));
    writeFileSync(path.join(dir, "joblib.py"), STUB_JOBLIB);
    writeFileSync(path.join(dir, "stubest.py"), STUB_ESTIMATORS);
    writeFileSync(path.join(dir, "prog.py"), TRAIN_PY);
    const out = run(
      dir,
      `
import hashlib, io, json, pickle
import prog, stubest
staged = {}
uploaded = []
prog._fetch_artifact = lambda uri: staged[uri]
def upload(blob):
    uploaded.append(blob)
    return "s3://lake/ml-artifacts/m/v2/model.joblib"
prog._upload = upload
prog._log = lambda m: None

def attempt(task, obj, kind="sklearn", features=None, tamper=False, raw=None):
    blob = raw if raw is not None else pickle.dumps(obj)
    staged["s3://lake/staged"] = blob
    imp = {"uri": "s3://lake/staged", "kind": kind, "flavor": "sklearn",
           "sha256": ("0" * 64) if tamper else hashlib.sha256(blob).hexdigest(),
           "serialization": "pickle", "features": features}
    try:
        r = prog._import_model({"task": task, "version": 2, "import": imp}, [])
    except RuntimeError as e:
        return {"error": str(e)}
    art = pickle.loads(uploaded[-1])
    return {"result": {k: r[k] for k in ("ok", "mode", "algorithm", "metrics", "feature_schema", "artifact_sha256")},
            "uploaded_sha": hashlib.sha256(uploaded[-1]).hexdigest(),
            "same_bytes": uploaded[-1] == blob,
            "art": {k: art[k] for k in ("task", "algorithm", "features", "classes", "external")} if kind == "sklearn" else None}

sig = [{"name": "a", "dtype": "numeric"}, {"name": "region", "dtype": "categorical"}]
own = pickle.dumps({"task": "regression", "algorithm": "lightgbm", "pipeline": None, "features": ["a"]})
print(json.dumps({
    "signed": attempt("classification", stubest.Clf(), features=sig),
    "named": attempt("classification", stubest.Clf()),
    "pipeline": attempt("classification", stubest.Pipe(), features=sig),
    "no_classes": attempt("classification", stubest.Bare(), features=sig),
    "no_names": attempt("regression", stubest.Bare()),
    "no_predict": attempt("regression", stubest.NoPredict(), features=sig),
    "anomaly": attempt("anomaly", stubest.Iso()),
    "tampered": attempt("regression", stubest.Bare(), features=sig, tamper=True),
    "own": attempt("regression", None, kind="agentswarms", features=[{"name": "a", "dtype": "numeric"}], raw=own),
    "own_wrong_task": attempt("classification", None, kind="agentswarms", raw=own),
}))
`,
    );
    expect(out.signed.result).toMatchObject({
      ok: true,
      mode: "import",
      algorithm: "mlflow:Clf",
      metrics: {},
      feature_schema: [
        { name: "a", dtype: "numeric", role: "feature" },
        { name: "region", dtype: "categorical", role: "feature" },
      ],
    });
    expect(out.signed.result.artifact_sha256).toBe(out.signed.uploaded_sha);
    // Its own labels, as strings, in its own order: 1, 2, 3, not indices.
    expect(out.signed.art).toEqual({
      task: "classification",
      algorithm: "mlflow:Clf",
      features: ["a", "region"],
      classes: ["1", "2", "3"],
      external: true,
    });
    // No signature: the columns the estimator was fitted on.
    expect(out.named.art.features).toEqual(["a", "b"]);
    // A pipeline is named by its last step.
    expect(out.pipeline.result.algorithm).toBe("mlflow:Clf");
    expect(out.no_classes.error).toMatch(/has to know its classes/);
    expect(out.no_names.error).toMatch(/no signature and does not name its input columns/);
    expect(out.no_predict.error).toMatch(/cannot predict/);
    expect(out.anomaly.error).toMatch(/decision_function/);
    expect(out.tampered.error).toMatch(/not the one that was checked/);
    // A model exported from here comes back byte for byte.
    expect(out.own.same_bytes).toBe(true);
    expect(out.own.result.artifact_sha256).toBe(out.own.uploaded_sha);
    expect(out.own_wrong_task.error).toMatch(/exported from a regression model/);
  }, 60_000);
});
