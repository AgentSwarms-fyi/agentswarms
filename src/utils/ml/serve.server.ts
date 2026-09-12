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
import {
  idleSeconds,
  ratePerMinute,
  replicaToScore,
  replicaToStop,
  scaleDecision,
} from "@/lib/mlAutoscale";
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
  keep_warm: boolean;
  idle_ttl_minutes: number;
  last_used_at: string | null;
  last_started_at: string | null;
  last_error: string | null;
  request_count: number;
  /** Copies held with no traffic, and the ceiling autoscaling may reach. */
  min_replicas: number;
  max_replicas: number;
  /** The counter and when it was read, so a rate can be measured not guessed. */
  scale_checked_at: string | null;
  scale_checked_count: number | null;
  last_scaled_at: string | null;
  last_scale_reason: string | null;
};

/**
 * One copy of the model, in its own sandbox.
 *
 * The deployment is the policy; this is the thing that actually answers. A
 * copy owns its session, its address and its own idle clock — the last of
 * which is what makes stopping one safe, because "idle" has to mean idle for
 * THIS container rather than for the endpoint as a whole.
 */
export type MlReplicaRow = {
  id: string;
  deployment_id: string;
  user_id: string;
  session_id: string | null;
  status: "starting" | "ready" | "failed" | "stopped";
  endpoint: string | null;
  last_used_at: string | null;
  last_started_at: string | null;
  last_error: string | null;
  request_count: number;
};

const LIVE_REPLICA = ["starting", "ready"] as const;

export async function listReplicas(deploymentId: string, liveOnly = true): Promise<MlReplicaRow[]> {
  let q = supabaseAdmin
    .from("ml_deployment_replicas")
    .select("*")
    .eq("deployment_id", deploymentId);
  if (liveOnly) q = q.in("status", [...LIVE_REPLICA]);
  const { data } = await q;
  return ((data ?? []) as MlReplicaRow[]).slice();
}

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

/**
 * Warm containers held right now.
 *
 * REPLICAS, not deployments. The cap exists to bound how much memory is held
 * resident, and one deployment with four copies is four sandboxes. Counting
 * deployments would have let a single endpoint walk straight through a limit
 * written to protect the machine. Every endpoint defaults to one copy, so this
 * counts the same as it used to until somebody raises a maximum.
 */
