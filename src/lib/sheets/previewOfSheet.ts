// A sheet's thumbnail from a running engine, as the sheet reads on screen:
// computed values in their number formats, and the colors its conditional
// formatting gives them. The editor and the server both draw it this way.

import { cellView } from "./cellView";
import { CondFormatter } from "./condFormat";
import type { GridData, WorkbookEngine } from "./engine";
import { isMatrix, todaySerial, type Scalar } from "./formula/values";
import { buildPreview, type WorkbookPreview } from "./preview";

export function previewOfSheet(
  engine: WorkbookEngine,
  sheetId: string,
  name: string,
  grid: GridData,
): WorkbookPreview {
  const rules = grid.cond?.length
    ? new CondFormatter(grid.cond, {
        value: (r, c) => engine.getValue(sheetId, r, c),
        evaluate: (f, r, c) => {
          const v = engine.evaluateAt(sheetId, r, c, f);
          return (isMatrix(v) ? (v[0]?.[0] ?? null) : v) as Scalar;
        },
        today: todaySerial(),
      })
    : null;
  return buildPreview(name, grid, (r, c) => {
    const view = cellView(engine.getValue(sheetId, r, c), engine.getInput(sheetId, r, c));
    const hit = rules?.at(r, c);
    return hit ? { ...view, cf: { bg: hit.bg, color: hit.color, b: hit.b } } : view;
  });
}
