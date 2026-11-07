// How a materialized view refreshes, the pure half (R458): rebuild it, append
// only the rows its source gained, or leave it as it is because nothing it
// reads has changed.
//
// A refresh used to be `CREATE OR REPLACE TABLE … AS <query>` every time: an
// hourly view over a table nobody had touched since yesterday rewrote all of
// its rows, and left a snapshot in the lakehouse's history, twenty-four times
// a day. The decision here is taken only when it is provably the same answer:
//
// - SKIP when no table the governed query reads has changed since the last
//   refresh, the query and the policies applied to it are what they were, it
//   calls nothing whose answer can change between two runs, and the view's
//   own table is as the last refresh left it.
// - APPEND when the query keeps or drops rows of ONE table the owner owns,
//   without aggregating, joining, ranking or limiting them, and that table has
//   only gained rows since: the new rows are exactly those whose rowid is at
//   or above the floor the last refresh recorded.
// - REBUILD otherwise, as before.
//
// Measured on DuckDB 1.5.5 with DuckLake before this was written: a
// transaction reads one snapshot of the lakehouse, its data and its
// `snapshots()` alike, so the floors and versions recorded with a refresh are
// those of the rows it read; a rowid is assigned in increasing order and
// survives an update, a flush of inlined rows and a compaction; and
// `duckdb_functions()` names each function's stability (`now()` and
// `current_date` are CONSISTENT_WITHIN_QUERY, `random()` VOLATILE).

/** One table reference in a parsed statement. */
export type TableRef = { catalog: string; schema: string; table: string };

/** What the parsed, governed query reads and calls. */
export type QueryFacts = {
  tables: TableRef[];
  /** Names referenced without a schema that are not a CTE the query defines. */
  unqualified: string[];
  /** read_parquet(), a ducklake_* function and the like: their input cannot be tracked. */
  tableFunctions: string[];
  functions: string[];
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function walk(v: unknown, visit: (o: Json) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
  } else if (isObj(v)) {
    visit(v);
    for (const x of Object.values(v)) walk(x, visit);
  }
}

/** CTE names defined anywhere in the statement. */
function cteNames(stmt: unknown): Set<string> {
  const out = new Set<string>();
  walk(stmt, (o) => {
    const map = isObj(o.cte_map) ? o.cte_map.map : undefined;
    if (Array.isArray(map)) {
      for (const e of map) if (isObj(e) && typeof e.key === "string") out.add(e.key.toLowerCase());
    }
  });
  return out;
}

/** The facts a decision needs, from `json_serialize_sql` output. */
export function queryFacts(serialized: string): QueryFacts {
  const parsed = JSON.parse(serialized) as Json;
  if (parsed.error) throw new Error(String(parsed.error_message ?? "the query did not parse"));
  const statements = Array.isArray(parsed.statements) ? parsed.statements : [];
  const facts: QueryFacts = { tables: [], unqualified: [], tableFunctions: [], functions: [] };
  const ctes = cteNames(statements);
  const fns = new Set<string>();
  walk(statements, (o) => {
    if (o.type === "BASE_TABLE" && typeof o.table_name === "string") {
      const schema = String(o.schema_name ?? "");
      if (!schema) {
        if (!ctes.has(o.table_name.toLowerCase())) facts.unqualified.push(o.table_name);
        return;
      }
      facts.tables.push({ catalog: String(o.catalog_name ?? ""), schema, table: o.table_name });
    } else if (o.type === "TABLE_FUNCTION") {
      const fn = isObj(o.function) ? String(o.function.function_name ?? "?") : "?";
      facts.tableFunctions.push(fn);
    }
    if ((o.class === "FUNCTION" || o.class === "WINDOW") && typeof o.function_name === "string") {
      fns.add(o.function_name.toLowerCase());
    }
  });
  facts.functions = [...fns].sort();
  return facts;
}

/**
 * Why rows of this query cannot be appended for the new rows of its source,
 * or null when they can: one SELECT over one base table that keeps or drops
 * rows one by one. Anything that looks at more than one row at a time (an
 * aggregate, a window, DISTINCT, LIMIT, a subquery, a join, a set operation)
 * makes the new rows' answer depend on the old ones.
 */
