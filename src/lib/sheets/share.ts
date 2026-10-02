// Sharing a workbook, as both halves speak of it: who someone is to a
// workbook, and which rows of a sheet a viewer's share keeps. The rules live
// on the server (src/utils/sheets/access.server.ts); this is the vocabulary.

/** Someone's part in a workbook: their own, or shared with them to edit or to view. */
export type Role = "owner" | "editor" | "viewer";

/**
 * Which rows of a sheet a viewer gets. `column` is a table sheet's column
 * name, or a grid sheet's column letter; `header` (grid sheets) is how many
 * top rows are kept whatever they hold (titles, the header row).
 */
export type RowFilter = { column: string; values: string[]; header?: number };

/** "Region is West or East", for the share list and the viewer's banner. */
export function describeRowFilter(f: RowFilter, kind: "grid" | "table" = "table"): string {
  const col = kind === "grid" ? `column ${f.column.toUpperCase()}` : f.column;
  const shown = f.values.slice(0, 3).map((v) => (v === "" ? "(blank)" : v));
  const more = f.values.length > 3 ? ` or ${f.values.length - 3} more` : "";
  return `${col} is ${shown.join(", ")}${more}`;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Can edit",
  viewer: "Can view",
};
