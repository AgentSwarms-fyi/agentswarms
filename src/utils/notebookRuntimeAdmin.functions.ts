// Server functions backing the Developer-runtime admin tab (/admin/iam →
// Runtime). Superadmin-gated; lets an operator enable the server runtime,
// tune limits and the egress allowlist, and manage who may use it — all from
// the UI instead of environment variables.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { EgressApplyResult } from "./notebookRuntime/egressApply.server";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperadmin } from "@/utils/iam.server";
import { ensureRuntimeSecret, runtimeSecretConfigured } from "@/utils/notebookRuntime/token.server";
import { appInContainer, dockerBase } from "@/utils/notebookRuntime/docker.server";

export type NbRuntimeError = { ok: false; error: string };

export type NbRuntimeSettings = {
  server_runtime_enabled: boolean;
  require_grant: boolean;
  backend: string;
  default_image: string;
  max_sessions_per_user: number;
  max_sessions_total: number;
  idle_ttl_minutes: number;
  session_max_minutes: number;
  cell_timeout_seconds: number;
  cpu_limit: string;
  mem_limit_mb: number;
  batch_cpu_limit: string;
  batch_mem_limit_mb: number;
  batch_max_minutes: number;
  egress_allowlist: string[];
  pip_allowed: boolean;
};

export type NbRuntimeGrant = {
  id: string;
  principal_type: string;
  principal_id: string;
  name: string;
};

export type NbRuntimeState = {
  ok: true;
  /** true when NOTEBOOK_RUNTIME_SECRET is set — required for the runtime to work */
  secretConfigured: boolean;
  settings: NbRuntimeSettings;
  grants: NbRuntimeGrant[];
  users: { id: string; email: string | null }[];
  groups: { id: string; name: string }[];
};

const DEFAULTS: NbRuntimeSettings = {
  server_runtime_enabled: false,
  require_grant: false,
  backend: "docker",
  default_image: "agentswarms/notebook-runtime:latest",
  max_sessions_per_user: 3,
  max_sessions_total: 50,
  idle_ttl_minutes: 30,
  session_max_minutes: 480,
  cell_timeout_seconds: 120,
  cpu_limit: "1",
  mem_limit_mb: 2048,
  batch_cpu_limit: "2",
  batch_mem_limit_mb: 4096,
  batch_max_minutes: 120,
  egress_allowlist: ["pypi.org", "files.pythonhosted.org", "openrouter.ai", "api.openai.com"],
  pip_allowed: true,
};

export const nbRuntimeGetState = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<NbRuntimeError | NbRuntimeState> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const [settingsRes, grantsRes, groupsRes, usersRes] = await Promise.all([
      supabaseAdmin.from("notebook_runtime_settings").select("*").eq("id", true).maybeSingle(),
      supabaseAdmin.from("notebook_runtime_grants").select("id, principal_type, principal_id"),
      supabaseAdmin.from("iam_groups").select("id, name"),
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    ]);

    const row = settingsRes.data;
    const settings: NbRuntimeSettings = row
      ? {
          server_runtime_enabled: row.server_runtime_enabled,
          require_grant: row.require_grant,
          backend: row.backend,
          default_image: row.default_image,
          max_sessions_per_user: row.max_sessions_per_user,
          max_sessions_total: row.max_sessions_total,
          idle_ttl_minutes: row.idle_ttl_minutes,
          session_max_minutes: row.session_max_minutes,
          cell_timeout_seconds: row.cell_timeout_seconds,
          cpu_limit: row.cpu_limit,
          mem_limit_mb: row.mem_limit_mb,
          batch_cpu_limit: row.batch_cpu_limit,
          batch_mem_limit_mb: row.batch_mem_limit_mb,
          batch_max_minutes: row.batch_max_minutes,
          egress_allowlist: row.egress_allowlist,
          pip_allowed: row.pip_allowed,
        }
      : DEFAULTS;

    const groups = (groupsRes.data ?? []).map((g) => ({ id: g.id, name: g.name }));
    const users = (usersRes.data?.users ?? []).map((u) => ({ id: u.id, email: u.email ?? null }));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));
    const grants: NbRuntimeGrant[] = (grantsRes.data ?? []).map((g) => ({
      id: g.id,
      principal_type: g.principal_type,
      principal_id: g.principal_id,
      name:
        g.principal_type === "group"
          ? (groupName.get(g.principal_id) ?? "(deleted group)")
          : (userEmail.get(g.principal_id) ?? "(unknown user)"),
    }));

    return {
      ok: true,
      secretConfigured: await runtimeSecretConfigured(),
      settings,
      grants,
      users,
      groups,
    };
  });

