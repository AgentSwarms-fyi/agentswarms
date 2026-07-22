// sql_query agent tool — server-side handler.
//
// IMPORTANT: This runs in the Cloudflare Workers runtime which forbids
// `new Function()` / `eval`. AlaSQL internally uses `new Function()` to
// JIT-compile queries, so it throws "Code generation from strings disallowed
// for this context". We therefore parse the query with `node-sql-parser`
// (pure JS, AST-based) and execute it ourselves against the in-memory rows
// loaded from Supabase.
//
// Supported query shapes (covers virtually everything the LLM produces for
// analytics questions):
//   - SELECT col, agg(col), * FROM t
//   - WHERE  with AND/OR, =, !=, <>, <, <=, >, >=, LIKE, IN, IS NULL, BETWEEN
//   - GROUP BY one or more columns
//   - ORDER BY one or more columns ASC/DESC
//   - LIMIT n [OFFSET m]
//   - Aggregates: COUNT(*), COUNT(col), SUM, AVG, MIN, MAX
//   - Column aliases (AS)
//   - Simple INNER JOIN ... ON a.x = b.y
//
// Strict guarantees:
//   - SELECT only (parser rejects everything else)
//   - Hard cap of 50 rows per result

import pkg from "node-sql-parser";
const { Parser } = pkg;
import type { ToolDef, AgentToolContext } from "./registry.server";

const ROW_CAP = 50;

type ColumnDef = { name: string; type: "number" | "string" | "date" };
type Row = Record<string, unknown>;
type LoadedTable = { name: string; columns: ColumnDef[]; rows: Row[] };

export const sqlQueryTool: ToolDef = {
  type: "function",
  function: {
    name: "sql_query",
    description:
      "EXECUTES a read-only SQL SELECT against the user's local data tables (CSVs they uploaded in the Data & SQL Agents page) and returns the actual result rows. " +
      "You MUST call this tool whenever the user asks any question that can be answered from their structured data — top customers, totals, " +
      "averages, time-series, joins, counts, breakdowns, rankings. " +
      "DO NOT write or display SQL in your reply text — call this tool to run it and answer from the returned rows. " +
      "Showing SQL to the user without executing it is a failure mode; always execute and report the answer in plain language. " +
      "Return rows are capped at 50; aggregate (SUM/AVG/COUNT/GROUP BY) for big questions. " +
      "Call list_data_tables first only if you don't already know what tables exist.",
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "A single SELECT statement. No INSERT/UPDATE/DELETE/CREATE/DROP. " +
            "Supports WHERE, GROUP BY, ORDER BY, LIMIT, COUNT/SUM/AVG/MIN/MAX, basic INNER JOIN, column aliases.",
        },
      },
      required: ["sql"],
    },
  },
};

export const listDataTablesTool: ToolDef = {
  type: "function",
  function: {
    name: "list_data_tables",
    description:
      "List the user's local data tables and their columns. Call this before sql_query if you don't already know the schema.",
    parameters: { type: "object", properties: {} },
  },
};

// Only allow a well-formed UUID into a PostgREST `.or()` filter string, so a
// scope id can never inject filter syntax.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadUserTables(
  ctx: AgentToolContext,
  allowSet?: Set<string> | null,
): Promise<LoadedTable[]> {
  // Normal (RLS) path: no explicit ownership filter — this client runs under
  // the user's JWT, so RLS returns exactly what they may read (own tables,
  // public samples, IAM-shared tables).
  // Headless path (ctx.scopeUserId set): `sb` is the service-role client with
  // RLS OFF, so we MUST restrict to the owner's own tables + public samples —
  // the only tenant boundary here.
  let query = ctx.sb.from("user_data_tables").select("id, name, columns, user_id, is_sample");
  if (ctx.scopeUserId) {
    if (!UUID_RE.test(ctx.scopeUserId)) return [];
    query = query.or(`user_id.eq.${ctx.scopeUserId},is_sample.eq.true`);
  }
  const { data: tables } = await query;
  if (!tables) return [];
  const filtered =
    allowSet && allowSet.size > 0 ? tables.filter((t) => allowSet.has(t.name)) : tables;
  const out: LoadedTable[] = [];
  for (const t of filtered) {
    const allRows: Row[] = [];
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data: chunk, error } = await ctx.sb
        .from("user_data_rows")
        .select("row")
        .eq("table_id", t.id)
        .range(from, from + PAGE - 1);
      if (error || !chunk || chunk.length === 0) break;
      allRows.push(...chunk.map((c) => c.row as Row));
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
    out.push({
      name: t.name,
      columns: (Array.isArray(t.columns) ? t.columns : []) as ColumnDef[],
      rows: allRows,
    });
  }
  return out;
}

