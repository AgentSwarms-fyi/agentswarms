// Registering a Teams bot: the owner's half of the integration.
//
// The mirror of slack.functions, and the same two rules about credentials.
// A summary never carries the app password, not even its ciphertext — only
// whether one is stored. And an omitted password on edit KEEPS what is there:
// writing null for a field the form did not send would disarm the bot on every
// unrelated edit, so changing which agent answers would silently stop it
// answering at all.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { encryptJson } from "@/utils/providers/crypto.server";

async function requireUser(accessToken: string): Promise<{ userId: string }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return { userId: data.user.id };
}

export type TeamsBotSummary = {
  id: string;
  app_id: string;
  display_name: string | null;
  tenant_id: string | null;
  target_type: "agent" | "analyst" | null;
  target_id: string | null;
  is_active: boolean;
  /** Presence only — the ciphertext never leaves the server either. */
  hasAppPassword: boolean;
  last_activity_at: string | null;
  last_error: string | null;
  created_at: string;
};

export const listTeamsBots = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<TeamsBotSummary[]> => {
    const { userId } = await requireUser(data.access_token);
    const { data: rows, error } = await supabaseAdmin
      .from("teams_bots")
      .select(
        "id, app_id, display_name, tenant_id, target_type, target_id, is_active, app_password_enc, last_activity_at, last_error, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      id: r.id,
      app_id: r.app_id,
      display_name: r.display_name,
      tenant_id: r.tenant_id,
      target_type: (r.target_type as "agent" | "analyst" | null) ?? null,
      target_id: r.target_id,
      is_active: r.is_active,
      hasAppPassword: Boolean((r.app_password_enc as { ciphertext?: string } | null)?.ciphertext),
      last_activity_at: r.last_activity_at,
      last_error: r.last_error,
      created_at: r.created_at,
    }));
  });

export const saveTeamsBot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid().optional(),
        // A Microsoft App id is a GUID. Constrained here so a pasted tenant
        // name or a URL fails at the form rather than becoming a row no
        // inbound activity can ever match.
        app_id: z
          .string()
          .trim()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            "A Microsoft App id is a GUID, like 11111111-2222-3333-4444-555555555555.",
          ),
        display_name: z.string().trim().max(200).optional(),
        tenant_id: z
          .string()
          .trim()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            "A tenant id is a GUID; leave it empty for a multi-tenant bot.",
          )
          .nullable()
          .optional(),
        target_type: z.enum(["agent", "analyst"]).nullable().optional(),
        target_id: z.string().uuid().nullable().optional(),
        /** Omitted on edit = keep what is stored. "" is not a way to clear it. */
        app_password: z.string().trim().min(8).optional(),
        is_active: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { userId } = await requireUser(data.access_token);

    // Typed against the table rather than Record<string, unknown>: supabase-js
    // rejects an open index signature, and the narrow type is what catches a
    // renamed column here instead of at runtime.
    const row: Database["public"]["Tables"]["teams_bots"]["Insert"] = {
      user_id: userId,
      app_id: data.app_id.toLowerCase(),
      display_name: data.display_name || null,
      tenant_id: data.tenant_id || null,
      // Both halves or neither: a type with no id names nothing, and an id
      // with no type cannot be looked up in either table.
      target_type: data.target_id ? (data.target_type ?? null) : null,
      target_id: data.target_type ? (data.target_id ?? null) : null,
      is_active: data.is_active ?? true,
    };
    if (data.app_password) {
      row.app_password_enc = (await encryptJson({ password: data.app_password })) as Json;
    }

    const q = data.id
      ? supabaseAdmin
          .from("teams_bots")
          .update(row)
          .eq("id", data.id)
          .eq("user_id", userId)
          .select("id")
      : supabaseAdmin.from("teams_bots").insert(row).select("id");
    const { data: saved, error } = await q.single();
    if (error) throw new Error(error.message);

    auditEvent({
      userId,
      action: data.id ? "teams_bot.update" : "teams_bot.create",
      resourceType: "teams_bot",
      resourceId: saved.id,
      resourceName: data.display_name || data.app_id,
      detail: {
        app_id: data.app_id,
        single_tenant: Boolean(data.tenant_id),
        target: data.target_type && data.target_id ? `${data.target_type}:${data.target_id}` : null,
        password_changed: Boolean(data.app_password),
      },
    });
    return { id: saved.id };
  });

export const deleteTeamsBot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { userId } = await requireUser(data.access_token);
    const { error } = await supabaseAdmin
      .from("teams_bots")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
