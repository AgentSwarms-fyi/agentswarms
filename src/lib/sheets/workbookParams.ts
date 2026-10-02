// The values a workbook's names have now, as a query sheet's {{variables}}
// (R155). Each name is read as a formula would read it (=Region); a date
// cell goes as its date ('2026-03-08'), so it compares with a DATE column
// the way it reads, not as Excel's serial number.

import { effectiveFormat } from "./cellView";
import { nameTarget } from "./definedNames";
import type { WorkbookEngine } from "./engine";
import { isDateFormat } from "./format";
import { serialParts } from "./formula/values";
import { paramValue, type QueryParams } from "./sql/queryParams";

const pad = (n: number) => String(n).padStart(2, "0");

export function workbookParams(engine: WorkbookEngine): QueryParams {
  const sheets = engine.listSheets();
  const at = sheets.find((s) => s.kind !== "table");
  const out: QueryParams = {};
  if (!at) return out;
  for (const n of engine.definedNames()) {
    const v = paramValue(engine.evaluateAt(at.id, 0, 0, `=${n.name}`, { array: true }));
    if (v === undefined) continue;
    if (typeof v === "number") {
      const t = nameTarget(n.ref);
      if (t && t.range.r0 === t.range.r1 && t.range.c0 === t.range.c1) {
        const s = sheets.find((x) => x.name.toLowerCase() === t.sheet.toLowerCase());
        const f = s && effectiveFormat(engine.getInput(s.id, t.range.r0, t.range.c0));
        if (f && isDateFormat(f)) {
          const p = serialParts(v);
          out[n.name] = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
          continue;
        }
      }
    }
    out[n.name] = v;
  }
  return out;
}
