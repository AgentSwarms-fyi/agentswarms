// A run becomes a model version, from wherever it ran.
//
//   POST /api/ml/experiments/register
//   Authorization: Bearer <session token | user JWT>
//   {"run_id": "…", "model": "churn", "task": "classification",
//    "source": {"schema": "analytics", "table": "customers"},
//    "target_column": "churned", "feature_schema": [...], "promote": false}
//
// `model` may be a uuid (an existing model) or a name — a name nothing owns
// yet creates the model, so a notebook can go from a trained pipeline to a
// registered version in one call. Registration itself is the registry's own
// external-version path: the digest is verified before inference loads the
// artifact, the same audit rows are written, and the version arrives as a
// candidate unless promotion was asked for.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EXTERNAL_TASKS } from "@/lib/experiments";
import { registerRunAsVersion } from "@/utils/ml/experimentArtifacts.server";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

const Body = z.object({
  run_id: z.string().uuid(),
  model: z.string().min(1).max(120),
  task: z.enum(EXTERNAL_TASKS).optional(),
  source: z.object({ schema: z.string().regex(NAME), table: z.string().regex(NAME) }).optional(),
  target_column: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
  algorithm: z.string().min(1).max(120).optional(),
  feature_schema: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        dtype: z.enum(["numeric", "categorical", "boolean", "datetime", "text"]),
        role: z.enum(["feature", "target", "dropped"]),
        categories: z.array(z.string()).max(200).optional(),
      }),
    )
    .max(1000)
    .optional(),
  classes: z.array(z.string()).max(1000).optional(),
  metrics: z.record(z.string().max(120), z.number().nullable()).optional(),
  promote: z.boolean().optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/ml/experiments/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json({ error: "Not signed in" }, 401);
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return json({ error: "Invalid body", issues: parsed.error.issues }, 400);
        }
        const b = parsed.data;
        const done = await registerRunAsVersion({
          userId: caller.userId,
          runId: b.run_id,
          // A uuid names a model; anything else is a name to find or create.
          model: UUID.test(b.model) ? { id: b.model } : { name: b.model },
          task: b.task,
          source: b.source,
          target_column: b.target_column,
          description: b.description,
          algorithm: b.algorithm,
          feature_schema: b.feature_schema,
          classes: b.classes,
          metrics: b.metrics,
          promote: b.promote,
          via: caller.scopeUserId ? "notebook" : "api",
        });
        if (!done.ok) return json({ error: done.error }, done.status);
        return json(
          {
            model_id: done.model_id,
            model_name: done.model_name,
            created_model: done.created_model,
            version_id: done.version_id,
            version: done.version,
          },
          201,
        );
      },
    },
  },
});
