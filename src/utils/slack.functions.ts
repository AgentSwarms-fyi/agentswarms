// Server functions for the inbound Slack integration: list, save and remove
// the workspaces allowed to ask the AI Analyst a question.
//
// Mirrors saas.functions deliberately — one auth pattern for connection
// management, not two — with one difference that matters: the signing secret
// here authenticates an INBOUND caller rather than authorising an outbound
// call. It is written and never read back, and there is no code path that
// returns it to a client.

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";

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

/**
 * What the client may know about a workspace.
 *
 * Secret PRESENCE, never the secret. `hasSigningSecret` is what the UI needs
 * to say "set" without ever holding the value — the same contract the Git
 * export token uses.
 */
export type SlackWorkspaceSummary = {
  id: string;
  team_id: string;
  team_name: string | null;
  analyst_id: string | null;
  is_active: boolean;
  hasSigningSecret: boolean;
  hasBotToken: boolean;
  /** Null means Slack has never called — the only real proof it is wired up. */
  last_command_at: string | null;
  last_error: string | null;
  created_at: string;
};

/** Rows as stored. Cast at one point; see the note in listSlackWorkspaces. */
type SlackRow = {
  id: string;
  team_id: string;
  team_name: string | null;
  analyst_id: string | null;
  is_active: boolean;
  signing_secret_enc: { ciphertext?: string; iv?: string } | null;
  bot_token_enc: { ciphertext?: string; iv?: string } | null;
  last_command_at: string | null;
  last_error: string | null;
  created_at: string;
};

/**
 * The table ships in migration 20260833000000, and types.ts is generated from
 * the DEPLOYED schema — the same reason budgetSpendClient casts. Regenerating
 * types after applying it removes the need.
 */
type LooseClient = {
  from: (t: string) => {
    select: (c: string) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => Promise<{ data: SlackRow[] | null; error: { message: string } | null }>;
      eq: (
        col: string,
        v: string,
      ) => {
        maybeSingle: () => Promise<{ data: SlackRow | null }>;
      };
    };
    insert: (v: Record<string, unknown>) => {
      select: (c: string) => {
        single: () => Promise<{
          data: { id: string } | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
    update: (v: Record<string, unknown>) => {
      eq: (
        col: string,
        v: string,
      ) => {
        eq: (
          col: string,
          v: string,
        ) => {
          select: (c: string) => {
            maybeSingle: () => Promise<{
              data: { id: string } | null;
              error: { message: string; code?: string } | null;
            }>;
          };
        };
      };
    };
    delete: () => {
      eq: (
        col: string,
        v: string,
      ) => { eq: (col: string, v: string) => Promise<{ error: { message: string } | null }> };
    };
  };
};

/**
 * Parse, and surface the MESSAGE rather than the ZodError.
 *
 * `schema.parse()` throws an error whose `.message` is the serialised issue
 * array, and that is what reaches the toast: a JSON blob with `origin`,
 * `code`, `pattern` and the useful sentence buried inside it. Written a
 * careful message for the reader and then shown them a stack trace is worse
 * than not having written one.
 */
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new Error(first?.message ?? "That input is not valid.");
}

export const listSlackWorkspaces = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseInput(z.object({ access_token: z.string().min(1) }), input),
  )
  .handler(async ({ data }): Promise<SlackWorkspaceSummary[]> => {
    const { sb } = await requireUser(data.access_token);
    const { data: rows, error } = await (sb as unknown as LooseClient)
      .from("slack_workspaces")
      .select(
        "id, team_id, team_name, analyst_id, is_active, signing_secret_enc, bot_token_enc, last_command_at, last_error, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      id: r.id,
      team_id: r.team_id,
      team_name: r.team_name,
      analyst_id: r.analyst_id,
      is_active: r.is_active,
      // Presence only. The ciphertext never leaves the server either.
      hasSigningSecret: Boolean(r.signing_secret_enc?.ciphertext),
      hasBotToken: Boolean(r.bot_token_enc?.ciphertext),
      last_command_at: r.last_command_at,
      last_error: r.last_error,
      created_at: r.created_at,
    }));
  });

