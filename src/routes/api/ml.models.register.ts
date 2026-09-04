// Public ML endpoint — register a version trained elsewhere.
//
//   POST /api/ml/models/register
//   Authorization: Bearer mlk_…   (scope: train)
//
// The key names the model; the body names the artifact and what it is. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  authenticateMlApiKey,
  mlBody,
  mlJson,
  mlOptions,
  registerExternalVersion,
} from "@/utils/ml/api.server";

const Body = z.object({
  artifact_uri: z.string().min(6).max(1000),
  artifact_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  algorithm: z.string().min(1).max(120),
  metrics: z.record(z.string(), z.number().nullable()).optional(),
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
  promote: z.boolean().optional(),
});

export const Route = createFileRoute("/api/ml/models/register")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "train");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const parsed = Body.safeParse(await mlBody(request));
        if (!parsed.success) {
          return mlJson({ error: "Invalid body", issues: parsed.error.issues }, 400);
        }
        const done = await registerExternalVersion(auth.model, parsed.data, {
          userId: auth.key.user_id,
          apiKeyId: auth.key.id,
        });
        if (!done.ok) return mlJson({ error: done.error }, 409);
        return mlJson({ version_id: done.versionId, version: done.version }, 201);
      },
    },
  },
});
