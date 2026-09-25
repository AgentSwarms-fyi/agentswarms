// The SQL behind a table sheet: its source, its calculated columns, and the
// sort and filters the person set, as one SELECT the lakehouse runs.
//
//   WITH s0 AS (SELECT *, row_number() OVER () AS __row FROM "sales"."orders"),
//        s1 AS (SELECT p.*, <margin formula> AS "margin" FROM s0 p),
//        s2 AS (SELECT p.*, <share formula> AS "share" FROM s1 p)
//   SELECT … FROM s2 WHERE <filters> ORDER BY <sort>, __row LIMIT 500 OFFSET 0
//
// Each calculated column is one layer, so a later column can use an earlier
// one ([@margin]) and a whole-column read ([amount], SUM) sees the rows as
// they are at that layer. __row is the source's order, which keeps paging
// stable when the sort leaves ties. A column whose formula does not compile
// is still there, empty, with the reason, the way a cell shows an error: one
// bad formula does not take the table down.

import {
  compileColumnFormula,
  kindOfSqlType,
  qid,
  qstr,
  type ColKind,
  type SheetColumn,
  type TableSource,
} from "./compile";
import { parseDateText, serialParts } from "../formula/values";

export const ROW_ID = "__row";

export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "contains"
  | "not_contains"
  | "starts"
  | "ends"
  | "blank"
  | "not_blank"
  | "in";

export type TableFilter = {
  column: string;
  op: FilterOp;
  value?: string;
  /** For "in": the values kept (as text), from the column's value list. */
  values?: string[];
  /** For "in": keep blanks too. */
  blanks?: boolean;
};

export type TableSort = { column: string; desc: boolean };
export type CalculatedColumn = { name: string; formula: string };

export type PivotAgg = "sum" | "avg" | "count" | "count_distinct" | "min" | "max";
export type PivotValue = { column: string; agg: PivotAgg };

/**
 * Where a table sheet's rows come from: a lakehouse table, or a pivot (a
 * GROUP BY) of another table sheet of the workbook.
 */
export type TableSourceRef =
  | { kind: "lakehouse"; schema: string; table: string }
  | { kind: "pivot"; from: string; rows: string[]; values: PivotValue[] };

/** A pivot value column's name: sum_amount, count_distinct_customer. */
export function pivotValueName(v: PivotValue): string {
  return `${v.agg}_${v.column}`;
}

/** "sales.orders", or "Pivot of Orders" — how the sheet names where its rows come from. */
export function sourceLabel(source: TableSourceRef): string {
  return source.kind === "lakehouse"
    ? `${source.schema}.${source.table}`
    : `Pivot of ${source.from}`;
}

/** Where the data came from before it was in the lakehouse, for the sheet's label. */
export type TableOrigin =
  | { kind: "lakehouse" }
  | { kind: "catalog"; asset_id: string; fqn: string }
  | { kind: "warehouse"; connection_id: string; connection_name: string; query: string }
  | { kind: "upload"; filename: string };

export type TableConfig = {
  source: TableSourceRef;
  /** The source's columns as last read: name and engine type. */
  columns: { name: string; type: string }[];
  calculated: CalculatedColumn[];
  sort: TableSort[];
  filters: TableFilter[];
  hidden: string[];
  widths: Record<string, number>;
  origin?: TableOrigin;
};

export type TableColumn = SheetColumn & {
  type: string;
  calculated?: boolean;
  formula?: string;
  /** Why a calculated column is empty. */
  error?: string;
};

export type TableRelation = {
  /** CTE definitions, in dependency order ("name AS (…)"). */
  ctes: string[];
  /** The CTE holding every row with every column. */
  last: string;
  columns: TableColumn[];
};

export type OtherTable = { name: string; config: TableConfig };

export class TableQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableQueryError";
  }
}

const MAX_DEPTH = 4;

/**
 * The layered relation for a table sheet. `others` resolves another table
 * sheet of the workbook by name, for lookups into it; `prefix` keeps the CTE
 * names of several tables in one statement apart.
 */
