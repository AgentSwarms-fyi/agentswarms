// The sheet tabs' rules around hidden sheets (R160), and what deleting one takes (R273).

import type { TableConfig } from "./sql/tableQuery";

/**
 * The sheet to show when the one in view is hidden: the next sheet showing,
 * or else the one before it. Undefined when the sheet in view is not hidden
 * (or no other sheet shows).
 */
export function shownInstead<T extends { id: string }>(
  tabs: readonly T[],
  inViewId: string | null | undefined,
  hidden: (t: T) => boolean,
): string | undefined {
  const i = tabs.findIndex((t) => t.id === inViewId);
  if (i < 0 || !hidden(tabs[i])) return undefined;
  const after = tabs.slice(i + 1).find((t) => !hidden(t));
  if (after) return after.id;
  for (let j = i - 1; j >= 0; j--) if (!hidden(tabs[j])) return tabs[j].id;
  return undefined;
}

/**
 * What deleting a sheet takes with it, for the confirmation. FOUND IN R273:
 * every sheet's said "Its cells go with it", a table sheet's too, which has no
 * cells: its rows are read from the lakehouse, which keeps them, and a table
 * Sheets held (rows uploaded or imported into it) can be changed from the
 * Lakehouse again once the sheet is gone.
 */
export function deleteSheetMessage(kind: "grid" | "table", config?: TableConfig): string {
  if (kind === "grid") {
    return "Its cells go with it. Formulas elsewhere that refer to it will show #REF!.";
  }
  const src = config?.source;
  const kept =
    src?.kind === "lakehouse"
      ? `Only the sheet goes: the lakehouse table ${src.schema}.${src.table} stays.`
      : src?.kind === "pivot"
        ? `Only the sheet goes: "${src.from}", the sheet it sums up, stays.`
        : "Only the sheet goes: the lakehouse tables it reads stay.";
  const held =
    src?.kind === "lakehouse" &&
    (config?.origin?.kind === "upload" || config?.origin?.kind === "warehouse")
      ? " Sheets stops holding the table, so it can be changed from the Lakehouse again."
      : "";
  return `${kept}${held} Formulas and pivots that use this sheet will show an error.`;
}
