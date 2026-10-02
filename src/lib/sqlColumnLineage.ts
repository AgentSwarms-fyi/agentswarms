// Column-level lineage for a SELECT, from DuckDB's own parse of it.
//
// json_serialize_sql gives the statement as a tree: a SELECT_NODE with a
// select_list of expressions, a from_table of BASE_TABLE / JOIN / SUBQUERY
// relations, and a cte_map. Each output column is the expression's alias (or
// the column it names), and its sources are every COLUMN_REF under the
// expression, resolved through the relation it belongs to — a base table
// directly, a CTE or subquery through its own output columns. `SELECT *`
// expands through the caller-supplied column list of a base table, so a
// model that starts from a lakehouse table traces to that table's columns.
// Pure over the tree; the one lookup it needs is injected.

export type SqlColumnRef = { schema: string; table: string; column: string };
export type SqlOutputColumn = { name: string; sources: SqlColumnRef[] };

type Node = Record<string, unknown>;
type Relation = { alias: string; columns: SqlOutputColumn[] };
type ColumnsOf = (schema: string, table: string) => string[] | null;

const asNode = (v: unknown): Node | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A list of unique refs, in first-seen order. */
function uniq(refs: SqlColumnRef[]): SqlColumnRef[] {
  const seen = new Set<string>();
  const out: SqlColumnRef[] = [];
  for (const r of refs) {
    const k = `${r.schema}.${r.table}.${r.column}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Every COLUMN_REF under an expression, as [qualifier?, column] pairs. */
function columnRefs(expr: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(expr)) {
    for (const e of expr) columnRefs(e, out);
    return out;
  }
  const n = asNode(expr);
  if (!n) return out;
  if (n.class === "COLUMN_REF" && Array.isArray(n.column_names)) {
    out.push((n.column_names as unknown[]).map(str));
    return out;
  }
  for (const v of Object.values(n)) columnRefs(v, out);
  return out;
}

/** The relations a FROM clause brings into scope, in order. */
function relations(
  from: unknown,
  ctes: Map<string, SqlOutputColumn[]>,
  columnsOf: ColumnsOf,
): Relation[] {
  const n = asNode(from);
  if (!n) return [];
  const type = str(n.type);
  if (type === "JOIN" || type === "CROSS_PRODUCT") {
    return [...relations(n.left, ctes, columnsOf), ...relations(n.right, ctes, columnsOf)];
  }
  if (type === "SUBQUERY") {
    const inner = asNode(n.subquery);
    const cols = inner ? traceQueryNode(inner.node, ctes, columnsOf) : [];
    return [{ alias: str(n.alias), columns: cols ?? [] }];
  }
  if (type === "BASE_TABLE") {
    const schema = str(n.schema_name);
    const table = str(n.table_name);
    const alias = str(n.alias) || table;
    const cte = !schema ? ctes.get(table.toLowerCase()) : undefined;
    if (cte) return [{ alias, columns: cte }];
    const names = columnsOf(schema, table);
    return [
      {
        alias,
        columns: (names ?? []).map((c) => ({ name: c, sources: [{ schema, table, column: c }] })),
      },
    ];
  }
  return [];
}

function resolve(ref: string[], rels: Relation[]): SqlColumnRef[] {
  const column = ref[ref.length - 1] ?? "";
  const qualifier = ref.length > 1 ? ref[ref.length - 2] : "";
  const candidates = qualifier
    ? rels.filter((r) => r.alias.toLowerCase() === qualifier.toLowerCase())
    : rels;
  for (const r of candidates) {
    const hit = r.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
    if (hit) return hit.sources;
  }
  return [];
}

function outputName(expr: Node): string {
  const alias = str(expr.alias);
  if (alias) return alias;
  if (expr.class === "COLUMN_REF" && Array.isArray(expr.column_names)) {
    const names = expr.column_names as unknown[];
    return str(names[names.length - 1]);
  }
  if (expr.class === "FUNCTION") return str(expr.function_name);
  return "";
}

function traceSelectNode(
  node: Node,
  outerCtes: Map<string, SqlOutputColumn[]>,
  columnsOf: ColumnsOf,
): SqlOutputColumn[] {
  const ctes = new Map(outerCtes);
  const map = (asNode(node.cte_map)?.map ?? []) as unknown[];
  for (const entry of map) {
    const e = asNode(entry);
    const q = asNode(asNode(e?.value)?.query);
    if (!e || !q) continue;
    const cols = traceQueryNode(q.node, ctes, columnsOf);
    ctes.set(str(e.key).toLowerCase(), cols ?? []);
  }
  const rels = relations(node.from_table, ctes, columnsOf);
  const out: SqlOutputColumn[] = [];
  for (const item of (node.select_list as unknown[]) ?? []) {
    const expr = asNode(item);
    if (!expr) continue;
    if (expr.class === "STAR") {
      const rel = str(expr.relation_name);
      const exclude = new Set(
        ((expr.exclude_list as unknown[]) ?? []).map((x) => str(x).toLowerCase()),
      );
      for (const r of rels) {
        if (rel && r.alias.toLowerCase() !== rel.toLowerCase()) continue;
        for (const c of r.columns) {
          if (!exclude.has(c.name.toLowerCase()))
            out.push({ name: c.name, sources: uniq(c.sources) });
        }
      }
      continue;
    }
    const sources = uniq(columnRefs(expr).flatMap((ref) => resolve(ref, rels)));
    out.push({ name: outputName(expr), sources });
  }
  return out;
}

function traceQueryNode(
  nodeIn: unknown,
  ctes: Map<string, SqlOutputColumn[]>,
  columnsOf: ColumnsOf,
): SqlOutputColumn[] | null {
  const node = asNode(nodeIn);
  if (!node) return null;
  if (node.type === "SELECT_NODE") return traceSelectNode(node, ctes, columnsOf);
  if (node.type === "SET_OPERATION_NODE") {
    // UNION and friends: columns by position, each fed by both sides.
    const left = traceQueryNode(node.left, ctes, columnsOf) ?? [];
    const right = traceQueryNode(node.right, ctes, columnsOf) ?? [];
    return left.map((c, i) => ({
      name: c.name,
      sources: uniq([...c.sources, ...(right[i]?.sources ?? [])]),
    }));
  }
  return null;
}

/**
 * The output columns of a serialised statement and where each comes from.
 * Null when the tree is not a SELECT (or failed to parse).
 */
export function traceSelectColumns(ast: unknown, columnsOf: ColumnsOf): SqlOutputColumn[] | null {
  const root = asNode(ast);
  if (!root || root.error) return null;
  const statements = root.statements as unknown[] | undefined;
  const first = asNode(statements?.[0]);
  if (!first) return null;
  return traceQueryNode(first.node, new Map(), columnsOf);
}