export function buildTableRelation(
  cfg: TableConfig,
  opts: {
    name: string;
    prefix?: string;
    others?: (name: string) => OtherTable | undefined;
    /** Formulas that failed at run time, dropped to empty with this reason. */
    broken?: Record<string, string>;
  },
  depth = 0,
  seen: Set<string> = new Set(),
): TableRelation {
  const prefix = opts.prefix ?? "s";
  const ctes: string[] = [];
  const base = `${prefix}0`;
  let columns: TableColumn[] = cfg.columns.map((c) => ({
    name: c.name,
    type: c.type,
    kind: kindOfSqlType(c.type),
  }));
  seen.add(opts.name.toLowerCase());

  // Other tables are built on demand, once, with their own prefixes.
  const built = new Map<string, TableSource>();
  let otherCount = 0;
  const others = (name: string): TableSource | undefined => {
    const key = name.toLowerCase();
    const hit = built.get(key);
    if (hit) return hit;
    if (seen.has(key)) {
      throw new TableQueryError(
        `${name} and this table look each other up in a circle; one of the lookups has to go`,
      );
    }
    if (depth + 1 > MAX_DEPTH) {
      throw new TableQueryError("Lookups go more than four tables deep");
    }
    const other = opts.others?.(name);
    if (!other) return undefined;
    const rel = buildTableRelation(
      other.config,
      { name: other.name, prefix: `${prefix}_${++otherCount}_`, others: opts.others },
      depth + 1,
      new Set(seen),
    );
    ctes.push(...rel.ctes);
    const t: TableSource = {
      from: rel.last,
      columns: rel.columns.map((c) => ({ name: c.name, kind: c.kind })),
    };
    built.set(key, t);
    return t;
  };

  if (cfg.source.kind === "pivot") {
    // A GROUP BY of another table sheet (its calculated columns included).
    // The groups are numbered in key order: a GROUP BY's output order is not
    // stable between runs, and __row is what keeps paging from shuffling.
    const p = cfg.source;
    const src = others(p.from);
    if (!src) {
      throw new TableQueryError(`The pivot's table "${p.from}" is not in this workbook any more`);
    }
    const col = (name: string) => {
      const c = src.columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!c) throw new TableQueryError(`"${p.from}" has no column "${name}" any more`);
      return c;
    };
    if (!p.values.length) throw new TableQueryError("A pivot needs at least one value to total");
    const keys = p.rows.map((r) => col(r));
    const aggs = p.values.map((v) => {
      const c = col(v.column);
      const x = qid(c.name);
      const num = c.kind === "number" ? `CAST(${x} AS DOUBLE)` : `TRY_CAST(${x} AS DOUBLE)`;
      const expr =
        v.agg === "count"
          ? `count(${x})`
          : v.agg === "count_distinct"
            ? `count(DISTINCT ${x})`
            : v.agg === "sum"
              ? `sum(${num})`
              : v.agg === "avg"
                ? `avg(${num})`
                : `${v.agg}(${x})`;
      const kind: ColKind =
        (v.agg === "min" || v.agg === "max") && c.kind !== "number" ? c.kind : "number";
      return { sql: `${expr} AS ${qid(pivotValueName(v))}`, name: pivotValueName(v), kind };
    });
    const keySql = keys.map((k) => qid(k.name));
    const inner =
      `SELECT ${[...keySql, ...aggs.map((a) => a.sql)].join(", ")} FROM ${src.from}` +
      (keySql.length ? ` GROUP BY ${keySql.join(", ")}` : "");
    const order = keySql.length
      ? `ORDER BY ${keySql.map((k) => `${k} NULLS LAST`).join(", ")}`
      : "";
    ctes.push(`${base} AS (SELECT *, row_number() OVER (${order}) AS ${ROW_ID} FROM (${inner}))`);
    columns = [
      ...keys.map((k) => ({ name: k.name, kind: k.kind, type: SQL_TYPE[k.kind] })),
      ...aggs.map((a) => ({ name: a.name, kind: a.kind, type: SQL_TYPE[a.kind] })),
    ];
  } else {
    const src = `${qid(cfg.source.schema)}.${qid(cfg.source.table)}`;
    ctes.push(`${base} AS (SELECT *, row_number() OVER () AS ${ROW_ID} FROM ${src})`);
  }

  let prev = base;
  cfg.calculated.forEach((calc, i) => {
    const name = calc.name.trim();
    const layer = `${prefix}${i + 1}`;
    if (columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      columns.push({
        name,
        type: "VARCHAR",
        kind: "text",
        calculated: true,
        formula: calc.formula,
        error: `There is already a column named "${name}"`,
      });
      // A duplicate name cannot be selected twice; it is shown, not computed.
      return;
    }
    let sql = "NULL";
    let kind: ColKind = "text";
    let error: string | undefined = opts.broken?.[name];
    if (!error) {
      try {
        const compiled = compileColumnFormula(calc.formula, {
          columns: columns.filter((c) => !c.error).map((c) => ({ name: c.name, kind: c.kind })),
          self: prev,
          row: "p",
          selfName: opts.name,
          table: others,
        });
        sql = compiled.sql;
        kind = compiled.kind;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    ctes.push(`${layer} AS (SELECT p.*, ${sql} AS ${qid(name)} FROM ${prev} p)`);
    columns.push({
      name,
      type: SQL_TYPE[kind],
      kind,
      calculated: true,
      formula: calc.formula,
      ...(error ? { error } : {}),
    });
    prev = layer;
  });

  return { ctes, last: prev, columns };
}

const SQL_TYPE: Record<ColKind, string> = {
  number: "DOUBLE",
  text: "VARCHAR",
  bool: "BOOLEAN",
  date: "DATE",
  datetime: "TIMESTAMP",
  other: "VARCHAR",
};

function findColumn(columns: TableColumn[], name: string): TableColumn {
  const c = columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!c) throw new TableQueryError(`The table has no column "${name}" any more`);
  return c;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function dateLit(text: string): string | null {
  const serial = parseDateText(text);
  if (serial === null) return null;
  const p = serialParts(serial);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `DATE '${p.y}-${pad(p.m)}-${pad(p.d)}'`;
}

const CMP: Partial<Record<FilterOp, string>> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  ge: ">=",
  lt: "<",
  le: "<=",
};

