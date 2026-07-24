// Server functions for deploying swarms: create an API key (raw key returned
// once, only its SHA-256 hash is stored). Listing and revoking are done from
// the client under RLS. Schedules are managed with plain RLS queries too.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";

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

export const createSwarmApiKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        swarm_id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        reject_approvals: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: false; error: string } | { ok: true; id: string; raw_key: string }> => {
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

      const raw = generateRawKey();
      const key_hash = await sha256Hex(raw);
      const key_prefix = raw.slice(0, 16) + "…";

      const { data: row, error } = await supabaseAdmin
        .from("swarm_api_keys")
        .insert({
          user_id: userId,
          swarm_id: data.swarm_id,
          name: data.name,
          key_hash,
          key_prefix,
          // Fail closed: a headless run has no human to decide an approval, so
          // unless the caller explicitly opts into auto-approval we stop at the
          // gate rather than silently bypassing the operator's oversight.
          reject_approvals: data.reject_approvals ?? true,
        })
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Could not create key" };
      auditEvent({
        userId,
        action: "swarm.api_key.create",
        resourceType: "swarm",
        resourceId: data.swarm_id,
        resourceName: data.name,
        detail: { reject_approvals: data.reject_approvals ?? true },
      });
      return { ok: true, id: row.id, raw_key: raw };
    },
  );
