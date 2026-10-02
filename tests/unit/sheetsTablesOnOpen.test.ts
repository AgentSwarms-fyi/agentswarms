// R130. A grid formula over a table sheet (=COUNTA(Orders[id]),
// =SUM(Orders[amount])) was right while typed and wrong every time the
// workbook was opened: COUNTA read 1 and SUM #VALUE! until the cell was typed
// again. The engine computes every formula as it is built, and asks whether
// a name is a table sheet from the page's list of sheets, which was filled
// only after the engine was built. Adding a table sheet and renaming one had
// the same order. Here: the engine's side of it, and the order in the page.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WorkbookEngine, type SheetDef, type TableResolver } from "@/lib/sheets/engine";

const defs: SheetDef[] = [
  {
    id: "g",
    name: "Sheet1",
    kind: "grid",
    grid: { cells: { "0,0": { i: "=COUNTA(Orders[id])" }, "1,0": { i: "=SUM(Orders[amount])" } } },
  },
  { id: "t", name: "Orders", kind: "table" },
];

function resolverKnowing(tables: string[]): TableResolver {
  return {
    resolve: () => 0,
    isTable: (n) => tables.some((t) => t.toLowerCase() === n.toLowerCase()),
    call: (req) => (req.fn === "COUNTA" ? 108 : 51749.84),
  };
}

describe("the engine computes as it is built", () => {
  it("with the tables known, a formula over one asks the table", () => {
    const e = new WorkbookEngine(defs, resolverKnowing(["Orders"]));
    expect(e.getValue("g", 0, 0)).toBe(108);
    expect(e.getValue("g", 1, 0)).toBe(51749.84);
  });

  it("with them not known yet, the same formulas come out wrong and stay so", () => {
    const known: string[] = [];
    const e = new WorkbookEngine(defs, resolverKnowing(known));
    known.push("Orders"); // what the page did: filled the list after building
    // COUNTA counted the one error the unresolved reference made; SUM got
    // the reference unresolved (the page's resolver said #VALUE!).
    expect(e.getValue("g", 0, 0)).toBe(1);
    expect(e.getValue("g", 1, 0)).not.toBe(51749.84);
  });
});

describe("the page knows the sheets before the engine computes", () => {
  const src = readFileSync("src/components/sheets/useWorkbook.ts", "utf8");
  const between = (from: string, to: string) => {
    const a = src.indexOf(from);
    expect(a, from).toBeGreaterThan(-1);
    return src.slice(a, src.indexOf(to, a));
  };
  const before = (body: string, first: string, then: string) => {
    const i = body.indexOf(first);
    const j = body.indexOf(then);
    expect(i, first).toBeGreaterThan(-1);
    expect(j, then).toBeGreaterThan(-1);
    expect(i, `${first} before ${then}`).toBeLessThan(j);
  };

  it("opening a workbook", () => {
    const build = between("// Build the engine once per load", "const setTabsBoth");
    before(build, "tabsRef.current = meta;", "new WorkbookEngine(defs, resolver");
  });

  it("adding a sheet", () => {
    before(between("const addTabLocal", "const renameTabLocal"), "setTabsBoth(", ".addSheet(");
  });

  it("renaming one", () => {
    before(
      between("const renameTabLocal", "const removeTabLocal"),
      "setTabsBoth(",
      "engine.replaceGrid(",
    );
  });

  it("removing one", () => {
    before(between("const removeTabLocal", "const reorderLocal"), "setTabsBoth(", ".removeSheet(");
  });
});