export function appendShapeRefusal(serialized: string, aggregates: Set<string>): string | null {
  // The marker parseExact uses, already in the text (a string literal holding
  // it): the statement could not be printed back exactly, so it is rebuilt.
  if (serialized.includes("\\u0000num:")) return "its text cannot be rewritten exactly";
  const parsed = JSON.parse(serialized) as Json;
  const statements = Array.isArray(parsed.statements) ? parsed.statements : [];
  if (statements.length !== 1) return "more than one statement";
  const node = isObj(statements[0]) ? (statements[0] as Json).node : null;
  if (!isObj(node) || node.type !== "SELECT_NODE") return "not a plain SELECT";
  if (cteNames(node).size) return "it defines a CTE";
  const from = node.from_table;
  if (!isObj(from) || from.type !== "BASE_TABLE") return "it does not read exactly one table";
  if (from.at_clause || from.sample) return "it reads a table at a version or a sample";
  if (Array.isArray(node.group_expressions) && node.group_expressions.length) return "it groups";
  if (node.having || node.qualify || node.sample) return "it filters groups or samples";
  const modifiers = Array.isArray(node.modifiers) ? node.modifiers : [];
  if (modifiers.some((m) => isObj(m) && m.type !== "ORDER_MODIFIER")) {
    return "it uses DISTINCT or LIMIT";
  }
  let why: string | null = null;
  walk(node, (o) => {
    if (why) return;
    if (o.class === "SUBQUERY") why = "it has a subquery";
    else if (o.class === "WINDOW") why = "it uses a window function";
    else if (o.class === "FUNCTION" && typeof o.function_name === "string") {
      if (aggregates.has(o.function_name.toLowerCase())) why = "it aggregates";
    }
  });
  return why;
}

/** A JSON string that stands for a number too long for a double; never in DuckDB's output. */
const BIG = "\u0000num:";

/**
 * JSON.parse, keeping every number with more digits than a double holds as
 * text. DuckDB's parse tree carries 18446744073709551615 ("no location") and
 * the user's own literals, a BIGINT key or a DECIMAL(38) amount; read as
 * doubles they round, and the statement printed back from the tree would
 * compare against a different number (found building R458: the engine refused
 * the rounded location, which is how it showed).
 */
export function parseExact(json: string): unknown {
  let out = "";
  let i = 0;
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < json.length && /[0-9eE.+-]/.test(json[j]!)) j++;
      const token = json.slice(i, j);
      const digits = token.replace(/[^0-9]/g, "").replace(/^0+/, "").length;
      out += digits > 15 ? JSON.stringify(BIG + token) : token;
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}

/** JSON.stringify, putting back the numbers parseExact kept as text. */
export function stringifyExact(value: unknown): string {
  return JSON.stringify(value).replace(/"\\u0000num:([-0-9eE.+]+)"/g, "$1");
}

/**
 * The statement with its one table read only from `floor` up: the table
 * reference replaced by `fromNode`, the parsed `FROM (SELECT * FROM t WHERE
 * rowid >= floor) AS alias` the caller serialized, under the original alias so
 * every column reference still resolves. Both trees are read with parseExact,
 * and the result goes back to the engine through stringifyExact.
 */
export function withRowFloor(serialized: string, fromSerialized: string): string {
  const parsed = parseExact(serialized) as Json;
  const floorTree = parseExact(fromSerialized) as Json;
  const fromNode = ((floorTree.statements as Json[])[0]!.node as Json).from_table as Json;
  const stmt = (parsed.statements as Json[])[0]!;
  const node = stmt.node as Json;
  const from = node.from_table as Json;
  const alias = String(from.alias || from.table_name);
  node.from_table = {
    ...fromNode,
    alias,
    column_name_alias: Array.isArray(from.column_name_alias) ? from.column_name_alias : [],
  };
  return stringifyExact(parsed);
}

/** The text a floor's subquery is parsed from. The caller has checked the names. */
export function floorSubquerySql(schema: string, table: string, floor: number): string {
  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return (
    `SELECT * FROM (SELECT * FROM ${ident(schema)}.${ident(table)} ` +
    `WHERE rowid >= ${Math.max(0, Math.floor(floor))}) AS _floor`
  );
}

