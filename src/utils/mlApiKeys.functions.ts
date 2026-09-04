// Server functions for managing a model's API keys (mint, list, revoke).
//
// The plaintext key is returned exactly once, by create — it is stored hashed
// and cannot be recovered afterwards, only replaced. Every function is scoped
// to models the caller OWNS: a grantee can predict with a shared model in the
// app, but publishing it to the outside world stays with its owner.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadModelForUser } from "@/utils/ml/access.server";
import {
  ML_KEY_SCOPES,
  generateMlApiKey,
  hashMlApiKey,
  mlKeyPrefix,
  type MlKeyScope,
} from "@/utils/mlApiKeys";

export type MlApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: MlKeyScope[];
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
};

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

/** Resolve the caller and confirm they own this model. */
async function ownerOf(
  accessToken: string,
  modelId: string,
): Promise<{ ok: true; userId: string } | Fail> {
  try {
    const userId = await resolveCaller(accessToken);
    await loadModelForUser(modelId, userId, { write: true });
    return { ok: true, userId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const KEY_COLUMNS =
  "id, name, key_prefix, scopes, is_active, expires_at, revoked_at, last_used_at, use_count, created_at";

export const mlApiKeysList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), model_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; keys: MlApiKeyRow[] }> => {
    const owner = await ownerOf(data.access_token, data.model_id);
    if (!owner.ok) return owner;
    const { data: rows, error } = await supabaseAdmin
      .from("ml_api_keys")
      .select(KEY_COLUMNS)
      .eq("model_id", data.model_id)
      .eq("user_id", owner.userId)
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, keys: (rows ?? []) as MlApiKeyRow[] };
  });

export const mlApiKeyCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(ML_KEY_SCOPES)).min(1).max(ML_KEY_SCOPES.length),
        expires_at: z.string().datetime().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; key: string; id: string }> => {
    const owner = await ownerOf(data.access_token, data.model_id);
    if (!owner.ok) return owner;

    const plaintext = generateMlApiKey();
    const { data: row, error } = await supabaseAdmin
      .from("ml_api_keys")
      .insert({
        user_id: owner.userId,
        model_id: data.model_id,
        name: data.name,
        key_hash: await hashMlApiKey(plaintext),
        key_prefix: mlKeyPrefix(plaintext),
        scopes: [...new Set(data.scopes)],
        expires_at: data.expires_at ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };

    // The only time the plaintext leaves this function.
    return { ok: true, key: plaintext, id: row.id };
  });

export const mlApiKeyRevoke = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const owner = await ownerOf(data.access_token, data.model_id);
    if (!owner.ok) return owner;

    // Revoked rather than deleted: the row is the audit trail for whatever the
    // key already ran, and last_used_at is how you spot a leaked one.
    const { error } = await supabaseAdmin
      .from("ml_api_keys")
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("model_id", data.model_id)
      .eq("user_id", owner.userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
