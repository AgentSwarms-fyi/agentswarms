// Orchestration service for notebook runtime sessions: create, poll/reconcile,
// stop, and reap. Keeps the API routes thin and the lifecycle logic in one
// testable place. The DB row is the source of truth, so any app replica can
// reconcile any session (the orchestrators are stateless HTTP clients).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { getOrchestrator, type KernelKind } from "./orchestrator";
import { getRuntimeSettings } from "./config.server";
import { signSessionToken } from "./token.server";

export type SessionRow = Database["public"]["Tables"]["notebook_runtime_sessions"]["Row"];

const LIVE = ["queued", "starting", "ready", "running", "stopping"] as const;

function internalAppUrl(): string {
  return process.env.NOTEBOOK_APP_INTERNAL_URL || process.env.APP_URL || "http://app:3000";
}
export function gatewayUrl(): string {
  return process.env.NOTEBOOK_GATEWAY_URL || "";
}
function egressProxy(): string {
  return process.env.NOTEBOOK_EGRESS_PROXY || "";
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

  const { data: row, error } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .insert({
      user_id: opts.userId,
      notebook_id: opts.notebookId ?? null,
      kind: opts.kind,
      status: batch ? "running" : "starting",
      backend: settings.backend,
      image: settings.image,
      cpu_limit: cpu,
      mem_limit_mb: mem,
      entrypoint: opts.entrypoint ?? null,
      inputs: (opts.inputs ?? null) as Database["public"]["Tables"]["notebook_runtime_sessions"]["Insert"]["inputs"],
      started_at: nowIso,
      last_active_at: nowIso,
      expires_at: expiresAt,
    })
    .select("*")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Failed to create runtime session");

  const token = signSessionToken({
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
    await supabaseAdmin.from("notebook_runtime_sessions").update({ container_ref: ref }).eq("id", row.id);
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
