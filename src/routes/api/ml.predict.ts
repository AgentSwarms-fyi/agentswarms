// Public ML endpoint — score rows and wait for the answer.
//
//   POST /api/ml/predict
//   Authorization: Bearer mlk_…   (scope: predict)
//
// The key names the model; the body names the rows. Everything runs on the
// same service the app uses (src/utils/ml/api.server.ts), so the limits, the
// audit trail and the lakehouse guard are the same whoever calls.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ML_ROWS_PREDICT_CAP,
  authenticateMlApiKey,
  mlBody,
  mlJson,
  mlOptions,
  pickVersion,
} from "@/utils/ml/api.server";
import { predictRowsSync } from "@/utils/ml/predict.server";
import { forecastNotes } from "@/utils/tools/registry.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A request must answer before the proxies in front of it give up. */
const MAX_WAIT_MS = 110_000;

export const Route = createFileRoute("/api/ml/predict")({
  server: {
    handlers: {
      OPTIONS: async () => mlOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateMlApiKey(request, "predict");
        if (!auth.ok) return mlJson({ error: auth.error }, auth.status);
        const body = await mlBody<{
          rows?: unknown;
          keys?: unknown;
          version_id?: unknown;
          wait_seconds?: unknown;
        }>(request);

        // Two ways in. `rows` means the caller computed the features and owns
        // being right about them. `keys` means it did not: the platform reads
        // them from the model's feature view, which is the same table training
        // read, so there is nothing left for the caller to compute differently.
        const wantsKeys = body.keys !== undefined;
        let rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : null;
        let resolvedFrom: { view: string; missing: string[] } | null = null;

        if (wantsKeys) {
          if (rows) {
            return mlJson({ error: "Send rows or keys, not both" }, 400);
          }
          if (!auth.model.feature_view_id) {
            return mlJson(
              {
                error:
                  "This model has no feature view, so it cannot be scored by key. Send rows, or attach a feature view to the model.",
              },
              400,
            );
          }
          const { loadFeatureView, lookupFeatures } =
            await import("@/utils/featureViews/lookup.server");
          const view = await loadFeatureView(auth.model.feature_view_id, auth.model.user_id);
          if (!view) return mlJson({ error: "The model's feature view is missing" }, 409);
          const looked = await lookupFeatures({
            view,
            keys: body.keys as never,
            userId: auth.model.user_id,
            via: "ml-predict-api",
          });
          if (!looked.ok) return mlJson({ error: looked.error }, 400);
          rows = looked.resolution.rows;
          resolvedFrom = { view: view.name, missing: looked.resolution.missing };
        }

        if (
          !rows ||
          !rows.length ||
          !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))
        ) {
          return mlJson(
            { error: "rows must be a non-empty array of objects keyed by feature column" },
            400,
          );
        }
        if (rows.length > ML_ROWS_PREDICT_CAP) {
          return mlJson(
            {
              error: `At most ${ML_ROWS_PREDICT_CAP} rows per call; use /api/ml/predict/batch for a table`,
            },
            400,
          );
        }
        const versionId =
          typeof body.version_id === "string" && UUID.test(body.version_id)
            ? body.version_id
            : undefined;
        const version = await pickVersion(
          auth.model.id,
          versionId,
          auth.model.production_version_id,
        );
        if (!version) return mlJson({ error: "No trained version to predict with" }, 409);
        if (auth.model.task === "forecast") {
          // Served from the training forecast, like the agent tool: no sandbox.
          const stored = (version.forecast ?? null) as {
            points?: unknown[];
            meta?: Record<string, unknown> | null;
          } | null;
          return mlJson({
            version_id: version.id,
            version: version.version,
            task: "forecast",
            algorithm: version.algorithm,
            period: stored?.meta?.period ?? null,
            aggregation: stored?.meta?.aggregation ?? null,
            last_observed_period: stored?.meta?.last_period ?? null,
            forecast: stored?.points ?? [],
            notes: forecastNotes(version.algorithm, stored?.meta ?? null),
          });
        }
        const waitMs = Math.min(
          MAX_WAIT_MS,
          Math.max(1000, (typeof body.wait_seconds === "number" ? body.wait_seconds : 90) * 1000),
        );
        const result = await predictRowsSync({
          model: auth.model,
          version,
          userId: auth.key.user_id,
          rows: rows as Record<string, unknown>[],
          via: "api",
          waitMs,
        });
        if (result.predictionId) {
          void supabaseAdmin
            .from("ml_predictions")
            .update({ api_key_id: auth.key.id })
            .eq("id", result.predictionId)
            .then(() => {});
        }
        if (!result.ok) {
          if (result.pending && result.predictionId) {
            return mlJson(
              {
                accepted: true,
                prediction_id: result.predictionId,
                note: "Still scoring — poll /api/ml/predict/status with this prediction_id.",
              },
              202,
            );
          }
          return mlJson({ error: result.error, prediction_id: result.predictionId ?? null }, 409);
        }
        // `served` says whether a container was started for this call. A
        // caller measuring latency otherwise cannot tell a cold answer from a
        // slow model, and those want opposite fixes.
        return mlJson({
          prediction_id: result.predictionId,
          version_id: version.id,
          version: version.version,
          algorithm: result.algorithm,
          columns: result.columns,
          rows: result.rows,
          warnings: result.warnings,
          elapsed_seconds: result.elapsedSeconds,
          served: result.served,
          ...(resolvedFrom
            ? { feature_view: resolvedFrom.view, keys_not_found: resolvedFrom.missing }
            : {}),
        });
      },
    },
  },
});
