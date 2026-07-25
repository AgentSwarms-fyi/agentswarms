// Orchestration service for notebook runtime sessions: create, poll/reconcile,
// stop, and reap. Keeps the API routes thin and the lifecycle logic in one
// testable place. The DB row is the source of truth, so any app replica can
// reconcile any session (the orchestrators are stateless HTTP clients).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { getOrchestrator, type KernelKind } from "./orchestrator";
import { getRuntimeSettings } from "./config.server";
import { signSessionToken } from "./token.server";
import { appInContainer } from "./docker.server";

export type SessionRow = Database["public"]["Tables"]["notebook_runtime_sessions"]["Row"];

export const LIVE = ["queued", "starting", "ready", "running", "stopping"] as const;

// Defaults adapt to how the app is deployed, so neither a compose install nor a
// local `npm run dev` needs env wiring. Override any of them for custom setups.
//
// Kernel → app callback URL: inside compose the app is a service on the kernel's
// network; on a dev host it is only reachable through the Docker host gateway.
function internalAppUrl(): string {
  if (process.env.NOTEBOOK_APP_INTERNAL_URL) return process.env.NOTEBOOK_APP_INTERNAL_URL;
  if (process.env.APP_URL) return process.env.APP_URL;
  const port = process.env.PORT || "8080";
  return appInContainer() ? `http://agentswarms:${port}` : `http://host.docker.internal:${port}`;
}

/**
 * Websocket URL the BROWSER uses to reach the gateway. Empty means "derive from
 * the page's own origin" — that's what makes localhost, a cloud VM's IP, and a
 * custom domain all work without configuration. Set NOTEBOOK_GATEWAY_URL when
 * the gateway sits behind a reverse proxy on a different host/path.
 */
export function gatewayUrl(): string {
  return process.env.NOTEBOOK_GATEWAY_URL || "";
}
function egressProxy(): string {
  return process.env.NOTEBOOK_EGRESS_PROXY || "http://notebook-egress:3128";
}

/** Internal hosts that must bypass the egress proxy (callbacks to the app). */
function noProxyList(appUrl: string): string {
  let host = "app";
  try {
    host = new URL(appUrl).hostname;
  } catch {
    /* keep default */
  }
  return [host, "localhost", "127.0.0.1", ".svc", ".cluster.local"].join(",");
}

function buildKernelEnv(opts: {
  sessionId: string;
  token: string;
  kind: KernelKind;
  entrypoint?: string | null;
  inputs?: unknown;
}): Record<string, string> {
  const appUrl = internalAppUrl();
  const env: Record<string, string> = {
    NB_MODE: opts.kind,
    NB_SESSION_ID: opts.sessionId,
    // The in-container `agentswarms` helper calls back here for model/KB access.
    AGENTSWARMS_ORIGIN: appUrl,
    AGENTSWARMS_TOKEN: opts.token,
    KG_IP: "0.0.0.0",
    KG_PORT: "8888",
  };
  const proxy = egressProxy();
  if (proxy) {
    const noProxy = noProxyList(appUrl);
    Object.assign(env, {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    });
  }
  if (opts.kind === "batch") {
    env.NB_ENTRYPOINT = opts.entrypoint || "";
    env.NB_INPUTS = JSON.stringify(opts.inputs ?? {});
    env.NB_RESULT_CALLBACK = `${appUrl}/api/notebook/runtime/result`;
  }
  return env;
}

export async function getSession(userId: string, sessionId: string): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/** Create a session row + launch the kernel. Caller must have checked
 * enablement, permission, and concurrency caps. */
export async function startSession(opts: {
  userId: string;
  notebookId?: string | null;
  kind: KernelKind;
  entrypoint?: string | null;
  inputs?: unknown;
}): Promise<{ session: SessionRow; token: string; gatewayUrl: string }> {
  const settings = await getRuntimeSettings();
  const batch = opts.kind === "batch";
  const cpu = batch ? settings.batchCpuLimit : settings.cpuLimit;
  const mem = batch ? settings.batchMemLimitMb : settings.memLimitMb;
  const maxMin = batch ? settings.batchMaxMinutes : settings.sessionMaxMinutes;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + maxMin * 60_000).toISOString();

  // `notebook_id` is a uuid FK to a saved notebook. Interactive kernels driven
  // over the websocket (e.g. running a bundled sample, which has a slug id like
  // "langchain", not a DB row) pass no real notebook — coerce anything that
  // isn't a uuid to null so the insert can't fail with
  // "invalid input syntax for type uuid".
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const notebookId = opts.notebookId && UUID_RE.test(opts.notebookId) ? opts.notebookId : null;

  const { data: row, error } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .insert({
      user_id: opts.userId,
      notebook_id: notebookId,
      kind: opts.kind,
      status: batch ? "running" : "starting",
      backend: settings.backend,
      image: settings.image,
      cpu_limit: cpu,
      mem_limit_mb: mem,
      entrypoint: opts.entrypoint ?? null,
      inputs: (opts.inputs ??
        null) as Database["public"]["Tables"]["notebook_runtime_sessions"]["Insert"]["inputs"],
      started_at: nowIso,
      last_active_at: nowIso,
      expires_at: expiresAt,
    })
    .select("*")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Failed to create runtime session");

  const token = await signSessionToken({
    userId: opts.userId,
    sessionId: row.id,
    ttlSeconds: Math.min(maxMin * 60, 3600),
  });
  if (!token) {
    await supabaseAdmin
      .from("notebook_runtime_sessions")
      .update({ status: "error", error: "NOTEBOOK_RUNTIME_SECRET not configured" })
      .eq("id", row.id);
    throw new Error("NOTEBOOK_RUNTIME_SECRET is not configured on the server");
  }

  const env = buildKernelEnv({
    sessionId: row.id,
    token,
    kind: opts.kind,
    entrypoint: opts.entrypoint,
    inputs: opts.inputs,
  });
  const orch = await getOrchestrator(settings);
  try {
    const { ref } = await orch.create({
      sessionId: row.id,
      userId: opts.userId,
      kind: opts.kind,
      image: settings.image,
      cpuLimit: cpu,
      memLimitMb: mem,
      timeoutSeconds: maxMin * 60,
      env,
    });
    await supabaseAdmin
      .from("notebook_runtime_sessions")
      .update({ container_ref: ref })
      .eq("id", row.id);
    return { session: { ...row, container_ref: ref }, token, gatewayUrl: gatewayUrl() };
  } catch (e) {
    await supabaseAdmin
      .from("notebook_runtime_sessions")
      .update({ status: "error", error: e instanceof Error ? e.message : String(e) })
      .eq("id", row.id);
    throw e;
  }
}

