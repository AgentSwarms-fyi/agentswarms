// The table list a SQL tool's description carries.
//
// PURE — no Supabase, no env. The sql_query tool describes the user's tables
// inline so the model can write correct SQL without a round trip. Measured on
// an account with fifteen tables of forty-odd columns (ADVERSARIAL_LOG R12),
// that description alone was 17,000 characters — 4,300 prompt tokens on every
// turn of every agent with the tool enabled, whether or not the question was
// about data; it was the single largest item of a thirteen-tool prompt. So
// the listing has a budget: tables are listed with their columns until the
// budget is spent, and by name with a column count after it, with a pointer
// to list_data_tables for the rest.

export const SQL_SCHEMA_SUMMARY_MAX_CHARS = 4000;

export type TableForSummary = {
  name: string;
  columns?: { name: string; type: string }[] | null;
};

export type SchemaSummary = {
  text: string;
  /** Tables whose columns made it into the text. */
  listed: number;
  /** Tables named only, their columns left to list_data_tables. */
  namedOnly: number;
};

/**
 * Tables sorted by name — a stable prefix is what a provider's prompt cache
 * keys on, and the database returns rows in whatever order it likes — each
 * with its columns while the budget lasts, by name with a column count after.
 */
export function summarizeTablesForPrompt(
  tables: TableForSummary[],
  maxChars: number = SQL_SCHEMA_SUMMARY_MAX_CHARS,
): SchemaSummary {
  const budget = Number.isFinite(maxChars)
    ? Math.min(200_000, Math.max(200, Math.floor(maxChars)))
    : SQL_SCHEMA_SUMMARY_MAX_CHARS;
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const full: string[] = [];
  const named: string[] = [];
  let used = 0;
  for (const t of sorted) {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const line = `${t.name}(${cols.map((c) => `${c.name}:${c.type}`).join(", ")})`;
    // Once one table did not fit, the rest are named only: a listing that
    // skips a wide table and then lists a narrow one reads as if the wide
    // table did not exist.
    if (named.length === 0 && used + line.length + 2 <= budget) {
      full.push(line);
      used += line.length + 2;
    } else {
      named.push(`${t.name} (${cols.length} columns)`);
    }
  }
  let text = full.join("; ");
  if (named.length > 0) {
    text +=
      (text ? "; " : "") +
      `columns not listed for ${named.join(", ")} — call list_data_tables for them`;
  }
  return { text, listed: full.length, namedOnly: named.length };
}
