/**
 * Row and column security for lakehouse tables.
 *
 * DuckDB has no per-user ACLs, so a policy cannot be handed to the engine to
 * enforce. Instead a non-owner's SELECT is rewritten before it runs: every
 * reference to a policed table becomes a subquery carrying the row filter and
 * the column masks.
 *
 * The rewrite happens on the AST DuckDB itself produced (`json_serialize_sql`
 * out, `json_deserialize_sql` back in), not on the SQL text. That matters:
 * text rewriting can be defeated by comments, casing, whitespace, string
 * literals that look like table names, or a name reached through a CTE, while
 * the parser sees through all of it. If the rewrite cannot be completed for
 * any reason, the query is REFUSED rather than run unfiltered.
 */
import type { DuckDBConnection } from "@duckdb/node-api";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { effectivePolicy, type TagPolicy } from "@/lib/tagPolicies";

export type TablePolicy = {
  id: string;
  schema_name: string;
  table_name: string;
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
};

/** Single-quote a SQL string literal. */
const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;
/** Double-quote an identifier. */
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * Policies covering any of these tables, authored by the schema owners.
 * A policy belongs to the owner of the schema; a reader never sees the row,
 * because knowing the filter would tell them exactly what they are denied.
 */
export async function loadPolicies(
  ownerIds: string[],
  tables: { schema: string; table: string }[],
): Promise<Map<string, TablePolicy>> {
  const out = new Map<string, TablePolicy>();
  if (!ownerIds.length || !tables.length) return out;
  const { data } = await supabaseAdmin
    .from("lakehouse_table_policies")
    .select("id, user_id, schema_name, table_name, row_filter, masked_columns, mask_style")
    .in("user_id", ownerIds)
    .in("schema_name", [...new Set(tables.map((t) => t.schema))]);
  for (const row of data ?? []) {
    const key = `${String(row.schema_name).toLowerCase()}.${String(row.table_name).toLowerCase()}`;
    if (!tables.some((t) => `${t.schema}.${t.table}` === key)) continue;
    out.set(key, {
      id: row.id as string,
      schema_name: row.schema_name as string,
      table_name: row.table_name as string,
      row_filter: (row.row_filter as string | null) ?? null,
      masked_columns: (row.masked_columns as string[] | null) ?? [],
      mask_style: (row.mask_style as "null" | "hash") ?? "null",
    });
  }
  // Policies by tag: an owner's rules, applied to whatever the catalog says
  // these tables and their columns are tagged with, folded into the same
  // per-table policy the rewrite enforces. A table with no explicit policy
  // but a `pii` column under a mask rule gets a policy here.
  const rules = await loadTagPolicies(ownerIds);
  if (rules.length) {
    const tagged = await lakehouseAssetTags(ownerIds, tables);
    for (const t of tables) {
      const key = `${t.schema.toLowerCase()}.${t.table.toLowerCase()}`;
      const asset = tagged.get(key);
      if (!asset) continue;
      const explicit = out.get(key) ?? null;
      const eff = effectivePolicy({
        explicit,
        tableTags: asset.tableTags,
        columns: asset.columns,
        tagPolicies: rules,
      });
      if (!eff) continue;
      out.set(key, {
        id: explicit?.id ?? `tag:${key}`,
        schema_name: explicit?.schema_name ?? asset.schema,
        table_name: explicit?.table_name ?? asset.table,
        row_filter: eff.row_filter,
        masked_columns: eff.masked_columns,
        mask_style: eff.mask_style,
      });
    }
  }
  return out;
}

/** Every tag rule these owners wrote. */
export async function loadTagPolicies(ownerIds: string[]): Promise<TagPolicy[]> {
  if (!ownerIds.length) return [];
  const { data } = await supabaseAdmin
    .from("lakehouse_tag_policies")
    .select("id, tag, scope, mask_style, row_filter")
    .in("user_id", ownerIds);
  return (data ?? []).map((r) => ({
    id: r.id,
    tag: r.tag,
    scope: r.scope as "column" | "table",
    mask_style: (r.mask_style as "null" | "hash") ?? "null",
    row_filter: r.row_filter ?? null,
  }));
}

export type LakehouseAssetTags = {
  schema: string;
  table: string;
  tableTags: string[];
  columns: { name: string; tags?: string[] }[];
};

