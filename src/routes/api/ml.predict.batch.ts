// Public ML endpoint — score a lakehouse table into a new table.
//
//   POST /api/ml/predict/batch
//   Authorization: Bearer mlk_…   (scope: predict)
//
// The key names the model; the body names the input and output tables. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  authenticateMlApiKey,
  mlBody,
  mlJson,
  mlOptions,
  pickVersion,
  startBatchPrediction,
} from "@/utils/ml/api.server";

const IDENT = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const Body = z.object({
  version_id: z.string().uuid().optional(),
  input: z.object({ schema: IDENT, table: IDENT, where: z.string().max(2000).optional() }),
  output: z.object({ schema: IDENT, table: z.string().regex(/^[a-z_][a-z0-9_]{0,127}$/) }),
});

export const Route = createFileRoute("/api/ml/predict/batch")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "predict");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const parsed = Body.safeParse(await mlBody(request));
        if (!parsed.success) {
          return mlJson({ error: "Invalid body", issues: parsed.error.issues }, 400);
        }
        const version = await pickVersion(
          auth.model.id,
          parsed.data.version_id,
          auth.model.production_version_id,
        );
        if (!version) return mlJson({ error: "No trained version to predict with" }, 409);
        const started = await startBatchPrediction({
          userId: auth.key.user_id,
          model: auth.model,
          version,
          input: parsed.data.input,
          output: parsed.data.output,
          via: "api",
          apiKeyId: auth.key.id,
        });
        if (!started.ok) return mlJson({ error: started.error }, 409);
        return mlJson(
          {
            accepted: true,
            prediction_id: started.predictionId,
            output: `${parsed.data.output.schema}.${parsed.data.output.table}`,
            note: "Poll /api/ml/predict/status with this prediction_id.",
          },
          202,
        );
      },
    },
  },
});
