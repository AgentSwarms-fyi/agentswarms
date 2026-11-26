// Resolving a person's own Kubeflow Pipelines connection (R540), for the
// workflow step that runs a pipeline and for the editor's pickers.
//
// Only the caller's own connection: a workflow runs as its owner, and a
// connection's token is the owner's credential, sent only to the address it
// was saved for (integrationHosts).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  kubeflowBase,
  kubeflowNamespace,
  type KubeflowConnection,
} from "@/utils/ml/kubeflowClient.server";

export async function kubeflowConnectionOf(
  userId: string,
  integrationId: string,
): Promise<
  | { ok: true; conn: KubeflowConnection; name: string }
  | { ok: false; error: string; transient?: true }
> {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) {
    return { ok: false, error: "Choose a Kubeflow connection." };
  }
  const { data: row, error } = await supabaseAdmin
    .from("integrations")
    .select("id, name, config, is_active")
    .eq("id", integrationId)
    .eq("user_id", userId)
    .eq("type", "kubeflow")
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      error: `Could not read the Kubeflow connection: ${error.message}`,
      transient: true,
    };
  }
  if (!row) {
    return {
      ok: false,
      error: "The Kubeflow connection this step uses was removed. Choose another in the step.",
    };
  }
  if (!row.is_active)
    return { ok: false, error: "The Kubeflow connection this step uses is turned off." };
  const { resolveIntegrationConfig } = await import("@/utils/providers/integrationConfig.server");
  const { integrationHosts } = await import("@/utils/providers/integrationHosts");
  const cfg = (await resolveIntegrationConfig(
    userId,
    "kubeflow",
    (row.config ?? {}) as Record<string, unknown>,
    { sendTo: integrationHosts("kubeflow") },
  )) as Record<string, unknown>;
  const s = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
  if (!kubeflowBase(s("api_url"))) {
    return { ok: false, error: "The Kubeflow connection has no usable address." };
  }
  return {
    ok: true,
    name: row.name,
    conn: {
      api_url: s("api_url"),
      auth: s("auth") || undefined,
      token: s("token"),
      namespace: kubeflowNamespace(s("namespace")) ?? undefined,
    },
  };
}
