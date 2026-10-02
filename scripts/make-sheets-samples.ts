// Writes the sample workbooks under public/samples/sheets/: real .xlsx files
// built with the app's own engine and Excel writer, so each opens in Excel
// and imports into Sheets with its formulas, lookups, rules, validations,
// filters and charts. Deterministic: the same data every run.
//
//   npm run sheets:samples             (or: npm run sheets:samples -- <folder>)
//
// The files are listed for the Sheets page in src/lib/sheets/samples.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cellKey, parseA1 } from "../src/lib/sheets/a1";
import type { ChartDef } from "../src/lib/sheets/charts";
import type { CondFormat } from "../src/lib/sheets/condFormat";
import {
  WorkbookEngine,
  type CellInput,
  type CellStyle,
  type GridData,
} from "../src/lib/sheets/engine";
import type { AutoFilter } from "../src/lib/sheets/filter";
import type { Validation } from "../src/lib/sheets/validation";
import { writeXlsx } from "../src/lib/sheets/xlsx";

// Another folder can be given, to look at the files before replacing the committed ones.
const OUT = process.argv[2] ?? fileURLToPath(new URL("../public/samples/sheets", import.meta.url));
const resolve = (dir: string, file: string) => `${dir}/${file}`;

// ── A tiny deterministic random source ─────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ── Building a sheet ────────────────────────────────────────────────────────
type SheetSpec = {
  name: string;
  grid: GridData;
};

class Sheet {
  grid: GridData = { cells: {} };
  constructor(public name: string) {}
  set(ref: string, input: string | number, extra: Partial<CellInput> = {}): this {
    const at = parseA1(ref)!;
    this.grid.cells[cellKey(at.row, at.col)] = { i: String(input), ...extra };
    return this;
  }
  row(ref: string, values: (string | number | null)[], extra: Partial<CellInput> = {}): this {
    const at = parseA1(ref)!;
    values.forEach((v, k) => {
      if (v === null || v === "") return;
      this.grid.cells[cellKey(at.row, at.col + k)] = { i: String(v), ...extra };
    });
    return this;
  }
  style(ref: string, s: CellStyle): this {
    const [a, b] = ref.split(":");
    const p = parseA1(a)!;
    const q = parseA1(b ?? a)!;
    for (let r = p.row; r <= q.row; r++)
      for (let c = p.col; c <= q.col; c++) {
        const k = cellKey(r, c);
        const cur = this.grid.cells[k] ?? { i: "" };
        this.grid.cells[k] = { ...cur, s: { ...(cur.s ?? {}), ...s } };
      }
    return this;
  }
  format(ref: string, f: string): this {
    const [a, b] = ref.split(":");
    const p = parseA1(a)!;
    const q = parseA1(b ?? a)!;
    for (let r = p.row; r <= q.row; r++)
      for (let c = p.col; c <= q.col; c++) {
        const k = cellKey(r, c);
        if (this.grid.cells[k]) this.grid.cells[k] = { ...this.grid.cells[k], f };
      }
    return this;
  }
  widths(w: Record<string, number>): this {
    this.grid.colWidths = {};
    for (const [letter, px] of Object.entries(w))
      this.grid.colWidths[String(parseA1(`${letter}1`)!.col)] = px;
    return this;
  }
  cond(list: Omit<CondFormat, "id">[]): this {
    this.grid.cond = list.map((c, i) => ({ ...c, id: `c${i}` }));
    return this;
  }
  validate(list: Omit<Validation, "id">[]): this {
    this.grid.validations = list.map((v, i) => ({ ...v, id: `v${i}` }));
    return this;
  }
  filter(f: AutoFilter): this {
    this.grid.filter = f;
    return this;
  }
  charts(list: Omit<ChartDef, "id">[]): this {
    this.grid.charts = list.map((c, i) => ({ ...c, id: `ch${i}` }));
    return this;
  }
  freeze(rows: number, cols = 0): this {
    this.grid.frozenRows = rows;
    if (cols) this.grid.frozenCols = cols;
    return this;
  }
  spec(): SheetSpec {
    return { name: this.name, grid: this.grid };
  }
}

const HEAD: CellStyle = { b: true, color: "#FFFFFF", bg: "#1F4E78" };
const TITLE: CellStyle = { b: true, sz: 16, color: "#1F4E78" };
const NOTE: CellStyle = { i: true, color: "#595959" };
const MONEY = '"$"#,##0';
const MONEY2 = '"$"#,##0.00';
const PCT = "0.0%";

