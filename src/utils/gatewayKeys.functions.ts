// Server functions behind Integrations -> LLM Gateway -> API access: mint,
// list, edit and revoke gateway keys, and set a key's monthly budget.
//
// Every write goes through the service role with an explicit user_id pin,
// the same idiom as the ML API keys: the plaintext key exists only in the
// create response, the row holds a hash, and the audit trigger on the table
// records every change under the owner's name.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  GATEWAY_KEY_SCOPES,
  generateGatewayKey,
  gatewayKeyPrefix,
  hashGatewayKey,
  parseGatewayModel,
  type GatewayKeyScope,
} from "@/utils/gateway/keys";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/api.server";

export type GatewayKeyListRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: GatewayKeyScope[];
  agent_ids: string[];
  model_allow: string[];
  fallback_models: string[];
  rate_limit_per_min: number | null;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  /** Monthly cap in USD from budget_limits, or null when none is set. */
  monthly_cap_usd: number | null;
};

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

const KEY_COLUMNS =
  "id, name, key_prefix, scopes, agent_ids, model_allow, fallback_models, rate_limit_per_min, is_active, expires_at, revoked_at, last_used_at, use_count, created_at";

/** A chain entry must parse as provider/model; the UI shows what was rejected. */
function validChain(entries: string[]): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const t = parseGatewayModel(e, GATEWAY_PROVIDERS);
    if (t && t.kind === "model") ok.push(`${t.provider}/${t.model}`);
    else rejected.push(e);
  }
  return { ok, rejected };
}

async function capsFor(userId: string, keyIds: string[]): Promise<Map<string, number>> {
  const caps = new Map<string, number>();
  if (keyIds.length === 0) return caps;
  const { data } = await supabaseAdmin
    .from("budget_limits")
    .select("scope_id, monthly_cap_usd, is_active")
    .eq("scope_type", "gateway_key")
    .in("scope_id", keyIds);
  for (const b of data ?? []) {
    if (b.is_active && Number(b.monthly_cap_usd) > 0)
      caps.set(b.scope_id, Number(b.monthly_cap_usd));
  }
  void userId;
  return caps;
}

export const gatewayKeysList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | { ok: true; keys: GatewayKeyListRow[] }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: rows, error } = await supabaseAdmin
      .from("gateway_keys")
      .select(KEY_COLUMNS)
      .eq("user_id", caller.userId)
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    const list = (rows ?? []) as Omit<GatewayKeyListRow, "monthly_cap_usd">[];
    const caps = await capsFor(
      caller.userId,
      list.map((k) => k.id),
    );
    return {
      ok: true,
      keys: list.map((k) => ({ ...k, monthly_cap_usd: caps.get(k.id) ?? null })),
    };
  });

/** The owner's agents, for the create dialog's allow-list. */
export const gatewayAgentsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; agents: { id: string; name: string; model: string }[] }> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const { data: rows, error } = await supabaseAdmin
        .from("agents")
        .select("id, name, llm_provider, llm_model")
        .eq("user_id", caller.userId)
        .eq("is_active", true)
        .order("name");
      if (error) return { ok: false, error: error.message };
      return {
        ok: true,
        agents: (rows ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          model: `${a.llm_provider}/${a.llm_model}`,
        })),
      };
    },
  );