/** One filter as a predicate on the final relation's columns. */
export function filterSql(f: TableFilter, columns: TableColumn[]): string {
  const c = findColumn(columns, f.column);
  const col = qid(c.name);
  const blank = `(${col} IS NULL OR CAST(${col} AS VARCHAR) = '')`;
  const value = (f.value ?? "").trim();
  switch (f.op) {
    case "blank":
      return blank;
    case "not_blank":
      return `(NOT ${blank})`;
    case "in": {
      const vals = (f.values ?? []).slice(0, 10_000);
      const parts: string[] = [];
      if (vals.length) {
        parts.push(`CAST(${col} AS VARCHAR) IN (${vals.map(qstr).join(", ")})`);
      }
      if (f.blanks) parts.push(blank);
      return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
    }
    case "contains":
    case "not_contains":
    case "starts":
    case "ends": {
      const pat =
        f.op === "starts"
          ? `${escapeLike(value)}%`
          : f.op === "ends"
            ? `%${escapeLike(value)}`
            : `%${escapeLike(value)}%`;
      const like = `coalesce(CAST(${col} AS VARCHAR) ILIKE ${qstr(pat)} ESCAPE '\\', FALSE)`;
      return f.op === "not_contains" ? `(NOT ${like})` : like;
    }
  }
  const op = CMP[f.op];
  if (!op) throw new TableQueryError(`Unknown filter "${f.op}"`);
  if (c.kind === "number") {
    const n = Number(value.replace(/,/g, ""));
    if (!value || !Number.isFinite(n)) {
      throw new TableQueryError(`"${f.value ?? ""}" is not a number, and ${c.name} holds numbers`);
    }
    const test = `CAST(${col} AS DOUBLE) ${op} CAST(${n} AS DOUBLE)`;
    return f.op === "ne" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)`;
  }
  if (c.kind === "date" || c.kind === "datetime") {
    const d = dateLit(value);
    if (!d) {
      throw new TableQueryError(`"${f.value ?? ""}" is not a date like 2024-01-31`);
    }
    const lhs = c.kind === "datetime" ? `CAST(${col} AS DATE)` : col;
    const test = `${lhs} ${op} ${d}`;
    return f.op === "ne" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)`;
  }
  if (c.kind === "bool") {
    const b = value.toLowerCase();
    if (b !== "true" && b !== "false") throw new TableQueryError(`${c.name} is TRUE or FALSE`);
    const test = `${col} = ${b.toUpperCase()}`;
    return f.op === "ne" ? `coalesce(NOT (${test}), TRUE)` : `coalesce(${test}, FALSE)`;
  }
  const test = `lower(CAST(${col} AS VARCHAR)) ${op} lower(${qstr(value)})`;
  return f.op === "ne" ? `coalesce(${test}, TRUE)` : `coalesce(${test}, FALSE)`;
}

