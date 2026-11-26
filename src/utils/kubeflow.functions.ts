// What the workflow editor's Kubeflow step picks from (R540): the caller's
// own Kubeflow connections, a connection's pipelines, and a pipeline's
// versions with the parameters each declares. Read live from the server, so
// the editor offers what is there now.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import type { KubeflowPipeline, KubeflowVersion } from "@/utils/ml/kubeflowClient.server";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

type Fail = { ok: false; error: string };

export const kubeflowConnectionsList = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; connections: { id: string; name: string; active: boolean }[] } | Fail
    > => {
      const userId = await resolveCaller(data.access_token);
      const { data: rows, error } = await supabaseAdmin
        .from("integrations")
        .select("id, name, is_active")
        .eq("user_id", userId)
        .eq("type", "kubeflow")
        .order("name");
      if (error) return { ok: false, error: error.message };
      return {
        ok: true,
        connections: (rows ?? []).map((r) => ({ id: r.id, name: r.name, active: r.is_active })),
      };
    },
  );

export const kubeflowPipelinesList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), integration_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; pipelines: KubeflowPipeline[] } | Fail> => {
    const userId = await resolveCaller(data.access_token);
    const { kubeflowConnectionOf } = await import("@/utils/ml/kubeflow.server");
    const c = await kubeflowConnectionOf(userId, data.integration_id);
    if (!c.ok) return c;
    const { kubeflowPipelines } = await import("@/utils/ml/kubeflowClient.server");
    try {
      return { ok: true, pipelines: await kubeflowPipelines(c.conn) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const kubeflowVersionsList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        integration_id: z.string().uuid(),
        pipeline_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; versions: KubeflowVersion[] } | Fail> => {
    const userId = await resolveCaller(data.access_token);
    const { kubeflowConnectionOf } = await import("@/utils/ml/kubeflow.server");
    const c = await kubeflowConnectionOf(userId, data.integration_id);
    if (!c.ok) return c;
    const { kubeflowVersions } = await import("@/utils/ml/kubeflowClient.server");
    try {
      return { ok: true, versions: await kubeflowVersions(c.conn, data.pipeline_id) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