const createSchema = z.object({
  access_token: z.string().min(1),
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(GATEWAY_KEY_SCOPES)).min(1).max(GATEWAY_KEY_SCOPES.length),
  agent_ids: z.array(z.string().uuid()).max(200).optional(),
  model_allow: z.array(z.string().min(1).max(160)).max(50).optional(),
  fallback_models: z.array(z.string().min(1).max(160)).max(10).optional(),
  rate_limit_per_min: z.number().int().min(1).max(100000).nullable().optional(),
  monthly_cap_usd: z.number().min(0).max(1_000_000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

export const gatewayKeyCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; key: string; id: string; rejected_fallbacks: string[] }> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const chain = validChain(data.fallback_models ?? []);
      // Agents named on the key must be the owner's; anything else is dropped,
      // not stored, so a key can never point at another user's agent.
      let agentIds = [...new Set(data.agent_ids ?? [])];
      if (agentIds.length > 0) {
        const { data: own } = await supabaseAdmin
          .from("agents")
          .select("id")
          .eq("user_id", caller.userId)
          .in("id", agentIds);
        const ownSet = new Set((own ?? []).map((a) => a.id));
        agentIds = agentIds.filter((id) => ownSet.has(id));
      }
      const plaintext = generateGatewayKey();
      const { data: row, error } = await supabaseAdmin
        .from("gateway_keys")
        .insert({
          user_id: caller.userId,
          name: data.name,
          key_hash: await hashGatewayKey(plaintext),
          key_prefix: gatewayKeyPrefix(plaintext),
          scopes: [...new Set(data.scopes)],
          agent_ids: agentIds,
          model_allow: (data.model_allow ?? []).map((p) => p.trim()).filter(Boolean),
          fallback_models: chain.ok,
          rate_limit_per_min: data.rate_limit_per_min ?? null,
          expires_at: data.expires_at ?? null,
        })
        .select("id")
        .single();
      if (error) return { ok: false, error: error.message };
      if (data.monthly_cap_usd && data.monthly_cap_usd > 0) {
        const { error: bErr } = await supabaseAdmin.from("budget_limits").upsert(
          {
            scope_type: "gateway_key",
            scope_id: row.id,
            monthly_cap_usd: data.monthly_cap_usd,
            is_active: true,
          },
          { onConflict: "scope_type,scope_id" },
        );
        if (bErr)
          return { ok: false, error: `Key created, but its budget was not saved: ${bErr.message}` };
        auditEvent({
          userId: caller.userId,
          action: "gateway.key.budget",
          resourceType: "gateway_key",
          resourceId: row.id,
          resourceName: data.name,
          detail: { monthly_cap_usd: data.monthly_cap_usd },
        });
      }
      // The only time the plaintext leaves this function.
      return { ok: true, key: plaintext, id: row.id, rejected_fallbacks: chain.rejected };
    },
  );

export const gatewayKeyUpdate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        fallback_models: z.array(z.string().min(1).max(160)).max(10).optional(),
        model_allow: z.array(z.string().min(1).max(160)).max(50).optional(),
        rate_limit_per_min: z.number().int().min(1).max(100000).nullable().optional(),
        monthly_cap_usd: z.number().min(0).max(1_000_000).nullable().optional(),
        is_active: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; rejected_fallbacks: string[] }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const patch: {
      updated_at: string;
      name?: string;
      fallback_models?: string[];
      model_allow?: string[];
      rate_limit_per_min?: number | null;
      is_active?: boolean;
    } = { updated_at: new Date().toISOString() };
    let rejected: string[] = [];
    if (data.name !== undefined) patch.name = data.name;
    if (data.fallback_models !== undefined) {
      const chain = validChain(data.fallback_models);
      patch.fallback_models = chain.ok;
      rejected = chain.rejected;
    }
    if (data.model_allow !== undefined) {
      patch.model_allow = data.model_allow.map((p) => p.trim()).filter(Boolean);
    }
    if (data.rate_limit_per_min !== undefined) patch.rate_limit_per_min = data.rate_limit_per_min;
    if (data.is_active !== undefined) patch.is_active = data.is_active;
    const { data: row, error } = await supabaseAdmin
      .from("gateway_keys")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .select("id, name")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Key not found" };
    if (data.monthly_cap_usd !== undefined) {
      if (data.monthly_cap_usd && data.monthly_cap_usd > 0) {
        const { error: bErr } = await supabaseAdmin.from("budget_limits").upsert(
          {
            scope_type: "gateway_key",
            scope_id: row.id,
            monthly_cap_usd: data.monthly_cap_usd,
            is_active: true,
          },
          { onConflict: "scope_type,scope_id" },
        );
        if (bErr) return { ok: false, error: bErr.message };
      } else {
        await supabaseAdmin
          .from("budget_limits")
          .delete()
          .eq("scope_type", "gateway_key")
          .eq("scope_id", row.id);
      }
      auditEvent({
        userId: caller.userId,
        action: "gateway.key.budget",
        resourceType: "gateway_key",
        resourceId: row.id,
        resourceName: row.name,
        detail: { monthly_cap_usd: data.monthly_cap_usd },
      });
    }
    return { ok: true, rejected_fallbacks: rejected };
  });

export const gatewayKeyRevoke = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: row, error } = await supabaseAdmin
      .from("gateway_keys")
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Key not found" };
    return { ok: true };
  });
