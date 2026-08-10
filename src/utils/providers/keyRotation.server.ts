// Re-encrypt every stored credential to the current key.
//
// Rotating PROVIDER_CREDS_SECRET is two moves. The OPERATOR does the part
// software cannot: set the new secret as PROVIDER_CREDS_SECRET, move the old one
// to PROVIDER_CREDS_SECRET_OLD, and restart. From that moment both keys decrypt
// and everything new is written with the new key. This module does the other
// part — sweeping existing rows onto the new key — which the admin UI triggers.
//
// It is deliberately blob-shape-agnostic. Every table that stores a credential
// is listed here; within a row, `reEncryptDeep` finds and rewrites every
// ciphertext at any JSON depth, so a whole-column blob, a nested `_enc` field
// and a `{token: …}` object are all handled the same way. Adding a new
// encrypted column later means adding the table name here, nothing else.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { blobKeyStatus, reEncryptDeep } from "./crypto.server";

/**
 * Every table any `encryptJson` caller writes to. Derived by grepping all call
 * sites, not guessed — the set is closed because nothing else produces a blob.
 * Empty tables are listed anyway so rotation covers them once they hold data.
 */
export const ENCRYPTED_TABLES = [
  "user_secrets",
  "data_warehouse_connections",
  "saas_connections",
  "integrations",
  "provider_credentials",
  "catalog_sources",
  "git_export_config",
  "kb_sources",
  "mcp_servers",
] as const;

export type TableStatus = {
  table: string;
  rows: number;
  blobs: number;
  onCurrent: number;
  onOther: number;
  legacy: number;
  error?: string;
};

export type TableRotation = {
  table: string;
  rowsScanned: number;
  rowsUpdated: number;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
  error?: string;
};

/** Which column identifies a row for the write-back. Every encrypted table has
 *  one of these; `id` is preferred. */
function rowKey(row: Record<string, unknown>): { col: string; val: unknown } | null {
  if (typeof row.id === "string") return { col: "id", val: row.id };
  if (typeof row.user_id === "string") return { col: "user_id", val: row.user_id };
  return null;
}

/** Read-only: how many blobs each table holds and how many are on the current key. */
export async function keyEncryptionStatus(): Promise<TableStatus[]> {
  const out: TableStatus[] = [];
  for (const table of ENCRYPTED_TABLES) {
    const { data, error } = await supabaseAdmin.from(table).select("*");
    if (error) {
      out.push({
        table,
        rows: 0,
        blobs: 0,
        onCurrent: 0,
        onOther: 0,
        legacy: 0,
        error: error.message,
      });
      continue;
    }
    let blobs = 0;
    let onCurrent = 0;
    let onOther = 0;
    let legacy = 0;
    for (const row of data ?? []) {
      for (const val of Object.values(row)) {
        const s = await blobKeyStatus(val);
        blobs += s.total;
        onCurrent += s.onCurrent;
        onOther += s.onOther;
        legacy += s.legacy;
      }
    }
    out.push({ table, rows: (data ?? []).length, blobs, onCurrent, onOther, legacy });
  }
  return out;
}

/**
 * Sweep every row of every encrypted table onto the current key. Idempotent: a
 * row already fully on the current key is read but not written. A row that
 * cannot be decrypted under any configured key is counted as failed and left
 * exactly as it was — never destroyed — so a bad key config or a corrupt blob
 * costs nothing and the sweep can be re-run after fixing it.
 */
export async function reEncryptAllToCurrentKey(): Promise<{
  tables: TableRotation[];
  totalMigrated: number;
  totalFailed: number;
}> {
  const tables: TableRotation[] = [];
  let totalMigrated = 0;
  let totalFailed = 0;

  for (const table of ENCRYPTED_TABLES) {
    const result: TableRotation = {
      table,
      rowsScanned: 0,
      rowsUpdated: 0,
      migrated: 0,
      alreadyCurrent: 0,
      failed: 0,
    };
    const { data, error } = await supabaseAdmin.from(table).select("*");
    if (error) {
      result.error = error.message;
      tables.push(result);
      continue;
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      result.rowsScanned++;
      const key = rowKey(row);
      const patch: Record<string, unknown> = {};
      let rowMigrated = 0;

      for (const [col, val] of Object.entries(row)) {
        const r = await reEncryptDeep(val);
        result.migrated += r.migrated;
        result.alreadyCurrent += r.alreadyCurrent;
        result.failed += r.failed;
        if (r.migrated > 0) {
          patch[col] = r.value;
          rowMigrated += r.migrated;
        }
      }

      if (rowMigrated > 0) {
        if (!key) {
          // No id/user_id to write back against — count the migrated blobs as
          // failed rather than silently leaving them on the old key.
          result.failed += rowMigrated;
          result.migrated -= rowMigrated;
          continue;
        }
        // The patch is built by walking the row, so its shape is only known at
        // runtime; the generated table types cannot express that.
        const { error: upErr } = await supabaseAdmin
          .from(table)
          .update(patch as never)
          .eq(key.col, key.val as string);
        if (upErr) {
          result.error = upErr.message;
          result.failed += rowMigrated;
          result.migrated -= rowMigrated;
        } else {
          result.rowsUpdated++;
        }
      }
    }

    totalMigrated += result.migrated;
    totalFailed += result.failed;
    tables.push(result);
  }

  return { tables, totalMigrated, totalFailed };
}
