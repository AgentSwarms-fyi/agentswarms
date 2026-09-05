// Data monitors, the pure half: what each kind of check asks the table, how
// its answer is judged, and how a history of answers becomes a baseline.
// Nothing here touches a database; the runner and the UI both import it, and
// the tests exercise it directly.

export const MONITOR_KINDS = [
  "freshness",
  "volume",
  "schema",
  "nulls",
  "uniqueness",
  "custom_sql",
] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

export const MONITOR_KIND_LABEL: Record<MonitorKind, string> = {
  freshness: "Freshness",
  volume: "Volume",
  schema: "Schema",
  nulls: "Null rate",
  uniqueness: "Uniqueness",
  custom_sql: "Custom SQL",
};

export const MONITOR_KIND_HELP: Record<MonitorKind, string> = {
  freshness: "The newest value of a timestamp column must be no older than a limit.",
  volume:
    "The row count, or the rows added since the last run, must stay within bounds and within the range the history makes normal.",
  schema: "The column set and types must not change between runs.",
  nulls: "The share of nulls in a column must stay under a limit.",
  uniqueness: "A set of columns must not contain duplicate combinations.",
  custom_sql: "A SELECT of your own returns one number that must stay within bounds.",
};

export const MONITOR_SCHEDULES = ["hourly", "daily", "weekly", "cron"] as const;
export type MonitorSchedule = (typeof MONITOR_SCHEDULES)[number];
export const MONITOR_SEVERITIES = ["warning", "critical"] as const;
export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number];

export type MonitorConfig = {
  column?: string;
  columns?: string[];
  max_age_minutes?: number;
  mode?: "delta" | "total";
  min_rows?: number | null;
  max_rows?: number | null;
  anomaly?: boolean;
  max_null_pct?: number;
  sql?: string;
  min?: number | null;
  max?: number | null;
};

export type Baseline = { mean: number; std: number; n: number; sigma: number };

export type Evaluation = {
  status: "ok" | "alert";
  message: string;
  detail: Record<string, unknown>;
};

/** Double-quote an identifier; a quote inside is doubled, as SQL requires. */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Configuration errors say what to fix before anything is saved. The
 * runner re-validates too, so a row edited by hand cannot run nonsense.
 */
export function validateMonitorConfig(kind: MonitorKind, config: MonitorConfig): string | null {
  switch (kind) {
    case "freshness":
      if (!config.column?.trim()) return "Freshness needs a timestamp column.";
      if (!(Number(config.max_age_minutes) > 0)) return "Freshness needs a maximum age in minutes.";
      return null;
    case "volume": {
      const lo = config.min_rows ?? null;
      const hi = config.max_rows ?? null;
      if (lo !== null && !(Number(lo) >= 0)) return "Minimum rows must be zero or more.";
      if (hi !== null && !(Number(hi) >= 0)) return "Maximum rows must be zero or more.";
      if (lo !== null && hi !== null && Number(lo) > Number(hi))
        return "Minimum rows is above maximum rows.";
      if (lo === null && hi === null && !config.anomaly) {
        return "Volume needs bounds, or anomaly detection against the history, or both.";
      }
      return null;
    }
    case "schema":
      return null;
    case "nulls":
      if (!config.column?.trim()) return "Null rate needs a column.";
      if (!(Number(config.max_null_pct) >= 0 && Number(config.max_null_pct) <= 100)) {
        return "The null-rate limit is a percentage between 0 and 100.";
      }
      return null;
    case "uniqueness":
      if (!config.columns?.length || config.columns.some((c) => !c.trim())) {
        return "Uniqueness needs at least one column.";
      }
      return null;
    case "custom_sql": {
      const sql = (config.sql ?? "").trim();
      if (!sql) return "Custom SQL needs a SELECT.";
      if (!/^\s*(select|with)\b/i.test(sql))
        return "Custom SQL must be a single SELECT (or WITH ... SELECT).";
      if (/;\s*\S/.test(sql)) return "Custom SQL must be one statement.";
      if (config.min == null && config.max == null)
        return "Custom SQL needs a minimum, a maximum, or both.";
      if (config.min != null && config.max != null && Number(config.min) > Number(config.max)) {
        return "Minimum is above maximum.";
      }
      return null;
    }
  }
}

/**
 * The SQL a check runs. Kept portable across DuckDB and the warehouse
 * dialects: no engine-specific date arithmetic, so freshness reads the
 * newest timestamp and the age is computed by the runner.
 */
