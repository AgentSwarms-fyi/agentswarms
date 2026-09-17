// Reading SQL text safely enough to make an access decision from it.
//
// WHY THIS EXISTS. The lakehouse authorizes what a statement reads by handing
// it to DuckDB's own parser (`json_serialize_sql`) and walking the AST. That is
// the right way to do it and it is what the SELECT path does. It cannot be the
// whole answer, because the parser refuses every other statement kind:
//
//   SELECT json_serialize_sql('CREATE TABLE a.b AS SELECT * FROM c.d')
//   -> "Only SELECT statements can be serialized to json!"
//
// Verified against the engine this app ships (DuckDB 1.5.5) for CTAS,
// INSERT…SELECT, MERGE…USING, UPDATE…FROM, DELETE…USING and CREATE VIEW: all
// six are refused by the serializer. So a write statement's read set has to be
// recovered from the text, and text analysis of SQL is exactly the kind of
// shortcut that rots into a security hole.
//
// The rule that keeps it honest is FAIL CLOSED. This module does not try to
// understand a statement. It finds every schema-qualified name in it, outside
// string literals and comments, and the caller must be able to justify ALL of
// them. Over-approximating costs a user a refusal they could argue with; under-
// approximating costs them a table they did not know they had exposed.

/** A `schema.table` mention, as written. */
export type QualifiedRef = { schema: string; table: string };

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

/**
 * The statement with comments blanked, string literals preserved.
 *
 * Replaces, rather than deletes, so every character index in the result still
 * lines up with the input — callers that report a position stay correct.
 *
 * THE OLD VERSION WAS NOT LITERAL-AWARE, and the stripped text is what runs:
 * `INSERT INTO s.t VALUES ('A--B')` had everything from `--` deleted and died
 * with a syntax error nobody could explain, and `SELECT '/*' AS a, '*(/)' AS b`
 * silently became one column. So this walks the string instead of running two
 * regexes over it.
 */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Single-quoted literal, with '' as the escape. Dollar-quoting too, since
    // DuckDB accepts $$…$$ and a comment marker inside one is just text.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          out += quote + quote;
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$" && next === "$") {
      const end = sql.indexOf("$$", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      // Newlines survive so line numbers in an engine error still match.
      for (let k = i; k < stop; k++) out += sql[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Every `schema.table` in the statement, outside literals and comments.
 *
 * Deliberately blunt. It does not know which side of a join a name is on, or
 * whether it is a target or a source — the caller treats all of them as things
 * the user must be allowed to touch. A name inside a string is skipped, which
 * is the one false positive worth removing: `VALUES ('analytics.orders')` is
 * data, not a reference.
 *
 * Three-part names (`catalog.schema.table`) yield their LAST two parts, so a
 * fully qualified lake reference still resolves to the schema being read.
 */
export function qualifiedRefs(sql: string): QualifiedRef[] {
  const s = stripComments(sql);
  const out: QualifiedRef[] = [];
  const seen = new Set<string>();
  let i = 0;

  const readIdent = (): string | null => {
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end === -1) return null;
      const raw = s.slice(i + 1, end);
      i = end + 1;
      return raw;
    }
    if (!isIdentStart(s[i] ?? "")) return null;
    const start = i;
    while (i < s.length && IDENT_CHAR.test(s[i]!)) i++;
    return s.slice(start, i);
  };

  while (i < s.length) {
    const ch = s[i]!;
    // Skip literals wholesale — a dotted name inside one is not a reference.
    if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$" && s[i + 1] === "$") {
      const end = s.indexOf("$$", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (!isIdentStart(ch) && ch !== '"') {
      i++;
      continue;
    }

    const parts: string[] = [];
    for (;;) {
      const id = readIdent();
      if (id === null) break;
      parts.push(id);
      // A dot binds only when an identifier follows immediately; `t.*` and
      // `x.1` are not references.
      if (s[i] === "." && (isIdentStart(s[i + 1] ?? "") || s[i + 1] === '"')) {
        i++;
        continue;
      }
      break;
    }
    if (parts.length >= 2) {
      const table = parts[parts.length - 1]!;
      const schema = parts[parts.length - 2]!;
      // Separated by a character an identifier cannot contain, written as an
      // ESCAPE: a literal NUL byte in the source makes git call the file
      // binary and is invisible in every diff. A space would let `"a b".c`
      // and `a."b c"` collide into one key and drop a reference, which for a
      // security check means authorizing less than the statement touches.
      const key = `${schema.toLowerCase()}\u0000${table.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ schema, table });
      }
    }
    // A bare identifier that is not part of a dotted name: nothing to record.
    if (parts.length === 0) i++;
  }
  return out;
}

/**
 * The sub-SELECT of a write statement, when there is one that can be isolated.
 *
 * Only the forms where the select is unambiguously the tail of the statement:
 * `CREATE TABLE x AS <select>`, `CREATE VIEW x AS <select>` and
 * `INSERT INTO x [(cols)] <select>`. Returns null for everything else —
 * MERGE, UPDATE…FROM and DELETE…USING put their sources mid-statement, and
 * guessing where they end is how a parser-by-regex starts lying.
 *
 * A caller that gets null must fall back to `qualifiedRefs`, which is coarser
 * and refuses more.
 */
export function writeSubSelect(sql: string): string | null {
  const s = stripComments(sql).trim().replace(/;\s*$/, "");
  const m =
    /^(CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s+AS\s+)/i.exec(
      s,
    );
  if (m) {
    const tail = s.slice(m[0].length).trim();
    return /^(SELECT|WITH|\()/i.test(tail) ? tail : null;
  }
  const ins = /^INSERT\s+INTO\s+[^\s(]+\s*(\([^)]*\))?\s*/i.exec(s);
  if (ins) {
    const tail = s.slice(ins[0].length).trim();
    return /^(SELECT|WITH|\()/i.test(tail) ? tail : null;
  }
  return null;
}
