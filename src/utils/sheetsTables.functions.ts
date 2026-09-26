// Server functions behind a table sheet: a lakehouse table opened in a
// workbook, read a page at a time, with calculated columns, sort and filters
// computed by the engine.
//
// Nothing here reads the lakehouse except through runLakehouseStatement, so a
// table sheet sees exactly what the Query editor would show the same person:
// the same schema grants, the same row and column policies, the same audit.
// The SQL is built on the server from the sheet's structured settings (see
// src/lib/sheets/sql), never taken as text from the browser.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { columnNameProblem, tableNameProblem } from "@/lib/sheets/names";
import type { TableCallRequest } from "@/lib/sheets/formula/evaluate";
import { qid } from "@/lib/sheets/sql/compile";
import {
  buildTableRelation,
  isVolatile,
  pageSql,
  selectAllSql,
  sourceLabel,
  TableQueryError,
  valuesSql,
  type OtherTable,
  type TableColumn,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import type { SheetTabRow } from "@/utils/sheets.functions";
import { nameStr, originSchema, tableConfigSchema, tokenOnly } from "@/utils/sheets/schemas";
import {
  addTableTab,
  describeSource,
  engineMessage,
  importTarget,
  insertTableTab,
  landRows,
  otherTables,
  ownTableTab,
  readConnection,
  resolveCaller,
  selectAllFrom,
  toJsonRows,
  visibleCatalogSources,
  type Fail,
} from "@/utils/sheets/shared.server";

// ── What can be opened ─────────────────────────────────────────────────────

export type SheetSourceTable = { schema: string; table: string; columns: number };

/** Lakehouse tables the caller can read, for "Open a table". */
export const sheetsTableSources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          enabled: boolean;
          tables: SheetSourceTable[];
          schemas: { name: string; writable: boolean }[];
        }
      | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      try {
        const { listLakehouseTablesForUser } = await import("@/utils/lakehouse/tables.server");
        const r = await listLakehouseTablesForUser(caller.userId);
        return {
          ok: true,
          enabled: r.enabled,
          tables: r.tables.map((t) => ({
            schema: t.schema,
            table: t.table,
            columns: t.columns.length,
          })),
          schemas: r.schemas,
        };
      } catch (e) {
        return { ok: false, error: `Could not list the lakehouse tables: ${(e as Error).message}` };
      }
    },
  );

/** Open a lakehouse table as a new table sheet at the end of the workbook. */
export const sheetsAddTableTab = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        schema: nameStr,
        table: nameStr,
        origin: originSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    return addTableTab(caller.userId, data);
  });

// ── Bringing data in ───────────────────────────────────────────────────────
//
// Data from a connected source or a file lands in the lakehouse first, as a
// new table in a schema the caller owns, and the sheet reads that table. The
// sheet never holds the rows, and the table is an ordinary lakehouse table:
// queryable, governed, crawlable.

