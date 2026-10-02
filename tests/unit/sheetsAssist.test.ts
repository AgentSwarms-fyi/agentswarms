// Sheets AI (Phase H): the assistant beside the grid and Fill with AI. The
// model never writes a cell: it asks the workbook for reads (answered in the
// browser from the workbook as the person sees it) and ends with an answer
// and proposals the person applies with a click, each one undoable. Here:
// the protocol, the reads against a real engine, the description the model
// starts from, what each proposal does, and who may call the server.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assistReplySchema,
  afterTrial,
  describeAction,
  fillTargetColumn,
  MAX_TOOL_CALLS,
  parseAssistReply,
  parseFillAnswer,
} from "@/lib/sheets/assist";
import {
  planAction,
  proposalProblems,
  MAX_CHECKED_FORMULAS,
  MAX_FILL_ROWS,
} from "@/lib/sheets/assistApply";
import { runTool, workbookContext } from "@/lib/sheets/assistRuntime";
import { WorkbookEngine, type SheetDef, type TableResolver } from "@/lib/sheets/engine";
import { PENDING, TABLE_PUSHDOWN } from "@/lib/sheets/formula/evaluate";
import { GridTableResolver } from "@/lib/sheets/gridTableResolver";
import { ASSIST_SYSTEM } from "@/utils/sheets/assistPrompt.server";

// ── The protocol ──

describe("the model's replies", () => {
  it("are read as the JSON asked for, bare, fenced or inside prose", () => {
    const tools = { type: "tools", calls: [{ tool: "read_range", range: "A1:B2" }] };
    expect(parseAssistReply(JSON.stringify(tools))).toEqual(tools);
    expect(parseAssistReply("```json\n" + JSON.stringify(tools) + "\n```")).toEqual(tools);
    expect(
      parseAssistReply(`Sure. ${JSON.stringify({ type: "answer", text: "42" })} Done.`),
    ).toEqual({ type: "answer", text: "42" });
  });

  it("plain text, or JSON that is not the protocol, becomes an answer and never a change", () => {
    expect(parseAssistReply("Revenue is up.")).toEqual({ type: "answer", text: "Revenue is up." });
    const bad = JSON.stringify({ type: "answer", text: "x", actions: [{ kind: "drop_table" }] });
    const r = parseAssistReply(bad);
    expect(r.type).toBe("answer");
    expect("actions" in r && r.actions?.length).toBeFalsy();
  });

  it("at most a few reads at a time", () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, () => ({ tool: "find", text: "x" }));
    expect(assistReplySchema.safeParse({ type: "tools", calls }).success).toBe(false);
  });

  it("Fill with AI's answers land on their own rows, a missing one blank", () => {
    expect(parseFillAnswer('[{"i":1,"o":"neg"},{"i":0,"o":"pos"}]', 3)).toEqual({
      outputs: ["pos", "neg", ""],
      read: 2,
    });
    expect(parseFillAnswer('```json\n["a","b"]\n```', 2)).toEqual({ outputs: ["a", "b"], read: 2 });
    expect(parseFillAnswer('[{"i":7,"o":"x"}]', 2)).toEqual({ outputs: ["", ""], read: 0 });
    expect(parseFillAnswer("I cannot help with that.", 2)).toEqual({ outputs: ["", ""], read: 0 });
    // An answer of "" on purpose is an answer.
    expect(parseFillAnswer('[{"i":0,"o":""}]', 1)).toEqual({ outputs: [""], read: 1 });
  });

  it("R135: the answers without the brackets around them are read, as the model sent them", () => {
    const sent =
      '{"i": 0, "o": "negative"}, {"i": 1, "o": "neutral"}, {"i": 2, "o": "positive"}, {"i": 3, "o": "negative"}, {"i": 4, "o": "neutral"}';
    expect(parseFillAnswer(sent, 5)).toEqual({
      outputs: ["negative", "neutral", "positive", "negative", "neutral"],
      read: 5,
    });
    expect(parseFillAnswer('Here you go:\n{"i":1,"o":"b"}\n{"i":0,"o":"a"}', 2)).toEqual({
      outputs: ["a", "b"],
      read: 2,
    });
  });

  it("R137: Fill with AI writes by default into the column where answers were started, not past it", () => {
    // Comments in B2:B7; C2 answered by hand; D full of other data; E empty.
    const cells: Record<string, string> = { "1,2": "positive" };
    for (let r = 1; r <= 6; r++) {
      cells[`${r},1`] = `comment ${r}`;
      cells[`${r},3`] = `d${r}`;
    }
    const read = (r: number, c: number) => cells[`${r},${c}`] ?? "";
    expect(fillTargetColumn({ r0: 1, r1: 6, c1: 1 }, read)).toBe(2);
    // With C full it is data: the first column with room after it.
    for (let r = 1; r <= 6; r++) cells[`${r},2`] = "x";
    expect(fillTargetColumn({ r0: 1, r1: 6, c1: 1 }, read)).toBe(4);
  });

  it("R138: the trial's answers are the ones written; only the rows it did not cover are asked", async () => {
    const plan = [2, 3, 4, 5, 6, 7, 8].map((row) => ({ row, input: `c${row}` }));
    const trial = [2, 3, 4, 5, 6].map((row) => ({ row, input: `c${row}`, output: `t${row}` }));
    const { answers, rest } = afterTrial(plan, trial);
    expect(answers).toEqual(trial.map((t) => ({ row: t.row, value: t.output })));
    expect(rest.map((x) => x.row)).toEqual([7, 8]);
    expect(afterTrial(plan, null)).toEqual({ answers: [], rest: plan });
    const { readFileSync } = await import("node:fs");
    const dialog = readFileSync("src/components/sheets/AiFillDialog.tsx", "utf8");
    expect(dialog).toMatch(/const \{ answers, rest \} = afterTrial\(plan, trial\);/);
    expect(dialog).toMatch(/const batch = rest\.slice\(i, i \+ BATCH\);/);
  });

  it("a proposal reads in plain words", () => {
    expect(
      describeAction({
        kind: "set_formula",
        sheet: "Sales",
        cell: "E2",
        formula: "=C2*D2",
        fill_to_row: 6,
      }),
    ).toBe("Put =C2*D2 in Sales!E2 and fill it down to row 6");
  });
});

