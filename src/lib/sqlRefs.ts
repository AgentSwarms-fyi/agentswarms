// Pure SQL scanning and table-reference extraction, shared by client (catalog
// lineage, analyst lineage, audit emit) and server (warehouse-query audit,
// object-store query planning) code. NO IMPORTS, so it is safe in any bundle —
// that constraint is why the scanner lives here rather than beside its first
// caller in biDrillThrough.
//
// WHY THIS IS NOT A REGEX ANY MORE. It was, and the regex answered a looser
// question than every caller was asking. Measured against the real function:
//
//   "SELECT 1 FROM orders -- was: from legacy_orders"      -> orders, legacy_orders
//   "SELECT 1 /* from archived_orders */ FROM orders"      -> archived_orders, orders
//   "... WHERE note = 'imported from stripe_charges'"      -> orders, stripe_charges
//   "WITH t AS (SELECT 1 FROM orders) SELECT * FROM t"     -> orders, t
//
// A comment, a string literal and a CTE alias are not tables. For the catalog
// that was noise in a search index; for the lineage panel and the query audit
// it is an assertion — "this answer read stripe_charges" — about a table the
// query never opened. One parser now serves both, because two parsers drifting
// is how the Workbench and the catalog end up disagreeing about what a query
// touched.
//
// AND IT STILL HAS TO FIND QUOTED IDENTIFIERS. A scanner that treats every
// quoted run as opaque is safe for keyword detection and useless for this: it
// misses `FROM "orders"` entirely, and on `FROM "orders" WHERE x` it returns
// the next bare word — reporting WHERE as a table. Quoted identifiers are
// therefore emitted as words, MARKED as quoted so keyword checks can ignore
// them (a column named "order" is still not an ORDER BY).

export type SqlWord = {
  /** Upper-cased text, for keyword comparison. */
  word: string;
  /** Offsets of the identifier text itself — INSIDE any quotes. */
  start: number;
  end: number;
  depth: number;
  /**
   * Came from a quoted/backticked/bracketed run. Callers matching keywords
   * MUST skip these: quoting is precisely how SQL says "this is a name, not
   * syntax".
   */
  quoted?: boolean;
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Closing delimiter for each opening one. */
const CLOSERS: Record<string, string> = { '"': '"', "`": "`", "[": "]" };

/**
 * Words outside comments and string literals, each tagged with its paren depth.
 *
 * Single-quoted runs are string literals and are skipped entirely. Double
 * quotes, backticks and brackets delimit IDENTIFIERS and are emitted as
 * `quoted` words. (A double-quoted MySQL-style string is consumed whole, so a
 * `from` inside it still cannot masquerade as a keyword.)
 */
export function scanWords(sql: string): SqlWord[] {
  const out: SqlWord[] = [];
  const n = sql.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Single quotes double to escape ('it''s'). A literal, never a name.
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const closer = CLOSERS[c];
    if (closer) {
      const start = i + 1;
      i++;
      while (i < n) {
        if (sql[i] === closer) {
          // "" inside a double-quoted identifier is an escaped quote.
          if (closer === '"' && sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      const end = Math.min(i, n);
      if (end > start) {
        out.push({ word: sql.slice(start, end).toUpperCase(), start, end, depth, quoted: true });
      }
      i++; // step past the closing delimiter
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(sql[i])) i++;
      out.push({ word: sql.slice(start, i).toUpperCase(), start, end: i, depth });
      continue;
    }
    i++;
  }
  return out;
}

/** Words that introduce a row source. */
const SOURCE_KEYWORDS = new Set(["FROM", "JOIN"]);

/** Quote characters that may sit between the parts of a dotted reference. */
const QUOTE_CHARS = /["`[\]]/g;

/**
 * Reassemble `schema.table` — the scanner emits bare words, so a dotted
 * reference arrives as separate words with a "." between them in the source.
 * Quote characters are stripped from the gap so `"sales"."orders"`,
 * `` `a`.`b` ``, `[a].[b]` and `"sales".orders` all join.
 */
function dottedName(src: string, words: SqlWord[], start: number): string {
  let name = src.slice(words[start].start, words[start].end);
  let i = start;
  while (
    i + 1 < words.length &&
    src
      .slice(words[i].end, words[i + 1].start)
      .replace(QUOTE_CHARS, "")
      .trim() === "."
  ) {
    name += `.${src.slice(words[i + 1].start, words[i + 1].end)}`;
    i++;
  }
  return name;
}

/**
 * Names bound by a WITH clause.
 *
 * These read like tables at the FROM site and are not: dropping them is the
 * difference between "this came from `orders`" and "this came from `orders`
 * and something called `t`".
 */
function cteNames(src: string, words: SqlWord[]): Set<string> {
  const names = new Set<string>();
  if (words[0]?.word !== "WITH" || words[0]?.quoted) return names;
  for (let i = 0; i < words.length - 1; i++) {
    // `<name> AS (` at the point a CTE is bound.
    if (words[i + 1].word !== "AS" || words[i + 1].quoted) continue;
    if (
      !src
        .slice(words[i + 1].end)
        .trimStart()
        .startsWith("(")
    )
      continue;
    names.add(src.slice(words[i].start, words[i].end).toLowerCase());
  }
  return names;
}

/**
 * FROM/JOIN table references in a SQL statement (deduped, lowercased).
 *
 * Reports only what the query actually reads: no names from comments or string
 * literals, and no CTE aliases, which are computed in the query rather than
 * read from storage.
 */
export function extractTableRefs(sql: string): string[] {
  const src = sql ?? "";
  const words = scanWords(src);
  const ctes = cteNames(src, words);
  const out: string[] = [];

  for (let i = 0; i < words.length; i++) {
    if (words[i].quoted || !SOURCE_KEYWORDS.has(words[i].word)) continue;
    const next = words[i + 1];
    // `FROM (SELECT ...)` is a subquery, not a table. Its own FROM is scanned
    // in its turn, so the real tables are still found — one level down.
    if (!next || src.slice(words[i].end, next.start).includes("(")) continue;
    const name = dottedName(src, words, i + 1);
    if (!name) continue;
    const key = name.toLowerCase();
    if (ctes.has(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}
