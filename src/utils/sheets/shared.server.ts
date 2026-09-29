// Server-side helpers shared by the Sheets server functions: who is asking,
// which table sheet, what the lakehouse holds, and landing imported rows.
// Kept out of the *.functions.ts files so the browser bundle, which imports
// those for their RPC stubs, never reaches the service-role client.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { tableNameProblem } from "@/lib/sheets/names";
import { qid } from "@/lib/sheets/sql/compile";
import {
  checkSheetQuery,
  ROW_ID,
  type OtherTable,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";
import type { SheetTabRow } from "@/utils/sheets.functions";
import { tableConfigSchema } from "@/utils/sheets/schemas";

export type Fail = { ok: false; error: string };

export async function resolveCaller(
  accessToken: string,
): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

// Which sheets and rows a caller may read, and the other table sheets a
// lookup may use, come from sheets/access.server (requireTab, othersFor):
// there is no owner-only shortcut here, so none can skip a share.

/** The first line of an engine error, without DuckDB's LINE/caret decoration. */
export function engineMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.split("\n")[0].replace(/^(Binder|Conversion|Invalid Input|Out of Range) Error: /, "");
}

/** The columns a lakehouse table has right now. */
export async function describeSource(
  userId: string,
  schema: string,
  table: string,
): Promise<{ name: string; type: string }[]> {
  const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
  const r = await runLakehouseStatement(
    userId,
    `SELECT * FROM ${qid(schema)}.${qid(table)} LIMIT 0`,
    { rowCap: 1, auditVia: "sheets", useCache: false },
  );
  return r.columns.map((c) => ({ name: c.name, type: c.type }));
}

/**
 * The columns a query over the lakehouse returns, read as the caller reads
 * it (their grants and policies): a query they can't run is refused here,
 * before a sheet that could never show a row is made. Each column needs a
 * name of its own, since the sheet, its filters and its formulas name them.
 */
export async function describeQuery(
  userId: string,
  sql: string,
): Promise<{ name: string; type: string }[]> {
  const q = checkSheetQuery(sql);
  if (!q.ok) throw new Error(q.error);
  const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
  const r = await runLakehouseStatement(userId, `SELECT * FROM (${q.sql}\n) AS __query LIMIT 0`, {
    rowCap: 1,
    auditVia: "sheets",
    useCache: false,
  });
  const cols = r.columns.map((c) => ({ name: c.name, type: c.type }));
  if (!cols.length) throw new Error("The query returns no columns");
  const seen = new Set<string>();
  for (const c of cols) {
    const key = c.name.toLowerCase();
    if (key === ROW_ID) throw new Error(`A column can't be named ${ROW_ID}; rename it with AS`);
    if (c.name.length > 255) throw new Error(`"${c.name.slice(0, 40)}…" is too long a column name`);
    if (seen.has(key)) {
      throw new Error(`Two columns are named "${c.name}"; name one of them apart with AS`);
    }
    seen.add(key);
  }
  return cols;
}

/**
 * A table sheet over schema.table at the end of the workbook, after checking
 * (through the governed path) that the caller can read it.
 */
export async function addTableTab(
  userId: string,
  args: {
    workbook_id: string;
    name: string;
    schema: string;
    table: string;
    origin?: TableConfig["origin"];
  },
): Promise<{ ok: true; tab: SheetTabRow } | Fail> {
  const problem = tableNameProblem(args.name);
  if (problem) return { ok: false, error: problem };
  // The owner or an editor; the sheet is the owner's either way.
  const { requireAccess } = await import("@/utils/sheets/access.server");
  const got = await requireAccess(userId, args.workbook_id, "edit");
  if (!got.ok) return got;
  let columns: { name: string; type: string }[];
  try {
    // No access means a refusal here, before a sheet that could never show a
    // row is created.
    columns = await describeSource(userId, args.schema, args.table);
  } catch (e) {
    return {
      ok: false,
      error: `${args.schema}.${args.table} can't be opened: ${engineMessage(e)}`,
    };
  }
  return insertTableTab(got.access.ownerId, args.workbook_id, args.name, {
    source: { kind: "lakehouse", schema: args.schema, table: args.table },
    columns,
    calculated: [],
    sort: [],
    filters: [],
    hidden: [],
    widths: {},
    origin: args.origin ?? { kind: "lakehouse" },
  });
}