/**
 * What the catalog says these lakehouse tables are tagged with: the asset's
 * own tags and each column's tags, from the owners' lakehouse sources only —
 * a warehouse connection that happens to hold a same-named table is not the
 * lakehouse.
 */
export async function lakehouseAssetTags(
  ownerIds: string[],
  tables: { schema: string; table: string }[],
): Promise<Map<string, LakehouseAssetTags>> {
  const out = new Map<string, LakehouseAssetTags>();
  if (!ownerIds.length || !tables.length) return out;
  // A warehouse source's provider lives on its connection, not on the source.
  // Seen live: the first check read the source's config and found nothing,
  // so no table was ever tagged and the rules applied to no one.
  const { data: conns } = await supabaseAdmin
    .from("data_warehouse_connections")
    .select("id")
    .in("user_id", ownerIds)
    .eq("provider", "lakehouse");
  const connIds = (conns ?? []).map((c) => c.id);
  if (!connIds.length) return out;
  const { data: sources } = await supabaseAdmin
    .from("catalog_sources")
    .select("id")
    .in("user_id", ownerIds)
    .eq("kind", "warehouse")
    .in("connection_id", connIds);
  const lakeSources = (sources ?? []).map((src) => src.id);
  if (!lakeSources.length) return out;
  const { data: assets } = await supabaseAdmin
    .from("catalog_assets")
    .select("schema_name, name, tags, columns")
    .in("source_id", lakeSources)
    .in("schema_name", [...new Set(tables.map((t) => t.schema))])
    .in("name", [...new Set(tables.map((t) => t.table))]);
  for (const a of assets ?? []) {
    const key = `${String(a.schema_name ?? "").toLowerCase()}.${String(a.name).toLowerCase()}`;
    if (!tables.some((t) => `${t.schema.toLowerCase()}.${t.table.toLowerCase()}` === key)) continue;
    const cols = Array.isArray(a.columns)
      ? (a.columns as { name?: unknown; tags?: unknown }[])
      : [];
    out.set(key, {
      schema: String(a.schema_name ?? ""),
      table: String(a.name),
      tableTags: Array.isArray(a.tags) ? a.tags.map(String) : [],
      columns: cols
        .filter((c) => typeof c.name === "string")
        .map((c) => ({
          name: c.name as string,
          tags: Array.isArray(c.tags) ? (c.tags as unknown[]).map(String) : [],
        })),
    });
  }
  return out;
}

/**
 * Substitute the reader's identity into a filter. This is what makes a policy
 * useful beyond a static WHERE: `owner_email = @me` gives every reader their
 * own slice of one table. Values are escaped literals, never concatenated
 * text the reader controls — the filter itself is authored only by the owner.
 */
export function bindFilterPlaceholders(
  filter: string,
  reader: { id: string; email: string | null },
): string {
  return filter.replace(/@me\b/g, sq(reader.email ?? "")).replace(/@user_id\b/g, sq(reader.id));
}

type Column = { name: string; type: string };