export const saveSlackWorkspace = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseInput(
      z.object({
        access_token: z.string().min(1),
        id: z.string().uuid().optional(),
        // Slack workspace ids look like T01ABC2DEF. Constrained so a pasted
        // channel id or a URL fails here rather than becoming a row that can
        // never match an inbound request.
        team_id: z
          .string()
          .trim()
          .regex(/^T[A-Z0-9]{6,}$/i, "A Slack workspace id looks like T01AB2CD3EF."),
        team_name: z.string().trim().max(200).optional(),
        analyst_id: z.string().uuid().nullable().optional(),
        /** Omitted on edit = keep what is stored. "" is not a way to clear it. */
        signing_secret: z.string().trim().min(8).optional(),
        bot_token: z.string().trim().min(8).optional(),
        is_active: z.boolean().optional(),
      }),
      input,
    ),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { sb, userId } = await requireUser(data.access_token);
    const client = sb as unknown as LooseClient;

    const row: Record<string, unknown> = {
      user_id: userId,
      team_id: data.team_id.toUpperCase(),
      team_name: data.team_name || null,
      analyst_id: data.analyst_id ?? null,
      is_active: data.is_active ?? true,
    };
    // Only overwrite a secret when a new one was actually typed. Writing
    // `null` for an omitted field would silently disarm the endpoint on every
    // unrelated edit — change the analyst, lose the ability to authenticate.
    if (data.signing_secret) {
      row.signing_secret_enc = await encryptJson({ secret: data.signing_secret });
    }
    if (data.bot_token) {
      row.bot_token_enc = await encryptJson({ token: data.bot_token });
    }

    if (data.id) {
      const { data: saved, error } = await client
        .from("slack_workspaces")
        .update(row)
        .eq("id", data.id)
        // Scoped by owner as well as id: RLS already enforces it, and an
        // explicit filter costs nothing and survives a future service-role
        // caller.
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(friendlyError(error));
      if (!saved) throw new Error("That Slack workspace is not yours to edit.");
      auditEvent({
        userId,
        action: "slack_workspace.update",
        resourceType: "slack_workspace",
        resourceId: data.id,
        resourceName: data.team_id,
        detail: {
          analyst_id: data.analyst_id ?? null,
          rotated_secret: Boolean(data.signing_secret),
        },
      });
      return { id: saved.id };
    }

    // A new workspace with no signing secret could never authenticate a
    // request, so refusing here is kinder than a row that silently 401s
    // everything for ever.
    if (!data.signing_secret) {
      throw new Error(
        "A signing secret is required — copy it from your Slack app's Basic Information.",
      );
    }
    const { data: saved, error } = await client
      .from("slack_workspaces")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(friendlyError(error));
    if (!saved) throw new Error("Could not save the Slack workspace.");
    auditEvent({
      userId,
      action: "slack_workspace.create",
      resourceType: "slack_workspace",
      resourceId: saved.id,
      resourceName: data.team_id,
      detail: { analyst_id: data.analyst_id ?? null },
    });
    return { id: saved.id };
  });

export const deleteSlackWorkspace = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseInput(z.object({ access_token: z.string().min(1), id: z.string().uuid() }), input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { sb, userId } = await requireUser(data.access_token);
    const { error } = await (sb as unknown as LooseClient)
      .from("slack_workspaces")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "slack_workspace.delete",
      resourceType: "slack_workspace",
      resourceId: data.id,
    });
    return { ok: true };
  });

/**
 * Turn a Postgres error into something actionable.
 *
 * The unique constraint on `team_id` fires when a workspace is already
 * connected — possibly by a COLLEAGUE, since the constraint is global rather
 * than per-user. "duplicate key value violates unique constraint
 * slack_workspaces_team_id_key" tells the reader nothing about what to do.
 */
function friendlyError(error: { message: string; code?: string }): string {
  if (error.code === "23505" || /duplicate key|unique constraint/i.test(error.message)) {
    return (
      "That Slack workspace is already connected to AgentSwarms. " +
      "Only one installation per workspace is allowed, so that an inbound command has exactly one analyst to reach."
    );
  }
  return error.message;
}
