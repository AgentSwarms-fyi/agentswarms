// What an ETL pipeline's lakehouse nodes may read and write (R225).
//
// Checked before a run or a preview starts, so a graph that cannot run fails
// with its node's name before any container does. The app checks again on
// every read and commit (sandboxLake.server): the sandbox holds no lakehouse
// credential, and reads run through the owners' policies there.
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
 *
 * Since the sandbox gateway, a READ of a policed table is no longer refused:
 * the app runs it through the owner's policy, as the SQL editor does, and the
 * pipeline gets the rows and values its owner may see. Writing one still is.
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

  // Owners write their own tables; a table under another owner's policy is
  // read-only for everyone else. Reads of one are served through the policy.
  const foreign = allowed.filter((s) => s.user_id !== userId);
  const foreignWrites = touched.filter(
    (t) => t.write && foreign.some((f) => f.name.toLowerCase() === t.schema.toLowerCase()),
  );
  if (!foreignWrites.length) return null;
  const policies = await loadPolicies(
    [...new Set(foreign.map((f) => f.user_id))],
    foreignWrites.map((t) => ({ schema: t.schema.toLowerCase(), table: t.table.toLowerCase() })),
  );
  for (const t of foreignWrites) {
    if (!policies.has(`${t.schema}.${t.table}`.toLowerCase())) continue;
    return `Node "${t.label}": ${t.schema}.${t.table} has a security policy set by its owner, so it is read-only for anyone else — a pipeline cannot write it.`;
  }
  return null;
}
