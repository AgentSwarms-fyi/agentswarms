// Server functions for tracking a model on an MLflow server (R534): choosing
// where it is tracked, and sending versions there on demand. Owner only: the
// versions go out with the owner's own MLflow connection, and a person the
// model is shared with may use the model but has never been able to send it
// anywhere.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { loadModelForUser, type MlModelRow } from "@/utils/ml/access.server";
import { callerFailure } from "@/utils/callerLookup.server";
import { auditEvent } from "@/utils/audit.server";
import { MLFLOW_TASKS } from "@/lib/mlflowTasks";
import {
  parseModelTracking,
  trackingProblem,
  type ModelTracking,
  type VersionTracking,
} from "@/lib/mlflowTracking";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

async function ownedModel(
  modelId: string,
  userId: string,
): Promise<{ ok: true; model: MlModelRow } | Fail> {
  let model: MlModelRow;
  try {
    ({ model } = await loadModelForUser(modelId, userId, { write: true }));
  } catch {
    return { ok: false, error: "Model not found" };
  }
  if (model.user_id !== userId) {
    return {
      ok: false,
      error:
        "Only the model's owner can send it to MLflow: it goes out with the owner's own MLflow connection.",
    };
  }
  if (!(MLFLOW_TASKS as readonly string[]).includes(model.task)) {
    return {
      ok: false,
      error: `A ${model.task} model answers from what it stored, so there is no model to track on MLflow.`,
    };
  }
  return { ok: true, model };
}

const TrackingInput = z.object({
  integration_id: z.string().uuid(),
  experiment: z.string().max(250),
  registered_model: z.string().max(200),
  alias: z.string().max(64),
  enabled: z.boolean().default(true),
});

/** Choose (or stop) where a model is tracked; optionally send its ready versions now. */
export const mlSetTracking = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1).max(10000),
        model_id: z.string().uuid(),
        tracking: TrackingInput.nullable(),
        send_existing: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tracking: ModelTracking | null } | Fail> => {
    const userId = await resolveCaller(data.access_token);
    const owned = await ownedModel(data.model_id, userId);
    if (!owned.ok) return owned;
    const { model } = owned;

    let next: ModelTracking | null = null;
    if (data.tracking) {
      next = {
        integration_id: data.tracking.integration_id,
        experiment: data.tracking.experiment.trim(),
        registered_model: data.tracking.registered_model.trim(),
        alias: data.tracking.alias.trim(),
        enabled: data.tracking.enabled,
      };
      const problem = trackingProblem(next);
      if (problem) return { ok: false, error: problem };
      // One of the caller's own MLflow connections, and nothing else: the id
      // came from the page, and the sync will send the model wherever it points.
      const { data: row, error } = await supabaseAdmin
        .from("integrations")
        .select("id")
        .eq("id", next.integration_id)
        .eq("user_id", userId)
        .eq("type", "mlflow")
        .maybeSingle();
      if (error)
        return { ok: false, error: `Could not read your MLflow connections: ${error.message}` };
      if (!row) return { ok: false, error: "That MLflow connection is not one of yours." };
    }

    const before = parseModelTracking(model.tracking);
    const { error: upErr } = await supabaseAdmin
      .from("ml_models")
      .update({ tracking: next as unknown as Json })
      .eq("id", model.id)
      .eq("user_id", userId);
    if (upErr) {
      return {
        ok: false,
        error: /tracking/.test(upErr.message)
          ? "Tracking on MLflow needs a database update first (migration 20261202000000, for example npx supabase db push --remote)."
          : `Could not save it: ${upErr.message}`,
      };
    }
    auditEvent({
      userId,
      action: next ? "ml.mlflow.linked" : "ml.mlflow.unlinked",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      detail: {
        integration_id: next?.integration_id ?? before?.integration_id ?? null,
        experiment: next?.experiment ?? null,
        registered_model: next?.registered_model ?? null,
        alias: next?.alias ?? null,
        enabled: next?.enabled ?? false,
        send_existing: Boolean(next && data.send_existing),
      },
    });

    if (next?.enabled) {
      const m = await import("@/utils/ml/mlflowTracking.server");
      if (data.send_existing) {
        void m
          .syncModelToMlflow(model.id, "linked")
          .catch((e) =>
            console.warn(`[ml-mlflow] send all for ${model.id}: ${(e as Error).message}`),
          );
      } else {
        // Production may already be registered under this name: point the alias.
        m.afterPromotion(model.id);
      }
    }
    return { ok: true, tracking: next };
  });