/** A connection's tables, for "import a table". */
export const sheetsConnectionTables = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ connection_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; tables: { schema: string; name: string }[] } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      try {
        const { loadWarehouseConnectionForUser } =
          await import("@/utils/warehouse/connections.server");
        const { listWarehouseTables } = await import("@/utils/warehouse/drivers.server");
        const conn = await loadWarehouseConnectionForUser(
          supabaseAdmin,
          { connectionId: data.connection_id },
          caller.userId,
        );
        const tables = await listWarehouseTables(conn.config);
        return {
          ok: true,
          tables: tables.slice(0, 5000).map((t) => ({ schema: t.schema, name: t.name })),
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Import from a connected source: a table or a SELECT, into a new lakehouse
 * table, opened as a table sheet.
 */
export const sheetsImportFromConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        connection_id: z.string().uuid(),
        query: z.string().trim().max(20_000).optional(),
        table: z.object({ schema: nameStr, name: nameStr }).strict().optional(),
        target_schema: nameStr,
        target_table: nameStr,
        sheet_name: z.string().trim().min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow; rows: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const nameProblem = tableNameProblem(data.sheet_name);
    if (nameProblem) return { ok: false, error: nameProblem };
    if (!data.query && !data.table) return { ok: false, error: "Pick a table or write a query" };
    try {
      const problem = await importTarget(caller.userId, data.target_schema, data.target_table);
      if (problem) return { ok: false, error: problem };
      const { data: connRow } = await supabaseAdmin
        .from("data_warehouse_connections")
        .select("provider")
        .eq("id", data.connection_id)
        .maybeSingle();
      const query =
        data.query ||
        selectAllFrom(connRow?.provider ?? "postgres", data.table!.schema, data.table!.name);
      const read = await readConnection(caller.userId, data.connection_id, query);
      if (!read.ok) return read;
      const rows = await landRows(
        data.target_schema,
        data.target_table,
        { json: toJsonRows(read.rows) },
        false,
      );
      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.import",
        resourceType: "lakehouse",
        resourceName: `${data.target_schema}.${data.target_table}`,
        detail: { via: "sheets", source_connection: read.connectionName, rows },
      });
      const tab = await addTableTab(caller.userId, {
        workbook_id: data.workbook_id,
        name: data.sheet_name,
        schema: data.target_schema,
        table: data.target_table,
        origin: {
          kind: "warehouse",
          connection_id: data.connection_id,
          connection_name: read.connectionName,
          query,
        },
      });
      if (!tab.ok) {
        return {
          ok: false,
          error: `${data.target_schema}.${data.target_table} was imported (${rows.toLocaleString()} rows), but the sheet was not added: ${tab.error}`,
        };
      }
      return { ...tab, rows };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

/** Import a CSV file into a new lakehouse table, opened as a table sheet. */
export const sheetsImportCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        filename: z.string().trim().min(1).max(255),
        csv: z.string().min(1),
        target_schema: nameStr,
        target_table: nameStr,
        sheet_name: z.string().trim().min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow; rows: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { sheetsUploadMaxMb } = await getPlatformResources();
    const mb = Buffer.byteLength(data.csv, "utf8") / 1_048_576;
    if (mb > sheetsUploadMaxMb) {
      return {
        ok: false,
        error: `${data.filename} is ${mb.toFixed(1)} MB; an upload can be at most ${sheetsUploadMaxMb} MB here (SHEETS_UPLOAD_MAX_MB). Put larger files in object storage and import them with an ETL pipeline.`,
      };
    }
    const nameProblem = tableNameProblem(data.sheet_name);
    if (nameProblem) return { ok: false, error: nameProblem };
    try {
      const problem = await importTarget(caller.userId, data.target_schema, data.target_table);
      if (problem) return { ok: false, error: problem };
      const rows = await landRows(data.target_schema, data.target_table, { csv: data.csv }, false);
      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.import",
        resourceType: "lakehouse",
        resourceName: `${data.target_schema}.${data.target_table}`,
        detail: { via: "sheets", source_file: data.filename, rows },
      });
      const tab = await addTableTab(caller.userId, {
        workbook_id: data.workbook_id,
        name: data.sheet_name,
        schema: data.target_schema,
        table: data.target_table,
        origin: { kind: "upload", filename: data.filename },
      });
      if (!tab.ok) {
        return {
          ok: false,
          error: `${data.target_schema}.${data.target_table} was imported (${rows.toLocaleString()} rows), but the sheet was not added: ${tab.error}`,
        };
      }
      return { ...tab, rows };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

/**
 * Re-run a connected import: the source query again, replacing the table
 * this sheet imported into. Only a sheet whose table came from a connection
 * can do this, and only in a schema the caller owns.
 */
