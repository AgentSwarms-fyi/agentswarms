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
};

export async function loadWarehouseConnection(
  sb: SupabaseClient<Database>,
  ref: { connectionId?: string; name?: string },
  /**
   * The user who must OWN this connection. Enforced as a query filter (see the
   * file header — critical when `sb` is the service-role client), and used to
   * resolve any {{secret:NAME}} references in the stored config.
   */
  ownerUserId?: string,
): Promise<LoadedConnection> {
  let query = sb
    .from("data_warehouse_connections")
    .select("id, name, provider, credentials, is_active");
  if (ref.connectionId) query = query.eq("id", ref.connectionId);
  else if (ref.name) query = query.eq("name", ref.name);
  else throw new Error("connection id or name is required");
  if (ownerUserId) query = query.eq("user_id", ownerUserId);

  const { data: row, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Warehouse connection not found");
  if (!row.is_active) throw new Error(`Warehouse connection "${row.name}" is disabled`);

  const enc = row.credentials as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`Warehouse connection "${row.name}" has no stored credentials`);
  }
  let config = await decryptJson<WarehouseConfig>(enc.ciphertext, enc.iv);
  if (ownerUserId) {
    config = (await resolveSecretRefsInObject(
      ownerUserId,
      config as unknown as Record<string, unknown>,
    )) as unknown as WarehouseConfig;
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as WarehouseProvider,
    config,
  };
}
