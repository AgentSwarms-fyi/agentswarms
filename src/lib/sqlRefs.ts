// Pure SQL table-reference extraction, shared by client (catalog lineage,
// audit emit) and server (warehouse-query audit) code. No imports so it is
// safe in any bundle.

// Handles bare, backticked, double-quoted and bracketed identifiers,
// including quoted multi-part refs like "schema"."table".
const TABLE_REF_RE = /\b(?:from|join)\s+[`"[]?([\w$]+(?:[`"\]]?\.[`"[]?[\w$]+)*)/gi;

/** FROM/JOIN table references in a SQL statement (deduped, lowercased). */
export function extractTableRefs(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(TABLE_REF_RE)) {
    out.add(m[1].replace(/[`"\][]/g, "").toLowerCase());
  }
  return [...out];
}