// ── The workbook it reads ──

const sales: SheetDef = {
  id: "s",
  name: "Sales",
  kind: "grid",
  grid: {
    cells: {
      "0,0": { i: "Region" },
      "0,1": { i: "Rep" },
      "0,2": { i: "Units" },
      "0,3": { i: "Price" },
      "1,0": { i: "West" },
      "1,1": { i: "Ana" },
      "1,2": { i: "10" },
      "1,3": { i: "2.5" },
      "2,0": { i: "East" },
      "2,1": { i: "Ben" },
      "2,2": { i: "4" },
      "2,3": { i: "3" },
      "3,0": { i: "West" },
      "3,1": { i: "Cho" },
      "3,2": { i: "6" },
      "3,3": { i: "2" },
      "5,4": { i: "=SUM(C2:C4)" },
    },
  },
};
const orders: SheetDef = { id: "t", name: "Orders", kind: "table" };

function engine(resolver?: TableResolver) {
  return new WorkbookEngine([sales, orders], resolver);
}

describe("the reads the model asks for", () => {
  it("a range, as shown", async () => {
    const r = JSON.parse(
      await runTool(
        { tool: "read_range", range: "A1:B3" },
        { engine: engine(), activeSheetId: "s" },
      ),
    );
    expect(r.rows).toEqual([
      ["Region", "Rep"],
      ["West", "Ana"],
      ["East", "Ben"],
    ]);
  });

  it("a range too big to send is refused with what to do instead", async () => {
    const r = JSON.parse(
      await runTool(
        { tool: "read_range", range: "A1:Z100" },
        { engine: engine(), activeSheetId: "s" },
      ),
    );
    expect(r.error).toMatch(/at most 2000/);
  });

  it("any formula, computed by the workbook", async () => {
    const e = engine();
    const r = JSON.parse(
      await runTool(
        { tool: "evaluate", formula: '=SUMIFS(C:C,A:A,"West")' },
        { engine: e, activeSheetId: "s" },
      ),
    );
    expect(r.value).toBe(16);
    const u = JSON.parse(
      await runTool(
        { tool: "evaluate", formula: "=UNIQUE(A2:A4)" },
        { engine: e, activeSheetId: "s" },
      ),
    );
    expect(u.value).toEqual([["West"], ["East"]]);
  });

  it("a formula over a table sheet waits for the lakehouse's answer", async () => {
    let answered = false;
    const resolver: TableResolver = {
      resolve: () => 0,
      isTable: (n) => n.toLowerCase() === "orders",
      // Pending (the cell shows #BUSY!) until the lakehouse has answered.
      call: () => (answered ? 108 : PENDING),
    };
    const e = engine(resolver);
    const r = JSON.parse(
      await runTool(
        { tool: "evaluate", formula: "=COUNTA(Orders[region])" },
        {
          engine: e,
          activeSheetId: "s",
          settle: async () => {
            answered = true;
          },
        },
      ),
    );
    expect(r.value).toBe(108);
  });

  it("a sheet's columns and types, with its header row", async () => {
    const r = JSON.parse(
      await runTool(
        { tool: "describe_sheet", sheet: "Sales" },
        { engine: engine(), activeSheetId: "s" },
      ),
    );
    expect(r.header).toBe(1);
    expect(r.columns.slice(0, 4)).toEqual([
      { letter: "A", name: "Region", type: "text" },
      { letter: "B", name: "Rep", type: "text" },
      { letter: "C", name: "Units", type: "number" },
      { letter: "D", name: "Price", type: "number" },
    ]);
  });

  it("where a text appears", async () => {
    const r = JSON.parse(
      await runTool({ tool: "find", text: "west" }, { engine: engine(), activeSheetId: "s" }),
    );
    expect(r.hits.map((h: { cell: string }) => h.cell)).toEqual(["A2", "A4"]);
  });

  it("a table sheet is read through formulas, and a sheet that is not there says so", async () => {
    const t = JSON.parse(
      await runTool(
        { tool: "read_range", sheet: "Orders", range: "A1:B2" },
        { engine: engine(), activeSheetId: "s" },
      ),
    );
    expect(t.error).toMatch(/table sheet; read it with evaluate/);
    const n = JSON.parse(
      await runTool(
        { tool: "read_range", sheet: "Costs", range: "A1" },
        { engine: engine(), activeSheetId: "s" },
      ),
    );
    expect(n.error).toMatch(/No sheet named "Costs"/);
  });

  it("the description it starts from names the active cell, each sheet's header and a sample", () => {
    const text = workbookContext({
      engine: engine(),
      workbookName: "Q3",
      activeSheetId: "s",
      selection: "E6",
      focus: { row: 5, col: 4 },
      tableColumns: { Orders: [{ name: "region", type: "VARCHAR" }] },
    });
    expect(text).toContain('active cell E6 holds "=SUM(C2:C4)" showing "20"');
    expect(text).toContain(
      "Header row 1: A=Region [text], B=Rep [text], C=Units [number], D=Price [number]",
    );
    expect(text).toContain("West | Ana | 10 | 2.5");
    expect(text).toContain('TABLE sheet "Orders"');
    expect(text).toContain("region (VARCHAR)");
  });
});

