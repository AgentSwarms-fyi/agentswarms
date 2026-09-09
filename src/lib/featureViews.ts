// Feature views — the pure part: what a view is, what a key is, and the SQL
// that turns a set of keys into feature rows.
//
// NO IMPORTS, so the editor, the lookup and the tests all read the same rules.
//
// The whole point of this file is that the caller stops computing features.
// Everything here is therefore about being exact: which columns come back, in
// what order, matched to which key, and what happens when a key matches
// nothing or matches twice. A feature store that quietly picks one of two rows
// is worse than one that refuses, because the number it returns looks fine.

export type FeatureView = {
  id: string;
  name: string;
  schema_name: string;
  table_name: string;
  key_columns: string[];
  /** Empty means every column that is not a key. */
  feature_columns: string[];
  /** When set, the latest row per key wins; absent, a duplicate key is an error. */
  timestamp_column: string | null;
};

/** One row's worth of key values, e.g. `{ customer_id: "c-1" }`. */
export type FeatureKey = Record<string, string | number | boolean | null>;

export const MAX_KEYS_PER_LOOKUP = 200;
export const VIEW_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** A column name we are willing to put in SQL. Nothing else is quoted in. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function validateViewName(name: string): string | null {
  if (!name.trim()) return "Give the feature view a name";
  if (!VIEW_NAME_RE.test(name)) {
    return "A name is lower case letters, digits and underscores, starting with a letter or underscore";
  }
  return null;
}

/**
 * Double-quote an identifier for DuckDB.
 *
 * Callers must ALSO have checked it against `IDENT_RE` — quoting makes a name
 * safe to interpolate, and the check is what keeps a column list from becoming
 * an injection surface in the first place.
 */
