// A notebook saves the model it trained and registers it as a version — the
// half of experiment tracking that was the author's problem before.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXTERNAL_TASKS, artifactFileName } from "@/lib/experiments";
import { experimentArtifactKey } from "@/utils/ml/experimentArtifacts.server";

const rd = (p: string) => readFileSync(p, "utf8");

describe("where an uploaded artifact lands", () => {
  it("keeps it under the run's own prefix, beside the trainer's artifacts", () => {
    expect(experimentArtifactKey("11111111-2222-3333-4444-555555555555", "model.joblib")).toBe(
      "ml-artifacts/experiments/11111111-2222-3333-4444-555555555555/model.joblib",
    );
  });

  it("a name cannot climb out of that prefix, or be empty", () => {
    // The name arrives from a notebook, so it is input like any other.
    expect(artifactFileName("../../etc/passwd")).toBe("passwd");
    expect(artifactFileName("a/b/c/model.joblib")).toBe("model.joblib");
    expect(artifactFileName("../..")).toBe("model.joblib");
    expect(artifactFileName("")).toBe("model.joblib");
    expect(artifactFileName(null)).toBe("model.joblib");
    expect(artifactFileName("my model v2!.joblib")).toBe("my_model_v2_.joblib");
    expect(experimentArtifactKey("run-1", "../x.joblib")).toBe(
      "ml-artifacts/experiments/run-1/x.joblib",
    );
  });
});

describe("the digest is the platform's, not the caller's", () => {
  const srv = rd("src/utils/ml/experimentArtifacts.server.ts");

  it("hashes what arrived and records that, refusing a mismatch", () => {
    // A digest nobody verified protects nothing: inference checks this value
    // before loading the artifact, so it must describe the stored bytes.
    expect(srv).toContain("const put = await s3PutObject(lake.target, key, args.body)");
    expect(srv).toContain("args.claimedSha256.toLowerCase() !== put.sha256");
    expect(srv).toContain("artifact_sha256: put.sha256");
    const presign = rd("src/utils/lakehouse/presign.server.ts");
    expect(presign).toContain(
      'body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256',
    );
    // The helper returns the digest it computed; it never takes one as input.
    const put = presign.slice(presign.indexOf("export async function s3PutObject"));
    expect(put).toContain('createHash("sha256").update(body).digest("hex")');
    expect(put).not.toContain("sha256: args");
  });

  it("bounds one upload with a setting, not a constant", () => {
    expect(srv).toContain("limits.mlArtifactMaxMb");
    expect(srv).toContain("status: 413");
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain('envInt("ML_ARTIFACT_MAX_MB")');
    expect(cfg).toContain("ml_artifact_max_mb");
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain("ml_artifact_max_mb");
  });

  it("writes only to a running run the caller owns", () => {
    const fn = srv.slice(srv.indexOf("export async function putExperimentArtifact"));
    expect(fn).toContain('.eq("user_id", args.userId)');
    expect(fn).toContain('if (run.status !== "running")');
    expect(fn).toContain("status: 409");
  });
});