export const nbRuntimeUpdateSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        server_runtime_enabled: z.boolean().optional(),
        require_grant: z.boolean().optional(),
        backend: z.enum(["docker", "k8s", "e2b"]).optional(),
        default_image: z.string().min(1).max(300).optional(),
        max_sessions_per_user: z.number().int().min(1).max(50).optional(),
        max_sessions_total: z.number().int().min(1).max(1000).optional(),
        idle_ttl_minutes: z.number().int().min(1).max(1440).optional(),
        session_max_minutes: z.number().int().min(1).max(1440).optional(),
        cell_timeout_seconds: z.number().int().min(5).max(3600).optional(),
        cpu_limit: z.string().min(1).max(16).optional(),
        mem_limit_mb: z.number().int().min(256).max(65536).optional(),
        batch_cpu_limit: z.string().min(1).max(16).optional(),
        batch_mem_limit_mb: z.number().int().min(256).max(131072).optional(),
        batch_max_minutes: z.number().int().min(1).max(1440).optional(),
        egress_allowlist: z.array(z.string().min(1).max(255)).max(200).optional(),
        pip_allowed: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<NbRuntimeError | { ok: true; egress?: EgressApplyResult }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { access_token: _t, ...fields } = data;
    // Turning the runtime on mints a signing secret if none exists, so operators
    // never have to invent one by hand.
    if (fields.server_runtime_enabled === true) {
      try {
        await ensureRuntimeSecret();
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Could not create signing secret",
        };
      }
    }
    const patch = { ...fields, updated_at: new Date().toISOString() };
    const { error } = await supabaseAdmin
      .from("notebook_runtime_settings")
      .update(patch)
      .eq("id", true);
    if (error) return { ok: false, error: error.message };

    // The allow-list is only meaningful once it reaches the proxy. Report what
    // actually happened rather than implying success — this field used to be
    // stored and never applied, so silence here is exactly the old bug.
    let egress: EgressApplyResult | undefined;
    if (fields.egress_allowlist) {
      const { applyEgressAllowlist } = await import("./notebookRuntime/egressApply.server");
      egress = await applyEgressAllowlist(fields.egress_allowlist);
    }
    return { ok: true, egress };
  });

export type PreflightCheck = { name: string; status: "pass" | "fail" | "warn"; detail: string };

/**
 * Actually probe whether the selected backend can run kernels here. The backend
 * selector only chooses which API the orchestrator talks to — it never installs
 * Docker or Kubernetes — so this reports exactly what's missing instead of
 * letting a session fail later with an opaque error.
 */