/** Poll the orchestrator and reconcile the DB row. Returns the updated row. */
export async function refreshSession(row: SessionRow): Promise<SessionRow> {
  const terminal = ["stopped", "error", "succeeded"];
  if (terminal.includes(row.status) || !row.container_ref) return row;

  const settings = await getRuntimeSettings();
  const orch = await getOrchestrator(settings);
  const st = await orch.status(row.container_ref);

  const patch: Database["public"]["Tables"]["notebook_runtime_sessions"]["Update"] = {
    last_active_at: new Date().toISOString(),
  };
  if (st.state === "running") {
    patch.status = row.kind === "batch" ? "running" : "ready";
    if (st.endpoint) patch.endpoint = st.endpoint;
    if (!row.started_at) patch.started_at = new Date().toISOString();
  } else if (st.state === "starting") {
    patch.status = "starting";
  } else if (st.state === "succeeded") {
    patch.status = "succeeded";
    patch.stopped_at = new Date().toISOString();
    patch.logs = await orch.logs(row.container_ref).catch(() => "");
  } else if (st.state === "gone") {
    patch.status = row.status === "ready" || row.status === "running" ? "stopped" : "error";
    patch.stopped_at = new Date().toISOString();
  } else {
    patch.status = "error";
    patch.error = st.message ?? "kernel error";
    patch.stopped_at = new Date().toISOString();
  }
  await supabaseAdmin.from("notebook_runtime_sessions").update(patch).eq("id", row.id);
  return { ...row, ...patch } as SessionRow;
}

export async function stopSession(row: SessionRow): Promise<void> {
  if (row.container_ref) {
    const settings = await getRuntimeSettings();
    const orch = await getOrchestrator(settings);
    await orch.stop(row.container_ref).catch(() => {});
  }
  await supabaseAdmin
    .from("notebook_runtime_sessions")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("id", row.id);
}

/**
 * Refresh every live session for a user so vanished kernels are marked stopped.
 *
 * Without this, a container that crashed or was removed out-of-band keeps its
 * row in a live state forever and permanently consumes one of the user's
 * concurrency slots ("You already have the maximum of N live runtime sessions"),
 * with no way out. Called before the cap is enforced and before listing.
 */
export async function reconcileUserSessions(userId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .eq("user_id", userId)
    .in("status", [...LIVE]);
  for (const row of data ?? []) {
    await refreshSession(row).catch(() => {});
  }
}

/** A user's live sessions, annotated with the notebook they belong to. */
export async function listUserSessions(userId: string) {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id, kind, status, notebook_id, image, started_at, created_at, expires_at")
    .eq("user_id", userId)
    .in("status", [...LIVE])
    .order("created_at", { ascending: false });
  const rows = data ?? [];
  const ids = rows.map((r) => r.notebook_id).filter((v): v is string => !!v);
  const titles = new Map<string, string>();
  if (ids.length) {
    const { data: nbs } = await supabaseAdmin
      .from("user_python_notebooks")
      .select("id, title")
      .in("id", ids);
    for (const nb of nbs ?? []) titles.set(nb.id, nb.title);
  }
  return rows.map((r) => ({
    ...r,
    notebook_title: r.notebook_id ? (titles.get(r.notebook_id) ?? "(deleted notebook)") : null,
  }));
}

export async function touchSession(sessionId: string): Promise<void> {
  await supabaseAdmin
    .from("notebook_runtime_sessions")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/** Reap idle interactive kernels and anything past its hard expiry. */
export async function reapSessions(): Promise<number> {
  const settings = await getRuntimeSettings();
  const nowIso = new Date().toISOString();
  const idleCutoff = new Date(Date.now() - settings.idleTtlMinutes * 60_000).toISOString();

  const [{ data: idle }, { data: expired }] = await Promise.all([
    supabaseAdmin
      .from("notebook_runtime_sessions")
      .select("*")
      .eq("kind", "interactive")
      .in("status", [...LIVE])
      .lt("last_active_at", idleCutoff),
    supabaseAdmin
      .from("notebook_runtime_sessions")
      .select("*")
      .in("status", [...LIVE])
      .lt("expires_at", nowIso),
  ]);

  const byId = new Map<string, SessionRow>();
  for (const r of [...(idle ?? []), ...(expired ?? [])]) byId.set(r.id, r);
  let reaped = 0;
  for (const row of byId.values()) {
    await stopSession(row).catch(() => {});
    reaped++;
  }
  return reaped;
}
