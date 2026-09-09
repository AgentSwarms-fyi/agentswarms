/**
 * Building a training set from a feature view, point-in-time correct.
 *
 * Everything runs through `runLakehouseStatement` for the same reason the
 * lookup path does: that chokepoint applies the owner's schema access,
 * rewrites row-level policies into the query, and writes the audit row. A
 * training set is a read of two tables and a write of a third, and all three
 * have to be ones the caller may touch.
 *
 * The result is an ordinary lakehouse table. Nothing here schedules or
 * refreshes it, on purpose: a training set is a snapshot of what was true, and
 * a training set that changes under a model is not a record of anything.
 */
import {
  leakyJoinSql,
  trainingSetError,
  trainingSetSql,
  qi,
  type FeatureView,
  type TrainingSetPlan,
  type TrainingSpine,
} from "@/lib/featureViews";
import { auditEvent } from "@/utils/audit.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";
import { describeViewTable } from "@/utils/featureViews/lookup.server";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The feature columns this view contributes: the ones it names, or every
 * column of its table that is not a key and not the timestamp.
 *
 * The timestamp is excluded deliberately. It is the join's instrument, not a
 * feature, and a model that trains on it learns the shape of your ETL
 * schedule.
 */
export async function resolveFeatureColumns(
  userId: string,
  view: FeatureView,
): Promise<{ ok: true; columns: string[] } | { ok: false; error: string }> {
  if (view.feature_columns.length) return { ok: true, columns: view.feature_columns };
  const described = await describeViewTable(userId, view.schema_name, view.table_name);
  if (!described.ok) return described;
  const excluded = new Set([...view.key_columns, view.timestamp_column ?? ""]);
  const columns = described.columns.map((c) => c.name).filter((n) => !excluded.has(n));
  if (!columns.length) {
    return { ok: false, error: `${view.name} has no feature columns besides its key` };
  }
  return { ok: true, columns };
}

export type TrainingSetResult = {
  schema: string;
  table: string;
  rows: number;
  /** Spine rows that found no feature at or before their own timestamp. */
  unmatched: number;
  /** How many rows a naive latest-row join would have answered differently. */
  leaked: number | null;
  sql: string;
};

/**
 * Build the training set into `output`, then measure it.
 *
 * The leak count is the point of the whole feature: it is how many rows would
 * have carried a feature from their own future had the obvious join been
 * written by hand. Reporting it costs one extra query and turns "trust me"
 * into a number.
 */
export async function buildTrainingSet(args: {
  userId: string;
  view: FeatureView;
  spine: TrainingSpine;
  output: { schema: string; table: string };
  plan?: TrainingSetPlan;
  /** Skip the comparison query when the caller only wants the table. */
  measureLeak?: boolean;
}): Promise<{ ok: true; result: TrainingSetResult } | { ok: false; error: string }> {
  const { userId, view, spine, output } = args;
  if (!IDENT_RE.test(output.schema) || !IDENT_RE.test(output.table)) {
    return { ok: false, error: "The output schema and table must be plain identifiers" };
  }
  const resolved = await resolveFeatureColumns(userId, view);
  if (!resolved.ok) return resolved;
  const features = resolved.columns;

  const invalid = trainingSetError(view, spine, features);
  if (invalid) return { ok: false, error: invalid };

  const select = trainingSetSql(view, spine, features, args.plan ?? {});
  const target = `${qi(output.schema)}.${qi(output.table)}`;
  try {
    // One statement, so anyone reading the table sees the old rows or the new
    // ones — never a half-built training set.
    await runLakehouseStatement(userId, `CREATE OR REPLACE TABLE ${target} AS ${select}`, {
      auditVia: "feature-training-set",
      useCache: false,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const count = async (sql: string): Promise<number> => {
    const res = await runLakehouseStatement(userId, sql, {
      rowCap: 1,
      auditVia: "feature-training-set",
      useCache: false,
    });
    return Number((res.rows as unknown[][])[0]?.[0] ?? 0);
  };

  let rows = 0;
  let unmatched = 0;
  let leaked: number | null = null;
  try {
    rows = await count(`SELECT count(*) FROM ${target}`);
    // A feature column is NULL for a row that had no feature at its own
    // moment; the first one is enough to count them.
    unmatched = await count(`SELECT count(*) FROM ${target} WHERE ${qi(features[0])} IS NULL`);
    if (args.measureLeak !== false) {
      const leaky = leakyJoinSql(view, spine, features);
      // Rows where the honest answer and the obvious one differ: what a
      // hand-written join would have taught the model that it could not know.
      leaked = await count(
        `SELECT count(*) FROM (${select}) pit JOIN (${leaky}) naive USING (${spine.key_columns
          .map(qi)
          .join(", ")}, ${qi(spine.timestamp_column)}) ` +
          `WHERE pit.${qi(features[0])} IS DISTINCT FROM naive.${qi(features[0])}`,
      );
    }
  } catch {
    // Measuring is a courtesy; a training set that built is still built.
  }

  auditEvent({
    userId,
    action: "feature_view.training_set",
    resourceType: "feature_view",
    resourceId: view.id,
    resourceName: view.name,
    detail: {
      spine: `${spine.schema_name}.${spine.table_name}`,
      output: `${output.schema}.${output.table}`,
      as_of: spine.timestamp_column,
      features: features.length,
      rows,
      unmatched,
      leaked_rows_avoided: leaked,
      max_age_days: args.plan?.maxAgeDays ?? null,
    },
  });

  return {
    ok: true,
    result: { schema: output.schema, table: output.table, rows, unmatched, leaked, sql: select },
  };
}
