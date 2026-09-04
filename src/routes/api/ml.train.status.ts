// Public ML endpoint — poll a training job.
//
//   POST /api/ml/train/status
//   Authorization: Bearer mlk_…   (scope: read)
//
// The key names the model; the body names the job. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateMlApiKey, jobSummary, mlBody, mlJson, mlOptions } from "@/utils/ml/api.server";
import { refreshMlJob } from "@/utils/ml/train.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/ml/train/status")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "read");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const body = await mlBody<{ job_id?: string }>(request);
        if (typeof body.job_id !== "string" || !UUID.test(body.job_id)) {
          return mlJson({ error: "job_id (uuid) is required" }, 400);
        }
        // A job of another model is "not found", never "forbidden": the key
        // learns nothing about what it cannot see.
        const job = await refreshMlJob(body.job_id);
        if (!job || job.model_id !== auth.model.id) return mlJson({ error: "Job not found" }, 404);
        const { data: version } = await supabaseAdmin
          .from("ml_model_versions")
          .select(
            "id, version, status, stage, algorithm, metrics, feature_schema, warnings, trained_at",
          )
          .eq("id", job.version_id)
          .maybeSingle();
        return mlJson({
          ...jobSummary(job),
          version: version
            ? {
                id: version.id,
                version: version.version,
                status: version.status,
                stage: version.stage,
                algorithm: version.algorithm,
                metrics: version.metrics,
                warnings: version.warnings,
                trained_at: version.trained_at,
              }
            : null,
          logs_tail: job.logs ? job.logs.slice(-2000) : null,
        });
      },
    },
  },
});