export async function runListDataTables(
  ctx: AgentToolContext,
  _args?: unknown,
  allowSet?: Set<string> | null,
): Promise<string> {
  const tables = await loadUserTables(ctx, allowSet);
  if (tables.length === 0) {
    return JSON.stringify({
      tables: [],
      note: "No data tables found. The user can upload a CSV in the Data & SQL Agents page.",
    });
  }
  return JSON.stringify({
    tables: tables.map((t) => ({
      name: t.name,
      row_count: t.rows.length,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
    })),
  });
}

// ----------------------------------------------------------------------------
// Pure-JS SQL executor (no eval / no new Function).
// ----------------------------------------------------------------------------

type AstNode = any; // node-sql-parser types are loose; we navigate dynamically.

function getColumnValue(row: Row, colRef: AstNode, tableAliases: Record<string, string>): unknown {
  if (colRef?.type !== "column_ref") return undefined;
  const col = colRef.column;
  // node-sql-parser sometimes wraps column in { expr: { value } } for quoted idents
  const colName = typeof col === "string" ? col : (col?.expr?.value ?? col?.value ?? "");
  if (colRef.table) {
    const realTable = tableAliases[colRef.table] || colRef.table;
    return row[`${realTable}.${colName}`] ?? row[colName];
  }
  return row[colName];
}

function evalExpr(expr: AstNode, row: Row, tableAliases: Record<string, string>): unknown {
  if (expr == null) return null;
  switch (expr.type) {
    case "number":
      return Number(expr.value);
    case "single_quote_string":
    case "string":
    case "hex_string":
      return expr.value;
    case "bool":
      return Boolean(expr.value);
    case "null":
      return null;
    case "column_ref":
      return getColumnValue(row, expr, tableAliases);
    case "expr_list":
      return (expr.value || []).map((e: AstNode) => evalExpr(e, row, tableAliases));
    case "binary_expr": {
      const op = String(expr.operator || "").toUpperCase();
      if (op === "AND")
        return (
          Boolean(evalExpr(expr.left, row, tableAliases)) &&
          Boolean(evalExpr(expr.right, row, tableAliases))
        );
      if (op === "OR")
        return (
          Boolean(evalExpr(expr.left, row, tableAliases)) ||
          Boolean(evalExpr(expr.right, row, tableAliases))
        );
      const l = evalExpr(expr.left, row, tableAliases);
      const r = evalExpr(expr.right, row, tableAliases);
      switch (op) {
        case "=":
          return looseEq(l, r);
        case "!=":
        case "<>":
          return !looseEq(l, r);
        case "<":
          return numCompare(l, r) < 0;
        case "<=":
          return numCompare(l, r) <= 0;
        case ">":
          return numCompare(l, r) > 0;
        case ">=":
          return numCompare(l, r) >= 0;
        case "+":
          return Number(l) + Number(r);
        case "-":
          return Number(l) - Number(r);
        case "*":
          return Number(l) * Number(r);
        case "/":
          return Number(l) / Number(r);
        case "LIKE":
          return likeMatch(l, r, false);
        case "NOT LIKE":
          return !likeMatch(l, r, false);
        case "ILIKE":
          return likeMatch(l, r, true);
        case "IN":
          return Array.isArray(r) && r.some((v) => looseEq(l, v));
        case "NOT IN":
          return Array.isArray(r) && !r.some((v) => looseEq(l, v));
        case "IS":
          return r === null ? l === null || l === undefined : looseEq(l, r);
        case "IS NOT":
          return r === null ? !(l === null || l === undefined) : !looseEq(l, r);
        case "BETWEEN": {
          if (Array.isArray(r) && r.length === 2) {
            return numCompare(l, r[0]) >= 0 && numCompare(l, r[1]) <= 0;
          }
          return false;
        }
        default:
          throw new Error(`Unsupported operator: ${op}`);
      }
    }
    case "unary_expr": {
      const v = evalExpr(expr.expr, row, tableAliases);
      const op = String(expr.operator || "").toUpperCase();
      if (op === "NOT") return !v;
      if (op === "-") return -Number(v);
      if (op === "IS NULL") return v === null || v === undefined;
      if (op === "IS NOT NULL") return v !== null && v !== undefined;
      return v;
    }
    case "function":
    case "aggr_func":
      // Aggregates are handled at the projection level, not per-row.
      return null;
    case "case": {
      // Optional CASE WHEN support
      const args = expr.args || [];
      for (const a of args) {
        if (a.type === "when" && Boolean(evalExpr(a.cond, row, tableAliases))) {
          return evalExpr(a.result, row, tableAliases);
        }
        if (a.type === "else") {
          return evalExpr(a.result, row, tableAliases);
        }
      }
      return null;
    }
    default:
      // Best effort: return the value field if present
      return expr.value ?? null;
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a),
      nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return String(a) === String(b);
}

