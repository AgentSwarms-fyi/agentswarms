// A KServe predictor pod fetches its model's artifact (R532).
//
//   GET /api/ml/serving/artifact
//   X-Endpoint: <namespace>/<inferenceservice name>
//   X-Port-Token: <that endpoint's port token>
//
// The bytes of the artifact of the version the live copy naming that endpoint
// holds, streamed from the lake by the app, so the pod needs no storage
// credential and no route to storage. The pod checks the bytes against the
// digest the registry recorded before it loads them.
import { createFileRoute } from "@tanstack/react-router";

import { servingArtifact, servingCaller } from "@/utils/ml/kserve.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const Route = createFileRoute("/api/ml/serving/artifact")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const caller = await servingCaller(request);
        if (!caller.ok) return json({ error: caller.error }, caller.status);
        const art = await servingArtifact({
          modelId: caller.modelId,
          versionId: caller.versionId,
        });
        if (!art.ok) return json({ error: art.error }, art.status);
        return new Response(art.body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
            ...(art.bytes ? { "Content-Length": art.bytes } : {}),
          },
        });
      },
    },
  },
});