// ── What a proposal does ──

describe("a proposal, worked out before anything changes", () => {
  const ids = () => "id1";
  const plan = (a: Parameters<typeof planAction>[0], e = engine()) =>
    planAction(a, { engine: e, activeSheetId: "s", newId: ids, colWidth: 100, rowHeight: 20 });

  it("a formula filled down moves its relative references and keeps the $ ones", () => {
    const p = plan({ kind: "set_formula", cell: "E2", formula: "C2*D2*$D$2", fill_to_row: 4 });
    expect(p).toEqual({
      kind: "edits",
      sheetId: "s",
      edits: [
        { row: 1, col: 4, input: "=C2*D2*$D$2" },
        { row: 2, col: 4, input: "=C3*D3*$D$2" },
        { row: 3, col: 4, input: "=C4*D4*$D$2" },
      ],
    });
  });

  it("without fill_to_row it is the one cell", () => {
    const p = plan({ kind: "set_formula", cell: "F1", formula: "=1" });
    expect(p.kind === "edits" && p.edits).toEqual([{ row: 0, col: 5, input: "=1" }]);
  });

  it("too long a fill is refused, not cut short", () => {
    const p = plan({
      kind: "set_formula",
      cell: "E1",
      formula: "=1",
      fill_to_row: MAX_FILL_ROWS + 2,
    });
    expect(p).toMatchObject({ kind: "refused" });
  });

  it("values, including formulas and TRUE/FALSE; null clears", () => {
    const p = plan({
      kind: "set_values",
      range: "G1:H2",
      values: [
        ["Region", "Total"],
        ["West", "=SUMIFS(C:C,A:A,G2)"],
        [true, null],
      ],
    });
    expect(p.kind === "edits" && p.edits.map((x) => x.input)).toEqual([
      "Region",
      "Total",
      "West",
      "=SUMIFS(C:C,A:A,G2)",
      "TRUE",
      "",
    ]);
  });

  it("a number format goes on the cells that hold something, and an empty range is refused", () => {
    const p = plan({ kind: "format", range: "D2:D6", number_format: '"$"#,##0.00' });
    expect(p.kind === "edits" && p.edits).toEqual([
      { row: 1, col: 3, input: "2.5", format: '"$"#,##0.00' },
      { row: 2, col: 3, input: "3", format: '"$"#,##0.00' },
      { row: 3, col: 3, input: "2", format: '"$"#,##0.00' },
    ]);
    expect(plan({ kind: "format", range: "K1:K9", number_format: "0%" })).toMatchObject({
      kind: "refused",
    });
  });

  it("a highlight is a formula rule, put first so it wins where rules overlap", () => {
    const e = new WorkbookEngine([
      {
        ...sales,
        grid: {
          ...sales.grid!,
          cond: [
            {
              id: "old",
              ranges: ["A1:A9"],
              rule: { kind: "formula", formula: "=TRUE", style: {} },
            },
          ],
        },
      },
    ]);
    const p = plan({ kind: "highlight", range: "A2:D4", formula: "$C2<5", color: "yellow" }, e);
    expect(p.kind === "rule" && p.cond.map((c) => c.id)).toEqual(["id1", "old"]);
    expect(p.kind === "rule" && p.cond[0]).toMatchObject({
      ranges: ["A2:D4"],
      rule: { kind: "formula", formula: "=$C2<5", style: { bg: "#FFEB9C" } },
    });
  });

  it("a chart goes beside its data, below any chart already there", () => {
    const first = plan({ kind: "add_chart", range: "A1:C4", chart: "column", title: "Units" });
    expect(first.kind === "chart" && first.charts[0]).toMatchObject({
      type: "column",
      range: "A1:C4",
      title: "Units",
      x: 324,
      y: 0,
    });
    const e = new WorkbookEngine([
      {
        ...sales,
        grid: {
          ...sales.grid!,
          charts: [first.kind === "chart" ? first.charts[0] : (null as never)],
        },
      },
    ]);
    const second = plan({ kind: "add_chart", range: "A1:C4", chart: "line" }, e);
    expect(second.kind === "chart" && second.charts[1]).toMatchObject({ x: 324, y: 316 });
  });

  it("a table sheet, a sheet that is not there, or a taken name: refused with why", () => {
    expect(
      plan({ kind: "set_values", sheet: "Orders", range: "A1", values: [["x"]] }),
    ).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/table sheet/),
    });
    expect(
      plan({ kind: "set_values", sheet: "Costs", range: "A1", values: [["x"]] }),
    ).toMatchObject({
      kind: "refused",
      reason: 'There is no sheet named "Costs"',
    });
    expect(plan({ kind: "new_sheet", name: "sales", values: [] })).toMatchObject({
      kind: "refused",
    });
    expect(plan({ kind: "new_sheet", name: "Summary", values: [["Region"], ["West"]] })).toEqual({
      kind: "new_sheet",
      name: "Summary",
      edits: [
        { row: 0, col: 0, input: "Region" },
        { row: 1, col: 0, input: "West" },
      ],
    });
  });
});

