// Resolves the effective server-runtime configuration (the single settings row,
// with a few env overrides for deploy-time wiring) and the per-user capability
// check. Used by every /api/notebook/runtime/* route.
import os from "node:os";

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
  /** Writable tmpfs per sandbox (~/.local and ~/work), in MB. */
  sandboxTmpfsMb: number;
};

/**
 * Compute limits that are NOT about the notebook sandbox — the in-process
 * lakehouse engine and ETL throughput — resolved the same way: the settings
 * row wins, then the environment variable, then the built-in default.
 *
 * They live in the runtime settings row because that is the one place an
 * operator already goes to say how much of the host this deployment may use.
 */
export type PlatformResourceSettings = {
  lakehouseMemoryLimit: string;
  lakehouseThreads: number;
  etlMaxConcurrentRunsPerUser: number;
  etlPipelinesPerSweep: number;
};

/** A stored override only counts when it is a usable positive number. */
function positive(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
}

function envInt(name: string): number | undefined {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/**
 * The compute knobs, resolved. Deliberately NOT capped here: an operator who
 * has bought a 64-core machine is allowed to use it, and a ceiling written
 * into the code is a ceiling nobody can raise without a release. The admin UI
 * shows what the host actually has and warns when a value exceeds it, which
 * informs the decision instead of overriding it.
 */
export async function getPlatformResources(): Promise<PlatformResourceSettings> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select(
      "lakehouse_memory_limit, lakehouse_threads, etl_max_concurrent_runs_per_user, etl_pipelines_per_sweep",
    )
    .eq("id", true)
    .maybeSingle();

  return {
    lakehouseMemoryLimit:
      data?.lakehouse_memory_limit?.trim() || process.env.LAKEHOUSE_MEMORY_LIMIT?.trim() || "2GB",
    lakehouseThreads: positive(data?.lakehouse_threads) ?? envInt("LAKEHOUSE_THREADS") ?? 4,
    etlMaxConcurrentRunsPerUser:
      positive(data?.etl_max_concurrent_runs_per_user) ??
      envInt("ETL_MAX_CONCURRENT_RUNS_PER_USER") ??
      3,
    etlPipelinesPerSweep:
      positive(data?.etl_pipelines_per_sweep) ?? envInt("ETL_PIPELINES_PER_SWEEP") ?? 3,
  };
}

/**
 * What this host actually has, so the admin UI can size against reality rather
 * than against a number someone guessed. In a container these report the
 * cgroup's view where the runtime exposes it, and the host's otherwise — which
 * is why the UI presents them as guidance, not as a limit.
 */
export function hostResources(): { cpus: number; totalMemMb: number } {
  return {
    cpus: Math.max(1, os.cpus()?.length ?? 1),
    totalMemMb: Math.max(1, Math.round(os.totalmem() / (1024 * 1024))),
  };
}

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
    sandboxTmpfsMb: positive(data?.sandbox_tmpfs_mb) ?? 512,
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
