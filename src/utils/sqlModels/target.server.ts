/**
 * What stands at a SQL model's target before a build replaces it (R178).
 *
 * A build runs `DROP <other shape> IF EXISTS` and `CREATE OR REPLACE` at its
 * target. R103 made a new or renamed model find its name free when it is
 * saved, and R128 refused a table a sheet holds. Neither stopped a table made
 * at the target after the save (an import, an upload, a "Save as view", a
 * table someone created in SQL) from being replaced by the model's next
 * build, and a scheduled build does that unattended.
 *
 * So each build marks what it made with a comment, which DuckLake keeps in
 * its catalog, and a build replaces only its own mark. An object with no mark
 * is still the model's if it is no newer than the model's last successful
 * build: that is how a table built before builds left marks looks.
 */
import type { DuckDBConnection } from "@duckdb/node-api";

type Runner = Pick<DuckDBConnection, "run">;

/** The comment a build leaves on the table or view it made. */
export function builtMark(modelId: string): string {
  return `agentswarms: built by SQL model ${modelId}`;
}

export type TargetObject = {
  kind: "table" | "view";
  comment: string | null;
  /** When DuckLake's catalog began this object, in epoch ms; null when it cannot say. */
  createdMs: number | null;
  /**
   * The snapshot that began it has been expired: it is older than every
   * snapshot the catalog keeps (maintenance keeps a week of them).
   */
  beforeHistory: boolean;
};

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The table or view at schema.name in the lakehouse, if any, with its comment
 * and when it was made. Compared without case, as DuckDB resolves names.
 */
export async function targetObject(
  c: Runner,
  schema: string,
  name: string,
): Promise<TargetObject | null> {
  const found = await (
    await c.run(
      `SELECT 'table' AS kind, comment FROM duckdb_tables()
         WHERE database_name = 'lake' AND lower(schema_name) = lower(${sq(schema)})
           AND lower(table_name) = lower(${sq(name)})
       UNION ALL
       SELECT 'view' AS kind, comment FROM duckdb_views()
         WHERE database_name = 'lake' AND NOT internal AND lower(schema_name) = lower(${sq(schema)})
           AND lower(view_name) = lower(${sq(name)})`,
    )
  ).getRows();
  if (!found.length) return null;
  const kind = found[0][0] === "view" ? "view" : "table";
  const comment = found[0][1] == null ? null : String(found[0][1]);
  return { kind, comment, ...(await began(c, schema, name, kind)) };
}

/**
 * When the live table or view took its name, by DuckLake's snapshot clock.
 * FOUND IN R178's own round: maintenance expires snapshots older than a
 * week, so an older object's snapshot row is gone. That is not "unknown":
 * the object is older than all the history the catalog keeps.
 */
async function began(
  c: Runner,
  schema: string,
  name: string,
  kind: "table" | "view",
): Promise<Pick<TargetObject, "createdMs" | "beforeHistory">> {
  const [catalogTable, nameColumn] =
    kind === "table" ? ["ducklake_table", "table_name"] : ["ducklake_view", "view_name"];
  try {
    const rows = await (
      await c.run(
        `SELECT epoch_ms(snap.snapshot_time), snap.snapshot_id IS NULL
           FROM __ducklake_metadata_lake.${catalogTable} o
           JOIN __ducklake_metadata_lake.ducklake_schema s
             ON s.schema_id = o.schema_id AND s.end_snapshot IS NULL
           LEFT JOIN __ducklake_metadata_lake.ducklake_snapshot snap
             ON snap.snapshot_id = o.begin_snapshot
          WHERE o.end_snapshot IS NULL AND lower(s.schema_name) = lower(${sq(schema)})
            AND lower(o.${nameColumn}) = lower(${sq(name)})`,
      )
    ).getRows();
    if (!rows.length) return { createdMs: null, beforeHistory: false };
    const expired = rows[0][1] === true;
    return { createdMs: expired ? null : Number(rows[0][0]), beforeHistory: expired };
  } catch {
    return { createdMs: null, beforeHistory: false };
  }
}

export type ModelAtTarget = {
  id: string;
  schema_name: string;
  name: string;
  last_status: "built" | "failed" | "skipped" | null;
  last_run_at: string | null;
};

/**
 * Why a build must not replace what is at its target, or null when it may:
 * nothing is there, or this model made it. Anything it cannot place is
 * refused, so a doubt keeps someone's table rather than replacing it.
 */
export function targetRefusal(obj: TargetObject | null, model: ModelAtTarget): string | null {
  if (!obj) return null;
  if (obj.comment === builtMark(model.id)) return null;
  // Built before builds left a mark: no comment at all, after a successful
  // last build, and no newer than it. An object older than the catalog's kept
  // history cannot be dated against the build, and is taken as the model's:
  // that is how every table built before marks looks after a week.
  const lastBuilt =
    model.last_status === "built" && model.last_run_at ? Date.parse(model.last_run_at) : NaN;
  if (obj.comment === null && !Number.isNaN(lastBuilt)) {
    if (obj.createdMs !== null ? obj.createdMs <= lastBuilt : obj.beforeHistory) return null;
  }
  return (
    `A ${obj.kind} named ${model.schema_name}.${model.name} is at this model's target, and this ` +
    `model did not build it: the build would replace it. Rename the model, or rename or drop ` +
    `that ${obj.kind}.`
  );
}

/** The statement that marks what a build made. */
export function markStatement(
  kind: "TABLE" | "VIEW",
  quotedTarget: string,
  modelId: string,
): string {
  return `COMMENT ON ${kind} ${quotedTarget} IS ${sq(builtMark(modelId))}`;
}
