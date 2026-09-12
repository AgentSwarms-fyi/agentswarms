// Warm inference: a model version held in a long-lived sandbox instead of a
// container per prediction.
//
// The thing worth pinning here is not the speed — it is that speed changed
// NOTHING else. The same artifact, checked against the same digest, through
// the same fitted pipeline, recorded in the same row with the same audit. A
// second scoring path that agreed with the first today and diverged quietly
// later is the failure this feature could plausibly introduce.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const MIGRATION = rd("supabase/migrations/20260872000000_ml_deployments.sql");
const SERVE = rd("src/utils/ml/serve.server.ts");
const SCORER = rd("docker/notebook-runtime/score_server.py");
const PREDICT = rd("src/utils/ml/predict.server.ts");

describe("a deployment is one endpoint, per model, on one named version", () => {
  it("allows only one per model", () => {
    // Two would race each other awake and asleep, and a caller could not say
    // which one answered.
    expect(MIGRATION).toContain("UNIQUE (model_id)");
  });

  it("pins the version it serves rather than following production", () => {
    expect(MIGRATION).toContain("version_id uuid REFERENCES public.ml_model_versions(id)");
    // The row records what is LOADED; the model's production pointer is a
    // separate fact, and the UI reports the difference instead of hiding it.
    expect(rd("src/utils/mlOps.functions.ts")).toContain("stale: Boolean(");
    expect(rd("src/components/ml/DeploymentPanel.tsx")).toContain(
      "a newer version is in production",
    );
  });

  it("refuses to answer for a version it is not serving", () => {
    // The whole safety property of a pinned endpoint in one line.
    expect(SERVE).toContain("if (dep.version_id !== args.version.id) return null;");
  });

  it("is off by default and owner-only to change", () => {
    expect(MIGRATION).toContain("keep_warm boolean NOT NULL DEFAULT false");
    expect(MIGRATION).toContain("ALTER TABLE public.ml_deployments ENABLE ROW LEVEL SECURITY");
    expect(MIGRATION).toContain("auth.uid() = user_id");
    // A grantee sees whether it is up, which the version list already discloses.
    expect(MIGRATION).toContain("has_resource_access('ml_model', model_id, auth.uid())");
  });

  it("audits deploying, and what it is serving", () => {
    const trigger = MIGRATION.slice(MIGRATION.indexOf("CREATE TRIGGER audit_ml_deployments"));
    expect(trigger).toContain("audit_row_change('ml_deployment')");
    for (const col of ["version_id", "keep_warm", "idle_ttl_minutes"]) {
      expect(trigger, col).toContain(col);
    }
    expect(SERVE).toContain('action: "ml.deploy"');
    expect(SERVE).toContain('action: "ml.undeploy"');
  });
});

describe("warm and cold give the same answer", () => {
  it("runs the same program, not a second scorer", () => {
    // The bundle the sandbox loads is the same module the batch path runs.
    expect(SERVE).toContain('await import("@/utils/ml/pyTrain")');
    expect(SERVE).toContain("TRAIN_PY");
    // And the scorer calls that module's own functions rather than its own.
    expect(SCORER).toContain('ns["_download_artifact"]');
    expect(SCORER).toContain('ns["_predict"]');
    expect(SCORER).not.toContain("joblib.load");
  });

  it("carries the credentials the artifact download needs", () => {
    // Found live: the scorer came up, listened, and hung forever with
    // ready:false and no error — it had no lakehouse credentials, so the
    // artifact fetch had nothing to authenticate with. They ride in the
    // bundle rather than the container env, for the reason the MCP runner's
    // secrets do: a response body is not in `docker inspect` or a pod spec.
    expect(SERVE).toContain("mlTrainingEnv");
    expect(SERVE).toContain("env: Record<string, string>");
    expect(SCORER).toContain("os.environ[str(key)] = str(value)");
  });

  it("verifies the artifact digest, because the loader it calls does", () => {
    // The check lives in the shared program; the scorer must not route around
    // it by loading the file itself.
    expect(rd("src/utils/ml/pyTrain.ts")).toContain("Artifact digest mismatch");
    expect(SCORER).toContain("_download_artifact");
  });

  it("hands the pre-loaded artifact back through the program's own loader", () => {
    // Rather than reaching into _predict's internals. The swap is restored in
    // a finally, so a failed request cannot leave the module rewired.
    expect(SCORER).toContain('ns["_download_artifact"] = lambda _cfg: art');
    expect(SCORER).toContain("finally:");
    expect(SCORER).toContain('ns["_download_artifact"] = original');
  });

  it("records a warm prediction the same way a cold one is recorded", () => {
    // Same table, same finaliser — so the same digest, drift check and
    // ml.predict_query audit. Faster, not less accountable.
    expect(PREDICT).toContain(
      'await finalizePrediction(row.id, { status: "succeeded", result: scored.raw })',
    );
    expect(PREDICT).toContain('.from("ml_predictions")');
    // THIS LINE USED TO ASSERT `raw: body ?? {}` — the mechanism — and the
    // mechanism was wrong, so the guard pinned the bug while its own name
    // stated the property being broken. Measured live: 21 of 21 warm
    // predictions were stored as failures for six days, because the finaliser
    // accepts only the batch envelope and the warm scorer's body has no `ok`
    // (the Python entrypoint sets it, and the scorer bypasses that entrypoint
    // deliberately, to keep one scoring implementation).
    //
    // Now asserted as the OUTCOME: what is handed over satisfies the finaliser.
    expect(SERVE).toContain("raw: { ...(body ?? {}), ok: true }");
    expect(SERVE).not.toContain("raw: body ?? {},");
  });

  it("says which path answered", () => {
    expect(PREDICT).toContain('served: "warm"');
    expect(PREDICT).toContain('served: "sandbox"');
    expect(rd("src/routes/api/ml.predict.ts")).toContain("served: result.served");
  });
});

