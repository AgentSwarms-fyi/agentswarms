// The owner's side of sharing: server functions behind the lakehouse page's
// Shares dialog. Every write checks that the caller owns the schema a table
// comes from, validates a row filter against the table before saving it,
// and audits. Tokens are minted here and returned once; only the hash stays.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  SHARED_AS_RE,
  SHARE_NAME_RE,
  generateShareToken,
  hashShareToken,
  shareTokenPrefix,
} from "@/lib/deltaSharing";
import { auditEvent } from "@/utils/audit.server";
import { lakehouseConnection } from "./core.server";
import { bindFilterPlaceholders } from "./policies.server";
import { dropShareTableSnapshots } from "./shares.server";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Not signed in");
  return data.user.id;
}

const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** The caller must own the schema: sharing is the owner's decision alone. */
async function assertOwnsSchema(userId: string, schema: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("lakehouse_schemas")
    .select("id")
    .eq("name", schema)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error(`You do not own the schema "${schema}", so you cannot share from it`);
}

async function assertOwnsShare(userId: string, shareId: string) {
  const { data } = await supabaseAdmin
    .from("lakehouse_shares")
    .select("id, name, user_id")
    .eq("id", shareId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("No such share");
  return data;
}

export type LakehouseShareToken = {
  id: string;
  label: string;
  recipient_email: string | null;
  token_prefix: string;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
};

export type LakehouseShareTable = {
  id: string;
  schema_name: string;
  table_name: string;
  shared_as: string;
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
  snapshot: { version: string; rows: number; created_at: string } | null;
};

export type LakehouseShare = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  tables: LakehouseShareTable[];
  tokens: LakehouseShareToken[];
};

export const listLakehouseShares = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<LakehouseShare[]> => {
    const userId = await resolveCaller(data.access_token);
    const { data: shares } = await supabaseAdmin
      .from("lakehouse_shares")
      .select("id, name, description, created_at")
      .eq("user_id", userId)
      .order("name");
    if (!shares?.length) return [];
    const ids = shares.map((s) => s.id);
    const [{ data: tables }, { data: tokens }] = await Promise.all([
      supabaseAdmin
        .from("lakehouse_share_tables")
        .select(
          "id, share_id, schema_name, table_name, shared_as, row_filter, masked_columns, mask_style",
        )
        .in("share_id", ids)
        .order("schema_name")
        .order("shared_as"),
      supabaseAdmin
        .from("lakehouse_share_tokens")
        .select(
          "id, share_id, label, recipient_email, token_prefix, expires_at, created_at, last_used_at, use_count, revoked_at",
        )
        .in("share_id", ids)
        .order("created_at", { ascending: false }),
    ]);
    const tableIds = (tables ?? []).map((t) => t.id);
    const { data: snaps } = tableIds.length
      ? await supabaseAdmin
          .from("lakehouse_share_snapshots")
          .select("share_table_id, snapshot_id, row_count, created_at")
          .in("share_table_id", tableIds)
          .order("created_at", { ascending: false })
      : { data: [] };
    const latest = new Map<string, { version: string; rows: number; created_at: string }>();
    for (const s of snaps ?? []) {
      if (!latest.has(s.share_table_id)) {
        latest.set(s.share_table_id, {
          version: s.snapshot_id,
          rows: Number(s.row_count),
          created_at: s.created_at,
        });
      }
    }
    return shares.map((s) => ({
      ...s,
      tables: (tables ?? [])
        .filter((t) => t.share_id === s.id)
        .map((t) => ({
          id: t.id,
          schema_name: t.schema_name,
          table_name: t.table_name,
          shared_as: t.shared_as,
          row_filter: t.row_filter,
          masked_columns: t.masked_columns ?? [],
          mask_style: (t.mask_style as "null" | "hash") ?? "null",
          snapshot: latest.get(t.id) ?? null,
        })),
      tokens: (tokens ?? [])
        .filter((t) => t.share_id === s.id)
        .map((t) => ({
          id: t.id,
          label: t.label,
          recipient_email: t.recipient_email,
          token_prefix: t.token_prefix,
          expires_at: t.expires_at,
          created_at: t.created_at,
          last_used_at: t.last_used_at,
          use_count: Number(t.use_count ?? 0),
          revoked_at: t.revoked_at,
        })),
    }));
  });

export const createLakehouseShare = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z.string().regex(SHARE_NAME_RE, "lower-case letters, digits, - and _; up to 63"),
        description: z.string().max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row, error } = await supabaseAdmin
      .from("lakehouse_shares")
      .insert({ user_id: userId, name: data.name, description: data.description?.trim() || null })
      .select("id")
      .single();
    if (error) {
      throw new Error(
        error.code === "23505" ? `A share named "${data.name}" already exists` : error.message,
      );
    }
    auditEvent({
      userId,
      action: "lakehouse.share.create",
      resourceType: "lakehouse_share",
      resourceId: row.id,
      resourceName: data.name,
    });
    return { id: row.id };
  });

export const deleteLakehouseShare = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), share_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const share = await assertOwnsShare(userId, data.share_id);
    const { data: tables } = await supabaseAdmin
      .from("lakehouse_share_tables")
      .select("id")
      .eq("share_id", share.id);
    for (const t of tables ?? []) await dropShareTableSnapshots(t.id);
    const { error } = await supabaseAdmin.from("lakehouse_shares").delete().eq("id", share.id);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "lakehouse.share.delete",
      resourceType: "lakehouse_share",
      resourceId: share.id,
      resourceName: share.name,
    });
    return { ok: true };
  });

