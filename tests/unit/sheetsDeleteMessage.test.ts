// What a sheet's delete confirmation says it takes (R273). Every sheet's said
// "Its cells go with it", a table sheet's too, which has no cells: the
// lakehouse keeps its rows, and a table Sheets held is released.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deleteSheetMessage } from "@/lib/sheets/sheetTabs";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";

const config = (source: TableConfig["source"], origin?: TableConfig["origin"]): TableConfig => ({
  source,
  columns: [],
  calculated: [],
  sort: [],
  filters: [],
  hidden: [],
  widths: {},
  ...(origin ? { origin } : {}),
});

describe("deleteSheetMessage", () => {
  it("a grid sheet's cells go with it", () => {
    expect(deleteSheetMessage("grid")).toBe(
      "Its cells go with it. Formulas elsewhere that refer to it will show #REF!.",
    );
  });

  it("a table sheet over a lakehouse table: the table stays", () => {
    const m = deleteSheetMessage(
      "table",
      config({ kind: "lakehouse", schema: "sales", table: "orders" }),
    );
    expect(m).toContain("the lakehouse table sales.orders stays");
    expect(m).not.toContain("cells");
    expect(m).not.toContain("holding");
  });

  it("a table Sheets held (an upload, a warehouse import) is released", () => {
    for (const origin of [
      { kind: "upload", filename: "orders.csv" },
      { kind: "warehouse", connection_id: "c", connection_name: "pg", query: "select 1" },
    ] as const) {
      const m = deleteSheetMessage(
        "table",
        config({ kind: "lakehouse", schema: "sales", table: "orders" }, origin),
      );
      expect(m, origin.kind).toContain("Sheets stops holding the table");
    }
    // A table opened from the catalog is not held.
    const opened = deleteSheetMessage(
      "table",
      config(
        { kind: "lakehouse", schema: "sales", table: "orders" },
        { kind: "catalog", asset_id: "a", fqn: "x" },
      ),
    );
    expect(opened).not.toContain("holding");
  });

  it("a pivot names the sheet it sums up; a query keeps its tables", () => {
    expect(
      deleteSheetMessage(
        "table",
        config({ kind: "pivot", from: "Orders", rows: ["region"], values: [] }),
      ),
    ).toContain('"Orders", the sheet it sums up, stays');
    expect(deleteSheetMessage("table", config({ kind: "query", sql: "select 1" }))).toContain(
      "the lakehouse tables it reads stay",
    );
  });

  it("says formulas and pivots on a table sheet will show an error", () => {
    expect(deleteSheetMessage("table", config({ kind: "query", sql: "select 1" }))).toMatch(
      /Formulas and pivots that use this sheet will show an error\.$/,
    );
  });
});

describe("the workbook editor", () => {
  it("asks with the message for the sheet being deleted", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/sheets/WorkbookEditor.tsx"),
      "utf8",
    );
    expect(src).toContain("body: deleteSheetMessage(t.kind, wb.tableConfigs[t.id]),");
    expect(src).not.toContain('body: "Its cells go with it.');
  });
});