function orderSql(sort: TableSort[], columns: TableColumn[]): string {
  const keys = sort.map((s) => {
    const c = findColumn(columns, s.column);
    // Text sorts without case, as Excel's sort does.
    const expr = c.kind === "text" ? `lower(${qid(c.name)})` : qid(c.name);
    return `${expr} ${s.desc ? "DESC" : "ASC"} NULLS LAST`;
  });
  return [...keys, ROW_ID].join(", ");
}

function whereSql(filters: TableFilter[], columns: TableColumn[]): string {
  return filters.length ? ` WHERE ${filters.map((f) => filterSql(f, columns)).join(" AND ")}` : "";
}

/** One page of rows, with the filtered total on each row. */
export function pageSql(
  rel: TableRelation,
  cfg: Pick<TableConfig, "sort" | "filters">,
  page: { offset: number; limit: number },
): string {
  const cols = rel.columns.filter((c) => !isDuplicate(rel.columns, c));
  const list = [ROW_ID, ...cols.map((c) => qid(c.name))].join(", ");
  return (
    `WITH ${rel.ctes.join(",\n")}\n` +
    `SELECT ${list}, count(*) OVER () AS __total FROM ${rel.last}` +
    whereSql(cfg.filters, rel.columns) +
    ` ORDER BY ${orderSql(cfg.sort, rel.columns)}` +
    ` LIMIT ${Math.max(0, Math.floor(page.limit))} OFFSET ${Math.max(0, Math.floor(page.offset))}`
  );
}

/** A column's distinct values and their counts, for the filter list. */
export function valuesSql(
  rel: TableRelation,
  cfg: Pick<TableConfig, "filters">,
  column: string,
  limit = 1000,
): string {
  const c = findColumn(rel.columns, column);
  // The list reflects the OTHER filters, as Excel's does.
  const others = cfg.filters.filter((f) => f.column.toLowerCase() !== column.toLowerCase());
  // The most common values when there are too many, listed A to Z without
  // case, as Excel's filter list reads.
  return (
    `WITH ${rel.ctes.join(",\n")}\n` +
    `SELECT v, n FROM (SELECT CAST(${qid(c.name)} AS VARCHAR) AS v, count(*) AS n FROM ${rel.last}` +
    whereSql(others, rel.columns) +
    ` GROUP BY 1 ORDER BY n DESC, v NULLS FIRST LIMIT ${limit}) ORDER BY lower(v) NULLS FIRST, v`
  );
}