export const sheetsRefreshImport = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenOnly.extend({ tab_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; rows: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const tab = await ownTableTab(caller.userId, data.tab_id);
      if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
      const parsed = tableConfigSchema.safeParse(tab.table_config);
      if (!parsed.success) return { ok: false, error: "This sheet's settings could not be read" };
      const cfg = parsed.data;
      if (cfg.origin?.kind !== "warehouse" || cfg.source.kind !== "lakehouse") {
        return {
          ok: false,
          error: "Only a table imported from a connection can be refreshed from it",
        };
      }
      const { schema, table } = cfg.source;
      const problem = await importTarget(caller.userId, schema, table, { replacing: true });
      if (problem) return { ok: false, error: problem };
      const read = await readConnection(caller.userId, cfg.origin.connection_id, cfg.origin.query);
      if (!read.ok) return read;
      const rows = await landRows(schema, table, { json: toJsonRows(read.rows) }, true);
      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.import",
        resourceType: "lakehouse",
        resourceName: `${cfg.source.schema}.${cfg.source.table}`,
        detail: { via: "sheets", refresh: true, source_connection: read.connectionName, rows },
      });
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

// ── Reading ────────────────────────────────────────────────────────────────

export type TablePage = {
  ok: true;
  columns: TableColumn[];
  /** Each row: the source row number, then one value per column. */
  rows: (string | number | boolean | null)[][];
  total: number;
  offset: number;
  /** The source's columns now, when they differ from the sheet's settings. */
  sourceColumns?: { name: string; type: string }[];
  duration_ms: number;
};

/**
 * One page of a table sheet. The config comes from the editor (so sorting
 * or adding a column shows at once, before the settings are saved); other
 * table sheets are read as saved.
 */
