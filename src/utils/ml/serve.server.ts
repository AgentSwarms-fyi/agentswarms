/**
 * Warm inference: a model version held in a long-lived sandbox, scored over
 * HTTP instead of through a container per call.
 *
 * The batch path starts a container, boots Python, imports the ML stack,
 * downloads and hashes the artifact, scores, posts back and exits. Measured on
 * an idle machine with the image already pulled, that is about twenty seconds
 * before any scoring happens. A deployment pays it once.
 *
 * WHAT IS NOT DIFFERENT is the scoring. The sandbox runs the same program the
 * batch path runs and calls its `_predict`, so a warm answer and a cold answer
 * come from the same fitted pipeline and the same digest-verified artifact.
 * Everything here is about WHERE the work happens and how long it is kept, not
 * about what the answer is.
 *
 * Fails soft in one direction only: if a deployment is not up, the caller
 * falls back to the sandbox and gets a slower answer rather than an error.
 * Never the other way — a scorer that answered when the model was missing
 * would be worse than a wait.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { getPlatformResources, getRuntimeSettings } from "@/utils/notebookRuntime/config.server";
import {
  getSession,
  startSession,
  stopSession,
  type SessionRow,
} from "@/utils/notebookRuntime/service.server";
import { getOrchestrator, sandboxName } from "@/utils/notebookRuntime/orchestrator";
import type { MlModelRow, MlVersionRow } from "./access.server";

/** The stash a score session carries, so the source route can recognise it. */
export type MlScoreStash = { model_id: string; version_id: string };

export function mlScoreStashOf(inputs: unknown): MlScoreStash | null {
  const stash = (inputs as { __ml_score?: MlScoreStash } | null | undefined)?.__ml_score;
  if (!stash || typeof stash.model_id !== "string" || typeof stash.version_id !== "string") {
    return null;
  }
  return stash;
}

/**
 * The scoring program and its config, for a warm sandbox to load once.
 *
 * The SAME program the batch path runs, with the same config shape. The only
 * difference is that `input` is left out: a deployment does not know its rows
 * yet, and each request supplies them. Serving a second, smaller program here
 * would be the beginning of two scoring implementations.
 *
 * Scoped to the session's user, like every other bundle: a sandbox can only
 * ever read the thing it was started for.
 */
export async function mlScoreBundleFor(
  stash: MlScoreStash,
  userId: string,
): Promise<
  { code: string; config: Record<string, unknown>; env: Record<string, string> } | { error: string }
> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", stash.model_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!model) return { error: "Model not found for this session" };
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("id", stash.version_id)
    .eq("model_id", stash.model_id)
    .maybeSingle();
  if (!version) return { error: "Model version not found for this session" };
  if (!version.artifact_uri || !version.artifact_sha256) {
    return { error: "That version has no artifact to serve" };
  }

  const limits = await getPlatformResources();
  const config: Record<string, unknown> = {
    mode: "predict",
    model_id: model.id,
    version: version.version,
    task: model.task,
    target_column: model.target_column,
    artifact_uri: version.artifact_uri,
    artifact_sha256: version.artifact_sha256,
    output: null,
    max_rows: limits.mlPredictMaxRows,
  };
  const { etlPrelude } = await import("@/utils/etl/service.server");
  const { lakehouseAttachFn } = await import("@/utils/etl/codegen");
  const { TRAIN_PY } = await import("@/utils/ml/pyTrain");
  const b64 = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  const code =
    etlPrelude() +
    lakehouseAttachFn() +
    "\n" +
    TRAIN_PY +
    `\n_ML_CONFIG = json.loads(base64.b64decode('${b64}').decode('utf-8'))\n`;

  // The artifact is in the lake bucket, so the scorer needs the credentials
  // training used. Sent here rather than as container env for the reason the
  // MCP bundle sends secrets here: a response body is not in `docker inspect`
  // or a pod spec, so they exist only in the sandbox process's memory.
  let env: Record<string, string> = {};
  try {
    const { mlTrainingEnv } = await import("@/utils/ml/train.server");
    env = (await mlTrainingEnv(model as never, version.version)).env;
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { code, config, env };
}

export type MlDeploymentRow = {
  id: string;
  user_id: string;
  model_id: string;
  version_id: string | null;
  status: "starting" | "ready" | "failed" | "stopped";
  session_id: string | null;
  keep_warm: boolean;
  idle_ttl_minutes: number;
  last_used_at: string | null;
  last_started_at: string | null;
  last_error: string | null;
  request_count: number;
  /** Remembered so a score does not ask the orchestrator where to go. */
  endpoint: string | null;
};

