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
import { compareAnswers, type MlShadowTask } from "@/lib/mlShadow";
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
  /** A version being tried alongside the one in production. */
  candidate_version_id: string | null;
  candidate_mode: "off" | "shadow";
  candidate_started_at: string | null;
  shadow_requests: number;
  shadow_rows: number;
  shadow_agreed: number;
  shadow_errors: number;
  shadow_last_error: string | null;
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
  /**
   * The version THIS copy is holding.
   *
   * Until a candidate existed every copy served the endpoint's version, so the
   * version was a property of the endpoint. Two copies of one endpoint can now
   * hold different models, and a scorer that assumed otherwise would mirror
   * traffic to whichever it happened to pick.
   */
  version_id: string | null;
  role: "primary" | "candidate";
};

const LIVE_REPLICA = ["starting", "ready"] as const;

export async function listReplicas(
  deploymentId: string,
  liveOnly = true,
  role?: "primary" | "candidate",
): Promise<MlReplicaRow[]> {
  let q = supabaseAdmin
    .from("ml_deployment_replicas")
    .select("*")
    .eq("deployment_id", deploymentId);
  if (liveOnly) q = q.in("status", [...LIVE_REPLICA]);
  if (role) q = q.eq("role", role);
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
    // PRIMARY only. This returns an address the caller will score against, and
    // a candidate's address here would hand a live caller the answer of a
    // version nobody approved — the one thing shadowing promises cannot happen.
    for (const replica of await listReplicas(dep.id, true, "primary")) {
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
        // The candidate's copies were just retired with every other copy, so
        // leaving these set would describe a shadow that is not running. And
        // in the ordinary case — adopting the candidate by deploying it — the
        // endpoint would claim to be shadowing the very version it now serves.
        candidate_version_id: null,
        candidate_mode: "off",
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
  /** Defaults to the side that answers callers. */
  role?: "primary" | "candidate";
}): Promise<{ ok: true; endpoint: string; replicaId: string } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  const { data: row, error: insErr } = await supabaseAdmin
    .from("ml_deployment_replicas")
    .insert({
      deployment_id: args.deployment.id,
      user_id: args.userId,
      status: "starting",
      last_started_at: nowIso,
      // Recorded on the row rather than inferred from the deployment: the
      // endpoint's version_id is the PRIMARY's, and a candidate copy holds
      // something else entirely.
      version_id: args.version.id,
      role: args.role ?? "primary",
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
  // PRIMARY copies only. A candidate exists to be compared against, never to
  // answer somebody — handing a caller its answer is the one thing shadowing
  // promises will not happen.
  const ready = (await listReplicas(dep.id, true, "primary")).filter(
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
    // AFTER the answer is in hand and deliberately not awaited. A mirror that
    // the caller waits for is not a shadow, it is a second serving path with
    // twice the latency and twice the ways to fail.
    void mirrorToCandidate(dep, args, body).catch((e) =>
      console.warn("[ml-shadow] mirror failed:", (e as Error).message),
    );
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
  // The candidate's copy went down with every other one just now, so the row
  // would otherwise go on naming a shadow that is not running. SEEN LIVE after
  // stopping an endpoint mid-shadow. Harmless while stopped — the mirror finds
  // no candidate copy and returns — but a row should not describe something
  // that is not happening. The totals stay: they are what the run measured.
  await supabaseAdmin
    .from("ml_deployments")
    .update({ candidate_mode: "off", candidate_version_id: null })
    .eq("id", dep.id);
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

    // PRIMARY only, and this one is easy to get wrong in both directions. A
    // candidate counted as capacity makes an endpoint at its ceiling look
    // over-provisioned, so the scaler stops a copy: either the candidate,
    // killing the shadow silently, or the last primary, leaving an endpoint
    // whose only warm copy is one the scorer refuses to use. The candidate is
    // not spare capacity — it answers nobody.
    const replicas = await listReplicas(dep.id, true, "primary");
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

/** How long a mirrored call may take before it is abandoned. */
const SHADOW_TIMEOUT_MS = 20_000;
/** Recent disagreements kept per endpoint, so the table cannot grow forever. */
const SHADOW_KEEP_DISAGREEMENTS = 50;

/**
 * Ask the candidate the same question, throw its answer away, keep the score.
 *
 * Everything here is best-effort by construction. The caller already has their
 * answer before this starts; nothing it does can change that answer, and any
 * failure is recorded as a failure of the CANDIDATE rather than of the
 * request. That asymmetry is the whole promise of shadowing — if a mirror
 * could break a live prediction it would be a worse idea than switching.
 */
async function mirrorToCandidate(
  dep: MlDeploymentRow,
  args: { model: MlModelRow; userId: string; rows: Record<string, unknown>[] },
  primaryBody: Record<string, unknown> | null,
): Promise<void> {
  if (dep.candidate_mode !== "shadow" || !dep.candidate_version_id) return;
  // Only tasks where "the same answer" means something. Clustering and anomaly
  // detection return labels whose numbering is arbitrary between fits, so
  // comparing them would report disagreement on two identical models.
  const task = args.model.task;
  if (task !== "classification" && task !== "regression") return;

  const candidates = (await listReplicas(dep.id, true, "candidate")).filter(
    (r) => r.status === "ready" && Boolean(r.endpoint),
  );
  const target = replicaToScore(candidates);
  if (!target?.endpoint) return;

  let comparison: ReturnType<typeof compareAnswers> | null = null;
  let failure: string | null = null;
  try {
    const res = await fetch(`${target.endpoint}${SCORE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: args.rows }),
      signal: AbortSignal.timeout(SHADOW_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      failure = String(body?.error ?? `the candidate answered ${res.status}`);
    } else {
      const pairs = answerPairs(primaryBody, body);
      comparison = pairs.length > 0 ? compareAnswers(task as MlShadowTask, pairs) : null;
      if (!comparison) failure = "the candidate returned no comparable rows";
    }
    // AWAITED, and it has to be. A PostgREST builder is lazy: the request is
    // issued inside .then(), so a builder that is never awaited and never
    // given a .then() does not call the database at all. MEASURED: after four
    // mirrored requests the candidate's last_used_at was still null.
    //
    // The fire-and-forget stamps elsewhere in the repo end in `.then(() => {})`
    // for exactly this reason — that terminal .then is what runs them, and the
    // `void` only marks the floating promise. Here the mirror is already off
    // the caller's path, so awaiting is simpler and lets the surrounding catch
    // record a failure as the candidate's rather than losing it.
    await supabaseAdmin
      .from("ml_deployment_replicas")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", target.id);
  } catch (e) {
    failure = (e as Error).message;
  }

  // ATOMIC, not read-modify-write. `dep` was read when the request arrived, so
  // adding to its totals and writing them back would lose every count that
  // arrived in between — under exactly the concurrency a warm endpoint exists
  // for. The arithmetic lives in the function and matches addComparison().
  await supabaseAdmin.rpc("record_ml_shadow_result", {
    p_id: dep.id,
    p_rows: comparison?.rows ?? 0,
    p_agreed: comparison?.agreed ?? 0,
    p_error: failure ? failure.slice(0, 2000) : null,
  });

  if (comparison && comparison.examples.length > 0) {
    // The counters say how OFTEN they differ; these say how. Without them a
    // reader is told "they disagree on 8% of rows" and has nowhere to go.
    await supabaseAdmin.from("ml_shadow_disagreements").insert(
      comparison.examples.map((x) => ({
        deployment_id: dep.id,
        model_id: dep.model_id,
        primary_version_id: dep.version_id,
        candidate_version_id: dep.candidate_version_id,
        // Strings, and no input: a mirrored request carries whatever the
        // caller sent, and keeping that would put live personal data in a
        // debugging table nobody thinks of as a data store.
        primary_answer: String(x.primary).slice(0, 200),
        candidate_answer: String(x.candidate).slice(0, 200),
      })),
    );
    await trimDisagreements(dep.id);
  }
}

/** Line up the two answers row by row, on the prediction column. */
function answerPairs(
  primary: Record<string, unknown> | null,
  candidate: Record<string, unknown> | null,
): { primary: unknown; candidate: unknown }[] {
  const pCols = (primary?.columns as string[]) ?? [];
  const cCols = (candidate?.columns as string[]) ?? [];
  const pi = pCols.indexOf("prediction");
  const ci = cCols.indexOf("prediction");
  if (pi < 0 || ci < 0) return [];
  const pRows = (primary?.sample as unknown[][]) ?? [];
  const cRows = (candidate?.sample as unknown[][]) ?? [];
  // The shorter of the two. Comparing a row against nothing is not a
  // disagreement, and padding one side would invent one.
  const n = Math.min(pRows.length, cRows.length);
  const out: { primary: unknown; candidate: unknown }[] = [];
  for (let i = 0; i < n; i++) out.push({ primary: pRows[i]?.[pi], candidate: cRows[i]?.[ci] });
  return out;
}

/** Keep only the most recent disagreements for one endpoint. */
async function trimDisagreements(deploymentId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("ml_shadow_disagreements")
    .select("id")
    .eq("deployment_id", deploymentId)
    .order("created_at", { ascending: false })
    .range(SHADOW_KEEP_DISAGREEMENTS, SHADOW_KEEP_DISAGREEMENTS + 500);
  const stale = (data ?? []).map((r) => r.id);
  if (stale.length > 0) {
    await supabaseAdmin.from("ml_shadow_disagreements").delete().in("id", stale);
  }
}

/**
 * Start shadowing a version, or stop.
 *
 * Starting brings up a candidate copy and resets the totals: figures gathered
 * against a DIFFERENT candidate would answer a question nobody asked.
 */
export async function setShadowCandidate(args: {
  model: MlModelRow;
  userId: string;
  version: MlVersionRow | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const dep = await getDeployment(args.model.id);
  if (!dep || dep.status !== "ready") {
    return { ok: false, error: "The endpoint is not running, so there is nothing to shadow" };
  }

  // Stopping: take the candidate copies down and leave the totals to be read.
  if (!args.version) {
    for (const r of await listReplicas(dep.id, true, "candidate")) {
      await retireReplica(r, "shadow stopped");
    }
    await supabaseAdmin
      .from("ml_deployments")
      .update({ candidate_mode: "off", candidate_version_id: null })
      .eq("id", dep.id);
    auditEvent({
      userId: args.userId,
      action: "ml.shadow.stop",
      resourceType: "ml_deployment",
      resourceId: dep.id,
      resourceName: args.model.name,
      detail: {
        requests: dep.shadow_requests,
        rows: dep.shadow_rows,
        agreed: dep.shadow_agreed,
        errors: dep.shadow_errors,
      },
    });
    return { ok: true };
  }

  if (args.version.id === dep.version_id) {
    return { ok: false, error: "That version is already the one being served" };
  }
  if (args.version.status !== "ready" || !args.version.artifact_uri) {
    return { ok: false, error: "That version has no artifact to serve" };
  }
  const room = await replicaRoom(args.userId);
  if (!room.ok) return { ok: false, error: room.error };

  // Any previous candidate goes first: two candidates would be two answers to
  // the question "what would the new version have said".
  for (const r of await listReplicas(dep.id, true, "candidate")) {
    await retireReplica(r, "replaced by a new candidate");
  }

  const limits = await getPlatformResources();
  const started = await startReplica({
    deployment: dep,
    model: args.model,
    version: args.version,
    userId: args.userId,
    memLimitMb: limits.mlTrainMemLimitMb,
    waitMs: READY_TIMEOUT_MS,
    role: "candidate",
  });
  if (!started.ok) return { ok: false, error: started.error };

  await supabaseAdmin
    .from("ml_deployments")
    .update({
      candidate_version_id: args.version.id,
      candidate_mode: "shadow",
      candidate_started_at: new Date().toISOString(),
      // Reset: totals from a previous candidate describe a different question.
      shadow_requests: 0,
      shadow_rows: 0,
      shadow_agreed: 0,
      shadow_errors: 0,
      shadow_last_error: null,
    })
    .eq("id", dep.id);
  await supabaseAdmin.from("ml_shadow_disagreements").delete().eq("deployment_id", dep.id);

  auditEvent({
    userId: args.userId,
    action: "ml.shadow.start",
    resourceType: "ml_deployment",
    resourceId: dep.id,
    resourceName: args.model.name,
    detail: { candidate_version: args.version.version, candidate_version_id: args.version.id },
  });
  return { ok: true };
}
