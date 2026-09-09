// The physical layout of a lakehouse table, reasoned about from DuckLake's
// own per-file column statistics: how many files a lookup has to open, what a
// rewrite in key order would change, and which column is worth it. Pure —
// the server module reads the catalog and the query history and feeds it.

/** One data file's range for one column, as the DuckLake catalog keeps it. */
export type FileRange = {
  file_id: number;
  rows: number;
  bytes: number;
  /** Text as stored; typed by `rangeValue`. Null when the file has no value. */
  min: string | null;
  max: string | null;
  nulls: number;
};

export type ColumnLayout = {
  name: string;
  type: string;
  /** Files a point lookup on this column opens on average, out of `files`. */
  touched: number;
  files: number;
  /** 1 = a lookup opens one file, 0 = it opens them all; null below two files. */
  skip: number | null;
  nulls: number;
};

export type LayoutAdvice = {
  kind: "compact" | "cluster" | "recluster" | "ok";
  title: string;
  detail: string;
  columns?: string[];
};

const NUMERIC = /INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL/i;
const TEMPORAL = /^(DATE|TIMESTAMP|TIME)/i;

/** A stored min/max in the column's own order, so "less than" means what the engine means. */
export function rangeValue(raw: string | null, type: string): number | string | null {
  if (raw === null || raw === undefined) return null;
  if (NUMERIC.test(type)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (TEMPORAL.test(type)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : raw;
  }
  if (/BOOL/i.test(type)) return raw === "true" ? 1 : 0;
  return raw;
}

function compare(x: number | string, y: number | string): number {
  if (typeof x === "number" && typeof y === "number") return x - y;
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

type Span = { lo: number | string | null; hi: number | string | null };

/** A file without a range cannot be ruled out, so it overlaps everything. */
function overlaps(a: Span, b: Span): boolean {
  if (a.lo === null || a.hi === null || b.lo === null || b.hi === null) return true;
  return !(compare(a.hi, b.lo) < 0 || compare(b.hi, a.lo) < 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How a lookup on this column fares: for every file, the files whose range
 * intersects its own — including itself — averaged. Sorted, disjoint files
 * score one; files that all span the whole domain score all of them. The
 * skip ratio maps that onto 0..1 so two tables of different sizes compare.
 */
export function columnLayout(name: string, type: string, ranges: FileRange[]): ColumnLayout {
  const files = ranges.length;
  const spans: Span[] = ranges.map((r) => ({
    lo: rangeValue(r.min, type),
    hi: rangeValue(r.max, type),
  }));
  let total = 0;
  for (const a of spans) for (const b of spans) if (overlaps(a, b)) total += 1;
  const touched = files ? total / files : 0;
  const skip = files >= 2 ? Math.min(1, Math.max(0, 1 - (touched - 1) / (files - 1))) : null;
  return {
    name,
    type,
    touched: round2(touched),
    files,
    skip: skip === null ? null : round2(skip),
    nulls: ranges.reduce((s, r) => s + r.nulls, 0),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OPS = String.raw`(=|<>|!=|<=?|>=?|\bBETWEEN\b|\bIN\b|\bLIKE\b|\bIS\b)`;

/**
 * The columns a statement filters on, when it reads this table. A column
 * counts when it appears — bare or qualified — before a comparison anywhere
 * from the first WHERE, ON, HAVING or QUALIFY on. Approximate on purpose:
 * this ranks candidates for a human, it does not decide anything alone.
 */
export function filteredColumns(sql: string, table: string, columns: string[]): string[] {
  const s = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const mentions = new RegExp(`(^|[^A-Za-z0-9_])"?${escapeRe(table)}"?([^A-Za-z0-9_]|$)`, "i");
  if (!mentions.test(s)) return [];
  const at = s.search(/\bWHERE\b|\bON\b|\bHAVING\b|\bQUALIFY\b/i);
  if (at < 0) return [];
  const tail = s.slice(at);
  const name = (col: string) => `(?:"?[A-Za-z0-9_]+"?\\.)?"?${escapeRe(col)}"?`;
  return columns.filter(
    (col) =>
      // The column before the comparison: `o.order_date >= …`
      new RegExp(`(?:^|[^A-Za-z0-9_."])${name(col)}\\s*${OPS}`, "i").test(tail) ||
      // …or after it, as a join key or a reversed predicate: `c.id = orders.customer`
      new RegExp(`${OPS}\\s*${name(col)}(?![A-Za-z0-9_"])`, "i").test(tail),
  );
}

/** `"schema"."table"` — identifiers already validated by the caller. */
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** A cut value as a SQL literal in the key's own type. */
export function keyLiteral(value: string, type: string): string {
  if (NUMERIC.test(type) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim()))
    return value.trim();
  return `'${value.replace(/'/g, "''")}'::${type}`;
}

/**
 * The statements of a clustered rewrite, one transaction: the table's rows,
 * ranged on the first key at the given cuts, each range copied aside in key
 * order, deleted, and inserted back — so every new file holds one range and
 * the catalog's min/max per file no longer overlap. Rows with a null first
 * key form the last range. DuckLake drops a file whose rows were all deleted
 * in the same transaction, so the old layout leaves nothing behind but the
 * snapshot history.
 */
export function rewriteStatements(args: {
  schema: string;
  table: string;
  keys: string[];
  keyType: string;
  cuts: string[];
}): string[] {
  const target = `${qi(args.schema)}.${qi(args.table)}`;
  const first = qi(args.keys[0]);
  const order = args.keys.map(qi).join(", ");
  const cuts = [...new Set(args.cuts)];
  const ranges: string[] = [];
  if (cuts.length === 0) ranges.push(`${first} IS NOT NULL`);
  for (let i = 0; i <= cuts.length && cuts.length > 0; i++) {
    const lo = i === 0 ? null : keyLiteral(cuts[i - 1], args.keyType);
    const hi = i === cuts.length ? null : keyLiteral(cuts[i], args.keyType);
    ranges.push(
      [lo !== null ? `${first} >= ${lo}` : null, hi !== null ? `${first} < ${hi}` : null]
        .filter(Boolean)
        .join(" AND "),
    );
  }
  const out = ["BEGIN"];
  const tmp = "_agentswarms_cluster";
  for (const where of ranges) {
    out.push(
      `CREATE OR REPLACE TEMP TABLE ${tmp} AS SELECT * FROM ${target} WHERE ${where} ORDER BY ${order}`,
    );
    out.push(`DELETE FROM ${target} WHERE ${where}`);
    out.push(`INSERT INTO ${target} SELECT * FROM ${tmp}`);
  }
  const rest = args.keys.slice(1).map(qi).join(", ");
  out.push(
    `CREATE OR REPLACE TEMP TABLE ${tmp} AS SELECT * FROM ${target} WHERE ${first} IS NULL${rest ? ` ORDER BY ${rest}` : ""}`,
  );
  out.push(`DELETE FROM ${target} WHERE ${first} IS NULL`);
  out.push(`INSERT INTO ${target} SELECT * FROM ${tmp}`);
  out.push(`DROP TABLE IF EXISTS ${tmp}`);
  out.push("COMMIT");
  return out;
}

/** The quantiles that split the first key into `buckets` ranges of similar row count. */
export function cutsStatement(schema: string, table: string, key: string, buckets: number): string {
  const fractions = Array.from({ length: Math.max(0, buckets - 1) }, (_, i) =>
    ((i + 1) / buckets).toFixed(6),
  );
  return `SELECT unnest(quantile_disc(${qi(key)}, [${fractions.join(", ")}])::VARCHAR[]) AS cut FROM ${qi(schema)}.${qi(table)} WHERE ${qi(key)} IS NOT NULL`;
}

/** How many files a table should be rewritten into for a target file size — never zero. */
export function bucketCount(bytes: number, targetBytes: number): number {
  if (!(bytes > 0) || !(targetBytes > 0)) return 1;
  return Math.max(1, Math.ceil(bytes / targetBytes));
}

const plural = (n: number, w: string) =>
  `${n} ${n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`}`;

/**
 * What to do about a table's layout, most valuable first. Grounded in two
 * signals: what queries actually filtered on this week (the history), and
 * what the files can skip (the catalog's statistics). A column nobody filters
 * on is not worth clustering by however badly its files overlap.
 */
export function adviseLayout(input: {
  files: number;
  bytes: number;
  targetBytes: number;
  columns: ColumnLayout[];
  filtered: Record<string, number>;
  cluster: string[];
  filesSinceRewrite: number;
  keepClustered: boolean;
}): LayoutAdvice[] {
  const out: LayoutAdvice[] = [];
  const { files, columns, cluster } = input;
  if (cluster.length && input.filesSinceRewrite > 0) {
    out.push({
      kind: "recluster",
      title: `Rewrite again: ${plural(input.filesSinceRewrite, "file")} written since the last rewrite`,
      detail: input.keepClustered
        ? "They are not in key order yet; the hourly maintenance pass will rewrite the table."
        : "They are not in key order. Rewrite now, or turn on Keep clustered so maintenance does it.",
      columns: cluster,
    });
  }
  const avg = files ? input.bytes / files : 0;
  if (!cluster.length && files >= 8 && avg < input.targetBytes / 8) {
    out.push({
      kind: "compact",
      title: `${plural(files, "small file")} — a scan opens every one`,
      detail: `Average ${formatBytes(avg)} against a ${formatBytes(input.targetBytes)} target. The hourly maintenance pass merges adjacent files; a clustered rewrite compacts and orders them in one go.`,
    });
  }
  const ranked = Object.entries(input.filtered)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const [name, n] of ranked) {
    const col = byName.get(name);
    if (!col || col.skip === null) continue;
    if (cluster[0] === name) continue;
    if (col.skip > 0.5) continue;
    out.push({
      kind: "cluster",
      title: `Cluster by ${name}`,
      detail: `Filtered on in ${plural(n, "query")} this week; a lookup opens ${col.touched} of ${plural(files, "file")}.`,
      columns: [name],
    });
    break;
  }
  if (!out.some((a) => a.kind === "cluster") && !cluster.length && files >= 2 && !ranked.length) {
    const temporal = columns.find((c) => TEMPORAL.test(c.type) && c.skip !== null && c.skip <= 0.5);
    if (temporal) {
      out.push({
        kind: "cluster",
        title: `Consider clustering by ${temporal.name}`,
        detail: `No query filtered on this table this week; a date is the usual key. A lookup on it opens ${temporal.touched} of ${plural(files, "file")}.`,
        columns: [temporal.name],
      });
    }
  }
  if (!out.length) {
    out.push({
      kind: "ok",
      title: "Layout is fine",
      detail:
        files < 2
          ? "One file; sorted rows inside it let the engine skip row groups, and there is nothing to range."
          : "Lookups on the columns queries filter by open few files.",
    });
  }
  return out;
}

export function formatBytes(n: number): string {
  if (!(n > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
