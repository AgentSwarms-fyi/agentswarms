// Load + decrypt a warehouse connection for a specific owner.
//
// Under a caller's JWT client, RLS already enforces ownership. But several
// callers legitimately use the SERVICE-ROLE client (scheduled dashboard
// refreshes, catalog crawls, shared semantic models), and there RLS is OFF —
// so a connection id coming from user-controlled content (a BI widget's
// source.connection_id, for instance) would otherwise load and DECRYPT another
// tenant's warehouse credentials, then run the caller's SQL against their
// warehouse.
//
// `ownerUserId` is therefore applied as a hard filter, not just as the scope
// for {{secret:NAME}} resolution. Every caller already passes the owning user,
// so this is enforced centrally and a future service-role caller can't forget
// it. Callers that pass no owner keep the RLS-only behaviour, which is correct
// for JWT clients but MUST NOT be used with the service role.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { decryptJson } from "@/utils/providers/crypto.server";
import { resolveSecretRefsInObject } from "@/utils/secrets.server";
import type { WarehouseConfig, WarehouseProvider } from "./types";

export type LoadedConnection = {
  id: string;
  name: string;
  provider: WarehouseProvider;
  config: WarehouseConfig;
  /** Whose credential this is. Queries run against THEIR warehouse. */
  ownerUserId: string;
  /** True when reached through an IAM grant rather than ownership. */
  shared: boolean;
};

/** Only a well-formed uuid is ever interpolated into a PostgREST filter. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load a connection `userId` may use — owned by them, or shared via IAM.
 *
 * THE ONE PLACE GRANTS ARE RESOLVED. Every caller should use this rather than
 * assembling its own id list: nine call sites each resolving their own grants
 * is nine chances to forget, and the failure mode of forgetting is not a
 * visible error but a connection that silently stops working for a grantee.
 *
 * Grants are resolved FRESH on every call, deliberately. Caching them would
 * mean a revoked grant kept working until the cache expired — and on the
 * scheduled paths, that could be indefinitely. Revocation has to take effect
 * on the next run, which is what re-resolving guarantees.
 *
 * Resolution uses the SERVICE ROLE even when the caller holds a user JWT. The
 * grant tables are metadata, not secrets, and reading them under RLS would
 * make the security outcome depend on the policies of a table the user can
 * see — the answer to "may I use this connection" must not be something the
 * asker can influence.
 */
export async function loadWarehouseConnectionForUser(
  sb: SupabaseClient<Database>,
  ref: { connectionId?: string; name?: string },
  userId: string,
): Promise<LoadedConnection> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
  const grantedIds = await resolveGrantedResourceIds(supabaseAdmin, userId, "warehouse_connection");
  // A shared connection's row is not readable under the grantee's RLS — by
  // design, since it holds the credential — so the row itself is fetched with
  // the service role once a grant has been established.
  const client = grantedIds.size > 0 ? supabaseAdmin : sb;
  return loadWarehouseConnection(client, ref, userId, { grantedIds });
}

export async function loadWarehouseConnection(
  sb: SupabaseClient<Database>,
  ref: { connectionId?: string; name?: string },
  /**
   * The user who must OWN this connection. Enforced as a query filter (see the
   * file header — critical when `sb` is the service-role client), and used to
   * resolve any {{secret:NAME}} references in the stored config.
   */
  ownerUserId?: string,
  opts?: {
    /**
     * Connection ids this caller may use through an IAM grant, resolved by the
     * CALLER with resolveGrantedResourceIds. Widening the filter is the entire
     * security decision in this function, so the grant is never looked up here
     * — a caller must have gone and got it deliberately.
     *
     * A grantee may USE the connection: the owner's credential is decrypted
     * server-side and the query runs against their warehouse. They never
     * receive the credential, and nothing here lets them edit or delete it.
     */
    grantedIds?: Iterable<string>;
  },
): Promise<LoadedConnection> {
  let query = sb
    .from("data_warehouse_connections")
    .select("id, name, provider, credentials, is_active, user_id");
  if (ref.connectionId) query = query.eq("id", ref.connectionId);
  else if (ref.name) query = query.eq("name", ref.name);
  else throw new Error("connection id or name is required");

  if (ownerUserId) {
    // Ids are re-validated even though they came from our own grant lookup:
    // this string becomes a PostgREST filter, and `id.in.(…)` with an
    // unvalidated value is an injection into the query, not just a bad match.
    const granted = [...(opts?.grantedIds ?? [])].filter((x) => UUID_RE.test(x));
    query = granted.length
      ? query.or(`user_id.eq.${ownerUserId},id.in.(${granted.join(",")})`)
      : query.eq("user_id", ownerUserId);
  }

  const { data: row, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Warehouse connection not found");
  if (!row.is_active) throw new Error(`Warehouse connection "${row.name}" is disabled`);

  const enc = row.credentials as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`Warehouse connection "${row.name}" has no stored credentials`);
  }
  let config = await decryptJson<WarehouseConfig>(enc.ciphertext, enc.iv);
  // Secret references resolve as the connection's OWNER, not the caller.
  // On a shared connection those two differ, and resolving as the caller
  // would look up {{secret:PROD_PW}} in the GRANTEE's vault — finding either
  // nothing, or worse, a different secret that happens to share the name.
  // A shared connection runs as its owner; this is part of what that means.
  const secretScope = row.user_id ?? ownerUserId;
  if (secretScope) {
    config = (await resolveSecretRefsInObject(
      secretScope,
      config as unknown as Record<string, unknown>,
    )) as unknown as WarehouseConfig;
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as WarehouseProvider,
    config,
    ownerUserId: row.user_id,
    /** True when the caller is using this through a grant rather than owning it. */
    shared: !!ownerUserId && row.user_id !== ownerUserId,
  };
}