async function countLive(userId?: string): Promise<number> {
  let q = supabaseAdmin
    .from("ml_deployment_replicas")
    .select("id", { count: "exact", head: true })
    .in("status", [...LIVE_REPLICA]);
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

  // Already serving the version asked for? Then this is just a probe — but
  // the answer comes from a COPY that is actually healthy, not from a status
  // column. A row saying "ready" while every sandbox behind it has gone is
  // exactly the lie the replicas table was split out to make impossible.
  if (dep && dep.status === "ready" && dep.version_id === version.id) {
    for (const replica of await listReplicas(dep.id)) {
      if (replica.status !== "ready" || !replica.endpoint) continue;
      if (await healthy(replica.endpoint)) {
        return { ok: true, endpoint: replica.endpoint, deployment: dep };
      }
      // This one has gone. Retire it and keep looking; the endpoint as a
      // whole is only down when none of them answer.
      await retireReplica(replica, "health check failed");
    }
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
  // linger, or the endpoint answers with a model nobody asked for. EVERY copy,
  // not the first — leaving one behind is an endpoint that answers with two
  // different models depending on which copy the round-robin picks.
  if (dep) {
    for (const replica of await listReplicas(dep.id)) {
      await retireReplica(replica, "replaced");
    }
  }

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

  const first = await startReplica({
    deployment: dep,
    model,
    version,
    userId,
    memLimitMb: limits.mlTrainMemLimitMb,
    waitMs: args.waitMs ?? READY_TIMEOUT_MS,
  });
  if (!first.ok) {
    await markStopped(dep.id, first.error);
    return { ok: false, error: first.error };
  }
  await supabaseAdmin
    .from("ml_deployments")
    .update({ status: "ready", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", dep.id);

  auditEvent({
    userId,
    action: "ml.deploy",
    resourceType: "ml_deployment",
    resourceId: dep.id,
    resourceName: model.name,
    detail: { model_id: model.id, version: version.version, version_id: version.id },
  });

  // Any further copies the minimum asks for are started WITHOUT waiting. The
  // caller has a working endpoint the moment the first one answers; making
  // them wait another twenty seconds each for copies two and three would be
  // charging them for headroom they have not asked to use yet.
  const wantMore = Math.max(0, Math.min(dep.min_replicas, dep.max_replicas) - 1);
  if (wantMore > 0) {
    void (async () => {
      for (let i = 0; i < wantMore; i++) {
        const room = await replicaRoom(userId);
        if (!room.ok) break;
        await startReplica({
          deployment: dep,
          model,
          version,
          userId,
          memLimitMb: limits.mlTrainMemLimitMb,
          waitMs: READY_TIMEOUT_MS,
        });
      }
    })().catch((e) => console.warn("[ml-serve] extra copy failed:", (e as Error).message));
  }

  return { ok: true, endpoint: first.endpoint, deployment: { ...dep, status: "ready" } };
}

/** Is there room for one more warm container, for this user and overall? */
async function replicaRoom(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const caps = await deploymentCaps();
  const [mine, all] = await Promise.all([countLive(userId), countLive()]);
  if (mine >= caps.perUser) {
    return { ok: false, error: `You are already holding ${caps.perUser} warm containers` };
  }
  if (all >= caps.total)
    return { ok: false, error: "This instance is at its warm-container limit" };
  return { ok: true };
}

/**
 * Start one copy and wait for it to load the model.
 *
 * The replica row is written BEFORE the sandbox starts, so a copy that dies
 * during load is a row someone can see and reap rather than a container with
 * nothing pointing at it.
 */
async function startReplica(args: {
  deployment: MlDeploymentRow;
  model: MlModelRow;
  version: MlVersionRow;
  userId: string;
  memLimitMb: number;
  waitMs: number;
}): Promise<{ ok: true; endpoint: string; replicaId: string } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  const { data: row, error: insErr } = await supabaseAdmin
    .from("ml_deployment_replicas")
    .insert({
      deployment_id: args.deployment.id,
      user_id: args.userId,
      status: "starting",
      last_started_at: nowIso,
    })
    .select("*")
    .single();
  if (insErr || !row) return { ok: false, error: insErr?.message ?? "Could not record the copy" };
  const replica = row as MlReplicaRow;

  try {
    const { session } = await startSession({
      userId: args.userId,
      kind: "service",
      serviceMode: "score",
      restartOnFailure: true,
      // The scorer holds the ML stack and a fitted pipeline resident; the
      // 2 GB an MCP server gets is the wrong budget for that.
      memLimitMb: args.memLimitMb,
      inputs: { __ml_score: { model_id: args.model.id, version_id: args.version.id } },
    });
    await supabaseAdmin
      .from("ml_deployment_replicas")
      .update({ session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", replica.id);

    const ready = await waitReady(args.userId, session.id, args.waitMs);
    if (!ready.ok) {
      await supabaseAdmin
        .from("ml_deployment_replicas")
        .update({
          status: "failed",
          last_error: ready.error.slice(0, 2000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", replica.id);
      await stopQuietly(args.userId, session.id);
      return { ok: false, error: ready.error };
    }
    await supabaseAdmin
      .from("ml_deployment_replicas")
      .update({
        status: "ready",
        endpoint: ready.endpoint,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", replica.id);
    return { ok: true, endpoint: ready.endpoint, replicaId: replica.id };
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin
      .from("ml_deployment_replicas")
      .update({ status: "failed", last_error: message.slice(0, 2000) })
      .eq("id", replica.id);
    return { ok: false, error: message };
  }
}

/** Stop one copy's sandbox and mark the row, whichever way round it goes. */
async function retireReplica(replica: MlReplicaRow, reason: string): Promise<void> {
  if (replica.session_id) await stopQuietly(replica.user_id, replica.session_id);
  await supabaseAdmin
    .from("ml_deployment_replicas")
    .update({
      status: "stopped",
      endpoint: null,
      last_error: reason.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", replica.id);
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
  if (!dep || dep.status !== "ready") return null;
  // A deployment serving a different version must not answer for this one.
  if (dep.version_id !== args.version.id) return null;

  // THE QUIETEST COPY, by the same rule the scaler uses to choose what to
  // stop. Two different notions of "quietest" would have the two disagreeing
  // about the same endpoint, and the idle clock the scale-down safety check
  // reads would stop meaning what it says.
  const ready = (await listReplicas(dep.id)).filter(
    (r) => r.status === "ready" && Boolean(r.endpoint),
  );
  const replica = replicaToScore(ready);
  if (!replica?.endpoint) return null;
  const endpoint = replica.endpoint;

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
    void touch(dep.id, replica.id);
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
    // the sandbox may have just been reaped out from under this request.
    //
    // Retire THIS COPY rather than the endpoint. With one sandbox the two were
    // the same thing; with several, forgetting the whole endpoint's address
    // because one container went would throw away the copies still answering.
    void retireReplica(replica, `transport failure: ${(e as Error).message}`.slice(0, 200));
    console.warn("[ml-serve] warm score failed:", (e as Error).message);
    return null;
  }
}

/**
 * Record use on both the endpoint and the copy that answered.
 *
 * The endpoint's counter is what the autoscaler differences into a rate; the
 * copy's timestamp is what makes stopping it safe. Neither can be derived
 * from the other — a busy endpoint says nothing about which copy is quiet —
 * so both are written, and both off the request path.
 */
async function touch(deploymentId: string, replicaId: string): Promise<void> {
  try {
    await Promise.all([
      // One statement: the RPC sets both the counter and the timestamp the
      // idle reaper reads. A second UPDATE here would double the writes on the
      // path this whole feature exists to keep short.
      supabaseAdmin.rpc("increment_ml_deployment_use", { p_id: deploymentId }),
      supabaseAdmin
        .from("ml_deployment_replicas")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", replicaId),
    ]);
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
  for (const replica of await listReplicas(dep.id)) {
    await retireReplica(replica, "undeployed");
  }
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
    const replicas = await listReplicas(raw.id);
    const marks = [
      raw.last_used_at,
      raw.last_started_at,
      // A copy started a moment ago keeps the endpoint alive even if the
      // endpoint's own clocks are stale: something IS happening.
      ...replicas.flatMap((r) => [r.last_used_at, r.last_started_at]),
    ]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime())
      .filter((n) => Number.isFinite(n));
    if (marks.length === 0) continue;
    const idleMs = Date.now() - Math.max(...marks);
    if (idleMs < raw.idle_ttl_minutes * 60_000) continue;
    for (const replica of replicas) await retireReplica(replica, "idle");
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

/**
 * How hard one copy is expected to work, and how reluctant the scaler is.
 *
 * Env knobs rather than settings rows, like the two explanation limits they
 * sit beside: these describe the shape of the machine rather than a policy an
 * owner picks per model, and the per-model policy (min, max) lives on the
 * deployment where an owner can see it.
 */
const envCount = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};
const TARGET_RPM_PER_REPLICA = envCount("ML_SERVE_TARGET_RPM_PER_REPLICA", 120);
const SCALE_COOLDOWN_SECONDS = envCount("ML_SERVE_SCALE_COOLDOWN_SECONDS", 180);

/**
 * Resize every endpoint to the load it is actually carrying.
 *
 * Runs on the platform clock beside the idle reaper. The decision itself is in
 * src/lib/mlAutoscale.ts and is pure arithmetic — this function's whole job is
 * to measure honestly, act once, and record why.
 *
 * MEASURED, NOT SAMPLED: the endpoint keeps a cumulative request counter, and
 * a rate is the difference between two readings of it over the time between
 * them. The first pass after a restart has nothing to difference against and
 * deliberately does nothing but take a reading — guessing from a cumulative
 * total would read a month of traffic as if it had all arrived this minute.
 */
export async function autoscaleDeployments(): Promise<{ scaled: number }> {
  const { data: rows } = await supabaseAdmin
    .from("ml_deployments")
    .select("*")
    .eq("status", "ready");
  const deployments = (rows ?? []) as MlDeploymentRow[];
  const now = new Date();
  let scaled = 0;

  for (const dep of deployments) {
    const rate = ratePerMinute(
      dep.scale_checked_count,
      dep.scale_checked_at,
      dep.request_count,
      now,
    );
    // Always take a reading, whatever else happens: skipping it on a pass that
    // decided nothing would leave the next pass differencing across two
    // intervals and reporting half the real rate.
    const reading = {
      scale_checked_at: now.toISOString(),
      scale_checked_count: dep.request_count,
    };

    // An endpoint that cannot grow or shrink is not worth measuring further,
    // and the overwhelming majority are exactly that until somebody opts in.
    if (dep.min_replicas === dep.max_replicas) {
      await supabaseAdmin.from("ml_deployments").update(reading).eq("id", dep.id);
      continue;
    }
    if (rate === null) {
      await supabaseAdmin.from("ml_deployments").update(reading).eq("id", dep.id);
      continue;
    }

    const replicas = await listReplicas(dep.id);
    const ready = replicas.filter((r) => r.status === "ready");
    const starting = replicas.filter((r) => r.status === "starting");
    const quietest = replicaToStop(ready);

    const decision = scaleDecision({
      requestsPerMinute: rate,
      replicasReady: ready.length,
      replicasStarting: starting.length,
      min: dep.min_replicas,
      max: dep.max_replicas,
      targetPerReplica: TARGET_RPM_PER_REPLICA,
      secondsSinceChange: dep.last_scaled_at
        ? Math.max(0, (now.getTime() - new Date(dep.last_scaled_at).getTime()) / 1000)
        : Number.POSITIVE_INFINITY,
      cooldownSeconds: SCALE_COOLDOWN_SECONDS,
      // Idle since it was last USED, or since it STARTED if it never was.
      //
      // FOUND LIVE: a copy that has answered nothing has last_used_at null, so
      // reading only that returned null, the safety check said "no copy is
      // idle enough to stop", and the endpoint could never shrink again. A
      // copy nothing has ever been routed to is the SAFEST one to stop, not
      // the least safe — there is certainly no request inside it.
      idlestReplicaIdleSeconds: quietest
        ? (idleSeconds(quietest.last_used_at, now) ?? idleSeconds(quietest.last_started_at, now))
        : null,
    });

    if (decision.action === "hold") {
      await supabaseAdmin
        .from("ml_deployments")
        .update({ ...reading, last_scale_reason: decision.reason })
        .eq("id", dep.id);
      continue;
    }

    if (decision.action === "up") {
      const room = await replicaRoom(dep.user_id);
      if (!room.ok) {
        await supabaseAdmin
          .from("ml_deployments")
          .update({ ...reading, last_scale_reason: `wanted another copy but ${room.error}` })
          .eq("id", dep.id);
        continue;
      }
      const bundle = await loadForScale(dep);
      if (!bundle) {
        await supabaseAdmin.from("ml_deployments").update(reading).eq("id", dep.id);
        continue;
      }
      // ONE copy per pass, however far behind the endpoint is. The next pass
      // is a minute away and will add another if it is still needed — and by
      // then the first will have loaded, so the decision is made knowing what
      // it actually bought. Starting four at once on a burst is how a machine
      // runs out of memory serving a spike that was over before they loaded.
      const started = await startReplica({
        deployment: dep,
        model: bundle.model,
        version: bundle.version,
        userId: dep.user_id,
        memLimitMb: (await getPlatformResources()).mlTrainMemLimitMb,
        waitMs: READY_TIMEOUT_MS,
      });
      await supabaseAdmin
        .from("ml_deployments")
        .update({
          ...reading,
          last_scaled_at: now.toISOString(),
          last_scale_reason: started.ok
            ? `added a copy: ${decision.reason}`
            : `could not add a copy: ${started.error}`,
        })
        .eq("id", dep.id);
      if (started.ok) {
        scaled++;
        auditEvent({
          userId: dep.user_id,
          action: "ml.scale",
          resourceType: "ml_deployment",
          resourceId: dep.id,
          resourceName: dep.model_id,
          detail: {
            direction: "up",
            from: ready.length,
            to: ready.length + 1,
            requests_per_minute: Math.round(rate * 10) / 10,
            reason: decision.reason,
          },
        });
      }
      continue;
    }

    // Down. The copy chosen is the one the decision already judged safe — the
    // quietest — so the safety check and the action cannot disagree about
    // which container they mean.
    if (!quietest) {
      await supabaseAdmin.from("ml_deployments").update(reading).eq("id", dep.id);
      continue;
    }
    await retireReplica(quietest, "scaled down");
    await supabaseAdmin
      .from("ml_deployments")
      .update({
        ...reading,
        last_scaled_at: now.toISOString(),
        last_scale_reason: `removed a copy: ${decision.reason}`,
      })
      .eq("id", dep.id);
    scaled++;
    auditEvent({
      userId: dep.user_id,
      action: "ml.scale",
      resourceType: "ml_deployment",
      resourceId: dep.id,
      resourceName: dep.model_id,
      detail: {
        direction: "down",
        from: ready.length,
        to: ready.length - 1,
        requests_per_minute: Math.round(rate * 10) / 10,
        reason: decision.reason,
      },
    });
  }

  return { scaled };
}

/** The model and version a deployment is serving, for starting another copy. */
async function loadForScale(
  dep: MlDeploymentRow,
): Promise<{ model: MlModelRow; version: MlVersionRow } | null> {
  if (!dep.version_id) return null;
  const [{ data: model }, { data: version }] = await Promise.all([
    supabaseAdmin.from("ml_models").select("*").eq("id", dep.model_id).maybeSingle(),
    supabaseAdmin.from("ml_model_versions").select("*").eq("id", dep.version_id).maybeSingle(),
  ]);
  if (!model || !version) return null;
  return { model: model as MlModelRow, version: version as MlVersionRow };
}
