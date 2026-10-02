// What an ETL pipeline's lakehouse nodes may read and write (R225).
//
// A pipeline's lakehouse nodes run in a sandbox that holds engine-level
// catalog and storage credentials, so whatever the server allows here is all
// that stands between a graph and every table in the lake.
import type { DuckDBConnection } from "@duckdb/node-api";

import {
  assertSchemasAllowed,
  lakehouseConnection,
  selectReferencedSchemas,
  selectReferencedTables,
  type SchemaRow,
} from "./core.server";
import { loadPolicies } from "./policies.server";

export type LakehouseNodeRef = {
  label: string;
  kind: "source" | "target";
  schema: string;
  table?: string;
  /** "table" reads `schema.table`; anything else runs `query`. */
  mode?: string;
  query?: string;
};

/**
 * Why these nodes may not run for this user, or null when they may.
 *
 * FOUND IN R225: only each node's own `schema` field was checked. A source in
 * query mode ran its SQL as written, so a node naming the author's own schema
 * could query any schema in the lake, shared with them or not. And a schema
 * shared with the author was read whole, past its owner's row filter and
 * column masks, which the sandbox cannot apply, and written whole, though the
 * lakehouse keeps a policed table read-only for everyone but its owner. The
 * query is now governed as the SQL editor governs one (every schema it reads
 * must be the author's or shared with them; no table functions, no
 * unqualified tables), and a table under another owner's policy is refused.
 */
export async function lakehouseNodesRefusal(
  userId: string,
  allowed: SchemaRow[],
  nodes: LakehouseNodeRef[],
  connect: () => Promise<DuckDBConnection> = lakehouseConnection,
): Promise<string | null> {
  const touched: { label: string; schema: string; table: string; write: boolean }[] = [];
  let c: DuckDBConnection | null = null;
  try {
    for (const n of nodes) {
      if (n.kind === "source" && n.mode !== "table") {
        const query = (n.query ?? "").trim();
        if (!query) continue;
        c ??= await connect();
        try {
          assertSchemasAllowed(await selectReferencedSchemas(c, query), allowed);
        } catch (e) {
          return `Node "${n.label}": ${(e as Error).message}`;
        }
        for (const t of await selectReferencedTables(c, query)) {
          touched.push({ label: n.label, ...t, write: false });
        }
      } else if (n.table) {
        touched.push({
          label: n.label,
          schema: n.schema,
          table: n.table,
          write: n.kind === "target",
        });
      }
    }
  } finally {
    c?.closeSync();
  }

  // Owners read and write their own tables whole; everyone else meets the
  // owner's policy, which nothing in the sandbox can apply.
  const foreign = allowed.filter((s) => s.user_id !== userId);
  const foreignTables = touched.filter((t) =>
    foreign.some((f) => f.name.toLowerCase() === t.schema.toLowerCase()),
  );
  if (!foreignTables.length) return null;
  const policies = await loadPolicies(
    [...new Set(foreign.map((f) => f.user_id))],
    foreignTables.map((t) => ({ schema: t.schema.toLowerCase(), table: t.table.toLowerCase() })),
  );
  for (const t of foreignTables) {
    if (!policies.has(`${t.schema}.${t.table}`.toLowerCase())) continue;
    return t.write
      ? `Node "${t.label}": ${t.schema}.${t.table} has a security policy set by its owner, so it is read-only for anyone else — a pipeline cannot write it.`
      : `Node "${t.label}": ${t.schema}.${t.table} has a security policy set by its owner, which a pipeline cannot apply — query it in the Lakehouse, where the policy holds.`;
  }
  return null;
}
