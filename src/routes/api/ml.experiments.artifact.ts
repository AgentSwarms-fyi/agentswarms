// A run saves its model through the platform.
//
//   POST /api/ml/experiments/artifact?run_id=…&name=model.joblib&sha256=…
//   Authorization: Bearer <session token | user JWT>
//   Content-Type: application/octet-stream
//   <the artifact's bytes>
//
// The kernel holds no bucket credentials — user code runs there — so the
// bytes come here and the app writes them beside the trainer's own artifacts.
// The digest recorded is the one the app computes from what actually
// arrived; a `sha256` the client sends is checked against it and a mismatch
// is refused, because a digest nobody verified protects nothing.
//
// The metadata goes in the query string on purpose: a body that is one
// artifact, streamed, is simpler on both ends than a multipart envelope.
import { createFileRoute } from "@tanstack/react-router";

import { artifactFileName } from "@/lib/experiments";
import { putExperimentArtifact } from "@/utils/ml/experimentArtifacts.server";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export const Route = createFileRoute("/api/ml/experiments/artifact")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json({ error: "Not signed in" }, 401);

        const url = new URL(request.url);
        const runId = url.searchParams.get("run_id") ?? "";
        if (!UUID.test(runId)) return json({ error: "run_id must be a run's uuid" }, 400);
        const claimed = url.searchParams.get("sha256");
        if (claimed && !SHA256.test(claimed)) {
          return json({ error: "sha256 must be 64 hex characters" }, 400);
        }
        const body = Buffer.from(await request.arrayBuffer());

        const done = await putExperimentArtifact({
          userId: caller.userId,
          runId,
          name: artifactFileName(url.searchParams.get("name")),
          body,
          claimedSha256: claimed,
        });
        if (!done.ok) return json({ error: done.error }, done.status);
        return json({
          artifact_uri: done.artifact_uri,
          artifact_sha256: done.artifact_sha256,
          bytes: done.bytes,
        });
      },
    },
  },
});