export const sheetsTablePage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        tab_id: z.string().uuid(),
        config: tableConfigSchema,
        offset: z.number().int().min(0).max(1_000_000_000),
        limit: z.number().int().min(1).max(100_000),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<TablePage | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const started = Date.now();
    const { sheetsPageRows } = await getPlatformResources();
    const limit = Math.min(data.limit, sheetsPageRows);
    let tab;
    try {
      tab = await ownTableTab(caller.userId, data.tab_id);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
    const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
    let cfg = data.config as TableConfig;
    let sourceColumns: { name: string; type: string }[] | undefined;
    try {
      // The source may have gained or lost columns since the sheet was made.
      // (A pivot's columns come from its definition, not a table.)
      if (data.offset === 0 && cfg.source.kind === "lakehouse") {
        const now = await describeSource(caller.userId, cfg.source.schema, cfg.source.table);
        const same =
          now.length === cfg.columns.length &&
          now.every((c, i) => c.name === cfg.columns[i].name && c.type === cfg.columns[i].type);
        if (!same) {
          sourceColumns = now;
          cfg = { ...cfg, columns: now };
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: `${sourceLabel(cfg.source)} can't be read: ${engineMessage(e)}`,
      };
    }
    let others: Map<string, OtherTable>;
    try {
      others = await otherTables(tab.workbook_id, tab.id);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const broken: Record<string, string> = {};
    const relation = () =>
      buildTableRelation(cfg, {
        name: tab.name,
        others: (n) => others.get(n.toLowerCase()),
        broken,
      });
    const run = (sql: string, rowCap: number) =>
      runLakehouseStatement(caller.userId, sql, {
        rowCap,
        auditVia: "sheets",
        useCache: !isVolatile(cfg),
      });
    try {
      let rel = relation();
      let res;
      try {
        res = await run(pageSql(rel, cfg, { offset: data.offset, limit }), limit);
      } catch (e) {
        if (!cfg.calculated.length || e instanceof TableQueryError) throw e;
        // A formula can fail at run time on some row (a cast, a lookup that
        // finds a list). Find which, show that column empty with the reason,
        // and still show the table.
        for (let i = 0; i < cfg.calculated.length; i++) {
          const name = cfg.calculated[i].name.trim();
          const partial = buildTableRelation(
            { ...cfg, calculated: cfg.calculated.slice(0, i + 1) },
            { name: tab.name, others: (n) => others.get(n.toLowerCase()), broken },
          );
          const col = partial.columns.find((c) => c.name === name);
          if (!col || col.error) continue;
          try {
            await run(
              `WITH ${partial.ctes.join(",\n")}\nSELECT count(${qid(name)}) FROM ${partial.last}`,
              1,
            );
          } catch (ce) {
            broken[name] = `This formula fails on some rows: ${engineMessage(ce)}`;
          }
        }
        if (!Object.keys(broken).length) throw e;
        rel = relation();
        res = await run(pageSql(rel, cfg, { offset: data.offset, limit }), limit);
      }
      let total = res.rows.length ? Number(res.rows[0][res.rows[0].length - 1]) : 0;
      if (!res.rows.length && data.offset > 0) {
        // Past the end: the window total is on no row, so count.
        const count = await run(pageSql(rel, cfg, { offset: 0, limit: 1 }), 1);
        total = count.rows.length ? Number(count.rows[0][count.rows[0].length - 1]) : 0;
      }
      return {
        ok: true,
        columns: rel.columns,
        rows: res.rows.map((r) => r.slice(0, -1)),
        total,
        offset: data.offset,
        ...(sourceColumns ? { sourceColumns } : {}),
        duration_ms: Date.now() - started,
      };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

/** A column's values and counts, for the filter list. */
export const sheetsTableValues = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({ tab_id: z.string().uuid(), config: tableConfigSchema, column: nameStr })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; values: { v: string | null; n: number }[]; more: boolean } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      let tab;
      try {
        tab = await ownTableTab(caller.userId, data.tab_id);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
      try {
        const others = await otherTables(tab.workbook_id, tab.id);
        const cfg = data.config as TableConfig;
        const rel = buildTableRelation(cfg, {
          name: tab.name,
          others: (n) => others.get(n.toLowerCase()),
        });
        const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
        const LIMIT = 1000;
        const r = await runLakehouseStatement(
          caller.userId,
          valuesSql(rel, cfg, data.column, LIMIT + 1),
          { rowCap: LIMIT + 1, auditVia: "sheets", useCache: !isVolatile(cfg) },
        );
        return {
          ok: true,
          values: r.rows.slice(0, LIMIT).map((row) => ({
            v: row[0] === null ? null : String(row[0]),
            n: Number(row[1]),
          })),
          more: r.rows.length > LIMIT,
        };
      } catch (e) {
        return { ok: false, error: engineMessage(e) };
      }
    },
  );

// ── Saving the settings ────────────────────────────────────────────────────

/**
 * Save a table sheet's settings (calculated columns, sort, filters, widths).
 * Versioned like a grid save: a newer version on the server is not written
 * over.
 */
export const sheetsSaveTableConfig = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        tab_id: z.string().uuid(),
        base_version: z.number().int().min(1),
        config: tableConfigSchema,
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; version: number } | (Fail & { conflict?: boolean; version?: number })
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const names = new Set<string>();
      for (const c of data.config.calculated) {
        const problem = columnNameProblem(c.name);
        if (problem) return { ok: false, error: `${c.name}: ${problem}` };
        const key = c.name.trim().toLowerCase();
        if (names.has(key) || data.config.columns.some((s) => s.name.toLowerCase() === key)) {
          return { ok: false, error: `There is already a column named "${c.name.trim()}"` };
        }
        names.add(key);
      }
      // FOUND IN R127. The settings came back whole from the browser and were
      // stored as sent, source and origin included: a sheet could be pointed
      // at any table and say it had uploaded it, and the lakehouse then
      // refused that table's owner (sheets/owned.server). Where the rows come
      // from is set only where the sheet is made; a save keeps what is stored.
      let stored;
      try {
        stored = await ownTableTab(caller.userId, data.tab_id);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!stored) return { ok: false, error: "This sheet no longer exists" };
      const kept = tableConfigSchema.safeParse(stored.table_config);
      if (!kept.success) return { ok: false, error: "This sheet's settings could not be read" };
      const config: TableConfig = {
        ...data.config,
        source: kept.data.source,
        origin: kept.data.origin,
      };
      const { data: rows, error } = await supabaseAdmin
        .from("sheet_tabs")
        .update({ table_config: config as unknown as Json, version: data.base_version + 1 })
        .eq("id", data.tab_id)
        .eq("user_id", caller.userId)
        .eq("kind", "table")
        .eq("version", data.base_version)
        .select("version");
      if (error) return { ok: false, error: `Could not save the sheet: ${error.message}` };
      if (rows?.length) return { ok: true, version: rows[0].version };
      let tab;
      try {
        tab = await ownTableTab(caller.userId, data.tab_id);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!tab) return { ok: false, error: "This sheet no longer exists" };
      return {
        ok: false,
        conflict: true,
        version: tab.version,
        error: `This sheet was saved elsewhere (version ${tab.version}) after you opened it (version ${data.base_version}). Reload it to see those changes; yours are not saved.`,
      };
    },
  );

