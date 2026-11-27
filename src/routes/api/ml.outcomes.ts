// Public ML endpoint — report what actually happened to an online prediction (R551).
//
//   POST /api/ml/outcomes
//   Authorization: Bearer mlk_…   (scope: predict)
//   { "prediction_id": "…", "outcomes": [{ "row": 0, "actual": "pro" }] }
//
// The key that asked for a prediction reports on it, for rows that request
// had; what the model answered is taken from the request's own record. The
// answers are measured hourly against the model's training score, the way a
// batch run is measured against its outcome table.
import { createFileRoute } from "@tanstack/react-router";
import { authenticateMlApiKey, mlBody, mlJson, mlOptions } from "@/utils/ml/api.server";
import { recordOutcomes } from "@/utils/ml/outcomes.server";

export const Route = createFileRoute("/api/ml/outcomes")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "predict");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const body = await mlBody<Record<string, unknown>>(request);
        const res = await recordOutcomes({ key: auth.key, model: auth.model, body });
        return mlJson(res.body, res.status);
      },
    },
  },
});
