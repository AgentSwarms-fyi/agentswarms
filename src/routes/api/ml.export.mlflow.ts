// One model version as an MLflow model, zipped (R533).
//
//   POST /api/ml/export/mlflow
//   Authorization: Bearer <user JWT | session token>
//   {"model_id": "…", "version_id": "…"}
//
// The model's owner only: a person a model is shared with may score with it,
// and has never been able to take the model itself away. The zip holds the
// folder MLflow loads (MLmodel, the artifact, the loader and the scoring
// program, the environment), built by the app without running Python.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { exportMlflowZip } from "@/utils/ml/mlflow.server";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const Body = z.object({ model_id: z.string().uuid(), version_id: z.string().uuid() });

export const Route = createFileRoute("/api/ml/export/mlflow")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json({ error: "Not signed in" }, 401);
        if ("checkFailed" in caller) return json({ error: caller.checkFailed }, 503);
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "model_id and version_id must be ids" }, 400);
        const out = await exportMlflowZip({
          userId: caller.userId,
          modelId: parsed.data.model_id,
          versionId: parsed.data.version_id,
        });
        if (!out.ok) return json({ error: out.error }, out.status);
        return new Response(Buffer.from(out.bytes), {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${out.filename}"`,
            "Content-Length": String(out.bytes.length),
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