export const addLakehouseShareTable = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        share_id: z.string().uuid(),
        schema: z.string().min(1).max(128),
        table: z.string().min(1).max(128),
        shared_as: z.string().regex(SHARED_AS_RE).optional(),
        row_filter: z.string().max(2000).optional(),
        masked_columns: z.array(z.string().min(1).max(128)).max(200).optional(),
        mask_style: z.enum(["null", "hash"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const userId = await resolveCaller(data.access_token);
    const share = await assertOwnsShare(userId, data.share_id);
    await assertOwnsSchema(userId, data.schema);
    const filter = data.row_filter?.trim() || null;
    const masked = [...new Set((data.masked_columns ?? []).map((c) => c.trim()).filter(Boolean))];
    const c = await lakehouseConnection();
    try {
      const cols = await (
        await c.run(
          `SELECT column_name FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = '${data.schema.replace(/'/g, "''")}' AND table_name = '${data.table.replace(/'/g, "''")}' ORDER BY column_index`,
        )
      ).getRows();
      if (!cols.length) throw new Error(`No table "${data.schema}.${data.table}" in the lakehouse`);
      const names = new Set(cols.map((r) => String(r[0])));
      const unknown = masked.filter((m) => !names.has(m));
      if (unknown.length) throw new Error(`No such column to mask: ${unknown.join(", ")}`);
      if (filter) {
        const bound = bindFilterPlaceholders(filter, { id: userId, email: "probe@example.com" });
        try {
          await c.run(
            `SELECT 1 FROM ${qi(data.schema)}.${qi(data.table)} WHERE (${bound}) LIMIT 0`,
          );
        } catch (e) {
          throw new Error(
            `That row filter is not valid on ${data.schema}.${data.table}: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      c.closeSync();
    }
    const { data: row, error } = await supabaseAdmin
      .from("lakehouse_share_tables")
      .insert({
        share_id: share.id,
        schema_name: data.schema,
        table_name: data.table,
        shared_as: data.shared_as ?? data.table,
        row_filter: filter,
        masked_columns: masked,
        mask_style: data.mask_style ?? "null",
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(
        error.code === "23505"
          ? "That table, or that name, is already in the share"
          : error.message,
      );
    }
    auditEvent({
      userId,
      action: "lakehouse.share.table_add",
      resourceType: "lakehouse_share",
      resourceId: share.id,
      resourceName: share.name,
      detail: {
        table: `${data.schema}.${data.table}`,
        shared_as: data.shared_as ?? data.table,
        row_filter: filter,
        masked_columns: masked,
      },
    });
    return { id: row.id };
  });

export const removeLakehouseShareTable = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), share_table_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: t } = await supabaseAdmin
      .from("lakehouse_share_tables")
      .select("id, share_id, schema_name, table_name")
      .eq("id", data.share_table_id)
      .maybeSingle();
    if (!t) throw new Error("No such shared table");
    const share = await assertOwnsShare(userId, t.share_id);
    await dropShareTableSnapshots(t.id);
    const { error } = await supabaseAdmin.from("lakehouse_share_tables").delete().eq("id", t.id);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "lakehouse.share.table_remove",
      resourceType: "lakehouse_share",
      resourceId: share.id,
      resourceName: share.name,
      detail: { table: `${t.schema_name}.${t.table_name}` },
    });
    return { ok: true };
  });

export const createLakehouseShareToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        share_id: z.string().uuid(),
        label: z.string().min(1).max(80),
        recipient_email: z.string().email().optional(),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string; token: string; expires_at: string | null }> => {
    const userId = await resolveCaller(data.access_token);
    const share = await assertOwnsShare(userId, data.share_id);
    const token = generateShareToken();
    const expiresAt = data.expires_in_days
      ? new Date(Date.now() + data.expires_in_days * 86_400_000).toISOString()
      : null;
    const { data: row, error } = await supabaseAdmin
      .from("lakehouse_share_tokens")
      .insert({
        share_id: share.id,
        label: data.label.trim(),
        recipient_email: data.recipient_email?.trim().toLowerCase() || null,
        token_hash: await hashShareToken(token),
        token_prefix: shareTokenPrefix(token),
        expires_at: expiresAt,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "lakehouse.share.token_create",
      resourceType: "lakehouse_share",
      resourceId: share.id,
      resourceName: share.name,
      detail: { token_id: row.id, label: data.label.trim(), expires_at: expiresAt },
    });
    return { id: row.id, token, expires_at: expiresAt };
  });

export const revokeLakehouseShareToken = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), token_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: t } = await supabaseAdmin
      .from("lakehouse_share_tokens")
      .select("id, share_id, label")
      .eq("id", data.token_id)
      .maybeSingle();
    if (!t) throw new Error("No such token");
    const share = await assertOwnsShare(userId, t.share_id);
    const { error } = await supabaseAdmin
      .from("lakehouse_share_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", t.id)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "lakehouse.share.token_revoke",
      resourceType: "lakehouse_share",
      resourceId: share.id,
      resourceName: share.name,
      detail: { token_id: t.id, label: t.label },
    });
    return { ok: true };
  });