export function qi(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** Single-quote a literal. */
export function ql(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function validateView(v: {
  name: string;
  schema_name: string;
  table_name: string;
  key_columns: string[];
  feature_columns: string[];
  timestamp_column: string | null;
}): string | null {
  const nameError = validateViewName(v.name);
  if (nameError) return nameError;
  if (!v.schema_name || !v.table_name) return "Choose the table the features live in";
  if (v.key_columns.length === 0) return "Name at least one column that identifies a row";
  for (const c of [...v.key_columns, ...v.feature_columns, v.timestamp_column ?? ""]) {
    if (c && !IDENT_RE.test(c)) return `"${c}" is not a column name`;
  }
  const dupes = v.key_columns.filter((c) => v.feature_columns.includes(c));
  if (dupes.length) {
    // A key is what you look a row up BY. Feeding it back in as a feature
    // teaches the model to memorise identifiers, which scores beautifully in
    // training and predicts nothing.
    return `${dupes.join(", ")} cannot be both a key and a feature`;
  }
  if (new Set(v.key_columns).size !== v.key_columns.length) {
    return "A key column is listed twice";
  }
  return null;
}

/** The table a view reads, as SQL. */
export function viewTable(v: Pick<FeatureView, "schema_name" | "table_name">): string {
  return `${qi(v.schema_name)}.${qi(v.table_name)}`;
}

export function viewTableLabel(v: Pick<FeatureView, "schema_name" | "table_name">): string {
  return `${v.schema_name}.${v.table_name}`;
}

/** Every key in a batch must name exactly the view's key columns. */
export function validateKeys(
  view: Pick<FeatureView, "key_columns">,
  keys: FeatureKey[],
): string | null {
  if (!Array.isArray(keys) || keys.length === 0) return "keys must be a non-empty array";
  if (keys.length > MAX_KEYS_PER_LOOKUP) {
    return `Too many keys: ${keys.length} (the limit is ${MAX_KEYS_PER_LOOKUP})`;
  }
  for (const k of keys) {
    if (!k || typeof k !== "object" || Array.isArray(k)) return "each key must be an object";
    for (const col of view.key_columns) {
      if (!(col in k)) return `every key needs ${view.key_columns.join(" and ")}`;
      const v = k[col];
      if (v === null || v === undefined) return `${col} cannot be null in a key`;
      if (typeof v === "object") return `${col} must be a string, number or boolean`;
    }
  }
  return null;
}

/** A key rendered the one way, so a lookup and its result agree on identity. */
export function keyFingerprint(view: Pick<FeatureView, "key_columns">, key: FeatureKey): string {
  return view.key_columns.map((c) => `${c}=${String(key[c])}`).join("|");
}

/**
 * The SELECT that reads features for a set of keys.
 *
 * A column LIST, never `SELECT *`: what comes back is exactly what the view
 * declares, so a column added to the table later cannot silently become a
 * feature the model never trained on.
 *
 * Keys are matched with an OR of AND-ed equalities rather than an IN over a
 * tuple, because the composite-tuple form is not portable and this reads the
 * same for one key column or four. Values are literals — the lookup runs
 * through the governed chokepoint, which parses the statement, so a bound
 * parameter is not available to us here; every value is escaped and every
 * identifier is checked against a strict pattern before it is quoted.
 *
 * With a timestamp column the newest row per key wins, resolved by a window
 * function rather than by reading everything and picking in JavaScript.
 */
export function lookupSql(
  view: FeatureView,
  keys: FeatureKey[],
  opts?: { limit?: number },
): string {
  const cols = [...view.key_columns, ...view.feature_columns];
  const selected = cols.map(qi).join(", ");
  const where = keys
    .map(
      (k) =>
        "(" +
        view.key_columns
          .map((c) => {
            const v = k[c];
            const lit = typeof v === "number" || typeof v === "boolean" ? String(v) : ql(String(v));
            return `${qi(c)} = ${lit}`;
          })
          .join(" AND ") +
        ")",
    )
    .join(" OR ");
  const limit = opts?.limit ?? MAX_KEYS_PER_LOOKUP;

  if (view.timestamp_column) {
    const partition = view.key_columns.map(qi).join(", ");
    return (
      `SELECT ${selected} FROM (` +
      `SELECT ${selected}, row_number() OVER (PARTITION BY ${partition} ` +
      `ORDER BY ${qi(view.timestamp_column)} DESC) AS _fv_rn ` +
      `FROM ${viewTable(view)} WHERE ${where}` +
      `) WHERE _fv_rn = 1 LIMIT ${limit}`
    );
  }
  // No timestamp: one extra row is fetched deliberately, so a duplicate key
  // can be REPORTED rather than resolved by whichever row arrived first.
  return `SELECT ${selected} FROM ${viewTable(view)} WHERE ${where} LIMIT ${limit + 1}`;
}

export type Resolution = {
  /** One row per key that matched, keyed the same way the request was. */
  rows: Record<string, unknown>[];
  /** Keys that matched nothing, as fingerprints. */
  missing: string[];
  /** Keys that matched more than one row, when the view has no timestamp. */
  duplicated: string[];
};

/**
 * Match the rows a lookup returned back to the keys that were asked for.
 *
 * Done here rather than trusting result order, because a SELECT makes no
 * promise about which row comes back first and a feature attributed to the
 * wrong key is the worst failure this component has.
 */
export function resolveRows(
  view: FeatureView,
  keys: FeatureKey[],
  rows: Record<string, unknown>[],
): Resolution {
  const byPrint = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const print = keyFingerprint(view, row as FeatureKey);
    byPrint.set(print, [...(byPrint.get(print) ?? []), row]);
  }
  const out: Resolution = { rows: [], missing: [], duplicated: [] };
  for (const key of keys) {
    const print = keyFingerprint(view, key);
    const matched = byPrint.get(print) ?? [];
    if (matched.length === 0) out.missing.push(print);
    else {
      if (matched.length > 1 && !view.timestamp_column) out.duplicated.push(print);
      out.rows.push(matched[0]);
    }
  }
  return out;
}

/** What to tell a caller whose keys did not all resolve. */
export function resolutionError(view: FeatureView, r: Resolution): string | null {
  if (r.duplicated.length) {
    return (
      `${view.name} has more than one row for ${r.duplicated.slice(0, 3).join(", ")}. ` +
      `Give the view a timestamp column so the latest row wins, or make the key unique.`
    );
  }
  if (r.rows.length === 0) {
    return `No features found for ${r.missing.slice(0, 3).join(", ")} in ${view.name}`;
  }
  return null;
}

// ── Point-in-time training sets ─────────────────────────────────────────────
//
// Serving asks "what are this entity's features NOW". Training has to ask a
// harder question: "what were they at the moment this label was true?" — and
// the difference between the two is the most expensive mistake in applied ML.
//
// Join a label from February to the feature table's latest row and the model
// learns from June's numbers. It scores beautifully in the notebook, because
// the answer was in the features, and then it fails in production where June
// has not happened yet. Nothing about that failure looks like a bug: the code
// ran, the metric was high, and the leak is invisible unless somebody thought
// about time.
//
// An ASOF join asks the right question directly. For each spine row it takes
// the feature row with the greatest timestamp AT OR BEFORE that row's own
// timestamp, per key — so a label can only ever see its own past.

/** The spine: the labels a training set is built around, and when each was true. */
export type TrainingSpine = {
  schema_name: string;
  table_name: string;
  /** The moment each label was true. Features after it are the future. */
  timestamp_column: string;
  /** Spine column per view key column, in the view's key order. */
  key_columns: string[];
  /** Optional SQL filter on the spine, e.g. `label_at >= DATE '2024-01-01'`. */
  where?: string | null;
};

export type TrainingSetPlan = {
  /** How stale a feature row may be and still be joined. Null = no bound. */
  maxAgeDays?: number | null;
  /** Keep spine rows whose features were not found yet. */
  keepUnmatched?: boolean;
};

/**
 * Why this view cannot build a training set, or null.
 *
 * A view with no timestamp has no "as of" to join on — every row is simply
 * current — so the honest answer is to say so rather than to join the latest
 * row and call the result a training set.
 */
export function trainingSetError(
  view: FeatureView,
  spine: TrainingSpine,
  featureColumns: string[],
): string | null {
  if (!view.timestamp_column) {
    return `${view.name} has no timestamp column, so there is no "as of" to join on. Set one on the view — it is the column that says when each feature row became true.`;
  }
  if (spine.key_columns.length !== view.key_columns.length) {
    return `${view.name} is keyed by ${view.key_columns.length} column(s); map one spine column to each`;
  }
  for (const c of [...spine.key_columns, spine.timestamp_column]) {
    if (!c || !IDENT_RE.test(c)) return `"${c}" is not a column name`;
  }
  if (!IDENT_RE.test(spine.schema_name) || !IDENT_RE.test(spine.table_name)) {
    return "The label table's schema and name must be plain identifiers";
  }
  // Every spine column travels into the training set, so a feature that shares
  // a name with one of them would produce two columns called the same thing —
  // and the trainer would read whichever the engine handed it.
  const clash = featureColumns.filter(
    (f) => spine.key_columns.includes(f) || f === spine.timestamp_column,
  );
  if (clash.length) {
    return `The label table already has a column named ${clash[0]}. Rename it, or drop it from the view's features, so the training set has one column of that name.`;
  }
  return null;
}

/**
 * The point-in-time training set: every spine row, with the features that
 * were true for its key at its own timestamp.
 *
 * `featureColumns` is resolved by the caller (a view with none means "every
 * column that is not a key"), because only the server knows the table.
 */
export function trainingSetSql(
  view: FeatureView,
  spine: TrainingSpine,
  featureColumns: string[],
  plan: TrainingSetPlan = {},
): string {
  const ts = qi(view.timestamp_column as string);
  const on = view.key_columns
    .map((k, i) => `s.${qi(spine.key_columns[i])} = f.${qi(k)}`)
    // The inequality goes last: it is the one ASOF resolves, and everything
    // before it is an ordinary equality on the key.
    .concat(`s.${qi(spine.timestamp_column)} >= f.${ts}`)
    .join(" AND ");
  const selected = ["s.*", ...featureColumns.map((c) => `f.${qi(c)}`)].join(", ");
  // LEFT by default: a spine row whose key has no feature yet is a real part
  // of the training set, and silently dropping it changes what the model is
  // trained on without saying so.
  const kind = plan.keepUnmatched === false ? "ASOF JOIN" : "ASOF LEFT JOIN";
  let sql =
    `SELECT ${selected} FROM ${qi(spine.schema_name)}.${qi(spine.table_name)} s ` +
    `${kind} ${viewTable(view)} f ON ${on}`;
  const bounds: string[] = [];
  if (spine.where?.trim()) bounds.push(`(${spine.where.trim()})`);
  if (plan.maxAgeDays && plan.maxAgeDays > 0) {
    // A feature from two years before the label is not a feature, it is
    // history. Unmatched rows keep their NULLs rather than disappearing.
    const age = Math.floor(plan.maxAgeDays);
    bounds.push(
      `(f.${ts} IS NULL OR f.${ts} >= s.${qi(spine.timestamp_column)} - INTERVAL ${age} DAY)`,
    );
  }
  if (bounds.length) sql += ` WHERE ${bounds.join(" AND ")}`;
  return sql;
}

/**
 * The same question asked the wrong way — the latest row per key, regardless
 * of when the label was true. Kept so the UI can show both answers side by
 * side: seeing a February label carry a June feature is what makes the
 * problem land, and it is the join most people write by hand.
 */
export function leakyJoinSql(
  view: FeatureView,
  spine: TrainingSpine,
  featureColumns: string[],
): string {
  const partition = view.key_columns.map(qi).join(", ");
  const ts = qi(view.timestamp_column as string);
  const on = view.key_columns
    .map((k, i) => `s.${qi(spine.key_columns[i])} = f.${qi(k)}`)
    .join(" AND ");
  const selected = ["s.*", ...featureColumns.map((c) => `f.${qi(c)}`)].join(", ");
  return (
    `SELECT ${selected} FROM ${qi(spine.schema_name)}.${qi(spine.table_name)} s ` +
    `LEFT JOIN (SELECT *, row_number() OVER (PARTITION BY ${partition} ORDER BY ${ts} DESC) AS _fv_rn ` +
    `FROM ${viewTable(view)}) f ON ${on} AND f._fv_rn = 1`
  );
}
