// sql_query agent tool — server-side handler.
//
// What lives here is the TENANT BOUNDARY, not a SQL engine. `visibleUserTables`
// decides which datasets this caller may see (own, public samples, and
// IAM-granted tables) and `readUserTable` re-applies a shared dataset's
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

import { auditEvent } from "@/utils/audit.server";
import { resultDigest } from "@/utils/provenance/canonical";
import { restrictSharedDataset } from "@/utils/data/sharedDatasets.server";
import type { ToolDef, AgentToolContext } from "./registry.server";
import { scanDatasetRows } from "@/utils/data/datasetRows.server";
import { namesMentioned } from "@/lib/sqlRefs";

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
/** Rows one dataset may contribute to a tool-run query. Refused, not cut. */
const SQL_TOOL_MAX_ROWS = Number(process.env.SQL_TOOL_MAX_ROWS) || 200_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply the visibility rule for user_data_tables to a query.
 *
 * On the RLS path the user's JWT already restricts the read, so nothing is
 * added. On the HEADLESS path (`scopeUserId` set, service-role client, RLS off)
 * this is the only tenant boundary, and it mirrors the RLS policy exactly: the
 * owner's own tables, public samples, and tables shared to them by an IAM
 * grant. Narrowing it to `user_id` alone would be "secure" and would also hide
 * datasets the agent is entitled to use.
 *
 * Takes the query rather than the column list so each caller keeps its own
 * literal `.select(...)` — and with it, the inferred row type.
 *
 * Exported because the tool DESCRIPTION lists the same tables. That listing had
 * no filter at all, so on a headless run it named every tenant's tables and
 * their columns in the prompt. The data path still refused to read them, but
 * the schemas were already out.
 *
 * Returns null when the scope is unusable, which callers treat as "no tables".
 */
export async function scopeToVisibleTables<Q extends { or: (filter: string) => Q }>(
  ctx: AgentToolContext,
  query: Q,
): Promise<Q | null> {
  if (!ctx.scopeUserId) return query;
  if (!UUID_RE.test(ctx.scopeUserId)) return null;
  const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
  const granted = await resolveGrantedResourceIds(ctx.sb, ctx.scopeUserId, "data_table");
  const orParts = [`user_id.eq.${ctx.scopeUserId}`, `is_sample.eq.true`];
  const grantedIds = [...granted].filter((id) => UUID_RE.test(id));
  if (grantedIds.length) orParts.push(`id.in.(${grantedIds.join(",")})`);
  return query.or(orParts.join(","));
}

/**
 * The tables this caller may see, narrowed by the agent's allow-list. The list
 * only: no rows are read here.
 */
async function visibleUserTables(ctx: AgentToolContext, allowSet?: Set<string> | null) {
  // Normal (RLS) path: no explicit ownership filter — this client runs under
  // the user's JWT, so RLS returns exactly what they may read (own tables,
  // public samples, IAM-shared tables).
  // Headless path (ctx.scopeUserId set): `sb` is the service-role client with
  // RLS OFF, so we MUST restrict to what the owner may read — their own tables,
  // public samples, and tables shared to them via an IAM grant (mirroring the
  // RLS policy). This is the only tenant boundary here.
  const base = ctx.sb
    .from("user_data_tables")
    .select("id, name, columns, user_id, is_sample")
    // `__upload_*` rows are staging areas for an in-flight upload, not datasets.
    .not("name", "like", "__upload_%");
  const query = await scopeToVisibleTables(ctx, base);
  if (!query) return [];
  const { data: tables } = await query;
  if (!tables) return [];
  return allowSet && allowSet.size > 0 ? tables.filter((t) => allowSet.has(t.name)) : tables;
}

type VisibleTable = Awaited<ReturnType<typeof visibleUserTables>>[number];

/**
 * One table's rows, as this caller may see them. `oversized` when it has more
 * than SQL_TOOL_MAX_ROWS: its rows are then dropped, never answered from or
 * counted, and only its columns remain, for list_data_tables to show.
 */
async function readUserTable(
  ctx: AgentToolContext,
  t: VisibleTable,
): Promise<LoadedTable & { oversized: boolean }> {
  const viewerId = ctx.scopeUserId ?? ctx.userId;
  // A dataset SHARED with this caller carries the grant's row filter and
  // column mask. On headless runs ctx.sb is service-role (RLS off), so the
  // database can't enforce it for us — the restriction has to be applied
  // here or an agent would read past a mask the owner set.
  const shared = !t.is_sample && t.user_id !== viewerId;
  let columns = (Array.isArray(t.columns) ? t.columns : []) as ColumnDef[];
  // Through selectAllPages, which advances by the rows it RECEIVED.
  //
  // This loop advanced by the page it asked for, so a server returning fewer
  // rows than requested left a hole rather than a short tail: ask 0-999,
  // receive 500 because db-max-rows says so, then ask 1000-1999 and rows
  // 500-999 are never read at all. The agent then answers questions from a
  // table that is quietly missing its middle — and unlike a truncated read,
  // nothing about the result says a row is absent. It also folded the page's
  // error into the exhaustion test, and ordered by nothing at all, which is
  // its own way of reading the same row twice.
  const scan = await scanDatasetRows(t.id, SQL_TOOL_MAX_ROWS, ctx.sb);
  if (scan.truncated) {
    // The mask still applies to what a listing shows: the columns.
    if (shared)
      columns = (await restrictSharedDataset(ctx.sb, t.id, viewerId, columns, [])).columns;
    return { name: t.name, columns, rows: [], oversized: true };
  }
  let rows = scan.rows as Row[];
  if (shared) {
    const restricted = await restrictSharedDataset(ctx.sb, t.id, viewerId, columns, rows);
    columns = restricted.columns;
    rows = restricted.rows;
  }
  return { name: t.name, columns, rows, oversized: false };
}

