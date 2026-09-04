// Public ML endpoint — the model behind a key and its versions.
//
//   POST /api/ml/models
//   Authorization: Bearer mlk_…   (scope: read)
//
// The key names the model; the body names nothing. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateMlApiKey, mlJson, mlOptions, modelSummary } from "@/utils/ml/api.server";

export const Route = createFileRoute("/api/ml/models")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "read");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const { data: versions } = await supabaseAdmin
          .from("ml_model_versions")
          .select("*")
          .eq("model_id", auth.model.id)
          .order("version", { ascending: false });
        // A key is minted for one model; the list shape leaves room for wider keys.
        return mlJson({ models: [modelSummary(auth.model, versions ?? [])] });
      },
    },
  },
});
