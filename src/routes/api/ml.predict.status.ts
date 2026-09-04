// Public ML endpoint — poll a prediction run.
//
//   POST /api/ml/predict/status
//   Authorization: Bearer mlk_…   (scope: read)
//
// The key names the model; the body names the run. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateMlApiKey,
  mlBody,
  mlJson,
  mlOptions,
  predictionSummary,
} from "@/utils/ml/api.server";
import { refreshPrediction } from "@/utils/ml/predict.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/ml/predict/status")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "read");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const body = await mlBody<{ prediction_id?: string }>(request);
        if (typeof body.prediction_id !== "string" || !UUID.test(body.prediction_id)) {
          return mlJson({ error: "prediction_id (uuid) is required" }, 400);
        }
        const row = await refreshPrediction(body.prediction_id);
        if (!row || row.model_id !== auth.model.id) {
          return mlJson({ error: "Prediction not found" }, 404);
        }
        return mlJson(predictionSummary(row));
      },
    },
  },
});
