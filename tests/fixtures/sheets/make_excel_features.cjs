// Writes excel-features.xlsx: what a file saved by Excel carries that the
// openpyxl fixture cannot (openpyxl saves no formula results):
// - saved results for every formula;
// - newer functions with their _xlfn. prefixes (XLOOKUP, UNIQUE);
// - an array formula over a range;
// - a function Sheets does not compute (CUBEVALUE), with Excel's result;
// - a link to another workbook, with Excel's result;
// - a named-style header, a date, a percentage, and a [Red] negative format.
// Run: node tests/fixtures/sheets/make_excel_features.cjs
const path = require("node:path");
const ExcelJS = require("exceljs");

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Orders");
  ws.columns = [{ width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }];
  ws.addRow(["Order", "Customer", "Amount", "Placed"]);
  const orders = [
    ["A-1001", "Acme", 1200, new Date(Date.UTC(2024, 0, 5))],
    ["A-1002", "Globex", -150, new Date(Date.UTC(2024, 0, 9))],
    ["A-1003", "Acme", 980, new Date(Date.UTC(2024, 1, 2))],
    ["A-1004", "Initech", 2200, new Date(Date.UTC(2024, 1, 20))],
  ];
  for (const o of orders) ws.addRow(o);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  for (let r = 2; r <= 5; r++) {
    ws.getCell(`C${r}`).numFmt = "#,##0.00;[Red]-#,##0.00";
    ws.getCell(`D${r}`).numFmt = "dd-mmm-yyyy";
  }

  const sum = wb.addWorksheet("Summary");
  sum.getCell("A1").value = "Customer";
  sum.getCell("B1").value = "Total";
  sum.getCell("A1").font = { bold: true };
  sum.getCell("B1").font = { bold: true };
  // UNIQUE spills; Excel stores it as an array formula over A2:A4.
  sum.fillFormula("A2:A4", "_xlfn.UNIQUE(Orders!B2:B5)", ["Acme", "Globex", "Initech"], "array");
  for (let r = 2; r <= 4; r++) {
    sum.getCell(`B${r}`).value = {
      formula: `SUMIFS(Orders!C:C,Orders!B:B,A${r})`,
      result: [2180, -150, 2200][r - 2],
    };
  }
  sum.getCell("A6").value = "Lookup Globex";
  sum.getCell("B6").value = {
    formula: '_xlfn.XLOOKUP("Globex",Orders!B2:B5,Orders!C2:C5)',
    result: -150,
  };
  sum.getCell("A7").value = "Share of Acme";
  sum.getCell("B7").value = { formula: "B2/SUM(B2:B4)", result: 2180 / 4230 };
  sum.getCell("B7").numFmt = "0.0%";
  sum.getCell("A8").value = "From the cube";
  sum.getCell("B8").value = { formula: 'CUBEVALUE("Sales","[Measures].[Revenue]")', result: 98765 };
  sum.getCell("A9").value = "From another file";
  sum.getCell("B9").value = { formula: "[1]Budget!B2*1.1", result: 5500 };
  sum.getCell("A10").value = "Wrapped in IFERROR";
  sum.getCell("B10").value = {
    formula: 'IFERROR(CUBEMEMBER("Sales","[Q1]"),"none")',
    result: "Q1 2024",
  };

  const out = path.join(__dirname, "excel-features.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("wrote", out);
})();
