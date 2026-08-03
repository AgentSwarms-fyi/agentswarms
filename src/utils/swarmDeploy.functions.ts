// Server functions for deploying swarms: create an API key (raw key returned
// once, only its SHA-256 hash is stored). Listing and revoking are done from
// the client under RLS. Schedules are managed with plain RLS queries too.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { generateWebhookSecret } from "@/utils/swarmWebhook.server";

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateRawKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk_swarm_${hex}`;
}

async function userFromToken(accessToken: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user.id;
}

/** Scopes a swarm API key can carry. `run` is the only one that grants work. */
export const SWARM_KEY_SCOPES = ["run", "read_runs"] as const;
export type SwarmKeyScope = (typeof SWARM_KEY_SCOPES)[number];

export const createSwarmApiKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        swarm_id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        reject_approvals: z.boolean().optional(),
        /** Days until the key expires; omitted / null = never expires. */
        expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
        scopes: z.array(z.enum(SWARM_KEY_SCOPES)).min(1).optional(),
        /**
         * Rotation: the key this one replaces. Both stay valid so callers can
         * be migrated during an overlap window; the old one is revoked
         * explicitly afterwards (never auto-revoked here — that would break
         * every live caller the instant a new key is minted).
         */
        rotated_from: z.string().uuid().optional(),
        /** Default destination for async run results (may be overridden per run). */
        callback_url: z.string().url().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: false; error: string }
      | { ok: true; id: string; raw_key: string; webhook_secret: string | null }
    > => {
      const userId = await userFromToken(data.access_token);
      if (!userId) return { ok: false, error: "Invalid session" };

      // Ownership check — only the swarm owner can mint keys for it.
      const { data: swarm } = await supabaseAdmin
        .from("swarms")
        .select("id, user_id")
        .eq("id", data.swarm_id)
        .maybeSingle();
      if (!swarm || swarm.user_id !== userId) {
        return { ok: false, error: "Swarm not found or not yours" };
      }

      // A rotation source must be the caller's own key on the same swarm,
      // otherwise `rotated_from` could be used to point at someone else's row.
      if (data.rotated_from) {
        const { data: prev } = await supabaseAdmin
          .from("swarm_api_keys")
          .select("id, user_id, swarm_id")
          .eq("id", data.rotated_from)
          .maybeSingle();
        if (!prev || prev.user_id !== userId || prev.swarm_id !== data.swarm_id) {
          return { ok: false, error: "The key being rotated was not found" };
        }
      }

      const raw = generateRawKey();
      const key_hash = await sha256Hex(raw);
      const key_prefix = raw.slice(0, 16) + "…";
      const expires_at = data.expires_in_days
        ? new Date(Date.now() + data.expires_in_days * 86_400_000).toISOString()
        : null;
      // Resolved ONCE and used by both the insert and the audit entry. These
      // defaults were applied in each place independently, so changing one and
      // not the other would have the audit log report a policy the key was
      // never created with — an audit trail that quietly disagrees with the row
      // it describes is worse than none, because it is the thing you check when
      // you are trying to find out what happened.
      //
      // Fail closed on approvals: a headless run has no human to decide one, so
      // unless the caller explicitly opts in we stop at the gate rather than
      // silently bypassing the operator's oversight.
      const rejectApprovals = data.reject_approvals ?? true;
      const scopes = data.scopes ?? ["run"];

      const { data: row, error } = await supabaseAdmin
        .from("swarm_api_keys")
        .insert({
          user_id: userId,
          swarm_id: data.swarm_id,
          name: data.name,
          key_hash,
          key_prefix,
          reject_approvals: rejectApprovals,
          expires_at,
          scopes,
          rotated_from: data.rotated_from ?? null,
          // Every key gets a signing secret so async runs can post a verifiable
          // callback without a second setup step.
          webhook_secret: generateWebhookSecret(),
          callback_url: data.callback_url ?? null,
        })
        .select("id, webhook_secret")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Could not create key" };
      auditEvent({
        userId,
        action: data.rotated_from ? "swarm.api_key.rotate" : "swarm.api_key.create",
        resourceType: "swarm",
        resourceId: data.swarm_id,
        resourceName: data.name,
        detail: {
          reject_approvals: rejectApprovals,
          expires_at,
          scopes,
          ...(data.rotated_from ? { rotated_from: data.rotated_from } : {}),
        },
      });
      return { ok: true, id: row.id, raw_key: raw, webhook_secret: row.webhook_secret };
    },
  );