async function save(file: string, sheets: SheetSpec[]) {
  const engine = new WorkbookEngine(
    sheets.map((s, i) => ({ id: `s${i}`, name: s.name, kind: "grid" as const, grid: s.grid })),
  );
  engine.recalcAll();
  const buf = await writeXlsx(
    sheets.map((s, i) => ({
      kind: "grid" as const,
      name: s.name,
      grid: s.grid,
      value: (r: number, c: number) => engine.getValue(`s${i}`, r, c),
      spill: (r: number, c: number) => engine.spillSize(`s${i}`, r, c),
      arrayFormula: (r: number, c: number) => engine.arrayFormula(`s${i}`, r, c),
    })),
  );
  writeFileSync(resolve(OUT, file), Buffer.from(buf));
  // A check that every formula computes: no #NAME?, #REF! or #VALUE! anywhere.
  const bad: string[] = [];
  sheets.forEach((s, i) => {
    for (const key of Object.keys(s.grid.cells)) {
      const [r, c] = key.split(",").map(Number);
      const v = engine.getValue(`s${i}`, r, c);
      if (v && typeof v === "object" && "err" in v && v.err !== "#N/A")
        bad.push(`${s.name}!${key} ${v.err} ${s.grid.cells[key].i}`);
    }
  });
  if (bad.length)
    throw new Error(`${file}: formulas that do not compute:\n${bad.slice(0, 20).join("\n")}`);
  console.log(`wrote ${file}`);
}

