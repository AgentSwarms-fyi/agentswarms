// Server functions for managing a notebook's API keys (mint, list, revoke).
//
// The plaintext key is returned exactly once, by create — it is stored hashed
// and cannot be recovered afterwards, only rotated. Every function is scoped to
// the caller's own notebooks.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createClient } from "@supabase/supabase-js";
import {
  generateNotebookApiKey,
  hashNotebookApiKey,
  notebookKeyPrefix,
} from "@/utils/notebookApiKeys";

export type NbApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  entrypoint: string;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
};

type Fail = { ok: false; error: string };

/** Resolve the caller and confirm they own this notebook. */
async function ownerOf(
  accessToken: string,
  notebookId: string,
): Promise<{ ok: true; userId: string } | Fail> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { ok: false, error: "Server is not configured" };
  const sb = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const { data } = await sb
    .from("user_python_notebooks")
    .select("id")
    .eq("id", notebookId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return { ok: false, error: "Notebook not found" };
  return { ok: true, userId: user.id };
}

export const nbApiKeysList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), notebook_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; keys: NbApiKeyRow[] }> => {
    const owner = await ownerOf(data.access_token, data.notebook_id);
    if (!owner.ok) return owner;

    const { data: rows, error } = await supabaseAdmin
      .from("notebook_api_keys")
      .select(
        "id, name, key_prefix, entrypoint, is_active, expires_at, revoked_at, last_used_at, use_count, created_at",
      )
      .eq("notebook_id", data.notebook_id)
      .eq("user_id", owner.userId)
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, keys: (rows ?? []) as NbApiKeyRow[] };
  });

export const nbApiKeyCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        notebook_id: z.string().uuid(),
        name: z.string().min(1).max(80),
        // Empty means "run the notebook top to bottom".
        entrypoint: z.string().max(120).optional(),
        expires_at: z.string().datetime().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; key: string; id: string }> => {
    const owner = await ownerOf(data.access_token, data.notebook_id);
    if (!owner.ok) return owner;

    const plaintext = generateNotebookApiKey();
    const { data: row, error } = await supabaseAdmin
      .from("notebook_api_keys")
      .insert({
        user_id: owner.userId,
        notebook_id: data.notebook_id,
        name: data.name,
        key_hash: await hashNotebookApiKey(plaintext),
        key_prefix: notebookKeyPrefix(plaintext),
        entrypoint: data.entrypoint ?? "entrypoint",
        expires_at: data.expires_at ?? null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };

    // The only time the plaintext leaves this function.
    return { ok: true, key: plaintext, id: row.id };
  });

export const nbApiKeyRevoke = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        notebook_id: z.string().uuid(),
        id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const owner = await ownerOf(data.access_token, data.notebook_id);
    if (!owner.ok) return owner;

    // Revoked rather than deleted: the row is the audit trail for whatever the
    // key already ran, and last_used_at is how you spot a leaked one.
    const { error } = await supabaseAdmin
      .from("notebook_api_keys")
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", owner.userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