/** Send one version now (and wait for it), or every unsent version (in the background). */
export const mlSyncToMlflow = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1).max(10000),
        model_id: z.string().uuid(),
        version_id: z.string().uuid().optional(),
        /** Point the alias at production again (after a move that failed). */
        move_alias: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; tracking?: VersionTracking; started?: boolean }
      | { ok: false; error: string; tracking?: VersionTracking }
    > => {
      const userId = await resolveCaller(data.access_token);
      const owned = await ownedModel(data.model_id, userId);
      if (!owned.ok) return owned;
      const link = parseModelTracking(owned.model.tracking);
      if (!link?.enabled) return { ok: false, error: "This model is not tracked on MLflow." };
      const m = await import("@/utils/ml/mlflowTracking.server");
      if (data.move_alias) {
        const out = await m.moveMlflowAlias(owned.model.id);
        if (out.ok) return { ok: true };
        return { ok: false, error: "error" in out ? out.error : `Not moved: ${out.skipped}.` };
      }
      if (!data.version_id) {
        void m
          .syncModelToMlflow(owned.model.id, "manual")
          .catch((e) =>
            console.warn(`[ml-mlflow] send all for ${owned.model.id}: ${(e as Error).message}`),
          );
        return { ok: true, started: true };
      }
      const { data: v } = await supabaseAdmin
        .from("ml_model_versions")
        .select("id")
        .eq("id", data.version_id)
        .eq("model_id", owned.model.id)
        .maybeSingle();
      if (!v) return { ok: false, error: "Version not found" };
      const out = await m.syncVersionToMlflow(v.id, "manual");
      if (out.ok) return { ok: true, tracking: out.tracking };
      if ("skipped" in out) return { ok: false, error: `Not sent: ${out.skipped}.` };
      return { ok: false, error: out.error, tracking: out.tracking };
    },
  );

// ── Importing from an MLflow server (R535) ──────────────────────────────────

/** Registered models on one of your MLflow connections, or one model's versions. */
export const mlMlflowBrowse = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1).max(10000),
        integration_id: z.string().uuid(),
        /** Set to list this registered model's versions. */
        name: z.string().max(200).optional(),
        query: z.string().max(100).default(""),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          models?: import("@/utils/ml/mlflowRegistry.server").RegisteredModelSummary[];
          versions?: import("@/utils/ml/mlflowRegistry.server").ModelVersionSummary[];
        }
      | Fail
    > => {
      const userId = await resolveCaller(data.access_token);
      const reg = await import("@/utils/ml/mlflowRegistry.server");
      if (data.name) {
        const out = await reg.listModelVersions(userId, data.integration_id, data.name);
        return out.ok ? { ok: true, versions: out.versions } : { ok: false, error: out.error };
      }
      const out = await reg.searchRegisteredModels(userId, data.integration_id, data.query);
      return out.ok ? { ok: true, models: out.models } : { ok: false, error: out.error };
    },
  );

/** Import one registered version (by number or alias) as the model's next version. */
export const mlImportFromMlflow = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1).max(10000),
        model_id: z.string().uuid(),
        integration_id: z.string().uuid(),
        name: z.string().min(1).max(200),
        version: z
          .string()
          .regex(/^\d{1,9}$/)
          .optional(),
        alias: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; version: number; from: string } | Fail> => {
    const userId = await resolveCaller(data.access_token);
    const { importFromMlflowServer } = await import("@/utils/ml/mlflowRegistry.server");
    const out = await importFromMlflowServer({
      userId,
      modelId: data.model_id,
      integrationId: data.integration_id,
      name: data.name,
      version: data.version,
      alias: data.alias,
    });
    return out.ok
      ? { ok: true, version: out.version, from: out.from }
      : { ok: false, error: out.error };
  });