/** A table sheet with these settings at the end of the workbook (the name already checked). */
export async function insertTableTab(
  userId: string,
  workbookId: string,
  name: string,
  config: TableConfig,
): Promise<{ ok: true; tab: SheetTabRow } | Fail> {
  const args = { workbook_id: workbookId, name };
  const { data: last, error: posErr } = await supabaseAdmin
    .from("sheet_tabs")
    .select("position")
    .eq("workbook_id", args.workbook_id)
    .order("position", { ascending: false })
    .limit(1);
  if (posErr) return { ok: false, error: `Could not read the sheets: ${posErr.message}` };
  const { data: tab, error } = await supabaseAdmin
    .from("sheet_tabs")
    .insert({
      workbook_id: args.workbook_id,
      user_id: userId,
      name: args.name.trim(),
      kind: "table",
      position: (last?.[0]?.position ?? -1) + 1,
      grid: { cells: {} } as Json,
      table_config: config as unknown as Json,
    })
    .select("id, workbook_id, name, kind, position, grid, table_config, version, updated_at")
    .single();
  if (error || !tab) {
    return {
      ok: false,
      error:
        error?.code === "23505"
          ? `This workbook already has a sheet named "${args.name.trim()}"`
          : `Could not add the sheet: ${error?.message ?? "no row"}`,
    };
  }
  return { ok: true, tab: tab as SheetTabRow };
}

export const LAKE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Where an import may land: a regular schema the caller owns, under a new name. */
export async function importTarget(
  userId: string,
  schema: string,
  table: string,
  opts: { replacing?: boolean } = {},
): Promise<string | null> {
  if (!LAKE_NAME.test(table)) {
    return "A lakehouse table name is lowercase letters, digits and _, starting with a letter";
  }
  const { accessibleSchemas, lakehouseTableExists } = await import("@/utils/lakehouse/core.server");
  const allowed = await accessibleSchemas(userId);
  const target = allowed.find((x) => x.name === schema);
  if (!target) return `You can't write to the schema "${schema}"`;
  if (target.user_id !== userId)
    return `"${schema}" is shared with you; import into a schema you own`;
  if (target.lake_source_id || target.iceberg_catalog_id) return `"${schema}" is a read-only mount`;
  if (!opts.replacing && (await lakehouseTableExists(schema, table))) {
    // R101/R102: a new table is new. Importing over an existing one would
    // replace rows other things read.
    return `${schema}.${table} already exists. Pick a new name; importing never replaces a table.`;
  }
  return null;
}

/** JSON the engine can read back: dates as ISO text, big integers as numbers or text. */
export function toJsonRows(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, (_k, v) => {
    if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v && typeof v === "object" && "type" in v && (v as { type: unknown }).type === "Buffer") {
      return null;
    }
    return v;
  });
}

/**
 * Write staged rows as schema.table (CREATE TABLE, or CREATE OR REPLACE when
 * refreshing a table this sheet made). The staged file is server-owned and
 * lives for the statement.
 */