describe("a missing endpoint is slower, never wrong", () => {
  it("falls back to the sandbox rather than failing", () => {
    // Every one of these returns null, which is the caller's signal to take
    // the cold path. None of them is an error to the person predicting.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    // The sandbox moved into ml_deployment_replicas, so "nothing to score on"
    // is now two conditions: no endpoint at all, and no COPY of it that is
    // ready. The property is unchanged — every one of these returns null.
    expect(warm).toContain('if (!dep || dep.status !== "ready") return null;');
    expect(warm).toContain("if (!replica?.endpoint) return null;");
    expect(warm).toContain("if (res.status === 503) return null;");
    expect(PREDICT).toContain("const warm = await scoreOnDeployment(args);");
    expect(PREDICT).toContain("if (warm) return warm;");
  });

  it("treats a transport failure as a fallback, not a failure", () => {
    // The sandbox may have been reaped out from under the request.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain("[ml-serve] warm score failed");
    expect(warm.slice(warm.indexOf("} catch (e) {"))).toContain("return null;");
  });

  it("never serves a forecast, which has no model in the loop", () => {
    expect(SERVE).toContain("Forecast models are answered from their stored series");
    expect(rd("src/components/ml/DeploymentPanel.tsx")).toContain('task === "forecast"');
  });
});

describe("readiness means loaded, not listening", () => {
  it("waits for the model, not just the container", () => {
    // The orchestrator reports a container running long before Python has
    // imported sklearn and pulled the artifact. The first real request must
    // not be the one that pays for that.
    expect(SERVE).toContain("HEALTH_PATH");
    expect(SCORER).toContain('_state["ready"]');
    // /healthz is 200 only once the artifact is in memory, and the scorer
    // refuses to score before then rather than loading on the first request.
    expect(SCORER).toContain('200 if _state["ready"] else 503');
    expect(SCORER).toContain('self._send(503, {"error": err or "still loading"})');
  });

  it("loads on a thread so the container answers while it loads", () => {
    // A container that accepts no connections for twenty seconds is
    // indistinguishable from one that crashed.
    expect(SCORER).toContain("threading.Thread(target=load_model, daemon=True).start()");
  });

  it("bounds a request body and a scoring call", () => {
    expect(SCORER).toContain("MAX_BODY_BYTES");
    expect(SCORER).toContain("body too large");
    expect(SERVE).toContain("SCORE_TIMEOUT_MS");
  });

  it("survives a bad row", () => {
    // One malformed request must not take the endpoint down for everyone.
    const post = SCORER.slice(SCORER.indexOf("def do_POST"));
    expect(post).toContain("except Exception as e:");
    expect(post).toContain("self._send(500,");
  });
});

