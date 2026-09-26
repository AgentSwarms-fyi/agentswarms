// Lakehouse tables a Sheets workbook owns: the ones Sheets created to hold a
// table sheet's rows (a file uploaded into a table sheet, or rows imported
// from a connection). Sheets replaces such a table when the import is
// refreshed, and the sheet's calculated columns, pivots and formulas are built
// on its columns, so a change made to it anywhere else either breaks the sheet
// or is silently overwritten. The Lakehouse reads them like any table and
// refuses to change them.
//
// Ownership is read from the sheets themselves, not kept in a list of its
// own: delete the table sheet and the table is an ordinary lakehouse table
// again; restore a version or open a copy and it is owned again.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SheetOwner = { workbookId: string; workbook: string; sheet: string };

type Held = { schema: string; table: string; owner: SheetOwner };

const key = (schema: string, table: string) => `${schema.toLowerCase()}.${table.toLowerCase()}`;

/**
 * Every table a sheet holds.
 *
 * FOUND IN R127. A claim counts only when the sheet's owner owns the table's
 * schema, which every real import requires (importTarget in
 * sheets/shared.server). A sheet's settings once came back from the browser
 * whole and were stored as sent, so a sheet could name anyone's table and say
 * it had uploaded it, and this guard then refused that table's own owner. A
 * claim on a table in someone else's schema holds nothing.
 */
async function heldTables(): Promise<Held[]> {
  const { data, error } = await supabaseAdmin
    .from("sheet_tabs")
    .select("name, workbook_id, user_id, table_config, sheet_workbooks(name)")
    .eq("kind", "table")
    .in("table_config->origin->>kind", ["upload", "warehouse"]);
  // Failing closed: if the sheets cannot be read, no one can tell whether a
  // table is a sheet's, and a write that might break one is refused.
  if (error) throw new Error(`Could not check which tables Sheets owns: ${error.message}`);
  const claims: (Held & { userId: string })[] = [];
  for (const row of data ?? []) {
    const src = (
      row.table_config as { source?: { kind?: string; schema?: string; table?: string } }
    )?.source;
    if (src?.kind !== "lakehouse" || !src.schema || !src.table) continue;
    const wb = row.sheet_workbooks as { name?: string } | { name?: string }[] | null;
    const name = (Array.isArray(wb) ? wb[0]?.name : wb?.name) ?? "a workbook";
    claims.push({
      schema: src.schema,
      table: src.table,
      userId: row.user_id,
      owner: { workbookId: row.workbook_id, workbook: name, sheet: row.name },
    });
  }
  if (!claims.length) return [];
  const names = [...new Set(claims.flatMap((c) => [c.schema, c.schema.toLowerCase()]))];
  const { data: schemas, error: sErr } = await supabaseAdmin
    .from("lakehouse_schemas")
    .select("name, user_id")
    .in("name", names);
  if (sErr) throw new Error(`Could not check which tables Sheets owns: ${sErr.message}`);
  const schemaOwner = new Map((schemas ?? []).map((s) => [s.name.toLowerCase(), s.user_id]));
  return claims
    .filter((c) => schemaOwner.get(c.schema.toLowerCase()) === c.userId)
    .map(({ schema, table, owner }) => ({ schema, table, owner }));
}

/** Owners of the given tables (by lower-case "schema.table"); tables no sheet owns are absent. */
export async function sheetOwners(
  tables: { schema: string; table: string }[],
): Promise<Map<string, SheetOwner>> {
  const out = new Map<string, SheetOwner>();
  if (!tables.length) return out;
  const wanted = new Set(tables.map((t) => key(t.schema, t.table)));
  for (const h of await heldTables()) {
    const k = key(h.schema, h.table);
    if (wanted.has(k) && !out.has(k)) out.set(k, h.owner);
  }
  return out;
}

/** Why a write to these tables is refused, or null when none is a sheet's. */
export async function sheetOwnedRefusal(
  tables: { schema: string; table: string }[],
): Promise<string | null> {
  const owners = await sheetOwners(tables);
  for (const t of tables) {
    const o = owners.get(key(t.schema, t.table));
    if (o)
      return (
        `${t.schema}.${t.table} holds the rows of the sheet "${o.sheet}" in the Sheets workbook ` +
        `"${o.workbook}", and only Sheets changes it (it is replaced when the sheet refreshes its ` +
        `import). Read it here like any table. To change the data, make a copy that is yours: ` +
        `CREATE TABLE ${t.schema}.${t.table}_copy AS SELECT * FROM ${t.schema}.${t.table}; or ` +
        `delete that sheet in Sheets, after which the table can be changed here.`
      );
  }
  return null;
}

/** The sheet-held tables in a schema (lower-case names), for refusing to drop the schema. */
export async function sheetOwnedInSchema(
  schema: string,
): Promise<{ table: string; owner: SheetOwner }[]> {
  return (await heldTables())
    .filter((h) => h.schema.toLowerCase() === schema.toLowerCase())
    .map((h) => ({ table: h.table.toLowerCase(), owner: h.owner }));
}
