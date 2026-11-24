// A KServe predictor pod asks for its model (R532).
//
//   GET /api/ml/serving/bundle
//   X-Endpoint: <namespace>/<inferenceservice name>
//   X-Port-Token: <that endpoint's port token>
//
// The answer is the scoring program and its config for the version the live
// copy naming that endpoint holds: the same bundle a scoring sandbox gets,
// without the prelude that would call back for a session's environment. No
// header names a model, so a pod can only ever get its own. The artifact is
// /api/ml/serving/artifact, under the same check.
import { createFileRoute } from "@tanstack/react-router";

import { servingCaller } from "@/utils/ml/kserve.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const Route = createFileRoute("/api/ml/serving/bundle")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const caller = await servingCaller(request);
        if (!caller.ok) return json({ error: caller.error }, caller.status);
        const { mlScoreBundleFor } = await import("@/utils/ml/serve.server");
        const bundle = await mlScoreBundleFor(
          { model_id: caller.modelId, version_id: caller.versionId },
          caller.userId,
          { standalone: true },
        );
        if ("error" in bundle) return json({ error: bundle.error }, 404);
        return json({ code: bundle.code, config: bundle.config, env: bundle.env });
      },
    },
  },
});