describe("the sandbox it runs in", () => {
  it("has its own mode in the image", () => {
    const entry = rd("docker/notebook-runtime/entrypoint.sh");
    expect(entry).toContain('"${NB_MODE:-interactive}" = "score"');
    expect(entry).toContain("score_server.py");
    expect(rd("docker/notebook-runtime/Dockerfile")).toContain("COPY score_server.py");
  });

  it("is a service, so it has no expiry and restarts if it dies", () => {
    expect(SERVE).toContain('kind: "service"');
    expect(SERVE).toContain('serviceMode: "score"');
    expect(SERVE).toContain("restartOnFailure: true");
  });

  it("gets the ML memory budget, not an MCP server's", () => {
    expect(SERVE).toContain("memLimitMb: limits.mlTrainMemLimitMb");
    // startSession only honoured an override for batch before this.
    expect(rd("src/utils/notebookRuntime/service.server.ts")).toContain(
      "((batch || service) && opts.memLimitMb)",
    );
  });

  it("does not spend an MCP server's budget", () => {
    // Those counters were written when a service could only be an MCP app;
    // a scorer would have taken one of the three slots a person gets, and
    // refused an MCP server because somebody deployed a model.
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    const perUser = cfg.slice(cfg.indexOf("export async function countLiveServices("));
    expect(perUser).toContain('.not("mcp_app_id", "is", null)');
    const total = cfg.slice(cfg.indexOf("export async function countLiveServicesTotal("));
    expect(total).toContain('.not("mcp_app_id", "is", null)');
  });

  it("is counted and capped on its own terms", () => {
    expect(MIGRATION).toContain("ml_max_deployments_per_user");
    expect(MIGRATION).toContain("ml_max_deployments_total");
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain("ML_MAX_DEPLOYMENTS_PER_USER");
    expect(cfg).toContain("ML_MAX_DEPLOYMENTS_TOTAL");
    expect(SERVE).toContain("warm-endpoint limit");
  });
});

describe("an endpoint nobody calls is stopped", () => {
  it("is reaped on idle, and this is the only thing that reaps it", () => {
    // A service session has no expiry by design, and the generic reaper only
    // knows how to idle out an MCP server — so without this a scorer would
    // run until the host was restarted.
    expect(SERVE).toContain("export async function reapIdleDeployments");
    expect(SERVE).toContain("idle_ttl_minutes * 60_000");
    expect(SERVE).toContain('.eq("keep_warm", false)');
    expect(rd("src/utils/etl/schedule.server.ts")).toContain("m.reapIdleDeployments()");
  });

  it("does not ask the orchestrator where to go on every score", () => {
    // Measured live: with the container start gone, a `docker inspect` per
    // score had taken its place and a "warm" prediction still took 1.6s. The
    // address is stable for the life of the sandbox, so it is remembered and
    // only re-resolved when a call to it actually fails.
    expect(rd("supabase/migrations/20260874000000_ml_deployment_endpoint.sql")).toContain(
      "ADD COLUMN IF NOT EXISTS endpoint text",
    );
    // The address is remembered on the COPY that owns it now — one endpoint
    // can have several, and a single remembered address was the shape that
    // made more than one impossible.
    expect(rd("supabase/migrations/20260908000000_ml_deployment_replicas.sql")).toContain(
      "endpoint text",
    );
    expect(SERVE).toContain("const endpoint = replica.endpoint;");
    expect(SERVE).toContain("endpoint: ready.endpoint,");
    // A stale address must not stay remembered: retiring the copy clears it.
    expect(SERVE).toContain("endpoint: null,");
    const retire = SERVE.slice(SERVE.indexOf("async function retireReplica"));
    expect(retire.slice(0, 600)).toContain("endpoint: null,");
  });

  it("one dead copy does not take the whole endpoint down", () => {
    // With a single sandbox these were the same event, so a transport failure
    // forgot the endpoint's address. With several, doing that would throw away
    // the copies that are still answering.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain("void retireReplica(replica,");
    expect(warm).not.toContain('.from("ml_deployments").update({ endpoint: null })');
  });

  it("warms the scorer's first call before reporting ready", () => {
    // sklearn and pandas do over a second of work on their first call, and a
    // warm endpoint whose FIRST request pays that is not warm.
    expect(SCORER).toContain("score([{}])");
    expect(SCORER).toContain("warmup pass skipped");
  });

  it("does not call a freshly started endpoint idle", () => {
    // Found live, in the audit trail: ml.deploy at 17:17:45, then
    // ml.undeploy reason=idle idle_minutes=17 at 17:18:22 — the reaper read
    // the PREVIOUS container's last_used_at and stopped a sandbox that was
    // thirty-seven seconds old. It takes the later of the two marks now.
    expect(SERVE).toContain("const idleMs = Date.now() - Math.max(...marks);");
    expect(SERVE).not.toContain("raw.last_used_at ?? raw.last_started_at");
  });

  it("counts its own use atomically", () => {
    const rpc = rd("supabase/migrations/20260873000000_ml_deployment_use.sql");
    expect(rpc).toContain("request_count = request_count + 1");
    expect(rpc).toContain("SECURITY DEFINER");
    expect(SERVE).toContain("increment_ml_deployment_use");
  });
});
