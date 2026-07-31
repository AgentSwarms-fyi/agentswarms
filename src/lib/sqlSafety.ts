// One read-only guard for the LOCAL SQL engines.
//
// This existed twice with different holes: the browser workbench had a keyword
// denylist but permitted stacked statements, while the server refresh path
// rejected stacking but had no denylist. Neither had both, and a security
// check implemented twice is a security check that will drift.
//
// Pure and dependency-free so every caller — browser, server, and the
// differential test harness — can apply exactly the same rule.
//
// NOTE: the WAREHOUSE guard (`assertReadOnlySql` in utils/warehouse/
// drivers.server.ts) is intentionally separate: it also permits SHOW /
// DESCRIBE / EXPLAIN, which are useful and harmless against a remote database
// but meaningless here. Keep them in sync in spirit; do not merge one into the
// other without warehouse integration tests.

/** Statements that must never reach a local engine, whatever the leading verb. */
const MUTATION_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|TRUNCATE|REPLACE|GRANT|REVOKE|MERGE|CALL|EXEC|EXECUTE)\b/i;

/**
 * Remove comments and string literals.
 *
 * Literals are stripped so the denylist inspects only SQL structure — without
 * this, `SELECT note FROM t WHERE note = 'please update me'` is rejected for
 * containing the word UPDATE, which is both wrong and the kind of false
 * positive that leads someone to weaken the check.
 */
function structureOnly(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  // Single-quoted literals, honouring '' as an escaped quote.
  out = out.replace(/'(?:[^']|'')*'/g, "''");
  return out;
}

export type SqlSafetyVerdict = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Check a statement destined for a local engine.
 *
 * Returns the statement with trailing semicolons trimmed, ready to execute.
 * Rejects anything that is not a single SELECT/WITH.
 */
export function checkLocalReadOnlySql(sql: string): SqlSafetyVerdict {
  const trimmedOriginal = sql.trim().replace(/;+\s*$/, "");
  const structure = structureOnly(trimmedOriginal).trim();

  if (!structure) return { ok: false, reason: "Empty SQL statement" };

  // Stacked statements: one `;` left after trailing ones were trimmed means a
  // second statement is hiding behind the first.
  if (structure.includes(";")) {
    return { ok: false, reason: "Only a single SQL statement is allowed per query" };
  }

  if (!/^(select|with)\b/i.test(structure)) {
    return { ok: false, reason: "Only read-only queries (SELECT / WITH) are allowed" };
  }

  const mutation = MUTATION_RE.exec(structure);
  if (mutation) {
    return {
      ok: false,
      reason: `Only read-only queries are allowed — found "${mutation[1].toUpperCase()}"`,
    };
  }

  return { ok: true, sql: trimmedOriginal };
}

/** Boolean form, for callers that just need to gate a UI action. */
export function isLocalReadOnlySql(sql: string): boolean {
  return checkLocalReadOnlySql(sql).ok;
}

/** Throwing form, for server paths that should fail loudly. */
export function assertLocalReadOnlySql(sql: string): string {
  const verdict = checkLocalReadOnlySql(sql);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.sql;
}