function numCompare(a: unknown, b: unknown): number {
  const na = Number(a),
    nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const sa = String(a ?? ""),
    sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function likeMatch(value: unknown, pattern: unknown, ci: boolean): boolean {
  if (value == null || pattern == null) return false;
  const s = String(value);
  const p = String(pattern);
  // Escape regex metas except % and _
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$", ci ? "i" : "");
  return re.test(s);
}

function aggregate(name: string, values: unknown[]): unknown {
  const op = name.toUpperCase();
  const nums = values
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n));
  switch (op) {
    case "COUNT":
      return values.filter((v) => v !== null && v !== undefined).length;
    case "SUM":
      return nums.reduce((a, b) => a + b, 0);
    case "AVG":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "MIN":
      if (nums.length > 0) return Math.min(...nums);
      return values.filter((v) => v != null).sort((a, b) => numCompare(a, b))[0] ?? null;
    case "MAX":
      if (nums.length > 0) return Math.max(...nums);
      return values.filter((v) => v != null).sort((a, b) => numCompare(b, a))[0] ?? null;
    default:
      throw new Error(`Unsupported aggregate: ${op}`);
  }
}

function projectionLabel(item: AstNode, idx: number): string {
  if (item.as) return item.as;
  const e = item.expr;
  if (!e) return `col_${idx}`;
  if (e.type === "column_ref") {
    const c = e.column;
    return typeof c === "string" ? c : (c?.expr?.value ?? c?.value ?? `col_${idx}`);
  }
  if (e.type === "aggr_func") {
    const argCol = e.args?.expr?.column;
    const colName =
      typeof argCol === "string" ? argCol : (argCol?.expr?.value ?? argCol?.value ?? "*");
    return `${e.name}(${colName})`;
  }
  if (e.type === "function") {
    return e.name?.name?.[0]?.value || e.name || `col_${idx}`;
  }
  return `col_${idx}`;
}

function isAggrExpr(expr: AstNode): boolean {
  if (!expr) return false;
  if (expr.type === "aggr_func") return true;
  if (expr.type === "binary_expr") return isAggrExpr(expr.left) || isAggrExpr(expr.right);
  if (expr.type === "unary_expr") return isAggrExpr(expr.expr);
  return false;
}

function executeAggrOnGroup(
  expr: AstNode,
  group: Row[],
  tableAliases: Record<string, string>,
): unknown {
  if (expr.type === "aggr_func") {
    const name = String(expr.name).toUpperCase();
    const arg = expr.args?.expr;
    if (name === "COUNT" && (expr.args?.expr?.type === "star" || arg == null)) {
      return group.length;
    }
    const vals = group.map((r) => evalExpr(arg, r, tableAliases));
    return aggregate(name, vals);
  }
  if (expr.type === "binary_expr") {
    const l = executeAggrOnGroup(expr.left, group, tableAliases) as number;
    const r = executeAggrOnGroup(expr.right, group, tableAliases) as number;
    switch (expr.operator) {
      case "+":
        return Number(l) + Number(r);
      case "-":
        return Number(l) - Number(r);
      case "*":
        return Number(l) * Number(r);
      case "/":
        return Number(l) / Number(r);
      default:
        return null;
    }
  }
  // Non-aggregate inside a grouped projection: evaluate against first row
  return evalExpr(expr, group[0] || {}, tableAliases);
}