/** Why sql_query will not read a table: the cap, and the setting that moves it. */
function oversizedRefusal(name: string): string {
  return (
    `"${name}" has more than ${SQL_TOOL_MAX_ROWS.toLocaleString()} rows — refusing to answer ` +
    `from a prefix of it; narrow the question or raise SQL_TOOL_MAX_ROWS`
  );
}

export async function runListDataTables(
  ctx: AgentToolContext,
  _args?: unknown,
  allowSet?: Set<string> | null,
): Promise<string> {
  const visible = await visibleUserTables(ctx, allowSet);
  if (visible.length === 0) {
    return JSON.stringify({
      tables: [],
      note: "No data tables found. The user can upload a CSV in the Data & SQL Agents page.",
    });
  }
  // Every table is listed, an oversized one included (R487). It used to fail
  // the whole listing, which hid every other table from the agent too. Its
  // row_count is null rather than the cap: the rows read before the scan
  // stopped are not the size of the table.
  const tables = [];
  for (const t of visible) tables.push(await readUserTable(ctx, t));
  return JSON.stringify({
    tables: tables.map((t) => ({
      name: t.name,
      row_count: t.oversized ? null : t.rows.length,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      ...(t.oversized
        ? {
            note:
              `This table has more than ${SQL_TOOL_MAX_ROWS.toLocaleString()} rows, so sql_query ` +
              `refuses to read it rather than answer from a prefix of it. It can be queried once ` +
              `SQL_TOOL_MAX_ROWS is raised; the other tables are unaffected.`,
          }
        : {}),
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

  const visible = await visibleUserTables(ctx, allowSet);
  if (visible.length === 0) {
    return JSON.stringify({
      error:
        allowSet && allowSet.size > 0
          ? `No tables in this agent's allow-list are available. Allowed: ${Array.from(allowSet).join(", ")}.`
          : "User has no data tables yet. Suggest uploading a CSV in the Data & SQL Agents page.",
    });
  }

  // Only the tables the statement names are read (R487). Reading every visible
  // table meant one over SQL_TOOL_MAX_ROWS refused every query, including the
  // ones that never touch it. namesMentioned leans towards reading: a column
  // or alias sharing a table's name reads that table too, which costs a read
  // and never a wrong answer.
  const named = namesMentioned(
    sql,
    visible.map((t) => t.name),
  );
  const tables: LoadedTable[] = [];
  for (const t of visible) {
    if (!named.has(t.name)) continue;
    const read = await readUserTable(ctx, t);
    if (read.oversized) throw new Error(oversizedRefusal(t.name));
    tables.push({ name: read.name, columns: read.columns, rows: read.rows });
  }

  // `tables` above is the tenant boundary: visibleUserTables has applied scope
  // filtering and readUserTable shared-dataset masking. The engine only ever
  // sees rows this caller may read.
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
  // A dataset read is a data read. The UI path audits dataset.query; this tool
  // -- the one an agent actually uses -- wrote nothing, so an answer built from
  // a dataset showed "no data reads recorded". Names the tables the SQL
  // referenced (not merely those visible), so the trail says what was read.
  // Since R487 those are exactly the tables loaded above: namesMentioned chose
  // them, with the boundary-checked substring match (no RegExp built from a
  // table name) that used to live here, minus comments and string literals.
  const referenced = [...new Set(tables.map((t) => t.name))];
  auditEvent({
    userId: ctx.userId,
    action: "dataset.query",
    resourceType: "dataset",
    resourceName: referenced.join(", ").slice(0, 200) || undefined,
    decisionId: ctx.decisionId,
    detail: {
      via: "agent_tool",
      agent_id: ctx.agentId ?? null,
      tables: referenced,
      row_count: limited.length,
      total_matched: total,
      capped,
      // Recorded so the read can be REPLAYED: the query text, and a
      // fingerprint of what it returned. Re-running a query later only
      // proves the query runs; comparing today's result against the
      // digest taken at the time is what shows whether the answer's
      // data was what the record says it was.
      sql: sql.slice(0, 4000),
      result_digest: resultDigest(columns, limited),
    },
  });
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
  const visible = await visibleUserTables(ctx, allowSet);
  if (visible.length === 0) return "";
  // Like list_data_tables, an oversized table is described rather than
  // failing the summary of every other one.
  const tables = [];
  for (const t of visible) tables.push(await readUserTable(ctx, t));
  return tables
    .map((t) => {
      const size = t.oversized
        ? `more than ${SQL_TOOL_MAX_ROWS.toLocaleString()} rows, too many to query (SQL_TOOL_MAX_ROWS)`
        : `${t.rows.length} rows`;
      return `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(", ")}) — ${size}`;
    })
    .join("; ");
}