export function buildMonitorSql(
  kind: MonitorKind,
  config: MonitorConfig,
  schema: string,
  table: string,
): string {
  const t = qualifiedTable(schema, table);
  switch (kind) {
    case "freshness":
      return `SELECT max(${quoteIdent(config.column ?? "")}) AS value FROM ${t}`;
    case "volume":
      return `SELECT count(*) AS value FROM ${t}`;
    case "nulls": {
      const c = quoteIdent(config.column ?? "");
      return `SELECT 100.0 * sum(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) / nullif(count(*), 0) AS value FROM ${t}`;
    }
    case "uniqueness": {
      const cols = (config.columns ?? []).map(quoteIdent).join(", ");
      return `SELECT (SELECT count(*) FROM ${t}) - (SELECT count(*) FROM (SELECT DISTINCT ${cols} FROM ${t}) AS d) AS value`;
    }
    case "custom_sql":
      return (config.sql ?? "").trim().replace(/;\s*$/, "").trim();
    case "schema":
      return `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}' ORDER BY ordinal_position`;
  }
}

/** Mean and population standard deviation of the last runs' values. */
export function baselineOf(values: number[], sigma: number): Baseline | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 5) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return { mean, std: Math.sqrt(variance), n: v.length, sigma };
}

/**
 * Anomalous means further from the mean than sigma standard deviations. A
 * history with no spread at all (every run the same) treats any change as
 * anomalous, because that is exactly what the history says is abnormal; a
 * tiny spread is floored so one-row jitter does not page anybody.
 */
export function isAnomalous(value: number, baseline: Baseline | null): boolean {
  if (!baseline) return false;
  const floor = Math.max(1, Math.abs(baseline.mean) * 0.01);
  const std = Math.max(baseline.std, floor);
  return Math.abs(value - baseline.mean) > baseline.sigma * std;
}

export type ColumnSnapshot = { name: string; type: string };

