// sql_query agent tool — server-side handler.
//
// What lives here is the TENANT BOUNDARY, not a SQL engine. `loadUserTables`
// decides which datasets this caller may see (own, public samples, and
// IAM-granted tables) and `restrictSharedTable` re-applies a shared dataset's
// row filter and column mask on headless runs, where the client is
// service-role and the database cannot enforce it. Both must survive any
// change to how queries execute — an agent reading past a mask its owner set
// is the worst failure this file can have.
//
// Execution itself is delegated to utils/data/localEngine.server, the single
// entry point every server-side local query goes through. A hand-written AST
// interpreter used to live here because the app targeted Cloudflare Workers,
// which forbids the `new Function()` AlaSQL compiles with. Workers is no
// longer a deploy target, so the interpreter — and the three-engine split it
// created — is gone.

import { restrictSharedDataset } from "@/utils/data/sharedDatasets.server";
import type { ToolDef, AgentToolContext } from "./registry.server";

const ROW_CAP = 50;

type ColumnDef = { name: string; type: "number" | "string" | "date" };
export type Row = Record<string, unknown>;
export type LoadedTable = { name: string; columns: ColumnDef[]; rows: Row[] };

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
  // RLS OFF, so we MUST restrict to what the owner may read — their own tables,
  // public samples, and tables shared to them via an IAM grant (mirroring the
  // RLS policy). This is the only tenant boundary here.
  // `__upload_*` rows are staging areas for an in-flight upload, not datasets.
  let query = ctx.sb
    .from("user_data_tables")
    .select("id, name, columns, user_id, is_sample")
    .not("name", "like", "__upload_%");
  if (ctx.scopeUserId) {
    if (!UUID_RE.test(ctx.scopeUserId)) return [];
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    const granted = await resolveGrantedResourceIds(ctx.sb, ctx.scopeUserId, "data_table");
    const orParts = [`user_id.eq.${ctx.scopeUserId}`, `is_sample.eq.true`];
    const grantedIds = [...granted].filter((id) => UUID_RE.test(id));
    if (grantedIds.length) orParts.push(`id.in.(${grantedIds.join(",")})`);
    query = query.or(orParts.join(","));
  }
  const { data: tables } = await query;
  if (!tables) return [];
  const filtered =
    allowSet && allowSet.size > 0 ? tables.filter((t) => allowSet.has(t.name)) : tables;
  const viewerId = ctx.scopeUserId ?? ctx.userId;
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
    let columns = (Array.isArray(t.columns) ? t.columns : []) as ColumnDef[];
    let rows = allRows;
    // A dataset SHARED with this caller carries the grant's row filter and
    // column mask. On headless runs ctx.sb is service-role (RLS off), so the
    // database can't enforce it for us — the restriction has to be applied
    // here or an agent would read past a mask the owner set.
    if (!t.is_sample && t.user_id !== viewerId) {
      const restricted = await restrictSharedDataset(ctx.sb, t.id, viewerId, columns, rows);
      columns = restricted.columns;
      rows = restricted.rows;
    }
    out.push({ name: t.name, columns, rows });
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

  // `tables` above is the tenant boundary: loadUserTables has already applied
  // scope filtering and shared-dataset masking. The engine only ever sees rows
  // this caller may read.
  let result: Row[];
  try {
    const { runLocalSelect } = await import("@/utils/data/localEngine.server");
    const res = await runLocalSelect(sql, tables);
    result = res.rows;
  } catch (e) {
    // The agent needs the real reason so it can rewrite the query. A real
    // engine's binder error ("no such column: regoin") is far more useful than
    // the old interpreter's blanket "unsupported".
    return JSON.stringify({ error: (e as Error).message, sql });
  }

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
}

// Convenience: short schema summary string for callers that want to inline the
// list of tables into the tool description.
//
// `allowSet` is not optional decoration: this string is what tells a model
// which tables exist, so a caller that restricts runSqlQuery but not this is
// still naming the forbidden tables to the model. It took the embed BI widget
// path leaking past an agent's allow-list for the parameter to exist at all.
export async function describeUserTables(
  ctx: AgentToolContext,
  allowSet?: Set<string> | null,
): Promise<string> {
  const tables = await loadUserTables(ctx, allowSet);
  if (tables.length === 0) return "";
  return tables
    .map(
      (t) =>
        `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(", ")}) — ${t.rows.length} rows`,
    )
    .join("; ");
}