/** Every row of the table as the sheet shows it (for saving to the lakehouse). */
export function selectAllSql(
  rel: TableRelation,
  cfg: Pick<TableConfig, "sort" | "filters" | "hidden">,
): string {
  const hidden = new Set(cfg.hidden.map((h) => h.toLowerCase()));
  const cols = rel.columns.filter(
    (c) => !hidden.has(c.name.toLowerCase()) && !isDuplicate(rel.columns, c),
  );
  return (
    `WITH ${rel.ctes.join(",\n")}\n` +
    `SELECT ${cols.map((c) => qid(c.name)).join(", ")} FROM ${rel.last}` +
    whereSql(cfg.filters, rel.columns) +
    ` ORDER BY ${orderSql(cfg.sort, rel.columns)}`
  );
}

function isDuplicate(columns: TableColumn[], c: TableColumn): boolean {
  return Boolean(c.calculated && c.error && c.error.startsWith("There is already a column"));
}

/** A calculated column's formula uses TODAY(), NOW() or the like: never serve it from a cache. */
export function isVolatile(cfg: TableConfig): boolean {
  return cfg.calculated.some((c) => /\b(TODAY|NOW|RAND|RANDBETWEEN)\s*\(/i.test(c.formula));
}

const SHORT: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  ge: "≥",
  lt: "<",
  le: "≤",
  contains: "contains",
  not_contains: "excludes",
  starts: "begins",
  ends: "ends",
  blank: "is blank",
  not_blank: "not blank",
  in: "in",
};

/** "region in West, East" — the chip's text. */
export function describeFilter(f: TableFilter): string {
  if (f.op === "in") {
    const vals = [...(f.values ?? []), ...(f.blanks ? ["(blank)"] : [])];
    const shown = vals.slice(0, 3).join(", ");
    return `${f.column} in ${shown}${vals.length > 3 ? ` +${vals.length - 3}` : ""}`;
  }
  if (f.op === "blank" || f.op === "not_blank") return `${f.column} ${SHORT[f.op]}`;
  return `${f.column} ${SHORT[f.op]} ${f.value ?? ""}`;
}

/**
 * Every table sheet of a workbook as something a formula can read, built on
 * first use under its own CTE prefix, for grid formulas over tables
 * (=SUMIFS(Orders[amount], …)) that have no table of their own.
 */
export function workbookTables(
  others: (name: string) => OtherTable | undefined,
  prefix = "w",
): { resolve: (name: string) => TableSource | undefined; ctes: string[] } {
  const ctes: string[] = [];
  const built = new Map<string, TableSource>();
  let n = 0;
  const resolve = (name: string): TableSource | undefined => {
    const key = name.toLowerCase();
    const hit = built.get(key);
    if (hit) return hit;
    const other = others(name);
    if (!other) return undefined;
    const rel = buildTableRelation(other.config, {
      name: other.name,
      prefix: `${prefix}${++n}_`,
      others,
    });
    ctes.push(...rel.ctes);
    const t: TableSource = {
      from: rel.last,
      columns: rel.columns.filter((c) => !c.error).map((c) => ({ name: c.name, kind: c.kind })),
    };
    built.set(key, t);
    return t;
  };
  return { resolve, ctes };
}

/**
 * The lakehouse tables a table sheet reads, through pivots and lookups, as
 * schema.table: the inputs its saved output's lineage points back to.
 */
export function lakehouseInputs(
  cfg: TableConfig,
  others: (name: string) => OtherTable | undefined,
  seen: Set<string> = new Set(),
): string[] {
  const out = new Set<string>();
  const visit = (c: TableConfig) => {
    if (c.source.kind === "lakehouse") out.add(`${c.source.schema}.${c.source.table}`);
    const names = new Set<string>();
    if (c.source.kind === "pivot") names.add(c.source.from.toLowerCase());
    for (const calc of c.calculated) {
      for (const m of calc.formula.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\[/g)) {
        names.add(m[1].toLowerCase());
      }
    }
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const o = others(n);
      if (o) visit(o.config);
    }
  };
  visit(cfg);
  return [...out];
}
