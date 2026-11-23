// One lakehouse table's columns, as a given person may see them.
//
// FOUND FROM THE UI (R525). Reading the whole lakehouse listing attaches every
// Iceberg mount first; one on an unreachable host held a dialog at "Reading…"
// for over a minute, every time. One table's columns come from one statement
// against that table, read through the same access check, and bounded: unread
// columns are said, not waited for. Shared by run fixes and by model
// proposals (R527).

/** How long a table's columns are waited for before saying they could not be read. */
export const COLUMNS_TIMEOUT_MS = 20_000;

export type TableColumn = { name: string; type: string };

/** The table's columns, or null when it cannot be read (missing, not theirs, or slow). */
export async function lakehouseTableColumns(
  userId: string,
  schema: string,
  table: string,
  auditVia: string,
): Promise<TableColumn[] | null> {
  try {
    const { runLakehouseStatement } = await import("@/utils/lakehouse/core.server");
    const { qualifiedTable } = await import("@/utils/dataMonitors/core");
    const res = await Promise.race([
      runLakehouseStatement(userId, `SELECT * FROM ${qualifiedTable(schema, table)} LIMIT 0`, {
        rowCap: 1,
        timeoutMs: COLUMNS_TIMEOUT_MS,
        auditVia,
        useCache: false,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COLUMNS_TIMEOUT_MS)),
    ]);
    return res ? res.columns.map((c) => ({ name: c.name, type: c.type })) : null;
  } catch {
    return null;
  }
}
