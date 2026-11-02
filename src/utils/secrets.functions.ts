// Server functions for the Secrets Manager (/secrets).
// Values are AES-GCM encrypted before insert and never returned — the only
// way to "read" a secret is through server-side {{secret:NAME}} resolution.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";
import { callerFailure } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";
import { parseAllowedHosts, MAX_ALLOWED_HOSTS } from "@/lib/secretHosts";

export type SecretSummary = {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
  /**
   * Hosts a colleague the secret is shared with may send it to (R419). Empty:
   * nobody but the owner can use it. Empty too until migration 20261102000000.
   */
  allowed_hosts: string[];
};

const LIST_COLUMNS = "id, name, description, user_id, created_at, updated_at";

/** PostgREST's "no such column": the allowed-hosts migration has not been pushed. */
function missingAllowedHosts(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42703" || error.code === "PGRST204" || /allowed_hosts/.test(error.message ?? "")
  );
}

const MIGRATION_NEEDED =
  "Allowed hosts need database migration 20261102000000_secret_allowed_hosts. " +
  "Ask your operator to run `supabase db push`, then save again.";

const AllowedHostsSchema = z
  .array(z.string().max(300))
  .max(MAX_ALLOWED_HOSTS * 2)
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const parsed = parseAllowedHosts(v);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      return z.NEVER;
    }
    return parsed.hosts;
  });

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(
    url,
    key,
    withNulSafeFetch({
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Unauthorized"));
  return { sb, userId: data.user.id };
}

const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Start with a letter; letters, digits and _ only");

export const listSecrets = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; secrets: SecretSummary[]; me: string } | { ok: false; error: string }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        // RLS returns own secrets + IAM-granted ones. The value column is
        // deliberately not selected. A database without the allowed-hosts
        // migration still lists: every secret then shows no allowed host,
        // which is also how the resolver treats it.
        let res = await sb
          .from("user_secrets")
          .select(`${LIST_COLUMNS}, allowed_hosts`)
          .order("name", { ascending: true });
        if (missingAllowedHosts(res.error)) {
          res = (await sb
            .from("user_secrets")
            .select(LIST_COLUMNS)
            .order("name", { ascending: true })) as unknown as typeof res;
        }
        if (res.error) return { ok: false, error: res.error.message };
        const secrets: SecretSummary[] = (res.data ?? []).map((r) => {
          const hosts = (r as { allowed_hosts?: unknown }).allowed_hosts;
          return {
            ...(r as Omit<SecretSummary, "allowed_hosts">),
            allowed_hosts: Array.isArray(hosts) ? (hosts as string[]) : [],
          };
        });
        return { ok: true, secrets, me: userId };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const createSecret = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: NameSchema,
        description: z.string().max(300).optional(),
        value: z.string().min(1).max(20_000),
        allowed_hosts: AllowedHostsSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const encrypted = await encryptJson(data.value, { owner: userId });
      const { data: row, error } = await sb
        .from("user_secrets")
        .insert({
          user_id: userId,
          name: data.name,
          description: data.description?.trim() || null,
          value: encrypted,
          // Left out when empty, so a database without the migration can
          // still create a secret nobody else may use (which empty means).
          ...(data.allowed_hosts?.length ? { allowed_hosts: data.allowed_hosts } : {}),
        })
        .select("id")
        .single();
      if (error || !row) {
        const msg = missingAllowedHosts(error)
          ? MIGRATION_NEEDED
          : error?.message?.includes("duplicate")
            ? `You already have a secret named ${data.name}`
            : (error?.message ?? "Create failed");
        return { ok: false, error: msg };
      }
      auditEvent({
        userId,
        action: "secret.create",
        resourceType: "secret",
        resourceId: row.id,
        resourceName: data.name,
        detail: { allowed_hosts: data.allowed_hosts ?? [] },
      });
      return { ok: true, id: row.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Create failed" };
    }
  });

export const updateSecret = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        secret_id: z.string().uuid(),
        description: z.string().max(300).optional(),
        value: z.string().min(1).max(20_000).optional(),
        allowed_hosts: AllowedHostsSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const patch: {
        description?: string | null;
        value?: { ciphertext: string; iv: string };
        allowed_hosts?: string[];
      } = {};
      if (data.description !== undefined) patch.description = data.description.trim() || null;
      if (data.value !== undefined) patch.value = await encryptJson(data.value, { owner: userId });
      // Only the owner's UPDATE policy matches (below), so only the owner
      // decides where colleagues may send it.
      if (data.allowed_hosts !== undefined) patch.allowed_hosts = data.allowed_hosts;
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
      if (error) {
        return { ok: false, error: missingAllowedHosts(error) ? MIGRATION_NEEDED : error.message };
      }
      if (!updated || updated.length === 0) {
        return { ok: false, error: "Secret not found or you don't have permission to modify it" };
      }
      auditEvent({
        userId,
        action: "secret.update",
        resourceType: "secret",
        resourceId: data.secret_id,
        // Never the value: which fields changed, and the new host list in full.
        detail: {
          changed: Object.keys(patch),
          ...(patch.allowed_hosts !== undefined ? { allowed_hosts: patch.allowed_hosts } : {}),
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
    }
  });

export const deleteSecret = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
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