describe("a run becomes a version", () => {
  const srv = rd("src/utils/ml/experimentArtifacts.server.ts");

  it("through the registry's own external path, never around it", () => {
    expect(srv).toContain("registerExternalVersion");
    expect(srv).toContain("checkRegistrable");
    expect(srv).toContain('action: "ml.experiment.promote"');
    // Only the plain scores travel, never a curve point.
    expect(srv).toContain("promotableMetrics(run.metrics)");
  });

  it("closes a run that is still open rather than refusing it", () => {
    // The notebook that trained the model is the caller; making it say
    // "finish" first would only add a step to the same intent.
    const fn = srv.slice(srv.indexOf("export async function registerRunAsVersion"));
    expect(fn).toContain('if (run.status === "running")');
    expect(fn).toContain('status: "finished"');
    expect(fn.indexOf('run.status = "finished"')).toBeLessThan(fn.indexOf("checkRegistrable(run)"));
  });

  it("refuses a model somebody else owns, and a task no external version can serve", () => {
    expect(srv).toContain("Only the model's owner can register a version");
    expect(srv).toContain("status: 403");
    expect(srv).toContain("EXTERNAL_TASKS as readonly string[]).includes(model.task)");
    expect(EXTERNAL_TASKS).toEqual(["classification", "regression", "clustering", "anomaly"]);
  });

  it("creates a model only with a task and a lakehouse table the caller can reach", () => {
    const fn = srv.slice(srv.indexOf("async function createModelForRun"));
    expect(fn).toContain("accessibleSchemas(input.userId)");
    expect(fn).toContain("No access to lakehouse schema");
    expect(fn).toContain("needs a task");
    expect(fn).toContain("needs source=");
    // Classification and regression predict a column; the others do not.
    expect(fn).toContain('task === "classification" || task === "regression"');
    expect(fn).toContain("needs target_column");
  });
});

describe("the wiring", () => {
  it("both routes authenticate a kernel's session token, never a key of its own", () => {
    for (const p of [
      "src/routes/api/ml.experiments.artifact.ts",
      "src/routes/api/ml.experiments.register.ts",
    ]) {
      const route = rd(p);
      expect(route, p).toContain("resolvePythonCaller");
      expect(route, p).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
    const reg = rd("src/routes/api/ml.experiments.register.ts");
    // A uuid names a model; anything else is a name to find or create.
    expect(reg).toContain("UUID.test(b.model) ? { id: b.model } : { name: b.model }");
    expect(reg).toContain('via: caller.scopeUserId ? "notebook" : "api"');
  });

  it("the client raises on a failed save and prints where it went", () => {
    const client = rd("docker/notebook-runtime/agentswarms_helper.py");
    const save = client.slice(client.indexOf("    def save_model(self"));
    // Unlike the logging calls, this one raises: a save you believe happened
    // and did not is the same lie as a run that never started.
    expect(save).toContain('raise RuntimeError(data.get("error")');
    expect(save).toContain('"external": True');
    expect(save).toContain('"features": [str(c) for c in features]');
    expect(save).toContain("_ARTIFACT_TIMEOUT");
    const register = client.slice(client.indexOf("    def register(self"));
    expect(register).toContain('_post_sync("/api/ml/experiments/register"');
    expect(register).toContain("created_model");
    // Registering answers 201 Created. Reading any non-200 as a failure made
    // the client raise on a call that had in fact succeeded.
    expect(client).toContain("if resp.status_code // 100 != 2:");
    expect(client).not.toContain("if resp.status_code != 200:");
  });

  it("inference reads a label as well as a class index", () => {
    // The platform's trainer predicts an INDEX into `classes`; an sklearn
    // pipeline registered from outside predicts the LABEL. Assuming the index
    // made every notebook-registered classifier fail its first batch run with
    // "invalid literal for int()".
    const py = rd("src/utils/ml/pyTrain.ts");
    expect(py).toContain("def _label(i):");
    expect(py).toContain("except (TypeError, ValueError):");
    expect(py).toContain("return classes[k] if 0 <= k < len(classes) else str(i)");
    expect(py).not.toContain("[classes[int(i)] if 0 <= int(i) < len(classes)");
  });

  it("the migration records the size and adds the knob", () => {
    const sql = rd("supabase/migrations/20260891000000_ml_experiment_artifacts.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS artifact_bytes bigint");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS ml_artifact_max_mb integer");
  });

  it("is documented in both doc sets", () => {
    expect(rd("docs/ML.md")).toContain("run.save_model(");
    expect(rd("docs/ML.md")).toContain("ML_ARTIFACT_MAX_MB");
    expect(rd("src/routes/docs.ml.tsx")).toContain("save_model");
    expect(rd("src/components/ml/ExperimentsPanel.tsx")).toContain("save_model");
  });
});