/** The scorer's HTTP surface inside the sandbox. */
const SCORE_PATH = "/score";
const HEALTH_PATH = "/healthz";

/**
 * How long to wait for a cold deployment to load its model.
 *
 * The container appears in about three seconds and the artifact download plus
 * the sklearn import take most of the rest. Past this the caller is told to
 * try again rather than held indefinitely.
 */
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 750;
/** One score must not outlive the request in front of it. */
const SCORE_TIMEOUT_MS = 30_000;

export async function deploymentCaps(): Promise<{ perUser: number; total: number }> {
  const s = await getPlatformResources();
  return { perUser: s.mlMaxDeploymentsPerUser, total: s.mlMaxDeploymentsTotal };
}

export async function getDeployment(modelId: string): Promise<MlDeploymentRow | null> {
  const { data } = await supabaseAdmin
    .from("ml_deployments")
    .select("*")
    .eq("model_id", modelId)
    .maybeSingle();
  return (data as MlDeploymentRow | null) ?? null;
}

async function countLive(userId?: string): Promise<number> {
  let q = supabaseAdmin
    .from("ml_deployments")
    .select("id", { count: "exact", head: true })
    .in("status", ["starting", "ready"]);
  if (userId) q = q.eq("user_id", userId);
  const { count } = await q;
  return count ?? 0;
}

/** Where the scorer is reachable, or null when its sandbox is not serving. */
async function endpointOf(session: SessionRow): Promise<string | null> {
  try {
    const settings = await getRuntimeSettings();
    const orch = await getOrchestrator(settings);
    const status = await orch.status(sandboxName(session.id), "service");
    return status.endpoint ?? null;
  } catch {
    return null;
  }
}

