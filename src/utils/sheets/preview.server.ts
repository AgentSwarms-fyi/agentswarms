// Thumbnails for workbooks that have none yet (made before thumbnails were
// kept, or not opened since): the first grid sheet computed by the same
// engine the editor runs, so a thumbnail shows values, not formulas. A
// workbook too large to compute here gets an empty thumbnail; the editor
// draws the real one the next time it is opened.

import { WorkbookEngine, type GridData, type SheetDef } from "@/lib/sheets/engine";
import type { WorkbookPreview } from "@/lib/sheets/preview";
import { previewOfSheet } from "@/lib/sheets/previewOfSheet";

/** Cells over every grid sheet above which the server does not compute a thumbnail. */
export const BACKFILL_MAX_CELLS = 50_000;

export type TabForPreview = {
  id: string;
  name: string;
  kind: "grid" | "table";
  position: number;
  grid: unknown;
};

function gridOf(json: unknown): GridData {
  const g = (json && typeof json === "object" ? json : {}) as Partial<GridData>;
  return { ...g, cells: (g.cells ?? {}) as GridData["cells"] };
}

export function previewOfTabs(tabs: TabForPreview[]): WorkbookPreview | null {
  const ordered = [...tabs].sort((a, b) => a.position - b.position);
  const first = ordered.find((t) => t.kind === "grid");
  if (!first) return null;
  const defs: SheetDef[] = ordered.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    grid: t.kind === "grid" ? gridOf(t.grid) : undefined,
  }));
  const cells = defs.reduce((n, d) => n + Object.keys(d.grid?.cells ?? {}).length, 0);
  const grid = defs.find((d) => d.id === first.id)!.grid!;
  if (cells > BACKFILL_MAX_CELLS)
    return { v: 1, sheet: first.name.slice(0, 100), rows: [], widths: [], charts: [] };
  // Table sheets are not read here: a formula over one shows as pending.
  const engine = new WorkbookEngine(defs);
  return previewOfSheet(engine, first.id, first.name, grid);
}