function resolveSelectOrdinalExpr(expr: AstNode, columns: AstNode[]): AstNode {
  if (expr?.type !== "number") return expr;
  const index = Number(expr.value) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= columns.length) return expr;
  return columns[index]?.expr ?? expr;
}

function normalizeGroupBy(groupBy: AstNode, columns: AstNode[]): AstNode[] {
  if (!groupBy) return [];
  const items = Array.isArray(groupBy)
    ? groupBy
    : Array.isArray(groupBy.columns)
      ? groupBy.columns
      : [groupBy];
  return items.map((item: AstNode) => resolveSelectOrdinalExpr(item, columns));
}

function resolveOrderValue(
  expr: AstNode,
  row: Row,
  columns: AstNode[],
  tableAliases: Record<string, string>,
): unknown {
  const resolvedExpr = resolveSelectOrdinalExpr(expr, columns);
  if (resolvedExpr?.type === "column_ref") {
    const column =
      typeof resolvedExpr.column === "string"
        ? resolvedExpr.column
        : (resolvedExpr.column?.expr?.value ?? resolvedExpr.column?.value ?? "");
    if (column && column in row) return row[column];
  }

  const matchedIndex = columns.findIndex(
    (column) => JSON.stringify(column.expr ?? null) === JSON.stringify(resolvedExpr ?? null),
  );
  if (matchedIndex >= 0) {
    const matchedLabel = projectionLabel(columns[matchedIndex], matchedIndex);
    if (matchedLabel in row) return row[matchedLabel];
  }

  const derivedLabel = projectionLabel({ expr: resolvedExpr, as: null }, 0);
  if (derivedLabel in row) return row[derivedLabel];

  return evalExpr(resolvedExpr, row, tableAliases);
}

function executeSelect(ast: AstNode, tablesByName: Map<string, LoadedTable>): Row[] {
  // ----- FROM (with optional INNER JOIN) -----
  const fromList: AstNode[] = ast.from || [];
  if (fromList.length === 0) throw new Error("Query has no FROM clause");

  const tableAliases: Record<string, string> = {};
  // Build initial row set from the first table.
  const first = fromList[0];
  const firstTable = tablesByName.get(first.table);
  if (!firstTable) throw new Error(`Unknown table: ${first.table}`);
  tableAliases[first.as || first.table] = first.table;

  let rows: Row[] = firstTable.rows.map((r) => prefixRow(r, first.as || first.table));

  for (let i = 1; i < fromList.length; i++) {
    const j = fromList[i];
    const jt = tablesByName.get(j.table);
    if (!jt) throw new Error(`Unknown table: ${j.table}`);
    tableAliases[j.as || j.table] = j.table;
    const joinAlias = j.as || j.table;
    const right = jt.rows.map((r) => prefixRow(r, joinAlias));
    const joined: Row[] = [];
    for (const l of rows) {
      for (const r of right) {
        const merged = { ...l, ...r };
        if (!j.on || Boolean(evalExpr(j.on, merged, tableAliases))) joined.push(merged);
      }
    }
    rows = joined;
  }

  // ----- WHERE -----
  if (ast.where) {
    rows = rows.filter((r) => Boolean(evalExpr(ast.where, r, tableAliases)));
  }

  // ----- SELECT items -----
  const columns: AstNode[] =
    ast.columns === "*" ? [{ expr: { type: "column_ref", column: "*" }, as: null }] : ast.columns;
  const isStar =
    columns.length === 1 &&
    columns[0].expr?.type === "column_ref" &&
    columns[0].expr?.column === "*";
  const hasAggr = columns.some((c) => isAggrExpr(c.expr));
  const groupBy: AstNode[] = normalizeGroupBy(ast.groupby, columns);

  let resultRows: Row[];

  if (hasAggr || groupBy.length > 0) {
    // Group rows
    const groups = new Map<string, Row[]>();
    if (groupBy.length === 0) {
      groups.set("__all__", rows);
    } else {
      for (const r of rows) {
        const key = groupBy.map((g) => JSON.stringify(evalExpr(g, r, tableAliases))).join("\u0001");
        let bucket = groups.get(key);
        if (!bucket) {
          bucket = [];
          groups.set(key, bucket);
        }
        bucket.push(r);
      }
    }
    resultRows = [];
    for (const group of groups.values()) {
      const out: Row = {};
      columns.forEach((c, i) => {
        const label = projectionLabel(c, i);
        out[label] = isAggrExpr(c.expr)
          ? executeAggrOnGroup(c.expr, group, tableAliases)
          : evalExpr(c.expr, group[0], tableAliases);
      });
      resultRows.push(out);
    }
  } else if (isStar) {
    // Strip table prefixes for cleaner output
    resultRows = rows.map((r) => unprefixRow(r));
  } else {
    resultRows = rows.map((r) => {
      const out: Row = {};
      columns.forEach((c, i) => {
        out[projectionLabel(c, i)] = evalExpr(c.expr, r, tableAliases);
      });
      return out;
    });
  }

  // ----- ORDER BY -----
  if (ast.orderby && ast.orderby.length > 0) {
    resultRows.sort((a, b) => {
      for (const o of ast.orderby) {
        const av = resolveOrderValue(o.expr, a, columns, tableAliases);
        const bv = resolveOrderValue(o.expr, b, columns, tableAliases);
        const cmp = numCompare(av, bv);
        if (cmp !== 0) return o.type === "DESC" ? -cmp : cmp;
      }
      return 0;
    });
  }

  // ----- LIMIT / OFFSET -----
  if (ast.limit) {
    let offset = 0;
    let count = Number.MAX_SAFE_INTEGER;
    const v = ast.limit.value;
    if (Array.isArray(v) && v.length > 0) {
      if (v.length === 1) count = Number(v[0].value);
      else {
        offset = Number(v[0].value);
        count = Number(v[1].value);
      }
    }
    resultRows = resultRows.slice(offset, offset + count);
  }

  return resultRows;
}

