// The instance default model, set by a superadmin under Admin → Developer
// runtime → AI services → Default model.
//
// Every surface that calls a model falls back to it when it has no model of
// its own, or when its own cannot run for the person (providers/
// defaultModel.server). It lives in the database, not in .env: the variables
// that used to carry it (OPENROUTER_DEFAULT_MODEL and the per-section ones)
// are no longer read, and the page says so while any of them is still set.
//
// Saved on its own, not with the rest of the runtime settings: on a database
// whose migration has not added the column yet, the rest of the page must
// still save.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { requireSuperadmin } from "@/utils/iam.server";
import {
  adminDefaultModelSpec,
  BUILTIN_DEFAULT_MODEL,
  forgetDefaultModel,
  instanceDefaultModel,
  modelUnavailable,
  parseModelSpec,
  specOf,
} from "@/utils/providers/defaultModel.server";

/** Variables that used to choose a model and are no longer read. */
export const RETIRED_MODEL_ENV = [
  "OPENROUTER_DEFAULT_MODEL",
  "SHEETS_ASSIST_MODEL",
  "AI_SQL_DEFAULT_MODEL",
  "DOCUMENT_VISION_MODEL",
] as const;

export const DEFAULT_MODEL_MIGRATION = "20261031000000_default_model.sql";

type Fail = { ok: false; error: string };

export type DefaultModelState = {
  ok: true;
  /** What the administrator set, or null (the built-in one is in force). */
  spec: string | null;
  /** The model in force now. */
  effective: { spec: string; source: "admin" | "built-in" };
  builtIn: string;
  /** Can the administrator themselves run it? null = yes, else why not. */
  unavailableToYou: string | null;
  /** Retired variables still set in this server's environment. */
  retiredEnv: string[];
  /** False until the migration adds the column; saving is refused until then. */
  installed: boolean;
};

async function columnInstalled(): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select("default_model")
    .limit(1);
  return !error;
}

export const adminDefaultModelGet = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<DefaultModelState | Fail> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;
    forgetDefaultModel();
    const [installed, spec, effective] = await Promise.all([
      columnInstalled(),
      adminDefaultModelSpec(),
      instanceDefaultModel(),
    ]);
    const why = await modelUnavailable(guard.userId, effective);
    return {
      ok: true,
      spec,
      effective: { spec: effective.spec, source: effective.source },
      builtIn: BUILTIN_DEFAULT_MODEL,
      unavailableToYou: why?.message ?? null,
      retiredEnv: RETIRED_MODEL_ENV.filter((n) => (process.env[n] ?? "").trim()),
      installed,
    };
  });

export const adminDefaultModelSet = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        /** "provider/model", or null to go back to the built-in default. */
        spec: z.string().trim().max(200).nullable(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; spec: string | null; unavailableToYou: string | null } | Fail> => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;
      let spec: string | null = null;
      if (data.spec) {
        const t = parseModelSpec(data.spec);
        if (!t) {
          return {
            ok: false,
            error: `"${data.spec}" is not provider/model — for example openrouter/google/gemini-2.5-flash or anthropic/claude-sonnet-4.`,
          };
        }
        spec = specOf(t);
      }
      if (!(await columnInstalled())) {
        return {
          ok: false,
          error: `The default model can't be saved until the migration ${DEFAULT_MODEL_MIGRATION} is applied (npx supabase db push --include-all).`,
        };
      }
      const before = await adminDefaultModelSpec();
      const { error } = await supabaseAdmin
        .from("notebook_runtime_settings")
        .update({ default_model: spec, updated_at: new Date().toISOString() })
        .eq("id", true);
      if (error) return { ok: false, error: error.message };
      forgetDefaultModel();
      auditEvent({
        userId: guard.userId,
        action: "admin.default_model.set",
        resourceType: "settings",
        resourceName: "default_model",
        detail: { from: before, to: spec },
      });
      const effective = await instanceDefaultModel();
      const why = await modelUnavailable(guard.userId, effective);
      return { ok: true, spec, unavailableToYou: why?.message ?? null };
    },
  );