// ── From the data catalog ──────────────────────────────────────────────────

export type SheetCatalogAsset = {
  id: string;
  fqn: string;
  name: string;
  schema: string | null;
  source: string;
  /** "lakehouse" opens in place; "warehouse" imports through the connection. */
  via: "lakehouse" | "warehouse" | "unsupported";
  row_count: number | null;
  description: string | null;
};

/** Tables in the data catalog the caller can see, for "Open from the catalog". */
export const sheetsCatalogAssets = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ search: z.string().trim().max(200).optional() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; assets: SheetCatalogAsset[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const { sb, sources } = await visibleCatalogSources(data.access_token);
      if (!sources.length) return { ok: true, assets: [] };
      const bySource = new Map(sources.map((s) => [s.id, s]));
      let q = sb
        .from("catalog_assets")
        .select("id, fqn, name, schema_name, source_id, row_count, description, asset_type, status")
        .in(
          "source_id",
          sources.map((s) => s.id),
        )
        .neq("status", "deleted")
        .order("fqn", { ascending: true })
        .limit(500);
      if (data.search) {
        // LIKE's own characters are escaped, not dropped: an underscore is
        // half of most table names, and searching "sheets_revenue" as
        // "sheets revenue" matched nothing.
        const term = data.search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
        if (term) q = q.ilike("fqn", `%${term}%`);
      }
      const { data: rows, error } = await q;
      if (error) return { ok: false, error: `Could not read the catalog: ${error.message}` };
      return {
        ok: true,
        assets: (rows ?? []).map((r) => {
          const src = bySource.get(r.source_id)!;
          const via: SheetCatalogAsset["via"] =
            src.kind !== "warehouse" || !src.connection_id
              ? "unsupported"
              : src.provider === "lakehouse"
                ? "lakehouse"
                : "warehouse";
          return {
            id: r.id,
            fqn: r.fqn,
            name: r.name,
            schema: r.schema_name,
            source: src.name,
            via,
            row_count: r.row_count,
            description: r.description,
          };
        }),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/**
 * Open a catalog table: a lakehouse table opens in place; a table in a
 * connected warehouse is imported through its connection first.
 */
export const sheetsOpenCatalogAsset = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        asset_id: z.string().uuid(),
        sheet_name: z.string().trim().min(1).max(100),
        target_schema: nameStr.optional(),
        target_table: nameStr.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow; rows?: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const { sb, sources } = await visibleCatalogSources(data.access_token);
      const { data: asset, error } = await sb
        .from("catalog_assets")
        .select("id, fqn, name, schema_name, source_id")
        .eq("id", data.asset_id)
        .maybeSingle();
      if (error) return { ok: false, error: `Could not read the catalog: ${error.message}` };
      const src = asset ? sources.find((s) => s.id === asset.source_id) : undefined;
      // An asset of a source the caller can't see is not there, as far as they know.
      if (!asset || !src) return { ok: false, error: "That catalog table was not found" };
      if (src.kind !== "warehouse" || !src.connection_id || !asset.schema_name) {
        return {
          ok: false,
          error: "Only tables from a database connection or the lakehouse can be opened as a sheet",
        };
      }
      const origin = { kind: "catalog" as const, asset_id: asset.id, fqn: asset.fqn };
      if (src.provider === "lakehouse") {
        return addTableTab(caller.userId, {
          workbook_id: data.workbook_id,
          name: data.sheet_name,
          schema: asset.schema_name,
          table: asset.name,
          origin,
        });
      }
      if (!data.target_schema || !data.target_table) {
        return { ok: false, error: "Name the lakehouse table the import lands in" };
      }
      const problem = await importTarget(caller.userId, data.target_schema, data.target_table);
      if (problem) return { ok: false, error: problem };
      const query = selectAllFrom(src.provider ?? "postgres", asset.schema_name, asset.name);
      const read = await readConnection(caller.userId, src.connection_id, query);
      if (!read.ok) return read;
      const rows = await landRows(
        data.target_schema,
        data.target_table,
        { json: toJsonRows(read.rows) },
        false,
      );
      const { auditEvent } = await import("@/utils/audit.server");
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.import",
        resourceType: "lakehouse",
        resourceName: `${data.target_schema}.${data.target_table}`,
        detail: { via: "sheets", catalog_asset: asset.fqn, rows },
      });
      const tab = await addTableTab(caller.userId, {
        workbook_id: data.workbook_id,
        name: data.sheet_name,
        schema: data.target_schema,
        table: data.target_table,
        origin: {
          kind: "warehouse",
          connection_id: src.connection_id,
          connection_name: read.connectionName,
          query,
        },
      });
      if (!tab.ok) {
        return {
          ok: false,
          error: `${data.target_schema}.${data.target_table} was imported (${rows.toLocaleString()} rows), but the sheet was not added: ${tab.error}`,
        };
      }
      return { ...tab, rows };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

