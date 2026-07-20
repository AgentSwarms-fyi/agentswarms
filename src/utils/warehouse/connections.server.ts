// Load + decrypt a warehouse connection for the signed-in user.
// Rows are fetched under the caller's JWT client so RLS enforces ownership;
// the AES-GCM payload is decrypted with PROVIDER_CREDS_SECRET server-side.
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
  /** When set, {{secret:NAME}} references in the config are resolved for this user. */
  resolveSecretsFor?: string,
): Promise<LoadedConnection> {
  let query = sb
    .from("data_warehouse_connections")
    .select("id, name, provider, credentials, is_active");
  if (ref.connectionId) query = query.eq("id", ref.connectionId);
  else if (ref.name) query = query.eq("name", ref.name);
  else throw new Error("connection id or name is required");

  const { data: row, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Warehouse connection not found");
  if (!row.is_active) throw new Error(`Warehouse connection "${row.name}" is disabled`);

  const enc = row.credentials as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`Warehouse connection "${row.name}" has no stored credentials`);
  }
  let config = await decryptJson<WarehouseConfig>(enc.ciphertext, enc.iv);
  if (resolveSecretsFor) {
    config = (await resolveSecretRefsInObject(
      resolveSecretsFor,
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
