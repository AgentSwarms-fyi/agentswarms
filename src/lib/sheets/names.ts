// Names a formula has to be able to read, checked the same way in the editor
// and on the server.

/**
 * A table sheet's name is how formulas refer to it (Orders[amount]), so it
 * must lex as a name: letters, digits, _ and ., not starting with a digit,
 * and not something that reads as a cell (A1) or a boolean.
 */
export function tableNameProblem(name: string): string | null {
  const n = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.]{0,99}$/.test(n)) {
    return "A table sheet's name is used in formulas (Orders[amount]): letters, digits, _ and ., starting with a letter";
  }
  if (/^[A-Za-z]{1,3}\d+$/.test(n)) return `"${n}" looks like a cell address; pick another name`;
  if (/^(true|false)$/i.test(n)) return `"${n}" is a reserved word`;
  return null;
}

/** A calculated column's name is written as [@name], so it cannot hold brackets or @. */
export function columnNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "A column needs a name";
  if (n.length > 128) return "A column name can be at most 128 characters";
  if (/[[\]@#'"]/.test(n)) return "A column name cannot contain [ ] @ # ' or \"";
  if (n.startsWith("__")) return "Names starting with __ are reserved";
  return null;
}

/** "sales_orders_2024" → "SalesOrders2024": a name formulas can use. */
export function suggestTableName(table: string, taken: Set<string>): string {
  const base =
    table
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("")
      .replace(/^[^A-Za-z_]+/, "") || "Table";
  const safe = /^[A-Za-z]{1,3}\d+$/.test(base) ? `${base}_` : base;
  let name = safe.slice(0, 90);
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${safe.slice(0, 88)}${n++}`;
  return name;
}