function prefixRow(row: Row, alias: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[`${alias}.${k}`] = v;
    out[k] = v; // unqualified access too
  }
  return out;
}

function unprefixRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.includes(".")) out[k] = v;
  }
  return out;
}

export async function runSqlQuery(
  ctx: AgentToolContext,
  args: { sql: string },
  allowSet?: Set<string> | null,
): Promise<string> {
  const sql = (args.sql || "").trim().replace(/;+\s*$/, "");
  if (!sql) return JSON.stringify({ error: "Empty SQL" });

  const tables = await loadUserTables(ctx, allowSet);
  if (tables.length === 0) {
    return JSON.stringify({
      error:
        allowSet && allowSet.size > 0
          ? `No tables in this agent's allow-list are available. Allowed: ${Array.from(allowSet).join(", ")}.`
          : "User has no data tables yet. Suggest uploading a CSV in the Data & SQL Agents page.",
    });
  }

  const parser = new Parser();
  let ast: AstNode;
  try {
    // PostgreSQL dialect: treats "Region" / "Order ID" as identifiers (what
    // LLMs naturally write). MySQL dialect treats double-quoted tokens as
    // string literals, so `SELECT "Region" FROM t` returned the literal
    // "Region" for every row — silently breaking SQL agents.
    // PostgreSQL parser also accepts backtick-quoted identifiers and single-
    // quoted string literals, so it's a strict superset for our use case.
    const parsed = parser.astify(sql, { database: "PostgreSQL" });
    ast = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    return JSON.stringify({ error: `SQL parse error: ${(e as Error).message}`, sql });
  }
  if (!ast || ast.type !== "select") {
    return JSON.stringify({ error: "Only SELECT statements are allowed.", sql });
  }

  const tablesByName = new Map(tables.map((t) => [t.name, t]));

  try {
    const result = executeSelect(ast, tablesByName);
    const total = result.length;
    const capped = total > ROW_CAP;
    const limited = capped ? result.slice(0, ROW_CAP) : result;
    const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
    return JSON.stringify({
      sql,
      columns,
      rows: limited,
      row_count: limited.length,
      total_matched: total,
      capped,
      note: capped ? `Result truncated to first ${ROW_CAP} of ${total} rows.` : undefined,
    });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message, sql });
  }
}

// Convenience: short schema summary string for callers that want to inline the
// list of tables into the tool description.
export async function describeUserTables(ctx: AgentToolContext): Promise<string> {
  const tables = await loadUserTables(ctx);
  if (tables.length === 0) return "";
  return tables
    .map(
      (t) =>
        `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(", ")}) — ${t.rows.length} rows`,
    )
    .join("; ");
}