export const nbRuntimePreflight = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        backend: z.enum(["docker", "k8s", "e2b"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<NbRuntimeError | { ok: true; checks: PreflightCheck[] }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const { data: row } = await supabaseAdmin
      .from("notebook_runtime_settings")
      .select("backend, default_image")
      .eq("id", true)
      .maybeSingle();
    const backend = data.backend ?? row?.backend ?? "docker";
    const image =
      process.env.NOTEBOOK_RUNTIME_IMAGE ||
      row?.default_image ||
      "agentswarms/notebook-runtime:latest";
    const checks: PreflightCheck[] = [];

    checks.push(
      (await runtimeSecretConfigured())
        ? { name: "Signing secret", status: "pass", detail: "configured" }
        : {
            name: "Signing secret",
            status: "warn",
            detail: "not generated yet — created automatically when you enable the runtime",
          },
    );

    const gw = process.env.NOTEBOOK_GATEWAY_URL;
    checks.push({
      name: "Gateway URL",
      status: "pass",
      detail: gw ? `${gw} (from env)` : "ws://localhost:8090 (default)",
    });

    if (backend === "docker") {
      {
        // Use the same candidate probing the orchestrator does, so preflight can
        // never disagree with what actually happens at launch time.
        let base = "";
        try {
          base = await dockerBase();
          checks.push({
            name: "Docker socket-proxy",
            status: "pass",
            detail: `reachable at ${base}`,
          });
        } catch (e) {
          checks.push({
            name: "Docker socket-proxy",
            status: "fail",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
        if (base) {
          try {
            const img = await fetch(`${base}/images/${encodeURIComponent(image)}/json`);
            checks.push({
              name: "Kernel image",
              status: img.ok ? "pass" : "fail",
              detail: img.ok
                ? `${image} present`
                : `${image} not found — build it: docker compose --profile notebooks up -d --build`,
            });
          } catch {
            checks.push({
              name: "Kernel image",
              status: "warn",
              detail: `could not check ${image}`,
            });
          }
          const net =
            process.env.NOTEBOOK_NETWORK ||
            (appInContainer() ? "agentswarms_nb-internal" : "bridge");
          try {
            const n = await fetch(`${base}/networks/${encodeURIComponent(net)}`);
            checks.push({
              name: "Kernel network",
              status: n.ok ? "pass" : "fail",
              detail: n.ok
                ? appInContainer()
                  ? `${net} (isolated — kernels have no direct internet)`
                  : `${net} (dev mode: app runs on the host, so kernels use the default bridge; egress control is proxy-only)`
                : `${net} not found`,
            });
          } catch {
            checks.push({
              name: "Kernel network",
              status: "warn",
              detail: `could not check ${net}`,
            });
          }
        }
      }
      checks.push({
        name: "Egress proxy",
        status: "pass",
        detail: process.env.NOTEBOOK_EGRESS_PROXY
          ? `${process.env.NOTEBOOK_EGRESS_PROXY} (from env)`
          : "http://notebook-egress:3128 (default)",
      });
    }

    if (backend === "k8s") {
      const { readFileSync } = await import("node:fs");
      let token = "";
      try {
        token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
      } catch {
        /* not in-cluster */
      }
      if (!token) {
        checks.push({
          name: "In-cluster credentials",
          status: "fail",
          detail:
            "No ServiceAccount token. The Kubernetes backend does NOT install or connect to a cluster by URL — it requires the AgentSwarms app itself to run as a pod inside your cluster, with the RBAC from deploy/k8s/notebooks/ applied.",
        });
      } else {
        checks.push({
          name: "In-cluster credentials",
          status: "pass",
          detail: "ServiceAccount token present",
        });
        const ns = process.env.NOTEBOOK_K8S_NAMESPACE || "agentswarms-notebooks";
        const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
        const port = process.env.KUBERNETES_SERVICE_PORT || "443";
        try {
          const res = await fetch(`https://${host}:${port}/api/v1/namespaces/${ns}/pods?limit=1`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          checks.push({
            name: "Kubernetes API",
            status: res.ok ? "pass" : "fail",
            detail: res.ok
              ? `can list pods in ${ns}`
              : `HTTP ${res.status} listing pods in ${ns} (check RBAC / NODE_EXTRA_CA_CERTS)`,
          });
        } catch (e) {
          checks.push({
            name: "Kubernetes API",
            status: "fail",
            detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }

    if (backend === "e2b") {
      checks.push({
        name: "E2B backend",
        status: "fail",
        detail:
          "Not implemented — this backend is a stub and will throw on use. Choose Docker or Kubernetes.",
      });
    }

    return { ok: true, checks };
  });

export const nbRuntimeAddGrant = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        principal_type: z.enum(["user", "group"]),
        principal_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<NbRuntimeError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin.from("notebook_runtime_grants").upsert(
      {
        principal_type: data.principal_type,
        principal_id: data.principal_id,
        created_by: guard.userId,
      },
      { onConflict: "principal_type,principal_id", ignoreDuplicates: true },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const nbRuntimeRemoveGrant = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<NbRuntimeError | { ok: true }> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    const { error } = await supabaseAdmin
      .from("notebook_runtime_grants")
      .delete()
      .eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