// ── Found driving it (R131, R132) ──

describe("what the assistant says about its proposals", () => {
  it("R132: two blocks of cells are named as two, not 'not a range'", () => {
    const p = planAction(
      { kind: "add_chart", sheet: "Sales", range: "A1:A4,C1:C4", chart: "column" },
      { engine: engine(), activeSheetId: "s", newId: () => "x", colWidth: 100, rowHeight: 20 },
    );
    expect(p).toEqual({
      kind: "refused",
      reason: '"A1:A4,C1:C4" is 2 separate blocks of cells; this takes one block, like A1:C4',
    });
  });

  it("R132: proposals are checked before they are offered, a sheet the answer makes counting as there", () => {
    const args = { engine: engine(), activeSheetId: "s", colWidth: 100, rowHeight: 20 };
    const problems = proposalProblems(
      [
        { kind: "set_formula", sheet: "Sales", cell: "E2", formula: "=C2*D2", fill_to_row: 4 },
        { kind: "add_chart", sheet: "Sales", range: "A1:A4,C1:C4", chart: "column" },
        { kind: "new_sheet", name: "Summary", values: [["Region", "Units"]] },
        { kind: "add_chart", sheet: "Summary", range: "A1:B4", chart: "bar" },
        { kind: "format", sheet: "summary", range: "B2:B4,D2", number_format: "0" },
        { kind: "highlight", sheet: "Orders", range: "A1:A4", formula: "=A1>1" },
        { kind: "set_values", sheet: "Nowhere", range: "A1", values: [["x"]] },
      ],
      args,
    );
    expect(problems.map((p) => [p.index, p.reason])).toEqual([
      [1, '"A1:A4,C1:C4" is 2 separate blocks of cells; this takes one block, like A1:C4'],
      [4, '"B2:B4,D2" is 2 separate blocks of cells; this takes one block, like A1:C4'],
      [5, "Orders is a table sheet; the assistant changes grid sheets"],
      [6, 'There is no sheet named "Nowhere"'],
    ]);
    // A sheet that is already there cannot be made again.
    expect(
      proposalProblems([{ kind: "new_sheet", name: "sales", values: [] }], args).map(
        (p) => p.reason,
      ),
    ).toEqual(['There is already a sheet named "sales"']);
    // Checking changes nothing.
    expect(args.engine.gridOf("s")?.charts ?? []).toEqual([]);
    expect(args.engine.sheetIdByName("Summary")).toBeFalsy();
  });

  it("R133: a formula that errs by itself (a table's rows, an unknown function) is sent back, not offered", () => {
    const e = engine(
      new GridTableResolver({
        isTable: (n) => n.toLowerCase() === "orders",
        fetch: async () => ({}),
        onAnswers: () => {},
        onError: () => {},
      }),
    );
    const args = { engine: e, activeSheetId: "s", colWidth: 100, rowHeight: 20 };
    const problems = proposalProblems(
      [
        {
          kind: "new_sheet",
          name: "High Revenue",
          values: [["Region"], ["=FILTER(Orders, Orders[revenue]>1000)"]],
        },
        { kind: "set_formula", sheet: "Sales", cell: "E2", formula: "NOSUCHFN(C2)" },
        {
          kind: "set_values",
          sheet: "High Revenue",
          range: "B1:B2",
          values: [["x"], ["=UNIQUE(Orders[region])"]],
        },
        { kind: "highlight", sheet: "Sales", range: "A2:D4", formula: "=$C2>Orders[units]" },
        // Totals over a table, and errors that depend on the data, are fine.
        {
          kind: "new_sheet",
          name: "Totals",
          values: [
            ["West", '=SUMIFS(Orders[revenue], Orders[region], "West")'],
            ["=A1*2", "=1/0"],
          ],
        },
        { kind: "set_formula", sheet: "Sales", cell: "F2", formula: "=A2*2", fill_to_row: 4 },
        // A format keeps the cells as they are; they are not its proposals.
        { kind: "format", sheet: "Sales", range: "C2:C4", number_format: "0" },
      ],
      args,
    );
    expect(problems.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(problems[0].reason).toBe(
      "=FILTER(Orders, Orders[revenue]>1000) would show #VALUE!: Orders[revenue] is a whole table column. Use it inside SUM, SUMIFS, COUNTIFS, AVERAGEIFS, XLOOKUP, VLOOKUP or INDEX/MATCH, which the lakehouse computes; for a list of values, add a pivot or a filter on the table sheet.",
    );
    expect(problems[1].reason).toBe("=NOSUCHFN(C2) would show #NAME?: Unknown function NOSUCHFN");
    expect(problems[2].reason).toMatch(
      /^=UNIQUE\(Orders\[region\]\) would show #VALUE!: Orders\[region\] is a whole table column/,
    );
    expect(problems[3].reason).toMatch(/^=\$C2>Orders\[units\] would show #VALUE!/);
  });

  it("R134: a proposal that leaves every cell as it is goes back, not offered as a change", () => {
    const args = { engine: engine(), activeSheetId: "s", colWidth: 100, rowHeight: 20 };
    const problems = proposalProblems(
      [
        { kind: "set_formula", sheet: "Sales", cell: "E6", formula: "SUM(C2:C4)" },
        { kind: "set_values", sheet: "Sales", range: "A2:B2", values: [["West", "Ana"]] },
        // One cell different is a change; a format is always one.
        { kind: "set_values", sheet: "Sales", range: "A2:B2", values: [["West", "Bo"]] },
        { kind: "set_formula", sheet: "Sales", cell: "E6", formula: "=SUM(C2:C3)" },
        { kind: "format", sheet: "Sales", range: "C2:C4", number_format: "0" },
      ],
      args,
    );
    expect(problems.map((p) => [p.index, p.reason])).toEqual([
      [0, "the cells already hold exactly this; applying it changes nothing"],
      [1, "the cells already hold exactly this; applying it changes nothing"],
    ]);
  });

  it("R133: at most a set number of an answer's formulas are computed to check it", () => {
    const values = [
      ...Array.from({ length: MAX_CHECKED_FORMULAS }, (_, i) => [`=${i}+1`]),
      ["=NOSUCHFN(1)"],
    ];
    const args = { engine: engine(), activeSheetId: "s", colWidth: 100, rowHeight: 20 };
    expect(proposalProblems([{ kind: "new_sheet", name: "Big", values }], args)).toEqual([]);
    expect(
      proposalProblems([{ kind: "new_sheet", name: "Big", values: values.slice(1) }], args),
    ).toHaveLength(1);
  });

  it("R133: the model is told which functions work over a table sheet, from the evaluator's own list", () => {
    for (const fn of TABLE_PUSHDOWN) expect(ASSIST_SYSTEM).toContain(fn);
    expect(ASSIST_SYSTEM).toMatch(
      /A table's rows never come into a grid sheet: FILTER, SORT or UNIQUE/,
    );
    expect(ASSIST_SYSTEM).toMatch(/Proposals change GRID sheets only/);
  });

  it("R132: the panel sends what cannot be done back to the model once, then shows the answer", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/components/sheets/AssistPanel.tsx", "utf8");
    expect(panel).toMatch(
      /if \(actions\.length && !rechecked && round < MAX_TOOL_ROUNDS\) \{\s*const problems = proposalProblems\(actions,/,
    );
    expect(panel).toMatch(/if \(problems\.length\) \{\s*rechecked = true;/);
    expect(panel).toMatch(
      /role: "tool",\s*content: \[\s*"These proposals cannot be carried out as given:"/,
    );
  });

  it("R139: each workbook, and each way of seeing it (View as), starts its own conversation", async () => {
    const { readFileSync } = await import("node:fs");
    const hook = readFileSync("src/components/sheets/useSheetAssist.tsx", "utf8");
    expect(hook).toMatch(
      /<AssistPanel\s+(\/\/[^\n]*\n\s*)*key=\{`\$\{workbookId\}:\$\{wb\.asShare \?\? "own"\}`\}/,
    );
  });

  it("R131/R132: the model is told nothing changes until applied, and a chart is one block", async () => {
    const { readFileSync } = await import("node:fs");
    const prompt = readFileSync("src/utils/sheets/assistPrompt.server.ts", "utf8");
    expect(prompt).toMatch(/Nothing changes until the person applies a proposal/);
    expect(prompt).toMatch(/never say you changed, added or created anything/);
    expect(prompt).toMatch(/A chart's range is ONE block of cells/);
  });

  it("R131: whatever the model says, the panel says nothing has changed until applied", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/components/sheets/AssistPanel.tsx", "utf8");
    expect(panel).toMatch(
      /\{t\.actions\.some\(\(a\) => a\.state !== "applied"\) && \(\s*<p[^>]*data-testid="assist-pending-note"/,
    );
    expect(panel).toMatch(/Nothing has changed yet\. Apply what you want/);
  });
});

// ── The server ──

const state = {
  access: { ok: true } as { ok: boolean; error?: string },
  asked: [] as { need: string; asShare?: string | null }[],
  limited: false,
  model: "openrouter/google/gemini-3-flash-preview",
  chat: [] as { system: string; user: string; agentName: string }[],
  reply: '{"type":"answer","text":"16"}',
};
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  },
}));
vi.mock("@/utils/sheets/access.server", () => ({
  requireAccess: async (
    _u: string,
    _w: string,
    need: string,
    opts: { asShare?: string | null } = {},
  ) => {
    state.asked.push({ need, asShare: opts.asShare });
    return state.access.ok
      ? { ok: true, access: {} }
      : { ok: false, error: state.access.error ?? "no" };
  },
}));
vi.mock("@/utils/rateLimit.server", () => ({ rateLimitedGlobal: async () => state.limited }));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ sheetsAssistModel: state.model, sheetsAssistPerMinute: 30 }),
}));
vi.mock("@/utils/internalChat.server", () => ({
  internalChatText: async (a: { system: string; user: string; agentName: string }) => {
    state.chat.push(a);
    return { text: state.reply, cost: 0.0012 };
  },
}));

