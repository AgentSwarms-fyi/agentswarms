// Resolves the effective server-runtime configuration (the single settings row,
// with a few env overrides for deploy-time wiring) and the per-user capability
// check. Used by every /api/notebook/runtime/* route.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runtimeSecretConfigured } from "./token.server";

export type RuntimeBackend = "docker" | "k8s" | "e2b";

export type RuntimeSettings = {
  enabled: boolean;
  requireGrant: boolean;
  backend: RuntimeBackend;
  image: string;
  maxSessionsPerUser: number;
  maxSessionsTotal: number;
  idleTtlMinutes: number;
  sessionMaxMinutes: number;
  cellTimeoutSeconds: number;
  cpuLimit: string;
  memLimitMb: number;
  batchCpuLimit: string;
  batchMemLimitMb: number;
  batchMaxMinutes: number;
  egressAllowlist: string[];
  pipAllowed: boolean;
};

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Effective settings = the DB row, with optional env overrides for the pieces an
 * operator may want to pin per-environment. The runtime is only truly usable
 * when a signing secret is also configured (so tokens can be minted).
 */
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select("*")
    .eq("id", true)
    .maybeSingle();

  const envEnabled = envBool("NOTEBOOK_RUNTIME_ENABLED");
  const backend = (process.env.NOTEBOOK_RUNTIME_BACKEND ||
    data?.backend ||
    "docker") as RuntimeBackend;

  return {
    enabled:
      (envEnabled ?? data?.server_runtime_enabled ?? false) && (await runtimeSecretConfigured()),
    requireGrant: data?.require_grant ?? false,
    backend,
    image:
      process.env.NOTEBOOK_RUNTIME_IMAGE ||
      data?.default_image ||
      "agentswarms/notebook-runtime:latest",
    maxSessionsPerUser: data?.max_sessions_per_user ?? 3,
    maxSessionsTotal: data?.max_sessions_total ?? 50,
    idleTtlMinutes: data?.idle_ttl_minutes ?? 30,
    sessionMaxMinutes: data?.session_max_minutes ?? 480,
    cellTimeoutSeconds: data?.cell_timeout_seconds ?? 120,
    cpuLimit: data?.cpu_limit ?? "1",
    memLimitMb: data?.mem_limit_mb ?? 2048,
    batchCpuLimit: data?.batch_cpu_limit ?? "2",
    batchMemLimitMb: data?.batch_mem_limit_mb ?? 4096,
    batchMaxMinutes: data?.batch_max_minutes ?? 120,
    egressAllowlist: data?.egress_allowlist ?? [
      "pypi.org",
      "files.pythonhosted.org",
      "openrouter.ai",
      "api.openai.com",
    ],
    pipAllowed: data?.pip_allowed ?? true,
  };
}

/**
 * May this user start a server kernel? Enabled + (open, superadmin, or granted).
 * Uses the SECURITY DEFINER helper so grant/settings reads don't depend on the
 * caller's own RLS.
 */
export async function canUseRuntime(userId: string): Promise<boolean> {
  const settings = await getRuntimeSettings();
  if (!settings.enabled) return false;
  if (!settings.requireGrant) return true;
  const { data, error } = await (
    supabaseAdmin as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: boolean | null; error: unknown }>;
    }
  ).rpc("can_use_notebook_runtime", { uid: userId });
  if (error) return false;
  return data === true;
}

const LIVE_STATUSES = ["queued", "starting", "ready", "running", "stopping"];

/**
 * Count a user's live NOTEBOOK sessions (for the per-user concurrency cap).
 *
 * Published MCP servers are excluded on purpose: they are meant to sit there
 * for days, so counting them here would let one published server permanently
 * consume a notebook slot and lock the user out of the workspace.
 */
export async function countLiveSessions(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("kind", "service")
    .in("status", LIVE_STATUSES);
  return count ?? 0;
}

/** Count all live notebook sessions (for the instance-wide cap). */
export async function countLiveSessionsTotal(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id", { count: "exact", head: true })
    .neq("kind", "service")
    .in("status", LIVE_STATUSES);
  return count ?? 0;
}

/**
 * Caps for running MCP servers, which have their own budget.
 *
 * Env rather than columns on notebook_runtime_settings: these are a capacity
 * guard an operator sets once per deployment, not something worth another
 * settings migration and admin form.
 */
export function mcpServiceCaps(): { perUser: number; total: number } {
  const int = (name: string, fallback: number) => {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    perUser: int("MCP_MAX_SERVERS_PER_USER", 3),
    total: int("MCP_MAX_SERVERS_TOTAL", 20),
  };
}

/** Count a user's running MCP servers. */
export async function countLiveServices(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "service")
    .in("status", LIVE_STATUSES);
  return count ?? 0;
}

/** Count all running MCP servers on the instance. */
export async function countLiveServicesTotal(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("id", { count: "exact", head: true })
    .eq("kind", "service")
    .in("status", LIVE_STATUSES);
  return count ?? 0;
}