export async function landRows(
  schema: string,
  table: string,
  stage: { json?: string; csv?: string },
  replace: boolean,
): Promise<number> {
  const { lakehouseConnection } = await import("@/utils/lakehouse/core.server");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "sheets-import-"));
  const file = join(dir, stage.csv !== undefined ? "rows.csv" : "rows.json");
  const path = file.replace(/\\/g, "/").replace(/'/g, "''");
  const c = await lakehouseConnection();
  try {
    await writeFile(file, stage.csv ?? stage.json ?? "[]", "utf8");
    const reader =
      stage.csv !== undefined
        ? `read_csv_auto('${path}', header = true, sample_size = -1)`
        : `read_json_auto('${path}')`;
    await c.run(
      `CREATE ${replace ? "OR REPLACE " : ""}TABLE ${qid(schema)}.${qid(table)} AS SELECT * FROM ${reader}`,
    );
    const rows = await (await c.run(`SELECT count(*) FROM ${qid(schema)}.${qid(table)}`)).getRows();
    return Number(rows[0][0]);
  } finally {
    c.closeSync();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Provider-correct SELECT * of one table, for "import this table". */
export function selectAllFrom(provider: string, schema: string, table: string): string {
  const bt = (x: string) => `\`${x.replace(/`/g, "``")}\``;
  const dq = (x: string) => `"${x.replace(/"/g, '""')}"`;
  switch (provider) {
    case "mysql":
    case "databricks":
      return `SELECT * FROM ${bt(schema)}.${bt(table)}`;
    case "bigquery":
      return `SELECT * FROM ${bt(`${schema}.${table}`)}`;
    case "azure_synapse":
      return `SELECT * FROM [${schema.replace(/]/g, "]]")}].[${table.replace(/]/g, "]]")}]`;
    default:
      return `SELECT * FROM ${dq(schema)}.${dq(table)}`;
  }
}

/** Run a read against a connection and return every row, or say why not. */
export async function readConnection(
  userId: string,
  connectionId: string,
  query: string,
): Promise<{ ok: true; rows: Record<string, unknown>[]; connectionName: string } | Fail> {
  const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
  const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
  const { warehouseAbsMaxRows } = await import("@/utils/warehouse/governor.server");
  let conn;
  try {
    conn = await loadWarehouseConnectionForUser(supabaseAdmin, { connectionId }, userId);
  } catch (e) {
    const m = (e as Error).message;
    return {
      ok: false,
      error: /not found/i.test(m)
        ? "Its database connection is not shared with you, so its rows can't be read. Seeing a table in the catalog does not give access to its data; ask the connection's owner."
        : m,
    };
  }
  const cap = warehouseAbsMaxRows();
  let res;
  try {
    res = await executeWarehouseQuery(conn.config, query, cap, { userId });
  } catch (e) {
    return { ok: false, error: `${conn.name}: ${(e as Error).message}` };
  }
  if (res.truncated || res.rows.length >= cap) {
    // Refused, never truncated: a sheet of the first N rows looks exactly
    // like a small table, and every total on it would be wrong.
    return {
      ok: false,
      error: `This returns more than ${cap.toLocaleString()} rows, the most a direct import brings through the app (WAREHOUSE_ABS_MAX_ROWS). Land it in the lakehouse with an ETL pipeline, then open that table here, or narrow the query.`,
    };
  }
  if (!res.rows.length)
    return { ok: false, error: "The query returned no rows; there is nothing to import" };
  return { ok: true, rows: res.rows, connectionName: conn.name };
}

/**
 * Catalog sources the caller owns or was granted, read under their own RLS:
 * the catalog's policies (owner, or a catalog_source grant) decide, not a
 * second copy of them here.
 */
export async function visibleCatalogSources(accessToken: string) {
  const { userScopedClient } = await import("@/utils/swarmNodes.server");
  const sb = userScopedClient(accessToken);
  if (!sb) throw new Error("Server is missing Supabase configuration");
  const { data, error } = await sb
    .from("catalog_sources")
    .select("id, name, kind, connection_id, user_id");
  if (error) throw new Error(`Could not read the catalog: ${error.message}`);
  const connIds = [
    ...new Set((data ?? []).map((s) => s.connection_id).filter(Boolean)),
  ] as string[];
  const providers = new Map<string, string>();
  if (connIds.length) {
    // The provider only: never the credential.
    const { data: conns, error: cErr } = await supabaseAdmin
      .from("data_warehouse_connections")
      .select("id, provider")
      .in("id", connIds);
    if (cErr) throw new Error(`Could not read the catalog's connections: ${cErr.message}`);
    for (const c of conns ?? []) providers.set(c.id, c.provider);
  }
  return {
    sb,
    sources: (data ?? []).map((s) => ({
      ...s,
      provider: s.connection_id ? (providers.get(s.connection_id) ?? null) : null,
    })),
  };
}
