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
// The WAREHOUSE guard now lives here too, as checkWarehouseReadOnlySql. It
// differs in ONE thing — it also permits SHOW / DESCRIBE / EXPLAIN, which are
// useful against a remote database and meaningless here — and shares
// everything that makes the check a security control.
//
// This file used to say "keep them in sync in spirit". They were not. The
// warehouse copy had the leading-verb check and the stacked-statement check
// but no denylist, so `WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d`
// passed it: begins with WITH, no semicolon, deletes rows on every
// Postgres-family provider and on SQL Server. "In sync in spirit" is not a
// mechanism, which is the lesson the first paragraph of this comment had
// already learned once.

/** Statements that must never reach a local engine, whatever the leading verb. */
const MUTATION_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|TRUNCATE|REPLACE|GRANT|REVOKE|MERGE|CALL|EXEC|EXECUTE)\b/i;

/**
 * Remove comments, string literals and quoted identifiers.
 *
 * Literals are stripped so the denylist inspects only SQL structure — without
 * this, `SELECT note FROM t WHERE note = 'please update me'` is rejected for
 * containing the word UPDATE, which is both wrong and the kind of false
 * positive that leads someone to weaken the check.
 *
 * Quoted IDENTIFIERS are stripped for the same reason: `SELECT "update" FROM t`
 * and ``SELECT `delete` FROM t`` are ordinary read-only queries against columns
 * that happen to be named after keywords, and both were refused.
 *
 * T-SQL's `[bracketed]` identifiers are deliberately NOT stripped. Brackets are
 * array subscripting in the Postgres family, so treating them as quoting would
 * mean stripping different things on different targets — and the failure
 * direction of leaving them is a rejected query, not an accepted one.
 */
function structureOnly(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  // Single-quoted literals, honouring '' as an escaped quote.
  out = out.replace(/'(?:[^']|'')*'/g, "''");
  // Double-quoted and backtick identifiers, honouring the doubled form.
  out = out.replace(/"(?:[^"]|"")*"/g, '""');
  out = out.replace(/`(?:[^`]|``)*`/g, "``");
  return out;
}

export type SqlSafetyVerdict = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * The shared scan: strip comments/literals/quoted identifiers, reject stacked
 * statements, require an allowed leading verb, then apply the mutation
 * denylist.
 *
 * The two guards differ ONLY in which leading verbs they permit. Everything
 * that makes the check a security control is here, once.
 *
 * THE DENYLIST IS THE PART THAT WAS MISSING FROM THE WAREHOUSE GUARD, and its
 * absence was not theoretical. A leading-verb check alone accepts
 *
 *     WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d
 *
 * which begins with WITH, contains no semicolon, and deletes rows. PostgreSQL
 * and every wire-compatible fork this project supports (CockroachDB,
 * TimescaleDB, AlloyDB, Greenplum, YugabyteDB) run data-modifying CTEs, and
 * T-SQL accepts `WITH cte AS (SELECT …) DELETE FROM cte` for SQL Server and
 * Azure SQL. That is write access to a customer's production warehouse through
 * a control that claims to be read-only.
 */
function checkReadOnly(sql: string, verbs: RegExp, verbLabel: string): SqlSafetyVerdict {
  const trimmedOriginal = sql.trim().replace(/;+\s*$/, "");
  const structure = structureOnly(trimmedOriginal).trim();

  if (!structure) return { ok: false, reason: "Empty SQL statement" };

  // Stacked statements: one `;` left after trailing ones were trimmed means a
  // second statement is hiding behind the first.
  if (structure.includes(";")) {
    return { ok: false, reason: "Only a single SQL statement is allowed per query" };
  }

  if (!verbs.test(structure)) {
    return { ok: false, reason: `Only read-only queries (${verbLabel}) are allowed` };
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

/**
 * Check a statement destined for a local engine.
 *
 * Returns the statement with trailing semicolons trimmed, ready to execute.
 * Rejects anything that is not a single SELECT/WITH.
 */
export function checkLocalReadOnlySql(sql: string): SqlSafetyVerdict {
  return checkReadOnly(sql, /^(select|with)\b/i, "SELECT / WITH");
}

/**
 * Check a statement destined for a REMOTE warehouse.
 *
 * Identical to the local check except that SHOW / DESCRIBE / EXPLAIN are also
 * permitted: they are useful and harmless against a remote database and
 * meaningless against a local one. That difference is the entire reason the
 * two guards exist separately — everything else is shared, so the denylist
 * cannot go missing from one of them again.
 */
export function checkWarehouseReadOnlySql(sql: string): SqlSafetyVerdict {
  return checkReadOnly(
    sql,
    /^(select|with|show|describe|desc|explain)\b/i,
    "SELECT / WITH / SHOW / DESCRIBE / EXPLAIN",
  );
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