async function markStopped(id: string, error?: string | null): Promise<void> {
  await supabaseAdmin
    .from("ml_deployments")
    .update({
      status: error ? "failed" : "stopped",
      session_id: null,
      endpoint: null,
      last_error: error?.slice(0, 2000) ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/**
 * Bring a model's endpoint up, or confirm it already is.
 *
 * Idempotent: a deployment that is already serving costs two queries and a
 * probe. Concurrent callers may both see "starting" and both wait, which is
 * correct — the row is unique per model, so only one sandbox exists.
 */
export async function ensureDeployment(args: {
  model: MlModelRow;
  version: MlVersionRow;
  userId: string;
  waitMs?: number;
}): Promise<
  { ok: true; endpoint: string; deployment: MlDeploymentRow } | { ok: false; error: string }
> {
  const { model, version, userId } = args;
  if (version.status !== "ready" || !version.artifact_uri || !version.artifact_sha256) {
    return { ok: false, error: "That version has no artifact to serve" };
  }
  if (model.task === "forecast") {
    // A forecast is a stored series, answered from the version row with no
    // model in the loop at all. There is nothing to keep warm.
    return { ok: false, error: "Forecast models are answered from their stored series" };
  }

  let dep = await getDeployment(model.id);

  // Already serving the version asked for? Then this is just a probe.
  if (dep && dep.status === "ready" && dep.session_id && dep.version_id === version.id) {
    const session = await getSession(userId, dep.session_id);
    if (session && !["stopped", "failed"].includes(session.status)) {
      const endpoint = await endpointOf(session);
      if (endpoint && (await healthy(endpoint))) return { ok: true, endpoint, deployment: dep };
    }
    // The row said ready and the sandbox is not. Fall through and restart.
    await markStopped(dep.id);
    dep = await getDeployment(model.id);
  }

  const caps = await deploymentCaps();
  const mine = await countLive(userId);
  const all = await countLive();
  const alreadyLive = dep?.status === "starting" || dep?.status === "ready";
  if (!alreadyLive && mine >= caps.perUser) {
    return {
      ok: false,
      error: `You already have ${caps.perUser} warm endpoints; undeploy one first`,
    };
  }
  if (!alreadyLive && all >= caps.total) {
    return { ok: false, error: "This instance is at its warm-endpoint limit; try again later" };
  }

  // Stop whatever was there: a deployment serving a different version must not
  // linger, or the endpoint answers with a model nobody asked for.
  if (dep?.session_id) await stopQuietly(userId, dep.session_id);

  const limits = await getPlatformResources();
  const { ensurePlatformEgress } = await import("@/utils/notebookRuntime/egressApply.server");
  await ensurePlatformEgress();

  const nowIso = new Date().toISOString();
  const { data: saved, error: upErr } = await supabaseAdmin
    .from("ml_deployments")
    .upsert(
      {
        user_id: userId,
        model_id: model.id,
        version_id: version.id,
        status: "starting",
        last_started_at: nowIso,
        last_error: null,
        updated_at: nowIso,
        ...(dep ? {} : { keep_warm: false }),
      },
      { onConflict: "model_id" },
    )
    .select("*")
    .single();
  if (upErr) return { ok: false, error: upErr.message };
  dep = saved as MlDeploymentRow;

  try {
    const { session } = await startSession({
      userId,
      kind: "service",
      serviceMode: "score",
      restartOnFailure: true,
      // The scorer holds the ML stack and a fitted pipeline resident; the
      // 2 GB an MCP server gets is the wrong budget for that.
      memLimitMb: limits.mlTrainMemLimitMb,
      inputs: { __ml_score: { model_id: model.id, version_id: version.id } },
    });
    await supabaseAdmin
      .from("ml_deployments")
      .update({ session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", dep.id);

    const ready = await waitReady(userId, session.id, args.waitMs ?? READY_TIMEOUT_MS);
    if (!ready.ok) {
      await markStopped(dep.id, ready.error);
      await stopQuietly(userId, session.id);
      return { ok: false, error: ready.error };
    }
    await supabaseAdmin
      .from("ml_deployments")
      .update({
        status: "ready",
        endpoint: ready.endpoint,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", dep.id);

    auditEvent({
      userId,
      action: "ml.deploy",
      resourceType: "ml_deployment",
      resourceId: dep.id,
      resourceName: model.name,
      detail: { model_id: model.id, version: version.version, version_id: version.id },
    });
    return { ok: true, endpoint: ready.endpoint, deployment: { ...dep, status: "ready" } };
  } catch (e) {
    const message = (e as Error).message;
    await markStopped(dep.id, message);
    return { ok: false, error: message };
  }
}

/** Is the scorer listening AND finished loading its model? */
async function healthy(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the sandbox to serve AND for the model to finish loading.
 *
 * Two separate conditions: the orchestrator reports the container running long
 * before Python has imported sklearn and pulled the artifact. Readiness here
 * means the scorer answers /healthz with 200, which it only does once the
 * model is in memory — so the first real request never pays the load.
 */
async function waitReady(
  userId: string,
  sessionId: string,
  waitMs: number,
): Promise<{ ok: true; endpoint: string } | { ok: false; error: string }> {
  const deadline = Date.now() + waitMs;
  let lastError = "The scorer did not become ready";
  while (Date.now() < deadline) {
    const session = await getSession(userId, sessionId);
    if (!session) return { ok: false, error: "The scorer's sandbox disappeared" };
    if (session.status === "failed" || session.status === "stopped") {
      return { ok: false, error: session.error || "The scorer's sandbox stopped" };
    }
    const endpoint = await endpointOf(session);
    if (endpoint) {
      try {
        const res = await fetch(`${endpoint}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return { ok: true, endpoint };
        // 503 while loading carries the reason once it has failed.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error) lastError = body.error;
      } catch {
        /* not listening yet */
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { ok: false, error: lastError };
}

/**
 * Score rows on a warm endpoint. Returns null when there is nothing to score
 * on, which is the caller's signal to take the sandbox path instead.
 */
export async function scoreWarm(args: {
  model: MlModelRow;
  version: MlVersionRow;
  userId: string;
  rows: Record<string, unknown>[];
}): Promise<
  | {
      ok: true;
      columns: string[];
      rows: unknown[][];
      algorithm: string | null;
      warnings: string[];
      elapsedSeconds: number | null;
      /**
       * The scorer's whole answer, handed to `finalizePrediction` untouched so
       * a warm prediction gets the same digest, drift check and audit row a
       * cold one does. Re-deriving those here would be a second implementation
       * of the record.
       */
      raw: Record<string, unknown>;
    }
  | { ok: false; error: string }
  | null
> {
  const dep = await getDeployment(args.model.id);
  if (!dep || dep.status !== "ready" || !dep.session_id) return null;
  // A deployment serving a different version must not answer for this one.
  if (dep.version_id !== args.version.id) return null;

  // The remembered address first. Asking the orchestrator where the sandbox
  // is means a `docker inspect` per score, which was most of the latency a
  // warm endpoint was supposed to have removed.
  let endpoint = dep.endpoint;
  if (!endpoint) {
    const session = await getSession(args.userId, dep.session_id);
    if (!session) return null;
    endpoint = await endpointOf(session);
    if (!endpoint) return null;
    void supabaseAdmin.from("ml_deployments").update({ endpoint }).eq("id", dep.id);
  }

  try {
    const res = await fetch(`${endpoint}${SCORE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: args.rows }),
      signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      // 503 means it is loading or its model failed to load: not an answer,
      // and not a reason to fail the request either.
      if (res.status === 503) return null;
      return { ok: false, error: String(body?.error ?? `The scorer answered ${res.status}`) };
    }
    void touch(dep.id);
    return {
      ok: true,
      columns: (body?.columns as string[]) ?? [],
      rows: (body?.sample as unknown[][]) ?? [],
      algorithm: (body?.algorithm as string | null) ?? null,
      warnings: (body?.warnings as string[]) ?? [],
      elapsedSeconds: typeof body?.elapsed_seconds === "number" ? body.elapsed_seconds : null,
      raw: body ?? {},
    };
  } catch (e) {
    // A transport failure is a cold-path fallback, not an error to the caller:
    // the sandbox may have just been reaped out from under this request. Forget
    // the address so the next call re-resolves it rather than retrying a
    // container that has gone.
    void supabaseAdmin.from("ml_deployments").update({ endpoint: null }).eq("id", dep.id);
    console.warn("[ml-serve] warm score failed:", (e as Error).message);
    return null;
  }
}

/** Record use, so the idle reaper knows this endpoint is earning its memory. */
async function touch(id: string): Promise<void> {
  try {
    // One statement: the RPC sets both the counter and the timestamp the idle
    // reaper reads. A second UPDATE here would double the writes on the path
    // this whole feature exists to keep short.
    await supabaseAdmin.rpc("increment_ml_deployment_use", { p_id: id });
  } catch (e) {
    console.warn("[ml-serve] could not record use:", (e as Error).message);
  }
}

async function stopQuietly(userId: string, sessionId: string): Promise<void> {
  try {
    const session = await getSession(userId, sessionId);
    if (session) await stopSession(session);
  } catch (e) {
    console.warn("[ml-serve] could not stop a scorer:", (e as Error).message);
  }
}

/** Take an endpoint down. The model and its versions are untouched. */
export async function undeploy(modelId: string, userId: string): Promise<void> {
  const dep = await getDeployment(modelId);
  if (!dep) return;
  if (dep.session_id) await stopQuietly(userId, dep.session_id);
  await markStopped(dep.id);
  auditEvent({
    userId,
    action: "ml.undeploy",
    resourceType: "ml_deployment",
    resourceId: dep.id,
    resourceName: modelId,
    detail: { model_id: modelId, requests_served: dep.request_count },
  });
}

/**
 * Stop endpoints nobody is using.
 *
 * A warm scorer costs its memory whether or not anyone scores, so an idle one
 * is pure waste; `keep_warm` opts out for the endpoints where the first slow
 * request is the one that matters. This is the ONLY thing that reaps them —
 * the generic session reaper skips services without an MCP app, and a service
 * has no expiry by design.
 */
export async function reapIdleDeployments(): Promise<number> {
  const { data: rows } = await supabaseAdmin
    .from("ml_deployments")
    .select("*")
    .in("status", ["starting", "ready"])
    .eq("keep_warm", false);
  let stopped = 0;
  for (const raw of (rows ?? []) as MlDeploymentRow[]) {
    // The LATER of the two, not the first that is set.
    //
    // Measured live: a redeployed endpoint still carried `last_used_at` from
    // the previous container's last score, so the reaper read seventeen
    // minutes of idleness on a sandbox that was thirty-seven seconds old and
    // stopped it. Starting is something happening; an endpoint that has just
    // come up is not idle however long ago it was last called.
    const marks = [raw.last_used_at, raw.last_started_at]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime())
      .filter((n) => Number.isFinite(n));
    if (marks.length === 0) continue;
    const idleMs = Date.now() - Math.max(...marks);
    if (idleMs < raw.idle_ttl_minutes * 60_000) continue;
    if (raw.session_id) await stopQuietly(raw.user_id, raw.session_id);
    await markStopped(raw.id);
    auditEvent({
      userId: raw.user_id,
      action: "ml.undeploy",
      resourceType: "ml_deployment",
      resourceId: raw.id,
      resourceName: raw.model_id,
      detail: {
        reason: "idle",
        idle_minutes: Math.round(idleMs / 60_000),
        requests_served: raw.request_count,
      },
    });
    stopped++;
  }
  return stopped;
}
