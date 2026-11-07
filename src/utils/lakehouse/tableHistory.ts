// A table's own history, the pure half: which of the lakehouse's snapshots
// changed this table, in what way, and the statement that lists the rows a
// snapshot changed.
//
// FOUND IN R457. The table tab listed the last twelve snapshots of the whole
// lakehouse under "Snapshots", whatever table they touched, and each one
// offered "time-travel" on this table. On a lakehouse where anything else is
// being written, the twelve were mostly other tables' commits: a click
// queried this table as of a version where nothing about it had changed, and
// its real history was further back than the list reached.
//
// DuckLake names the table in a snapshot's `changes` map two ways, measured
// on DuckDB 1.5.5: by its table id (`tables_inserted_into`, `inlined_insert`,
// `inlined_delete`, `tables_deleted_from`, `tables_altered`, `flushed_inlined`)
// and by `schema.table` when the snapshot creates it, a rename included
// (`tables_created=[s.a2]` for a rename of s.a). The id survives a rename; a
// CREATE OR REPLACE makes a new table with a new id, and its history starts
// there.

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** What a snapshot did to one table, as words, from DuckLake's change keys. */
const KIND: Record<string, string> = {
  tables_created: "created",
  tables_inserted_into: "inserted",
  inlined_insert: "inserted",
  tables_deleted_from: "deleted",
  inlined_delete: "deleted",
  tables_altered: "altered",
  flushed_inlined: "flushed",
  merge_adjacent: "compacted",
  compacted_table: "compacted",
  tables_dropped: "dropped",
};

/**
 * The kinds of change a snapshot made to this table: its change map as the
 * engine's `to_json(changes)` writes it, the table's id and every
 * `schema.table` name it has had. An unknown key that names the table is
 * kept, spelled as DuckLake spells it.
 */
export function snapshotKinds(changesJson: string, tableId: string, names: string[]): string[] {
  let map: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(changesJson);
    if (parsed && typeof parsed === "object") map = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const lowered = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const values = Array.isArray(value) ? value.map(String) : [];
    const touches = values.includes(tableId) || values.some((v) => lowered.has(v.toLowerCase()));
    if (!touches) continue;
    const kind = KIND[key] ?? key.replace(/_/g, " ");
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

/** The current table's id and every name it has had, from DuckLake's catalog. */
export function tableIdentitySql(schema: string, table: string): string {
  return (
    `WITH cur AS (SELECT t.table_id FROM __ducklake_metadata_lake.ducklake_table t ` +
    `JOIN __ducklake_metadata_lake.ducklake_schema sc ON sc.schema_id = t.schema_id ` +
    `AND sc.end_snapshot IS NULL WHERE t.end_snapshot IS NULL ` +
    `AND sc.schema_name = ${lit(schema)} AND t.table_name = ${lit(table)}) ` +
    `SELECT t.table_id::VARCHAR AS id, sc.schema_name || '.' || t.table_name AS name, ` +
    `t.begin_snapshot::BIGINT AS since, t.end_snapshot IS NULL AS current ` +
    `FROM __ducklake_metadata_lake.ducklake_table t ` +
    `JOIN __ducklake_metadata_lake.ducklake_schema sc ON sc.schema_id = t.schema_id ` +
    `WHERE t.table_id IN (SELECT table_id FROM cur) ORDER BY since`
  );
}

/** The snapshots that changed one table, newest first. */
export function tableSnapshotsSql(tableId: string, names: string[], limit: number): string {
  const nameList = names.length ? `[${names.map(lit).join(", ")}]` : "[]::VARCHAR[]";
  return (
    `SELECT snapshot_id::BIGINT, snapshot_time::VARCHAR, to_json(changes)::VARCHAR, ` +
    `author, commit_message FROM lake.snapshots() ` +
    `WHERE list_contains(flatten(map_values(changes)), ${lit(tableId)}) ` +
    `OR list_has_any(flatten(map_values(changes)), ${nameList}) ` +
    `ORDER BY snapshot_id DESC LIMIT ${Math.max(1, Math.floor(limit))}`
  );
}

/** Kinds whose snapshot changed rows, so the change feed has something to show. */
export function changesRows(kinds: string[]): boolean {
  return kinds.includes("inserted") || kinds.includes("deleted");
}

/**
 * The rows one snapshot changed in a table: what was inserted, deleted, and
 * both sides of an update. DuckLake's change feed needs the table's current
 * name to exist at both ends of the range, so a snapshot from before the
 * table's last rename (or before it was created under this name) cannot be
 * asked: `since` is the snapshot that gave it this name.
 */
export function changeFeedSql(args: {
  schema: string;
  table: string;
  snapshot: number;
  rowCap: number;
}): string {
  const s = Math.floor(args.snapshot);
  return (
    `SELECT change_type, * EXCLUDE (change_type, snapshot_id, rowid), rowid AS _row_id ` +
    `FROM ducklake_table_changes('lake', ${lit(args.schema)}, ${lit(args.table)}, ${s}, ${s}) ` +
    `ORDER BY rowid, change_type LIMIT ${Math.max(1, Math.floor(args.rowCap)) + 1}`
  );
}

/** How many rows of each kind one snapshot changed. */
export function changeCountsSql(schema: string, table: string, snapshot: number): string {
  const s = Math.floor(snapshot);
  return (
    `SELECT change_type, count(*)::BIGINT FROM ducklake_table_changes('lake', ${lit(schema)}, ` +
    `${lit(table)}, ${s}, ${s}) GROUP BY 1 ORDER BY 1`
  );
}

/** The change kinds as people say them. */
export function describeChangeCounts(counts: Record<string, number>): string {
  const ins = counts.insert ?? 0;
  const del = counts.delete ?? 0;
  const upd = Math.max(counts.update_postimage ?? 0, counts.update_preimage ?? 0);
  const parts = [
    ins ? `${ins.toLocaleString()} inserted` : null,
    upd ? `${upd.toLocaleString()} updated` : null,
    del ? `${del.toLocaleString()} deleted` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no row changes";
}

/** `"schema"."table"`, for the messages a refusal quotes. */
export function qualified(schema: string, table: string): string {
  return `${ident(schema)}.${ident(table)}`;
}