async function tableColumns(c: DuckDBConnection, schema: string, table: string): Promise<Column[]> {
  const rows = await (
    await c.run(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = ${sq(schema)} AND table_name = ${sq(table)}
       ORDER BY ordinal_position`,
    )
  ).getRows();
  return rows.map((r) => ({ name: String(r[0]), type: String(r[1]) }));
}

/** The projection a policed reader gets: real columns, masked ones replaced. */
function maskedProjection(columns: Column[], policy: TablePolicy): string {
  const masked = new Set(policy.masked_columns.map((m) => m.toLowerCase()));
  return columns
    .map((col) => {
      if (!masked.has(col.name.toLowerCase())) return qi(col.name);
      const isText = /CHAR|TEXT|STRING/i.test(col.type);
      if (policy.mask_style === "hash" && isText) {
        // Keeps the column joinable and distinct-countable without revealing
        // the value — the usual ask for an email or an account number.
        return `md5(${qi(col.name)}) AS ${qi(col.name)}`;
      }
      // NULL works for every type, including the ones a hash would break.
      return `CAST(NULL AS ${col.type}) AS ${qi(col.name)}`;
    })
    .join(", ");
}

/** The SQL a policed table is replaced by. */
export function securedSubquery(
  columns: Column[],
  policy: TablePolicy,
  reader: { id: string; email: string | null },
): string {
  const projection = maskedProjection(columns, policy);
  const where = policy.row_filter?.trim()
    ? ` WHERE (${bindFilterPlaceholders(policy.row_filter.trim(), reader)})`
    : "";
  return `SELECT ${projection} FROM ${qi(policy.schema_name)}.${qi(policy.table_name)}${where}`;
}

/**
 * `query_location` is UINT64_MAX on synthesised nodes. JSON.parse rounds that
 * past MAX_SAFE_INTEGER, and re-serialising the rounded value makes the
 * deserialiser reject the whole tree. The field only feeds error positions,
 * so anything unusable is clamped.
 */
function clampQueryLocations(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) clampQueryLocations(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "query_location" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
      (node as Record<string, unknown>).query_location = 0;
    } else {
      clampQueryLocations(value);
    }
  }
}

/** Replace every BASE_TABLE node naming a policed table with its subquery. */
function substitute(
  node: unknown,
  replacements: Map<string, Record<string, unknown>>,
  applied: Set<string>,
): unknown {
  if (Array.isArray(node)) return node.map((item) => substitute(item, replacements, applied));
  if (!node || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  if (rec.type === "BASE_TABLE") {
    const key = `${String(rec.schema_name ?? "").toLowerCase()}.${String(rec.table_name ?? "").toLowerCase()}`;
    const secured = replacements.get(key);
    if (secured) {
      applied.add(key);
      // The reference keeps its alias, or takes the table name, so column
      // references elsewhere in the query still resolve.
      const alias = String(rec.alias ?? "") || String(rec.table_name ?? "");
      return { ...structuredClone(secured), alias };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec))
    out[key] = substitute(value, replacements, applied);
  return out;
}

export type PolicyRewrite = { sql: string; applied: string[] };

/**
 * Rewrite `sql` so every policed table is read through its policy. Returns
 * null when nothing applies, so the ordinary path pays no cost.
 *
 * Throws rather than degrades: a policy that cannot be applied must never
 * result in an unfiltered read.
 */
export async function applyTablePolicies(
  c: DuckDBConnection,
  sql: string,
  policies: Map<string, TablePolicy>,
  reader: { id: string; email: string | null },
): Promise<PolicyRewrite | null> {
  if (!policies.size) return null;

  const serialized = await (await c.run(`SELECT json_serialize_sql(${sq(sql)})`)).getRows();
  const tree = JSON.parse(String(serialized[0][0])) as Record<string, unknown> & {
    error?: boolean;
    error_message?: string;
  };
  if (tree.error) throw new Error(`SQL parse error: ${tree.error_message ?? "invalid SQL"}`);

  // Build one secured node per policed table, by asking the parser to
  // serialise the subquery we want and lifting its FROM node.
  const replacements = new Map<string, Record<string, unknown>>();
  for (const [key, policy] of policies) {
    const columns = await tableColumns(c, policy.schema_name, policy.table_name);
    if (!columns.length) {
      throw new Error(
        `A security policy covers ${policy.schema_name}.${policy.table_name}, but its columns could not be read — refusing to run unfiltered`,
      );
    }
    const inner = securedSubquery(columns, policy, reader);
    const wrapped = `SELECT * FROM (${inner}) AS ${qi(policy.table_name)}`;
    const rows = await (await c.run(`SELECT json_serialize_sql(${sq(wrapped)})`)).getRows();
    const parsed = JSON.parse(String(rows[0][0])) as {
      error?: boolean;
      error_message?: string;
      statements?: { node?: { from_table?: Record<string, unknown> } }[];
    };
    const node = parsed.statements?.[0]?.node?.from_table;
    if (parsed.error || !node) {
      throw new Error(
        `The security policy on ${policy.schema_name}.${policy.table_name} is not valid SQL: ${parsed.error_message ?? "could not be parsed"}`,
      );
    }
    replacements.set(key, node);
  }

  const applied = new Set<string>();
  const rewritten = substitute(tree, replacements, applied) as Record<string, unknown>;
  if (!applied.size) return null;
  clampQueryLocations(rewritten);

  const out = await (
    await c.run(`SELECT json_deserialize_sql(${sq(JSON.stringify(rewritten))})`)
  ).getRows();
  const finalSql = String(out[0][0]);
  if (!finalSql.trim()) {
    throw new Error("A security policy applies to this query but could not be enforced — refused");
  }
  return { sql: finalSql, applied: [...applied] };
}
