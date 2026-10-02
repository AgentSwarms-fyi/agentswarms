// Public ML endpoint — train a new version.
//
//   POST /api/ml/train
//   Authorization: Bearer mlk_…   (scope: train)
//
// The key names the model; the body names the options of the run. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  authenticateMlApiKey,
  mlBody,
  mlJson,
  mlOptions,
  trainNewVersion,
  type MlTrainInput,
} from "@/utils/ml/api.server";
import { ML_TUNINGS } from "@/utils/ml/types";

const IDENT = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const Body = z.object({
  time_budget_minutes: z.number().int().min(1).optional(),
  max_rows: z.number().int().min(100).optional(),
  feature_columns: z.array(IDENT).max(500).optional(),
  tuning: z.enum(ML_TUNINGS).optional(),
  prep: z
    .object({
      where: z.string().max(2000).optional(),
      sql: z.string().max(20_000).optional(),
      impute: z
        .object({
          numeric: z.enum(["median", "mean", "constant"]).optional(),
          categorical: z.enum(["most_frequent", "constant"]).optional(),
        })
        .optional(),
      scale: z.boolean().optional(),
      encoding: z.enum(["onehot", "ordinal"]).optional(),
      class_weight: z.boolean().optional(),
      target_clip: z.number().min(0).max(0.2).optional(),
      drop_columns: z.array(IDENT).max(500).optional(),
    })
    .optional(),
});

export const Route = createFileRoute("/api/ml/train")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "train");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const parsed = Body.safeParse(await mlBody(request));
        if (!parsed.success) {
          return mlJson({ error: "Invalid body", issues: parsed.error.issues }, 400);
        }
        const started = await trainNewVersion(auth.model, parsed.data as MlTrainInput, {
          userId: auth.key.user_id,
          apiKeyId: auth.key.id,
        });
        if (!started.ok) return mlJson({ error: started.error }, 409);
        return mlJson(
          {
            accepted: true,
            job_id: started.jobId,
            version_id: started.versionId,
            note: "Poll /api/ml/train/status with this job_id.",
          },
          202,
        );
      },
    },
  },
});
