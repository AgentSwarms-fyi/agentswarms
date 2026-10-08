/** First table referenced by the widget's SQL (handles `t`, "t", schema.t). */
export function extractBaseTable(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = sql.match(/\bfrom\s+[`"[]?([\w.$]+)[`"\]]?/i);
  return m?.[1] ?? null;
}