// ── Grid formulas over table sheets ────────────────────────────────────────

const callArg: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ col: z.object({ table: nameStr, column: nameStr }).strict() }).strict(),
    z.object({ cols: z.object({ table: nameStr, from: nameStr, to: nameStr }).strict() }).strict(),
    z.object({ table: nameStr }).strict(),
    z.object({ call: callRequest }).strict(),
    z
      .object({
        value: z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]),
      })
      .strict(),
  ]),
);
const callRequest: z.ZodType<unknown> = z.lazy(() =>
  z.object({ fn: z.string().max(40), args: z.array(callArg).max(64) }).strict(),
);

/** A table call's answer: a value, or an Excel error with the reason. */
export type TableCallAnswer = { v: string | number | boolean | null } | { e: string; d?: string };

/**
 * Answer grid formulas over table sheets (SUMIFS, XLOOKUP, … on Orders[…])
 * in one lakehouse statement: the tables' relations as CTEs, one column per
 * call. A call that does not compile, or that fails on its own, answers
 * with its error without failing the others.
 */
export const sheetsTableCalls = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        calls: z
          .array(z.object({ key: z.string().max(20_000), req: callRequest }).strict())
          .min(1)
          .max(200),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; answers: Record<string, TableCallAnswer> } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const { data: wb, error: wbErr } = await supabaseAdmin
        .from("sheet_workbooks")
        .select("id")
        .eq("id", data.workbook_id)
        .eq("user_id", caller.userId)
        .maybeSingle();
      if (wbErr) return { ok: false, error: `Could not read the workbook: ${wbErr.message}` };
      if (!wb) return { ok: false, error: "This workbook does not exist, or is not yours" };
      const { compileColumnFormula } = await import("@/lib/sheets/sql/compile");
      const { callText, EMPTY_IS } = await import("@/lib/sheets/sql/tableCalls");
      const { workbookTables } = await import("@/lib/sheets/sql/tableQuery");
      const { parseDateText } = await import("@/lib/sheets/formula/values");
      const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
      let others: Map<string, OtherTable>;
      try {
        others = await otherTables(data.workbook_id, "");
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const answers: Record<string, TableCallAnswer> = {};
      type Compiled = { key: string; fn: string; sql: string; kind: string };
      const compiled: Compiled[] = [];
      const tables = workbookTables((n) => others.get(n.toLowerCase()));
      for (const { key, req } of data.calls as { key: string; req: TableCallRequest }[]) {
        try {
          const text = callText(req);
          const c = compileColumnFormula(`=${text}`, {
            columns: [],
            self: "(SELECT 1)",
            row: "p",
            table: tables.resolve,
          });
          compiled.push({ key, fn: req.fn, sql: c.sql, kind: c.kind });
        } catch (e) {
          answers[key] = { e: "#VALUE!", d: (e as Error).message };
        }
      }
      const toAnswer = (c: Compiled, raw: unknown): TableCallAnswer => {
        if (raw === null || raw === undefined) {
          const empty = EMPTY_IS[c.fn];
          return empty
            ? { e: empty, d: empty === "#N/A" ? "Not found" : "No values to average" }
            : { v: null };
        }
        if (c.kind === "number") return { v: Number(raw) };
        if (c.kind === "bool") return { v: Boolean(raw) };
        if (c.kind === "date" || c.kind === "datetime") {
          // Excel's dates are serial numbers; the cell shows one once formatted as a date.
          const serial = parseDateText(String(raw).replace(/\.\d+$/, ""));
          return serial === null ? { v: String(raw) } : { v: serial };
        }
        return { v: String(raw) };
      };
      const run = async (batch: Compiled[]) => {
        const sql =
          (tables.ctes.length ? `WITH ${tables.ctes.join(",\n")}\n` : "") +
          `SELECT ${batch.map((c, i) => `${c.sql} AS v${i}`).join(", ")}`;
        const r = await runLakehouseStatement(caller.userId, sql, {
          rowCap: 1,
          auditVia: "sheets",
        });
        batch.forEach((c, i) => (answers[c.key] = toAnswer(c, r.rows[0]?.[i] ?? null)));
      };
      if (compiled.length) {
        try {
          await run(compiled);
        } catch {
          // One call failing at run time fails the statement: ask each alone.
          for (const c of compiled) {
            try {
              await run([c]);
            } catch (e) {
              answers[c.key] = { e: "#VALUE!", d: engineMessage(e) };
            }
          }
        }
      }
      return { ok: true, answers };
    },
  );

