// The lakehouse tables a user may read, with their columns — one query for
// the ML wizard's source picker and the Data Prep palette, so the two can
// never disagree about what a user is allowed to see.
import { accessibleSchemas, lakehouseConnection, lakehouseEnabled } from "./core.server";

export type LakehouseTableColumns = {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
};

export type LakehouseSchemaAccess = {
  name: string;
  /** The caller owns it, so a flow or a model may write into it. */
  writable: boolean;
};

export async function listLakehouseTablesForUser(userId: string): Promise<{
  enabled: boolean;
  tables: LakehouseTableColumns[];
  schemas: LakehouseSchemaAccess[];
}> {
  if (!lakehouseEnabled()) return { enabled: false, tables: [], schemas: [] };
  const allowed = await accessibleSchemas(userId);
  const schemas = allowed.map((s) => ({
    name: s.name,
    writable: s.user_id === userId && !s.lake_source_id,
  }));
  if (!allowed.length) return { enabled: true, tables: [], schemas };
  // Same path as the Lakehouse overview: the engine connection, after the
  // access check above, because information_schema is not a user schema and
  // the per-user statement guard rightly refuses it.
  const inList = allowed.map((sch) => `'${sch.name.replace(/'/g, "''")}'`).join(", ");
  const c = await lakehouseConnection();
  const rows = await (
    await c.run(
      `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns ` +
        `WHERE table_catalog = 'lake' AND table_schema IN (${inList}) ` +
        `ORDER BY table_schema, table_name, ordinal_position`,
    )
  ).getRows();
  const map = new Map<string, LakehouseTableColumns>();
  for (const row of rows) {
    const schema = String(row[0]);
    const table = String(row[1]);
    const key = `${schema}.${table}`;
    const t = map.get(key) ?? { schema, table, columns: [] };
    t.columns.push({ name: String(row[2]), type: String(row[3]) });
    map.set(key, t);
  }
  return { enabled: true, tables: [...map.values()], schemas };
}
