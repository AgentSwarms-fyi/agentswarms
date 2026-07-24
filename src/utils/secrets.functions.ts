// Server functions for the Secrets Manager (/secrets).
// Values are AES-GCM encrypted before insert and never returned — the only
// way to "read" a secret is through server-side {{secret:NAME}} resolution.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";

export type SecretSummary = {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
};

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Start with a letter; letters, digits and _ only");

export const listSecrets = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; secrets: SecretSummary[]; me: string } | { ok: false; error: string }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        // RLS returns own secrets + IAM-granted ones. The value column is
        // deliberately not selected.
        const { data: rows, error } = await sb
          .from("user_secrets")
          .select("id, name, description, user_id, created_at, updated_at")
          .order("name", { ascending: true });
        if (error) return { ok: false, error: error.message };
        return { ok: true, secrets: (rows ?? []) as SecretSummary[], me: userId };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const createSecret = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: NameSchema,
        description: z.string().max(300).optional(),
        value: z.string().min(1).max(20_000),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const encrypted = await encryptJson(data.value);
      const { data: row, error } = await sb
        .from("user_secrets")
        .insert({
          user_id: userId,
          name: data.name,
          description: data.description?.trim() || null,
          value: encrypted,
        })
        .select("id")
        .single();
      if (error || !row) {
        const msg = error?.message?.includes("duplicate")
          ? `You already have a secret named ${data.name}`
          : (error?.message ?? "Create failed");
        return { ok: false, error: msg };
      }
      auditEvent({ userId, action: "secret.create", resourceType: "secret", resourceId: row.id });
      return { ok: true, id: row.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Create failed" };
    }
  });

export const updateSecret = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        secret_id: z.string().uuid(),
        description: z.string().max(300).optional(),
        value: z.string().min(1).max(20_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const patch: { description?: string | null; value?: { ciphertext: string; iv: string } } = {};
      if (data.description !== undefined) patch.description = data.description.trim() || null;
      if (data.value !== undefined) patch.value = await encryptJson(data.value);
      if (Object.keys(patch).length === 0) return { ok: true };
      // RLS: only the owner's UPDATE policy matches — grantees can't write.
      // .select() returns the RLS-filtered affected rows, so an empty result
      // means the row doesn't exist or the caller isn't its owner (rather than
      // silently reporting success on a no-op update).
      const { data: updated, error } = await sb
        .from("user_secrets")
        .update(patch)
        .eq("id", data.secret_id)
        .select("id");
      if (error) return { ok: false, error: error.message };
      if (!updated || updated.length === 0) {
        return { ok: false, error: "Secret not found or you don't have permission to modify it" };
      }
      auditEvent({
        userId,
        action: "secret.update",
        resourceType: "secret",
        resourceId: data.secret_id,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
    }
  });

export const deleteSecret = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), secret_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const { data: deleted, error } = await sb
        .from("user_secrets")
        .delete()
        .eq("id", data.secret_id)
        .select("id");
      if (error) return { ok: false, error: error.message };
      if (!deleted || deleted.length === 0) {
        return { ok: false, error: "Secret not found or you don't have permission to delete it" };
      }
      auditEvent({
        userId,
        action: "secret.delete",
        resourceType: "secret",
        resourceId: data.secret_id,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
    }
  });