// ── Pivots ─────────────────────────────────────────────────────────────────

const pivotSource = z
  .object({
    kind: z.literal("pivot"),
    from: nameStr,
    rows: z.array(nameStr).max(10),
    values: z
      .array(
        z
          .object({
            column: nameStr,
            agg: z.enum(["sum", "avg", "count", "count_distinct", "min", "max"]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/**
 * Add a pivot of a table sheet: rows grouped by some columns, others totalled.
 * The pivot is itself a table sheet, so it sorts, filters, takes calculated
 * columns, is looked up by grid formulas and saves to the lakehouse like any.
 * With `tab_id`, an existing pivot's definition is changed instead.
 */
export const sheetsSavePivot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        workbook_id: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        source: pivotSource,
        tab_id: z.string().uuid().optional(),
        base_version: z.number().int().min(1).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tab: SheetTabRow } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const problem = tableNameProblem(data.name);
    if (problem) return { ok: false, error: problem };
    const keys = data.source.rows.map((r) => r.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      return { ok: false, error: "A column can group the rows only once" };
    }
    const names = data.source.values.map((v) => `${v.agg}_${v.column}`.toLowerCase());
    if (new Set(names).size !== names.length) {
      return { ok: false, error: "The same total is listed twice" };
    }
    try {
      const { data: wb, error: wbErr } = await supabaseAdmin
        .from("sheet_workbooks")
        .select("id")
        .eq("id", data.workbook_id)
        .eq("user_id", caller.userId)
        .maybeSingle();
      if (wbErr) return { ok: false, error: `Could not read the workbook: ${wbErr.message}` };
      if (!wb) return { ok: false, error: "This workbook does not exist, or is not yours" };
      const others = await otherTables(data.workbook_id, data.tab_id ?? "");
      if (!others.has(data.source.from.toLowerCase())) {
        return { ok: false, error: `There is no table sheet named "${data.source.from}"` };
      }
      const draft: TableConfig = {
        source: data.source,
        columns: [],
        calculated: [],
        sort: [],
        filters: [],
        hidden: [],
        widths: {},
      };
      // Build and run it once with no rows: a pivot that cannot be computed
      // (a column that is gone, a lookup in a circle, no access) is refused
      // here rather than saved as a sheet that shows only an error.
      const rel = buildTableRelation(draft, {
        name: data.name,
        others: (n) => others.get(n.toLowerCase()),
      });
      const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
      await runLakehouseStatement(caller.userId, pageSql(rel, draft, { offset: 0, limit: 1 }), {
        rowCap: 1,
        auditVia: "sheets",
        useCache: false,
      });
      const config: TableConfig = {
        ...draft,
        columns: rel.columns.map((c) => ({ name: c.name, type: c.type })),
      };
      if (!data.tab_id) return insertTableTab(caller.userId, data.workbook_id, data.name, config);
      // Editing: keep the pivot's own sort, filters, calculated columns and
      // widths where their columns still exist.
      const tab = await ownTableTab(caller.userId, data.tab_id);
      if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
      const prev = tableConfigSchema.safeParse(tab.table_config);
      const has = (n: string) =>
        config.columns.some((c) => c.name.toLowerCase() === n.toLowerCase());
      const merged: TableConfig = prev.success
        ? {
            ...config,
            calculated: prev.data.calculated,
            sort: prev.data.sort.filter((x) => has(x.column)),
            filters: prev.data.filters.filter((x) => has(x.column)),
            hidden: prev.data.hidden.filter(has),
            widths: prev.data.widths,
          }
        : config;
      const { data: rows, error } = await supabaseAdmin
        .from("sheet_tabs")
        .update({ table_config: merged as unknown as Json, version: tab.version + 1 })
        .eq("id", data.tab_id)
        .eq("user_id", caller.userId)
        .eq("version", data.base_version ?? tab.version)
        .select("id, workbook_id, name, kind, position, grid, table_config, version, updated_at");
      if (error) return { ok: false, error: `Could not save the pivot: ${error.message}` };
      if (!rows?.length) {
        return {
          ok: false,
          error: "This pivot was changed elsewhere since you opened it; reload the workbook first",
        };
      }
      return { ok: true, tab: rows[0] as SheetTabRow };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

// ── Downloading ────────────────────────────────────────────────────────────

/**
 * A table sheet's rows for a download (.xlsx or .csv): the view the sheet
 * shows (its filters, sort and hidden columns), up to SHEETS_EXPORT_MAX_ROWS.
 * Read through the lakehouse like every other read, so grants, row and
 * column policies and audit apply to a download as they do to the screen.
 */
export const sheetsTableExport = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly.extend({ tab_id: z.string().uuid(), config: tableConfigSchema }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          columns: { name: string; kind: string }[];
          rows: (string | number | boolean | null)[][];
          truncated: boolean;
          maxRows: number;
        }
      | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const { sheetsExportMaxRows } = await getPlatformResources();
      let tab;
      try {
        tab = await ownTableTab(caller.userId, data.tab_id);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
      const cfg = data.config as TableConfig;
      try {
        const others = await otherTables(tab.workbook_id, tab.id);
        const rel = buildTableRelation(cfg, {
          name: tab.name,
          others: (n) => others.get(n.toLowerCase()),
        });
        const hidden = new Set(cfg.hidden.map((h) => h.toLowerCase()));
        const columns = rel.columns
          .filter((c) => !hidden.has(c.name.toLowerCase()))
          .map((c) => ({ name: c.name, kind: c.kind }));
        const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
        const res = await runLakehouseStatement(
          caller.userId,
          `${selectAllSql(rel, cfg)} LIMIT ${sheetsExportMaxRows + 1}`,
          { rowCap: sheetsExportMaxRows + 1, auditVia: "sheets", useCache: !isVolatile(cfg) },
        );
        const truncated = res.rows.length > sheetsExportMaxRows;
        return {
          ok: true,
          columns,
          rows: (truncated ? res.rows.slice(0, sheetsExportMaxRows) : res.rows) as (
            | string
            | number
            | boolean
            | null
          )[][],
          truncated,
          maxRows: sheetsExportMaxRows,
        };
      } catch (e) {
        return { ok: false, error: engineMessage(e) };
      }
    },
  );