const fns = await import("@/utils/sheetsAssist.functions");
const WB = "11111111-1111-4111-8111-111111111111";
const SHARE = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  state.access = { ok: true };
  state.asked = [];
  state.limited = false;
  state.model = "openrouter/google/gemini-3-flash-preview";
  state.chat = [];
  state.reply = '{"type":"answer","text":"16"}';
});

describe("who may ask, and how", () => {
  const ask = (over: Record<string, unknown> = {}) =>
    fns.sheetsAssist({
      data: {
        access_token: "t",
        workbook_id: WB,
        context: "Workbook: Q3",
        messages: [{ role: "user", content: "total West units?" }],
        ...over,
      },
    });

  it("anyone who can open the workbook may ask (view), as the share they are looking through", async () => {
    const r = await ask({ as_share: SHARE });
    expect(r).toMatchObject({ ok: true, reply: { type: "answer", text: "16" }, cost: 0.0012 });
    expect(state.asked).toEqual([{ need: "view", asShare: SHARE }]);
    // Through the chat channel, with the workbook in the instructions.
    expect(state.chat[0].agentName).toBe("Sheets assistant");
    expect(state.chat[0].system).toContain("THE WORKBOOK NOW:\nWorkbook: Q3");
    expect(state.chat[0].user).toMatch(/^PERSON:\ntotal West units\?/);
  });

  it("someone who cannot open it gets nothing, and no model is called", async () => {
    state.access = { ok: false, error: "This workbook does not exist, or is not shared with you" };
    expect(await ask()).toMatchObject({ ok: false, error: /not shared with you/ });
    expect(state.chat).toEqual([]);
  });

  it("Fill with AI writes the workbook: the owner's and editors' (edit)", async () => {
    state.reply = '[{"i":0,"o":"positive"},{"i":1,"o":"negative"}]';
    const r = await fns.sheetsAiFill({
      data: {
        access_token: "t",
        workbook_id: WB,
        instruction: "sentiment",
        inputs: ["great", "awful"],
      },
    });
    expect(state.asked).toEqual([{ need: "edit", asShare: undefined }]);
    expect(r).toMatchObject({ ok: true, outputs: ["positive", "negative"], cost: 0.0012 });
    state.access = {
      ok: false,
      error: "This workbook is shared with you to view; it can't be changed from here",
    };
    expect(
      await fns.sheetsAiFill({
        data: { access_token: "t", workbook_id: WB, instruction: "x", inputs: ["a"] },
      }),
    ).toMatchObject({ ok: false, error: /to view/ });
  });

  it("R135: an answer with no answers in it is a failure to say, not a column of blanks", async () => {
    state.reply = "Sure! Here are the sentiments you asked for.";
    const r = await fns.sheetsAiFill({
      data: { access_token: "t", workbook_id: WB, instruction: "sentiment", inputs: ["a", "b"] },
    });
    expect(r).toMatchObject({ ok: false, error: /could not be read .* nothing was written/ });
  });

  it("past the per-person rate, refused with the setting's name", async () => {
    state.limited = true;
    expect(await ask()).toMatchObject({ ok: false, error: /SHEETS_ASSIST_PER_MINUTE/ });
    expect(state.chat).toEqual([]);
  });

  it("a model setting that is not provider/model says where to fix it", async () => {
    state.model = "gemini";
    expect(await ask()).toMatchObject({ ok: false, error: /Admin → Developer runtime/ });
  });

  it("the browser cannot choose the model", () => {
    expect(() =>
      fns.sheetsAssist({
        data: {
          access_token: "t",
          workbook_id: WB,
          context: "",
          messages: [{ role: "user", content: "x" }],
          model: "openai/expensive",
        },
      }),
    ).not.toThrow();
    expect(fns.transcript([{ role: "tool", content: "r" }])).toContain("RESULTS OF YOUR READS");
  });
});
