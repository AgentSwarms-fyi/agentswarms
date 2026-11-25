// An MLflow model brought in as the next version of a model (R533).
//
//   POST /api/ml/import/mlflow?model_id=…&file_name=…
//   Authorization: Bearer <user JWT | session token>
//   Content-Type: application/zip
//   <the zipped folder MLflow saved the model in>
//
// The model's owner only, as training is. The app reads the zip's listing and
// its MLmodel file and nothing else: the model file is staged in the lake and
// opened by the version's job in a sandbox, because loading a pickle runs
// whatever it holds. The answer names the version and its job; the job's
// progress is on the model's Jobs tab like a training run's.
import { createFileRoute } from "@tanstack/react-router";

import { importMaxBytes, importMlflowZip } from "@/utils/ml/mlflow.server";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/ml/import/mlflow")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json({ error: "Not signed in" }, 401);
        if ("checkFailed" in caller) return json({ error: caller.checkFailed }, 503);
        const url = new URL(request.url);
        const modelId = url.searchParams.get("model_id") ?? "";
        if (!UUID.test(modelId)) return json({ error: "model_id must be a model's id" }, 400);
        // Refused before it is read when the sender says how large it is.
        const declared = Number(request.headers.get("content-length") ?? NaN);
        const cap = importMaxBytes();
        if (Number.isFinite(declared) && declared > cap) {
          return json(
            {
              error: `The zip is above the ${Math.round(cap / 1048576)} MB import limit (ML_IMPORT_MAX_MB).`,
            },
            413,
          );
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const out = await importMlflowZip({
          userId: caller.userId,
          modelId,
          bytes,
          fileName: (url.searchParams.get("file_name") ?? "model.zip").slice(0, 200),
        });
        if (!out.ok) return json({ error: out.error }, out.status);
        return json({
          version_id: out.versionId,
          version: out.version,
          job_id: out.jobId,
        });
      },
    },
  },
});