export function schemaDiff(
  previous: ColumnSnapshot[] | null | undefined,
  current: ColumnSnapshot[],
): { added: string[]; removed: string[]; changed: { name: string; from: string; to: string }[] } {
  const out = {
    added: [] as string[],
    removed: [] as string[],
    changed: [] as { name: string; from: string; to: string }[],
  };
  if (!previous) return out;
  const prev = new Map(previous.map((c) => [c.name, c.type]));
  const cur = new Map(current.map((c) => [c.name, c.type]));
  for (const [name, type] of cur) {
    if (!prev.has(name)) out.added.push(name);
    else if (prev.get(name) !== type)
      out.changed.push({ name, from: prev.get(name) ?? "", to: type });
  }
  for (const name of prev.keys()) if (!cur.has(name)) out.removed.push(name);
  return out;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Judge one run. `value` is the number the SQL (or the runner) produced. */
export function evaluateMonitor(args: {
  kind: MonitorKind;
  config: MonitorConfig;
  value: number | null;
  previousValue?: number | null;
  baseline?: Baseline | null;
  latest?: string | null;
  columns?: ColumnSnapshot[];
  previousColumns?: ColumnSnapshot[] | null;
  now?: Date;
}): Evaluation {
  const { kind, config } = args;
  switch (kind) {
    case "freshness": {
      if (args.value === null) {
        return {
          status: "alert",
          message: "The table has no rows, or the timestamp column is empty.",
          detail: { latest: null },
        };
      }
      const age = args.value;
      const limit = Number(config.max_age_minutes);
      const detail = {
        latest: args.latest ?? null,
        age_minutes: Math.round(age),
        max_age_minutes: limit,
      };
      return age > limit
        ? {
            status: "alert",
            message: `Newest row is ${describeMinutes(age)} old; the limit is ${describeMinutes(limit)}.`,
            detail,
          }
        : { status: "ok", message: `Newest row is ${describeMinutes(age)} old.`, detail };
    }
    case "volume": {
      const total = args.value ?? 0;
      const mode = config.mode ?? "delta";
      const delta = args.previousValue == null ? null : total - args.previousValue;
      const judged = mode === "delta" ? delta : total;
      const detail: Record<string, unknown> = { total, delta, mode };
      const lo = config.min_rows ?? null;
      const hi = config.max_rows ?? null;
      if (lo !== null && total < Number(lo)) {
        return {
          status: "alert",
          message: `${fmt(total)} rows, below the minimum of ${fmt(Number(lo))}.`,
          detail,
        };
      }
      if (hi !== null && total > Number(hi)) {
        return {
          status: "alert",
          message: `${fmt(total)} rows, above the maximum of ${fmt(Number(hi))}.`,
          detail,
        };
      }
      if (config.anomaly && judged !== null && isAnomalous(judged, args.baseline ?? null)) {
        const b = args.baseline as Baseline;
        const what =
          mode === "delta" ? `${fmt(judged)} rows added since the last run` : `${fmt(judged)} rows`;
        return {
          status: "alert",
          message: `${what}; the last ${b.n} runs averaged ${fmt(b.mean)} (±${fmt(b.std)}).`,
          detail: { ...detail, baseline: b },
        };
      }
      const seen =
        mode === "delta" && delta !== null
          ? `${fmt(total)} rows, ${delta >= 0 ? "+" : ""}${fmt(delta)} since the last run.`
          : `${fmt(total)} rows.`;
      return { status: "ok", message: seen, detail };
    }
    case "nulls": {
      const pct = args.value ?? 0;
      const limit = Number(config.max_null_pct);
      const detail = { null_pct: pct, max_null_pct: limit, column: config.column };
      return pct > limit
        ? {
            status: "alert",
            message: `${fmt(pct)}% of ${config.column} is null; the limit is ${fmt(limit)}%.`,
            detail,
          }
        : { status: "ok", message: `${fmt(pct)}% of ${config.column} is null.`, detail };
    }
    case "uniqueness": {
      const dupes = args.value ?? 0;
      const cols = (config.columns ?? []).join(", ");
      const detail = { duplicates: dupes, columns: config.columns };
      return dupes > 0
        ? {
            status: "alert",
            message: `${fmt(dupes)} duplicate ${dupes === 1 ? "row" : "rows"} on (${cols}).`,
            detail,
          }
        : { status: "ok", message: `No duplicates on (${cols}).`, detail };
    }
    case "custom_sql": {
      if (args.value === null) {
        return { status: "alert", message: "The query returned no numeric value.", detail: {} };
      }
      const v = args.value;
      const detail = { value: v, min: config.min ?? null, max: config.max ?? null };
      if (config.min != null && v < Number(config.min)) {
        return {
          status: "alert",
          message: `Value ${fmt(v)} is below the minimum of ${fmt(Number(config.min))}.`,
          detail,
        };
      }
      if (config.max != null && v > Number(config.max)) {
        return {
          status: "alert",
          message: `Value ${fmt(v)} is above the maximum of ${fmt(Number(config.max))}.`,
          detail,
        };
      }
      return { status: "ok", message: `Value ${fmt(v)}.`, detail };
    }
    case "schema": {
      const columns = args.columns ?? [];
      const diff = schemaDiff(args.previousColumns, columns);
      const changed = diff.added.length + diff.removed.length + diff.changed.length;
      const detail = { columns, ...diff };
      if (!args.previousColumns) {
        return {
          status: "ok",
          message: `${columns.length} columns recorded as the baseline.`,
          detail,
        };
      }
      if (changed === 0)
        return { status: "ok", message: `${columns.length} columns, unchanged.`, detail };
      const parts: string[] = [];
      if (diff.added.length) parts.push(`added ${diff.added.join(", ")}`);
      if (diff.removed.length) parts.push(`removed ${diff.removed.join(", ")}`);
      if (diff.changed.length)
        parts.push(
          `retyped ${diff.changed.map((c) => `${c.name} (${c.from} → ${c.to})`).join(", ")}`,
        );
      return { status: "alert", message: `Schema changed: ${parts.join("; ")}.`, detail };
    }
  }
}

export function describeMinutes(m: number): string {
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

/** Minutes between a timestamp value (string or Date) and now; null when unparseable. */
export function ageMinutes(latest: unknown, now = new Date()): number | null {
  if (latest === null || latest === undefined) return null;
  const t = latest instanceof Date ? latest.getTime() : Date.parse(String(latest));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 60000);
}

/** A monitor's default name from what it watches. */
export function defaultMonitorName(
  kind: MonitorKind,
  table: string,
  config: MonitorConfig,
): string {
  switch (kind) {
    case "freshness":
      return `${table} · fresh within ${describeMinutes(Number(config.max_age_minutes) || 0)}`;
    case "volume":
      return `${table} · volume`;
    case "schema":
      return `${table} · schema`;
    case "nulls":
      return `${table} · nulls in ${config.column ?? "?"}`;
    case "uniqueness":
      return `${table} · unique (${(config.columns ?? []).join(", ")})`;
    case "custom_sql":
      return `${table} · custom check`;
  }
}
