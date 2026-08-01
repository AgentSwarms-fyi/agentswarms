// Turn a SQL engine's diagnostics into something a person can act on.
//
// Both local engines report failures in their own idiom, and those strings went
// straight to the user. A real example, from the semantic-model runner:
//
//   Catalog Error: Scalar Function with name `__postfix does not exist!
//   Did you mean "!__postfix"?
//
// The actual problem was a backtick-quoted column. Nothing in that message says
// so, the suggestion is nonsense, and the reader is left believing they have hit
// an internal bug. Worse, some of these name a REAL product limitation the user
// has no way to guess — AlaSQL treats `total` and `value` as reserved words, so
// `SUM(sales) AS total` is a parse error, and that is the single most natural
// alias anyone writes.
//
// The original text is always kept. Hiding it would trade one unhelpful message
// for another, and an operator reading logs needs the engine's own words.

export type LocalEngineName = "alasql" | "duckdb";

/** A rule maps an engine's phrasing to what the reader should actually do. */
type Rule = {
  engines?: LocalEngineName[];
  match: RegExp;
  explain: (m: RegExpMatchArray, engine: LocalEngineName) => string;
};

const RULES: Rule[] = [
  {
    // DuckDB is ANSI and rejects backticks outright. The parser error it
    // produces names a mangled identifier rather than the quoting.
    engines: ["duckdb"],
    match: /(?:Parser Error|Catalog Error).*?`/s,
    explain: () =>
      "This query quotes an identifier with backticks (`), which the DuckDB engine does not accept. " +
      'Use double quotes instead — "Order Date" rather than `Order Date`.',
  },
  {
    // The AlaSQL reserved-word defect. Costs an afternoon if you do not know.
    engines: ["alasql"],
    match: /\b(?:syntax error|parse error|unexpected)\b/i,
    explain: (_m, engine) =>
      `The ${engine} engine could not parse this SQL. ` +
      "A common cause is aliasing a column `total` or `value` — both are reserved words in AlaSQL, " +
      "so `SUM(amount) AS total` fails to parse. Rename the alias (for example `total_amount`). " +
      "AlaSQL also does not support CTEs, window functions or subqueries. " +
      "This deployment has opted out of the default engine with LOCAL_ENGINE=alasql; " +
      "removing that setting restores DuckDB, which supports all three.",
  },
  {
    match: /(?:Table with name|Table not found|Cannot find table)\s+"?([A-Za-z0-9_]+)"?/i,
    explain: (m) =>
      `There is no table called "${m[1]}" in this query's scope. ` +
      "Check the dataset name, and that it is one you own or has been shared with you.",
  },
  {
    match: /(?:Referenced column|Column with name|column not found)\s+"?([A-Za-z0-9_ ]+)"?/i,
    explain: (m) =>
      `The column "${m[1].trim()}" does not exist on the tables in this query. ` +
      "Column names are case-sensitive here, and a name containing a space must be quoted.",
  },
  {
    match: /Scalar Function with name ([A-Za-z0-9_]+) does not exist/i,
    explain: (m, engine) =>
      `"${m[1]}" is not a function the ${engine} engine provides. ` +
      "Check the spelling, or use a supported equivalent.",
  },
  {
    match: /Conversion Error|could not convert|Invalid cast/i,
    explain: () =>
      "A value could not be converted to the type the query expects. " +
      "This usually means a column holding text is being used as a number or a date — " +
      "column types are inferred from a sample of rows, so a single stray value can cause it.",
  },
  {
    match: /out of memory|memory limit|Resource Error/i,
    explain: () =>
      "The query ran out of memory. Narrow it with a filter or fewer columns, " +
      "or raise LOCAL_ENGINE_MEMORY_MB.",
  },
];

/**
 * Explain an engine failure, keeping the engine's own words.
 *
 * Returns the original message unchanged when nothing matches — a wrong
 * explanation is worse than none, so this only speaks when it recognises the
 * shape of the failure.
 */
export function explainEngineError(raw: string, engine: LocalEngineName): string {
  const message = (raw ?? "").trim();
  if (!message) return "The query failed, and the engine gave no reason.";

  for (const rule of RULES) {
    if (rule.engines && !rule.engines.includes(engine)) continue;
    const m = message.match(rule.match);
    if (m) return `${rule.explain(m, engine)}\n\nEngine (${engine}): ${message}`;
  }
  return message;
}

/** Convenience for a caught value of unknown type. */
export function explainEngineFailure(e: unknown, engine: LocalEngineName): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const err = new Error(explainEngineError(raw, engine));
  if (e instanceof Error && e.stack) err.stack = e.stack;
  return err;
}