// ── 1. Sales performance ───────────────────────────────────────────────────
async function sales() {
  const r = rng(2026);
  const regions = ["North", "South", "East", "West"];
  const reps = [
    ["Asha Rao", "North", 180000],
    ["Ben Okafor", "South", 150000],
    ["Chen Wei", "East", 170000],
    ["Dara Kim", "West", 160000],
    ["Elena Ruiz", "North", 140000],
    ["Farid Haddad", "West", 155000],
  ] as const;
  const products = [
    ["P-100", "Widget", "Hardware", 24, 11],
    ["P-110", "Widget Pro", "Hardware", 49, 22],
    ["P-200", "Gadget", "Hardware", 89, 47],
    ["P-300", "Cloud Seat", "Software", 30, 4],
    ["P-310", "Cloud Seat Plus", "Software", 55, 7],
    ["P-400", "Setup", "Services", 450, 260],
    ["P-410", "Training day", "Services", 1200, 640],
  ] as const;

  const prod = new Sheet("Products").row(
    "A1",
    ["SKU", "Product", "Category", "Unit price", "Unit cost", "Margin"],
    { s: HEAD },
  );
  products.forEach((p, i) => {
    const n = i + 2;
    prod
      .row(`A${n}`, [p[0], p[1], p[2], p[3], p[4]])
      .set(`F${n}`, `=(D${n}-E${n})/D${n}`, { f: PCT });
  });
  prod
    .format(`D2:E${products.length + 1}`, MONEY2)
    .widths({ A: 80, B: 150, C: 110, D: 100, E: 100, F: 90 });
  prod.cond([
    {
      ranges: [`F2:F${products.length + 1}`],
      rule: {
        kind: "scale",
        min: { type: "min", color: "#F8696B" },
        mid: { type: "percentile", value: 50, color: "#FFEB84" },
        max: { type: "max", color: "#63BE7B" },
      },
    },
  ]);

  const repSheet = new Sheet("Reps")
    .row("A1", ["Rep", "Region", "Annual target", "Sold", "Attainment", "Orders"], { s: HEAD })
    .widths({ A: 130, B: 90, C: 120, D: 120, E: 110, F: 80 });
  reps.forEach((p, i) => {
    const n = i + 2;
    repSheet
      .row(`A${n}`, [p[0], p[1], p[2]])
      .set(`D${n}`, `=SUMIFS(Orders!$I:$I,Orders!$D:$D,A${n})`, { f: MONEY })
      .set(`E${n}`, `=IFERROR(D${n}/C${n},0)`, { f: PCT })
      .set(`F${n}`, `=COUNTIFS(Orders!$D:$D,A${n})`);
  });
  repSheet.format(`C2:C${reps.length + 1}`, MONEY);
  repSheet.cond([
    { ranges: [`E2:E${reps.length + 1}`], rule: { kind: "icons", set: "3traffic" } },
    { ranges: [`D2:D${reps.length + 1}`], rule: { kind: "bar", color: "#638EC6" } },
  ]);
  // The chart reads one block: rep, sold, target (columns for sold, a line for target).
  repSheet.row("H1", ["Rep", "Sold", "Target"], { s: HEAD });
  reps.forEach((_, i) => {
    const n = i + 2;
    repSheet
      .set(`H${n}`, `=A${n}`)
      .set(`I${n}`, `=D${n}`, { f: MONEY })
      .set(`J${n}`, `=C${n}`, { f: MONEY });
  });
  repSheet.charts([
    {
      type: "combo",
      range: `H1:J${reps.length + 1}`,
      title: "Sold against target",
      legend: "bottom",
      x: 20,
      y: 200,
      w: 560,
      h: 300,
    },
  ]);

  const orders = new Sheet("Orders")
    .row(
      "A1",
      [
        "Order",
        "Date",
        "Region",
        "Rep",
        "SKU",
        "Product",
        "Category",
        "Qty",
        "Revenue",
        "Cost",
        "Margin",
        "Status",
      ],
      { s: HEAD },
    )
    .widths({
      A: 80,
      B: 100,
      C: 80,
      D: 120,
      E: 70,
      F: 130,
      G: 100,
      H: 60,
      I: 100,
      J: 100,
      K: 80,
      L: 90,
    })
    .freeze(1);
  const N = 240;
  // Open orders over $3,000: the Dashboard lists them, and its charts go below the list.
  let openBig = 0;
  for (let i = 0; i < N; i++) {
    const n = i + 2;
    const rep = reps[Math.floor(r() * reps.length)];
    const p = products[Math.floor(r() * products.length)];
    const month = 1 + Math.floor((i / N) * 12);
    const day = 1 + Math.floor(r() * 27);
    const qty = p[2] === "Services" ? 1 + Math.floor(r() * 3) : 5 + Math.floor(r() * 80);
    const status = r() < 0.08 ? "Returned" : r() < 0.25 ? "Open" : "Paid";
    if (status === "Open" && qty * p[3] > 3000) openBig++;
    orders
      .row(`A${n}`, [
        `SO-${10001 + i}`,
        `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        rep[1],
        rep[0],
        p[0],
      ])
      .set(`F${n}`, `=XLOOKUP(E${n},Products!$A:$A,Products!$B:$B,"?")`)
      .set(`G${n}`, `=XLOOKUP(E${n},Products!$A:$A,Products!$C:$C,"?")`)
      .set(`H${n}`, qty)
      .set(`I${n}`, `=H${n}*XLOOKUP(E${n},Products!$A:$A,Products!$D:$D,0)`, { f: MONEY2 })
      .set(`J${n}`, `=H${n}*XLOOKUP(E${n},Products!$A:$A,Products!$E:$E,0)`, { f: MONEY2 })
      .set(`K${n}`, `=IFERROR((I${n}-J${n})/I${n},0)`, { f: PCT })
      .set(`L${n}`, status);
    orders.format(`B${n}`, "yyyy-mm-dd");
  }
  orders.filter({ range: `A1:L${N + 1}`, cols: {} });
  orders.cond([
    {
      ranges: [`A2:L${N + 1}`],
      rule: { kind: "formula", formula: '=$L2="Returned"', style: { color: "#9C0006", st: true } },
    },
    { ranges: [`I2:I${N + 1}`], rule: { kind: "bar", color: "#63C384" } },
    {
      ranges: [`K2:K${N + 1}`],
      rule: { kind: "cell", op: "lt", a: "0.3", style: { bg: "#FFEB9C", color: "#9C5700" } },
    },
  ]);
  orders.validate([
    {
      ranges: [`C2:C${N + 1}`],
      rule: { kind: "list", items: regions },
      error: { style: "stop", title: "Unknown region" },
    },
    {
      ranges: [`E2:E${N + 1}`],
      rule: { kind: "list", source: `=Products!$A$2:$A$${products.length + 1}` },
      prompt: { title: "SKU", message: "Pick a product code from the Products sheet." },
    },
    {
      ranges: [`H2:H${N + 1}`],
      rule: { kind: "whole", op: "between", a: "1", b: "500" },
      error: { style: "warning", message: "Quantities above 500 are unusual; keep it?" },
    },
    { ranges: [`L2:L${N + 1}`], rule: { kind: "list", items: ["Open", "Paid", "Returned"] } },
  ]);

  const dash = new Sheet("Dashboard")
    .set("A1", "Sales performance 2026", { s: TITLE })
    .set(
      "A2",
      "Every figure is a formula over the Orders sheet: change an order and the dashboard follows.",
      { s: NOTE },
    )
    .row("A4", ["Revenue", "Gross margin", "Orders", "Average order", "Returned"], {
      s: { b: true, color: "#595959" },
    })
    .set("A5", '=SUMIFS(Orders!I:I,Orders!L:L,"<>Returned")', { f: MONEY, s: { b: true, sz: 14 } })
    .set("B5", '=IFERROR(1-SUMIFS(Orders!J:J,Orders!L:L,"<>Returned")/A5,0)', {
      f: PCT,
      s: { b: true, sz: 14 },
    })
    .set("C5", '=COUNTIFS(Orders!A:A,"SO-*",Orders!L:L,"<>Returned")', { s: { b: true, sz: 14 } })
    .set("D5", "=IFERROR(A5/C5,0)", { f: MONEY, s: { b: true, sz: 14 } })
    .set("E5", '=COUNTIFS(Orders!L:L,"Returned")', { s: { b: true, sz: 14 } });
  // Revenue by month and region: a SUMIFS grid the charts read.
  dash.row("A8", ["Month", ...regions], { s: HEAD });
  for (let m = 1; m <= 12; m++) {
    const n = 8 + m;
    dash.set(`A${n}`, `=DATE(2026,${m},1)`, { f: "mmm" });
    regions.forEach((reg, k) => {
      const col = String.fromCharCode(66 + k);
      dash.set(
        `${col}${n}`,
        `=SUMIFS(Orders!$I:$I,Orders!$C:$C,${col}$8,Orders!$B:$B,">="&$A${n},Orders!$B:$B,"<"&EDATE($A${n},1))`,
        { f: MONEY },
      );
    });
  }
  // By category, and the top product by revenue (INDEX/MATCH over a helper column).
  dash.row("G8", ["Category", "Revenue"], { s: HEAD });
  ["Hardware", "Software", "Services"].forEach((cat, k) => {
    const n = 9 + k;
    dash.set(`G${n}`, cat).set(`H${n}`, `=SUMIFS(Orders!$I:$I,Orders!$G:$G,G${n})`, { f: MONEY });
  });
  dash.set("G14", "Best product", { s: { b: true } });
  dash.set("H14", "=INDEX(Products!B2:B8,MATCH(MAX(Products!G2:G8),Products!G2:G8,0))");
  for (let i = 0; i < products.length; i++)
    prod.set(`G${i + 2}`, `=SUMIFS(Orders!$I:$I,Orders!$E:$E,A${i + 2})`, { f: MONEY });
  prod.set("G1", "Revenue", { s: HEAD });
  // Dynamic arrays: a leaderboard that re-sorts itself, and the large open orders.
  dash.row("J8", ["Leaderboard", "Sold"], { s: HEAD });
  dash
    .set("J9", "=SORTBY(Reps!A2:A7,Reps!D2:D7,-1)")
    .set("K9", "=SORTBY(Reps!D2:D7,Reps!D2:D7,-1)", { f: MONEY });
  // The cells the leaderboard spills into carry the format too, as in Excel.
  for (let n = 10; n <= 14; n++) dash.set(`K${n}`, "", { f: MONEY });
  dash.row("J17", ["Open orders over $3,000"], { s: HEAD });
  dash.set("J18", '=FILTER(Orders!A2:A241,(Orders!L2:L241="Open")*(Orders!I2:I241>3000),"None")');
  dash.widths({
    A: 120,
    B: 110,
    C: 110,
    D: 110,
    E: 110,
    F: 30,
    G: 120,
    H: 110,
    I: 30,
    J: 130,
    K: 110,
  });
  dash.cond([
    {
      ranges: ["B9:E20"],
      rule: {
        kind: "scale",
        min: { type: "min", color: "#FFFFFF" },
        max: { type: "max", color: "#63BE7B" },
      },
    },
  ]);
  // Below the open-orders list (J18 down), with a row to spare for the taller title row.
  const chartsY = (18 + openBig + 2) * 24;
  dash.charts([
    {
      type: "line",
      range: "A8:E20",
      title: "Revenue by month and region",
      legend: "bottom",
      smooth: true,
      x: 20,
      y: chartsY,
      w: 560,
      h: 300,
    },
    {
      type: "column",
      range: "A8:E20",
      title: "Monthly revenue, stacked",
      stacked: "normal",
      legend: "bottom",
      x: 600,
      y: chartsY,
      w: 560,
      h: 300,
    },
    {
      type: "doughnut",
      range: "G8:H11",
      title: "Revenue by category",
      labels: true,
      legend: "right",
      x: 1180,
      y: chartsY,
      w: 420,
      h: 300,
    },
  ]);

  await save("sales-performance-2026.xlsx", [
    dash.spec(),
    orders.spec(),
    prod.spec(),
    repSheet.spec(),
  ]);
}

// ── 2. Project tracker ─────────────────────────────────────────────────────
async function tracker() {
  const team = [
    ["Maya", "Design", 30],
    ["Omar", "Engineering", 40],
    ["Priya", "Engineering", 40],
    ["Lucas", "QA", 35],
    ["Ines", "Product", 25],
  ] as const;
  const statuses = ["Not started", "In progress", "Blocked", "Done"];
  const tasks = [
    ["Kick-off and scope", "Ines", "Done", "2026-09-01", "2026-09-03", 8, 1],
    ["User research", "Maya", "Done", "2026-09-02", "2026-09-10", 24, 1],
    ["Wireframes", "Maya", "Done", "2026-09-08", "2026-09-15", 20, 1],
    ["API design", "Omar", "Done", "2026-09-08", "2026-09-14", 16, 1],
    ["Data model", "Priya", "In progress", "2026-09-12", "2026-09-22", 24, 0.7],
    ["Auth and roles", "Omar", "In progress", "2026-09-15", "2026-09-26", 30, 0.5],
    ["Visual design", "Maya", "In progress", "2026-09-16", "2026-09-30", 32, 0.4],
    ["Import pipeline", "Priya", "Blocked", "2026-09-18", "2026-10-02", 28, 0.2],
    ["Reporting screens", "Omar", "Not started", "2026-09-29", "2026-10-15", 40, 0],
    ["Test plan", "Lucas", "In progress", "2026-09-20", "2026-09-28", 12, 0.6],
    ["Regression suite", "Lucas", "Not started", "2026-10-05", "2026-10-20", 36, 0],
    ["Performance pass", "Priya", "Not started", "2026-10-12", "2026-10-24", 20, 0],
    ["Beta release", "Ines", "Not started", "2026-10-26", "2026-10-30", 8, 0],
    ["Docs and help", "Maya", "Not started", "2026-10-15", "2026-10-28", 16, 0],
  ] as const;

  const teamSheet = new Sheet("Team")
    .row("A1", ["Name", "Role", "Hours a week", "Open tasks", "Open hours", "Load"], { s: HEAD })
    .widths({ A: 100, B: 120, C: 110, D: 100, E: 100, F: 90 });
  team.forEach((t, i) => {
    const n = i + 2;
    teamSheet
      .row(`A${n}`, [t[0], t[1], t[2]])
      .set(`D${n}`, `=COUNTIFS(Tasks!$C:$C,A${n},Tasks!$D:$D,"<>Done")`)
      .set(`E${n}`, `=SUMIFS(Tasks!$I:$I,Tasks!$C:$C,A${n})`)
      .set(`F${n}`, `=IFERROR(E${n}/(C${n}*2),0)`, { f: "0%" });
  });
  teamSheet.cond([
    {
      ranges: [`F2:F${team.length + 1}`],
      rule: { kind: "cell", op: "gt", a: "1", style: { bg: "#FFC7CE", color: "#9C0006", b: true } },
    },
    { ranges: [`E2:E${team.length + 1}`], rule: { kind: "bar", color: "#FFB628" } },
  ]);
  teamSheet.row("H1", ["Name", "Open hours"], { s: HEAD });
  team.forEach((_, i) =>
    teamSheet.set(`H${i + 2}`, `=A${i + 2}`).set(`I${i + 2}`, `=E${i + 2}`, { f: "0.0" }),
  );
  teamSheet.charts([
    {
      type: "bar",
      range: `H1:I${team.length + 1}`,
      title: "Open hours by person",
      legend: "none",
      labels: true,
      x: 20,
      y: 180,
      w: 460,
      h: 260,
    },
  ]);

  const t = new Sheet("Tasks")
    .row(
      "A1",
      [
        "ID",
        "Task",
        "Owner",
        "Status",
        "Start",
        "Due",
        "Estimate (h)",
        "Done",
        "Remaining (h)",
        "Days left",
        "Late",
      ],
      { s: HEAD },
    )
    .widths({ A: 60, B: 170, C: 90, D: 110, E: 100, F: 100, G: 100, H: 80, I: 110, J: 80, K: 60 })
    .freeze(1, 2);
  tasks.forEach((x, i) => {
    const n = i + 2;
    t.set(`A${n}`, `T-${String(i + 1).padStart(2, "0")}`)
      .set(`B${n}`, x[0])
      .set(`C${n}`, x[1])
      .set(`D${n}`, x[2])
      .set(`E${n}`, x[3], { f: "yyyy-mm-dd" })
      .set(`F${n}`, x[4], { f: "yyyy-mm-dd" })
      .set(`G${n}`, x[5])
      .set(`H${n}`, x[6], { f: "0%" })
      .set(`I${n}`, `=G${n}*(1-H${n})`, { f: "0.0" })
      .set(`J${n}`, `=IF(D${n}="Done","",F${n}-TODAY())`)
      .set(`K${n}`, `=AND(D${n}<>"Done",F${n}<TODAY())`);
  });
  const last = tasks.length + 1;
  t.cond([
    {
      ranges: [`A2:K${last}`],
      rule: { kind: "formula", formula: "=$K2=TRUE", style: { bg: "#FFC7CE", color: "#9C0006" } },
      stop: true,
    },
    {
      ranges: [`D2:D${last}`],
      rule: {
        kind: "text",
        op: "contains",
        text: "Blocked",
        style: { bg: "#FFEB9C", color: "#9C5700", b: true },
      },
    },
    {
      ranges: [`D2:D${last}`],
      rule: { kind: "text", op: "contains", text: "Done", style: { color: "#006100" } },
    },
    { ranges: [`H2:H${last}`], rule: { kind: "bar", color: "#63C384" } },
  ]);
  t.validate([
    {
      ranges: [`C2:C${last + 20}`],
      rule: { kind: "list", source: `=Team!$A$2:$A$${team.length + 1}` },
      error: { style: "stop", title: "Not on the team" },
    },
    {
      ranges: [`D2:D${last + 20}`],
      rule: { kind: "list", items: statuses },
      prompt: { message: "Not started, In progress, Blocked or Done" },
    },
    {
      ranges: [`H2:H${last + 20}`],
      rule: { kind: "decimal", op: "between", a: "0", b: "1" },
      error: { style: "stop", message: "Done is a share from 0% to 100%." },
    },
    {
      ranges: [`F2:F${last + 20}`],
      rule: { kind: "custom", formula: "=F2>=E2" },
      error: { style: "warning", message: "The due date is before the start." },
    },
  ]);
  t.filter({ range: `A1:K${last}`, cols: {} });

  const s = new Sheet("Summary")
    .set("A1", "Project tracker", { s: TITLE })
    .set("A2", "Status counts and hours come from the Tasks sheet; the red rows there are late.", {
      s: NOTE,
    })
    .row("A4", ["Status", "Tasks", "Hours left"], { s: HEAD })
    .widths({ A: 130, B: 90, C: 110, D: 30, E: 130, F: 110 });
  statuses.forEach((st, i) => {
    const n = 5 + i;
    s.set(`A${n}`, st)
      .set(`B${n}`, `=COUNTIF(Tasks!$D:$D,A${n})`)
      .set(`C${n}`, `=SUMIFS(Tasks!$I:$I,Tasks!$D:$D,A${n})`, { f: "0.0" });
  });
  s.set("A10", "Total", { s: { b: true } })
    .set("B10", "=SUM(B5:B8)", { s: { b: true } })
    .set("C10", "=SUM(C5:C8)", { f: "0.0", s: { b: true } });
  s.set("A12", "Complete", { s: { b: true } }).set(
    "B12",
    "=SUMPRODUCT(Tasks!G2:G15,Tasks!H2:H15)/SUM(Tasks!G2:G15)",
    { f: "0%", s: { b: true, sz: 14 } },
  );
  s.set("A13", "Late tasks", { s: { b: true } }).set("B13", "=COUNTIF(Tasks!K2:K15,TRUE)", {
    s: { b: true, sz: 14 },
  });
  s.set("A14", "Next due", { s: { b: true } }).set(
    "B14",
    '=INDEX(Tasks!B2:B15,MATCH(MINIFS(Tasks!F2:F15,Tasks!D2:D15,"<>Done"),Tasks!F2:F15,0))',
  );
  s.row("E4", ["Owner", "Remaining (h)"], { s: HEAD });
  team.forEach((m, i) =>
    s
      .set(`E${5 + i}`, m[0])
      .set(`F${5 + i}`, `=SUMIFS(Tasks!$I:$I,Tasks!$C:$C,E${5 + i})`, { f: "0.0" }),
  );
  s.charts([
    {
      type: "pie",
      range: "A4:B8",
      title: "Tasks by status",
      labels: true,
      legend: "right",
      x: 620,
      y: 0,
      w: 400,
      h: 260,
    },
    {
      type: "radar",
      range: `E4:F${4 + team.length}`,
      title: "Remaining work by owner",
      legend: "none",
      x: 620,
      y: 280,
      w: 400,
      h: 300,
    },
  ]);

  await save("project-tracker.xlsx", [s.spec(), t.spec(), teamSheet.spec()]);
}

// ── 3. Budget and cash flow ────────────────────────────────────────────────
async function budget() {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const sc = new Sheet("Scenarios")
    .row("A1", ["Scenario", "Monthly growth", "Price", "Churn", "Marketing"], { s: HEAD })
    .row("A2", ["Base", 0.04, 49, 0.02, 12000])
    .row("A3", ["Best", 0.07, 55, 0.015, 15000])
    .row("A4", ["Worst", 0.01, 45, 0.035, 9000])
    .widths({ A: 100, B: 130, C: 90, D: 90, E: 110 });
  sc.format("B2:B4", "0.0%").format("C2:C4", MONEY).format("D2:D4", "0.0%").format("E2:E4", MONEY);

  const as = new Sheet("Assumptions")
    .set("A1", "Budget and cash flow 2026", { s: TITLE })
    .set("A2", "Pick a scenario in B4; the Model sheet follows it through INDEX/MATCH.", {
      s: NOTE,
    })
    .set("A4", "Scenario", { s: { b: true } })
    .set("B4", "Base", { s: { bg: "#FFF2CC", b: true } })
    .set("A5", "Monthly growth")
    .set("B5", "=INDEX(Scenarios!$B$2:$B$4,MATCH($B$4,Scenarios!$A$2:$A$4,0))", { f: "0.0%" })
    .set("A6", "Price per customer")
    .set("B6", "=INDEX(Scenarios!$C$2:$C$4,MATCH($B$4,Scenarios!$A$2:$A$4,0))", { f: MONEY })
    .set("A7", "Monthly churn")
    .set("B7", "=INDEX(Scenarios!$D$2:$D$4,MATCH($B$4,Scenarios!$A$2:$A$4,0))", { f: "0.0%" })
    .set("A8", "Marketing a month")
    .set("B8", "=XLOOKUP($B$4,Scenarios!$A$2:$A$4,Scenarios!$E$2:$E$4)", { f: MONEY })
    .set("A9", "Customers in January")
    .set("B9", 1200)
    .set("A10", "Cost to serve a customer")
    .set("B10", 9, { f: MONEY })
    .set("A11", "Salaries a month")
    .set("B11", 38000, { f: MONEY })
    .set("A12", "Opening cash")
    .set("B12", 150000, { f: MONEY })
    .widths({ A: 200, B: 130 });
  as.validate([
    {
      ranges: ["B4"],
      rule: { kind: "list", source: "=Scenarios!$A$2:$A$4" },
      prompt: { title: "Scenario", message: "Base, Best or Worst" },
      error: { style: "stop" },
    },
    { ranges: ["B9"], rule: { kind: "whole", op: "gt", a: "0" } },
  ]);

  const m = new Sheet("Model")
    .row("A1", ["Line", ...months, "Year"], { s: HEAD })
    .widths({
      A: 170,
      ...Object.fromEntries(months.map((_, k) => [String.fromCharCode(66 + k), 90])),
      N: 110,
    })
    .freeze(1, 1);
  const lines = [
    "Customers",
    "Revenue",
    "Cost to serve",
    "Marketing",
    "Salaries",
    "Net",
    "Cash at month end",
  ];
  lines.forEach((l, i) => m.set(`A${i + 2}`, l, { s: { b: i === 5 || i === 6 } }));
  months.forEach((_, k) => {
    const col = String.fromCharCode(66 + k);
    const prev = String.fromCharCode(65 + k);
    m.set(
      `${col}2`,
      k === 0 ? "=Assumptions!$B$9" : `=ROUND(${prev}2*(1+Assumptions!$B$5-Assumptions!$B$7),0)`,
    )
      .set(`${col}3`, `=${col}2*Assumptions!$B$6`, { f: MONEY })
      .set(`${col}4`, `=-${col}2*Assumptions!$B$10`, { f: MONEY })
      .set(`${col}5`, "=-Assumptions!$B$8", { f: MONEY })
      .set(`${col}6`, "=-Assumptions!$B$11", { f: MONEY })
      .set(`${col}7`, `=SUM(${col}3:${col}6)`, { f: MONEY, s: { b: true } })
      .set(`${col}8`, k === 0 ? `=Assumptions!$B$12+${col}7` : `=${prev}8+${col}7`, {
        f: MONEY,
        s: { b: true },
      });
  });
  m.set("N2", "=M2")
    .set("N3", "=SUM(B3:M3)", { f: MONEY })
    .set("N4", "=SUM(B4:M4)", { f: MONEY })
    .set("N5", "=SUM(B5:M5)", { f: MONEY })
    .set("N6", "=SUM(B6:M6)", { f: MONEY })
    .set("N7", "=SUM(B7:M7)", { f: MONEY, s: { b: true } })
    .set("N8", "=M8", { f: MONEY, s: { b: true } });
  m.cond([
    {
      ranges: ["B7:N8"],
      rule: { kind: "cell", op: "lt", a: "0", style: { color: "#C00000", b: true } },
    },
    {
      ranges: ["B8:M8"],
      rule: {
        kind: "scale",
        min: { type: "min", color: "#F8696B" },
        max: { type: "max", color: "#63BE7B" },
      },
    },
  ]);
  // A chart-friendly block: months down the rows.
  m.row("A11", ["Month", "Revenue", "Costs", "Net", "Cash"], { s: HEAD });
  months.forEach((mo, k) => {
    const col = String.fromCharCode(66 + k);
    const n = 12 + k;
    m.set(`A${n}`, mo)
      .set(`B${n}`, `=${col}3`, { f: MONEY })
      .set(`C${n}`, `=-(${col}4+${col}5+${col}6)`, { f: MONEY })
      .set(`D${n}`, `=${col}7`, { f: MONEY })
      .set(`E${n}`, `=${col}8`, { f: MONEY });
  });
  m.row("J11", ["Month", "Cash"], { s: HEAD });
  months.forEach((mo, k) =>
    m.set(`J${12 + k}`, `=A${12 + k}`).set(`K${12 + k}`, `=E${12 + k}`, { f: MONEY }),
  );
  m.row("G11", ["Customers", "Revenue"], { s: HEAD });
  months.forEach((_, k) => {
    const col = String.fromCharCode(66 + k);
    m.set(`G${12 + k}`, `=${col}2`).set(`H${12 + k}`, `=${col}3`, { f: MONEY });
  });
  m.charts([
    {
      type: "combo",
      range: "A11:D23",
      title: "Revenue, costs and net",
      legend: "bottom",
      x: 20,
      y: 580,
      w: 560,
      h: 300,
    },
    {
      type: "area",
      range: "J11:K23",
      title: "Cash at month end",
      legend: "none",
      x: 600,
      y: 580,
      w: 460,
      h: 300,
    },
    {
      type: "scatter",
      range: "G11:H23",
      title: "Customers against revenue",
      legend: "none",
      xTitle: "Customers",
      yTitle: "Revenue",
      x: 1080,
      y: 580,
      w: 420,
      h: 300,
    },
  ]);

  await save("budget-cash-flow.xlsx", [as.spec(), m.spec(), sc.spec()]);
}

mkdirSync(OUT, { recursive: true });
await sales();
await tracker();
await budget();