/** A source as a refresh recorded it. */
export type SourceState = {
  schema: string;
  table: string;
  /** DuckLake's table id: a CREATE OR REPLACE makes a new one. */
  id: string;
  /** The smallest rowid a row added after the refresh can have. */
  floor: number;
};

/** What the last refresh recorded, kept with the view's rows in one commit. */
export type RefreshState = {
  /** The governed query's digest: the definition and the policies applied to it. */
  digest: string;
  /** The snapshot the refresh read. */
  snapshot: number;
  sources: SourceState[];
};

/** Change kinds that leave a table's rows as they were. */
const SAME_ROWS = new Set(["flushed", "compacted"]);
/** Change kinds that only add rows. */
const ADDS_ROWS = new Set(["inserted", "flushed", "compacted"]);

export type SourceNow = SourceState & {
  /** The kinds of every change to the table after the recorded snapshot. */
  kindsSince: string[][];
};

export type RefreshDecision =
  | { mode: "skip"; why: string }
  | { mode: "append"; why: string; source: SourceState }
  | { mode: "rebuild"; why: string };

/**
 * The decision, from what was recorded and what the refresh's own snapshot
 * shows. `tracked` is null when some table the query reads cannot be followed
 * (a mount, a view, a table function, a name without a schema); `volatile`
 * names a function whose answer can change between runs; `targetIntact` says
 * the view's table has not been written since the last refresh wrote it.
 */
export function decideRefresh(args: {
  prev: RefreshState | null;
  digest: string;
  tracked: SourceNow[] | null;
  untrackedWhy?: string;
  volatile: string[];
  targetIntact: boolean;
  appendRefusal: string | null;
  policed: boolean;
}): RefreshDecision {
  const { prev } = args;
  if (!prev) return { mode: "rebuild", why: "this is its first tracked refresh" };
  if (prev.digest !== args.digest) {
    return { mode: "rebuild", why: "the query or a policy applied to it changed" };
  }
  if (!args.tracked)
    return {
      mode: "rebuild",
      why: args.untrackedWhy ?? "it reads something that cannot be tracked",
    };
  if (args.volatile.length) {
    return {
      mode: "rebuild",
      why: `it calls ${args.volatile.join(", ")}, whose answer can change between runs`,
    };
  }
  if (!args.targetIntact) {
    return { mode: "rebuild", why: "its table was written since the last refresh" };
  }
  const byKey = new Map(prev.sources.map((s) => [`${s.schema}.${s.table}`.toLowerCase(), s]));
  const changed: SourceNow[] = [];
  for (const s of args.tracked) {
    const was = byKey.get(`${s.schema}.${s.table}`.toLowerCase());
    if (!was || was.id !== s.id) {
      return { mode: "rebuild", why: `${s.schema}.${s.table} is not the table it read last time` };
    }
    if (s.kindsSince.some((kinds) => kinds.some((k) => !SAME_ROWS.has(k)))) changed.push(s);
  }
  if (args.tracked.length !== prev.sources.length) {
    return { mode: "rebuild", why: "it reads other tables than last time" };
  }
  if (!changed.length) return { mode: "skip", why: "nothing it reads has changed" };
  if (args.appendRefusal)
    return { mode: "rebuild", why: `rows cannot be appended: ${args.appendRefusal}` };
  if (args.policed) return { mode: "rebuild", why: "a policy applies to what it reads" };
  if (changed.length !== 1 || args.tracked.length !== 1) {
    return { mode: "rebuild", why: "more than one table changed" };
  }
  const only = changed[0]!;
  if (only.kindsSince.some((kinds) => kinds.some((k) => !ADDS_ROWS.has(k)))) {
    return { mode: "rebuild", why: `${only.schema}.${only.table} had rows changed or removed` };
  }
  const was = byKey.get(`${only.schema}.${only.table}`.toLowerCase())!;
  return { mode: "append", why: `${only.schema}.${only.table} only gained rows`, source: was };
}
