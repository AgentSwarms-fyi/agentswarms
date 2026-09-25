// Server functions that take a sheet OUT: save a table sheet (its calculated
// columns, filters and sort included) or a grid range as a new lakehouse
// table, and register it in the data catalog so it is ready to consume:
// described, tagged, owned, its columns typed and PII-flagged, its lineage
// back to the tables it came from recorded.
//
// A save creates a table; it never replaces one (R101). The table is written
// through runLakehouseStatement where the SQL reads other tables, so what a
// person may copy is decided by the same grants and policies as any query.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { qid } from "@/lib/sheets/sql/compile";
import {
  buildTableRelation,
  lakehouseInputs,
  selectAllSql,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { nameStr, tableConfigSchema, tokenOnly } from "@/utils/sheets/schemas";
import {
  engineMessage,
  importTarget,
  otherTables,
  ownTableTab,
  resolveCaller,
  type Fail,
} from "@/utils/sheets/shared.server";

const COLUMN_TYPES = ["DOUBLE", "BIGINT", "VARCHAR", "BOOLEAN", "DATE", "TIMESTAMP"] as const;

const catalogMeta = {
  description: z.string().trim().max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  register: z.boolean(),
  /** Mark the catalog entry certified: ready for others to rely on. */
  certify: z.boolean().optional(),
};

export type SaveResult = {
  ok: true;
  fqn: string;
  rows: number;
  /** The catalog entry, when it was registered. */
  catalog?: { source_id: string; asset_id: string } | { error: string };
};

// ── The catalog ────────────────────────────────────────────────────────────

/**
 * The caller's lakehouse catalog source, made on first use: a lakehouse
 * connection (no credential; it runs as its owner) and a catalog source over
 * it, the same two rows the Data Catalog's own "Add source" creates.
 */
async function lakehouseCatalogSource(userId: string) {
  const { encryptJson } = await import("@/utils/providers/crypto.server");
  const existing = await supabaseAdmin
    .from("data_warehouse_connections")
    .select("id, name")
    .eq("user_id", userId)
    .eq("provider", "lakehouse")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw new Error(`Could not read your connections: ${existing.error.message}`);
  let conn = existing.data;
  if (!conn) {
    const credentials = (await encryptJson({ provider: "lakehouse", user_id: userId })) as Json;
    for (const name of ["Lakehouse", "Lakehouse (Sheets)", `Lakehouse ${Date.now() % 100000}`]) {
      const ins = await supabaseAdmin
        .from("data_warehouse_connections")
        .insert({
          user_id: userId,
          name,
          provider: "lakehouse",
          credentials,
          is_active: true,
          credentials_rotated_at: new Date().toISOString(),
        })
        .select("id, name")
        .single();
      if (!ins.error) {
        conn = ins.data;
        break;
      }
      if (ins.error.code !== "23505") {
        throw new Error(`Could not create the lakehouse connection: ${ins.error.message}`);
      }
    }
    if (!conn) throw new Error("Could not name the lakehouse connection");
  }
  const found = await supabaseAdmin
    .from("catalog_sources")
    .select("*")
    .eq("user_id", userId)
    .eq("kind", "warehouse")
    .eq("connection_id", conn.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (found.error) throw new Error(`Could not read your catalog: ${found.error.message}`);
  if (found.data) return found.data;
  for (const name of ["Lakehouse", "Lakehouse (Sheets)", `Lakehouse ${Date.now() % 100000}`]) {
    const ins = await supabaseAdmin
      .from("catalog_sources")
      .insert({ user_id: userId, kind: "warehouse", name, connection_id: conn.id })
      .select("*")
      .single();
    if (!ins.error) return ins.data;
    if (ins.error.code !== "23505") {
      throw new Error(`Could not create the catalog source: ${ins.error.message}`);
    }
  }
  throw new Error("Could not name the catalog source");
}

/**
 * Put schema.table in the catalog now, described and tagged, with lineage to
 * `upstream`, then re-crawl the lakehouse source in the background so the
 * rest of it is current too. The crawl keeps curation (description, tags,
 * column notes), so it does not undo what is written here.
 */
async function registerInCatalog(
  userId: string,
  schema: string,
  table: string,
  meta: { description?: string; tags?: string[]; upstream: string[]; certify?: boolean },
): Promise<{ source_id: string; asset_id: string }> {
  const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
  const { isPiiColumn, runCrawl, schemaHash } = await import("@/utils/catalog/crawler.server");
  const source = await lakehouseCatalogSource(userId);
  const described = await runLakehouseStatement(
    userId,
    `SELECT * FROM ${qid(schema)}.${qid(table)} LIMIT 5`,
    { rowCap: 5, auditVia: "sheets", useCache: false },
  );
  const count = await runLakehouseStatement(
    userId,
    `SELECT count(*) FROM ${qid(schema)}.${qid(table)}`,
    { rowCap: 1, auditVia: "sheets", useCache: false },
  );
  const columns = described.columns.map((c, i) => {
    const sample = described.rows.find((r) => r[i] !== null)?.[i];
    return {
      name: c.name,
      type: c.type,
      ...(sample !== undefined ? { sample: String(sample).slice(0, 80) } : {}),
      ...(isPiiColumn(c.name) ? { pii: true } : {}),
    };
  });
  const { data: user } = await supabaseAdmin.auth.admin.getUserById(userId);
  const fqn = `${schema}.${table}`;
  const tags = [...new Set(["sheets", ...(meta.tags ?? [])])];
  const { data: asset, error } = await supabaseAdmin
    .from("catalog_assets")
    .upsert(
      {
        user_id: userId,
        source_id: source.id,
        asset_type: "table",
        schema_name: schema,
        name: table,
        fqn,
        columns: columns as unknown as Json,
        row_count: Number(count.rows[0]?.[0] ?? 0),
        pii: columns.some((c) => c.pii),
        description: meta.description?.trim() || null,
        tags,
        owner: user?.user?.email ?? null,
        // The catalog's statuses are draft, certified and deprecated.
        status: meta.certify ? "certified" : "draft",
        schema_hash: schemaHash(columns),
        last_crawled_at: new Date().toISOString(),
      },
      { onConflict: "source_id,fqn" },
    )
    .select("id")
    .single();
  if (error || !asset) throw new Error(`Could not add it to the catalog: ${error?.message}`);
  const upstream = [...new Set(meta.upstream)].filter((u) => u.toLowerCase() !== fqn.toLowerCase());
  if (upstream.length) {
    // This table's edges are rewritten whole: a re-save from a different
    // sheet must not leave the old sheet's sources drawn as its inputs.
    const { error: clearErr } = await supabaseAdmin
      .from("catalog_lineage")
      .delete()
      .eq("downstream_fqn", fqn)
      .eq("source_system", "sheets")
      .eq("user_id", userId);
    if (clearErr) throw new Error(`Could not update its lineage: ${clearErr.message}`);
    const { error: linErr } = await supabaseAdmin.from("catalog_lineage").insert(
      upstream.map((up) => ({
        user_id: userId,
        source_id: source.id,
        upstream_fqn: up.slice(0, 512),
        downstream_fqn: fqn,
        source_system: "sheets",
        exact: true,
      })),
    );
    if (linErr) throw new Error(`Could not record its lineage: ${linErr.message}`);
  }
  if (source.status !== "crawling") {
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    void runCrawl(
      userId,
      source,
      async (connectionId) =>
        (await loadWarehouseConnectionForUser(supabaseAdmin, { connectionId }, userId)).config,
      async () => {
        throw new Error("A lakehouse source has no object storage");
      },
    ).catch((e) => console.warn("[sheets] catalog crawl after save failed:", (e as Error).message));
  }
  return { source_id: source.id, asset_id: asset.id };
}

// ── Saving a table sheet ───────────────────────────────────────────────────

/**
 * Save what a table sheet shows (calculated columns, filters and sort
 * applied, hidden columns left out) as a new lakehouse table.
 */
export const sheetsSaveTableAs = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        tab_id: z.string().uuid(),
        config: tableConfigSchema,
        target_schema: nameStr,
        target_table: nameStr,
        ...catalogMeta,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<SaveResult | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const tab = await ownTableTab(caller.userId, data.tab_id);
      if (!tab) return { ok: false, error: "This sheet does not exist, or is not yours" };
      const problem = await importTarget(caller.userId, data.target_schema, data.target_table);
      if (problem) return { ok: false, error: problem.replace("importing never", "saving never") };
      const others = await otherTables(tab.workbook_id, tab.id);
      const cfg = data.config as TableConfig;
      const rel = buildTableRelation(cfg, {
        name: tab.name,
        others: (n) => others.get(n.toLowerCase()),
      });
      const broken = rel.columns.filter(
        (c) => c.error && !cfg.hidden.some((h) => h.toLowerCase() === c.name.toLowerCase()),
      );
      if (broken.length) {
        return {
          ok: false,
          error: `Fix or hide ${broken.map((c) => c.name).join(", ")} first: ${broken[0].error}`,
        };
      }
      const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
      const target = `${qid(data.target_schema)}.${qid(data.target_table)}`;
      // Plain CREATE TABLE: if the name was taken since the check, this
      // fails rather than replacing the table.
      await runLakehouseStatement(
        caller.userId,
        `CREATE TABLE ${target} AS ${selectAllSql(rel, cfg)}`,
        { auditVia: "sheets" },
      );
      const counted = await runLakehouseStatement(caller.userId, `SELECT count(*) FROM ${target}`, {
        rowCap: 1,
        auditVia: "sheets",
        useCache: false,
      });
      const rows = Number(counted.rows[0]?.[0] ?? 0);
      const fqn = `${data.target_schema}.${data.target_table}`;
      let catalog: SaveResult["catalog"];
      if (data.register) {
        // Lineage: the table this sheet reads, and every table it looks up.
        const upstream = lakehouseInputs(cfg, (n) => others.get(n.toLowerCase()));
        try {
          catalog = await registerInCatalog(caller.userId, data.target_schema, data.target_table, {
            description: data.description,
            tags: data.tags,
            certify: data.certify,
            upstream,
          });
        } catch (e) {
          catalog = { error: (e as Error).message };
        }
      }
      return { ok: true, fqn, rows, ...(catalog ? { catalog } : {}) };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

// ── Saving a grid range ────────────────────────────────────────────────────

/**
 * Save a range of a grid sheet (its first row the header, the values as the
 * sheet computed them) as a new lakehouse table with the column types given.
 */
export const sheetsSaveGridAs = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        tab_id: z.string().uuid(),
        columns: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "lowercase identifier"),
                type: z.enum(COLUMN_TYPES),
              })
              .strict(),
          )
          .min(1)
          .max(500),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
        target_schema: nameStr,
        target_table: nameStr,
        ...catalogMeta,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<SaveResult | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const names = data.columns.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      return { ok: false, error: "Two columns have the same name; each header must be different" };
    }
    if (!data.rows.length) return { ok: false, error: "The range has a header but no rows" };
    if (data.rows.some((r) => r.length !== data.columns.length)) {
      return { ok: false, error: "Every row must have one value per column" };
    }
    const { sheetsMaxCells } = await getPlatformResources();
    if (data.rows.length * data.columns.length > sheetsMaxCells) {
      return {
        ok: false,
        error: `That is more than ${sheetsMaxCells.toLocaleString()} cells (SHEETS_MAX_CELLS)`,
      };
    }
    try {
      const { data: tab, error } = await supabaseAdmin
        .from("sheet_tabs")
        .select("id, workbook_id, name, kind, sheet_workbooks(name)")
        .eq("id", data.tab_id)
        .eq("user_id", caller.userId)
        .maybeSingle();
      if (error) return { ok: false, error: `Could not read the sheet: ${error.message}` };
      if (!tab || tab.kind !== "grid") return { ok: false, error: "This grid sheet was not found" };
      const problem = await importTarget(caller.userId, data.target_schema, data.target_table);
      if (problem) return { ok: false, error: problem.replace("importing never", "saving never") };
      // Staged as JSON objects and read back with the declared types, so a
      // column typed DATE is a DATE whatever the first rows happen to look like.
      const objects = data.rows.map((r) =>
        Object.fromEntries(data.columns.map((c, i) => [c.name, r[i]])),
      );
      const { lakehouseConnection } = await import("@/utils/lakehouse/core.server");
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "sheets-save-"));
      const file = join(dir, "rows.json");
      const path = file.replace(/\\/g, "/").replace(/'/g, "''");
      const spec = data.columns
        .map((c) => `'${c.name}': '${c.type === "BIGINT" ? "DOUBLE" : c.type}'`)
        .join(", ");
      const select = data.columns
        .map((c) =>
          c.type === "BIGINT"
            ? `CAST(round(${qid(c.name)}) AS BIGINT) AS ${qid(c.name)}`
            : qid(c.name),
        )
        .join(", ");
      const target = `${qid(data.target_schema)}.${qid(data.target_table)}`;
      const c = await lakehouseConnection();
      let rows = 0;
      try {
        await writeFile(file, JSON.stringify(objects), "utf8");
        await c.run(
          `CREATE TABLE ${target} AS SELECT ${select} FROM read_json('${path}', format = 'array', columns = {${spec}})`,
        );
        const counted = await (await c.run(`SELECT count(*) FROM ${target}`)).getRows();
        rows = Number(counted[0][0]);
      } finally {
        c.closeSync();
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      const { auditEvent } = await import("@/utils/audit.server");
      const workbookName =
        (tab as unknown as { sheet_workbooks?: { name?: string } }).sheet_workbooks?.name ?? "";
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.import",
        resourceType: "lakehouse",
        resourceName: `${data.target_schema}.${data.target_table}`,
        detail: { via: "sheets", from_grid: `${workbookName} / ${tab.name}`, rows },
      });
      const fqn = `${data.target_schema}.${data.target_table}`;
      let catalog: SaveResult["catalog"];
      if (data.register) {
        try {
          catalog = await registerInCatalog(caller.userId, data.target_schema, data.target_table, {
            description: data.description,
            tags: data.tags,
            certify: data.certify,
            upstream: [`sheets:${workbookName}/${tab.name}`],
          });
        } catch (e) {
          catalog = { error: (e as Error).message };
        }
      }
      return { ok: true, fqn, rows, ...(catalog ? { catalog } : {}) };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });

/** Re-crawl a saved table's catalog entry on demand ("Update the catalog"). */
export const sheetsRegisterTable = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    tokenOnly
      .extend({
        schema: nameStr,
        table: nameStr,
        description: catalogMeta.description,
        tags: catalogMeta.tags,
        certify: catalogMeta.certify,
        upstream: z.array(z.string().max(512)).max(50).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; source_id: string; asset_id: string } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
      const own = (await accessibleSchemas(caller.userId)).find(
        (s) => s.name === data.schema && s.user_id === caller.userId,
      );
      if (!own) return { ok: false, error: `You can only catalog tables in a schema you own` };
      const r = await registerInCatalog(caller.userId, data.schema, data.table, {
        description: data.description,
        tags: data.tags,
        upstream: data.upstream ?? [],
        certify: data.certify,
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: engineMessage(e) };
    }
  });
