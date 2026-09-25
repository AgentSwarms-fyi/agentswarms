// The workbook engine: inputs in, values out, recalculated incrementally.
//
// Owns every grid sheet's cell inputs, parses formulas once, records each
// formula's precedents as it reads them (so INDEX and whole-column references
// are exact), and on an edit recalculates only what depends on it. Dynamic
// arrays spill into empty neighbours (#SPILL! when blocked). A formula that
// reaches itself is #CYCLE!. Table references go to a resolver that may
// answer later; until it does the cell shows #BUSY!.

import { cellKey, MAX_COLS, MAX_ROWS, parseKey } from "./a1";
import {
  evaluate,
  PendingValue,
  PENDING,
  type EvalEnv,
  type RangeRef,
  type TableCallRequest,
} from "./formula/evaluate";
import { FUNCTIONS } from "./formula/functions";
import { FormulaSyntaxError, isFormula, parseFormula, type Node } from "./formula/parser";
import type { Borders } from "./style";
import {
  err,
  isError,
  isMatrix,
  parseNumberText,
  type Matrix,
  type Scalar,
  type Value,
} from "./formula/values";

export type CellStyle = {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** Strikethrough. */
  st?: boolean;
  align?: "left" | "center" | "right";
  /** Vertical alignment; Excel's default is the bottom. */
  va?: "top" | "middle" | "bottom";
  wrap?: boolean;
  /** Indent level (about three characters each). */
  ind?: number;
  font?: string;
  /** Font size in points. */
  sz?: number;
  color?: string;
  bg?: string;
  bd?: Borders;
};

/**
 * What is stored for a cell: the text typed, a number format, a style, a
 * link, and for a formula brought in from an Excel file that this engine
 * cannot compute (a function it lacks, a link to another file), the value
 * Excel last saved for it.
 */
export type CellInput = {
  i: string;
  f?: string;
  s?: CellStyle;
  l?: string;
  c?: string | number | boolean;
};

export type GridData = {
  cells: Record<string, CellInput>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  frozenRows?: number;
  frozenCols?: number;
  /** Merged ranges, "B2:D3". */
  merges?: string[];
  hiddenRows?: number[];
  hiddenCols?: number[];
  /** Gridlines off (View > Gridlines). */
  hideGrid?: boolean;
};

export type SheetDef = { id: string; name: string; kind: "grid" | "table"; grid?: GridData };

/** Answers structured references (Orders[amount]) for table sheets. */
export interface TableResolver {
  resolve(node: Extract<Node, { k: "struct" }>, formulaSheet: string): Value | typeof PENDING;
  /** Is this name a table sheet? */
  isTable?(name: string): boolean;
  /** A call over table columns (SUMIFS, XLOOKUP…), computed by the lakehouse. */
  call?(req: TableCallRequest): Value | typeof PENDING;
}

type CellId = string; // `${sheetId}|${row},${col}`
const cid = (sheetId: string, row: number, col: number): CellId => `${sheetId}|${row},${col}`;
const splitId = (id: CellId) => {
  const bar = id.indexOf("|");
  return { sheetId: id.slice(0, bar), ...parseKey(id.slice(bar + 1)) };
};

type Compiled = {
  ast?: Node;
  syntax?: string;
  volatile: boolean;
  tables: string[];
  /** Functions it calls that this engine does not have (from an Excel file). */
  unknown?: string[];
};

function unknownFunctions(node: Node, out: Set<string>): void {
  switch (node.k) {
    case "call":
      if (!FUNCTIONS[node.name]) out.add(node.name);
      node.args.forEach((a) => unknownFunctions(a, out));
      break;
    case "unary":
    case "percent":
      unknownFunctions(node.arg, out);
      break;
    case "bin":
      unknownFunctions(node.left, out);
      unknownFunctions(node.right, out);
      break;
    case "array":
      node.rows.forEach((r) => r.forEach((n) => unknownFunctions(n, out)));
      break;
    default:
      break;
  }
}

const VOLATILE = /\b(NOW|TODAY|RAND|RANDBETWEEN)\s*\(/i;

function tablesIn(node: Node, out: Set<string>): void {
  switch (node.k) {
    case "struct":
      if (node.table) out.add(node.table.toLowerCase());
      break;
    case "name":
      // VLOOKUP(x, Customers, 2) names a whole table.
      out.add(node.name.toLowerCase());
      break;
    case "call":
      node.args.forEach((a) => tablesIn(a, out));
      break;
    case "unary":
    case "percent":
      tablesIn(node.arg, out);
      break;
    case "bin":
      tablesIn(node.left, out);
      tablesIn(node.right, out);
      break;
    case "array":
      node.rows.forEach((r) => r.forEach((n) => tablesIn(n, out)));
      break;
    default:
      break;
  }
}

/** A literal input → its value: numbers (incl. %, dates), booleans, text. */
export function literalValue(input: string): Scalar {
  if (input === "") return null;
  if (input.startsWith("'")) return input.slice(1); // forced text
  const upper = input.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  const n = parseNumberText(input);
  return n === null ? input : n;
}

export class WorkbookEngine {
  private sheets = new Map<string, SheetDef>(); // by id
  private byName = new Map<string, string>(); // lower name → id
  private compiled = new Map<CellId, Compiled>();
  private memo = new Map<CellId, Scalar>();
  private arrays = new Map<CellId, Matrix>();
  private spillOwner = new Map<CellId, CellId>();
  private spillOf = new Map<CellId, CellId[]>();
  /** Cell → anchors whose spill it blocked (so clearing it lets them spill). */
  private blockedBy = new Map<CellId, Set<CellId>>();
  private deps = new Map<
    CellId,
    { cells: Set<CellId>; ranges: (RangeRef & { sheetId: string })[] }
  >();
  private rdepCells = new Map<CellId, Set<CellId>>();
  private computing = new Set<CellId>();
  private tableReaders = new Map<string, Set<CellId>>();
  resolver?: TableResolver;
  now?: Date;

  constructor(sheets: SheetDef[], resolver?: TableResolver) {
    this.resolver = resolver;
    for (const s of sheets) this.addSheetDef(s);
    this.recalcAll();
  }

  // ── Sheets ───────────────────────────────────────────────────────────────

  private addSheetDef(s: SheetDef): void {
    const copy: SheetDef = {
      ...s,
      grid: s.grid ? { ...s.grid, cells: { ...s.grid.cells } } : undefined,
    };
    this.sheets.set(s.id, copy);
    this.byName.set(s.name.toLowerCase(), s.id);
    if (copy.grid) {
      for (const [key, input] of Object.entries(copy.grid.cells)) {
        const { row, col } = parseKey(key);
        this.compile(cid(s.id, row, col), input.i);
      }
    }
  }

  sheetIdByName(name: string): string | undefined {
    return this.byName.get(name.toLowerCase());
  }

  sheet(id: string): SheetDef | undefined {
    return this.sheets.get(id);
  }

  listSheets(): SheetDef[] {
    return [...this.sheets.values()];
  }

  addSheet(s: SheetDef): void {
    this.addSheetDef(s);
    // A sheet that did not exist may now resolve formulas that said #REF!.
    this.recalcAll();
  }

  removeSheet(id: string): void {
    const s = this.sheets.get(id);
    if (!s) return;
    this.sheets.delete(id);
    this.byName.delete(s.name.toLowerCase());
    for (const key of [...this.compiled.keys()])
      if (key.startsWith(`${id}|`)) this.compiled.delete(key);
    this.recalcAll();
  }

  renameSheet(id: string, name: string): void {
    const s = this.sheets.get(id);
    if (!s) return;
    this.byName.delete(s.name.toLowerCase());
    s.name = name;
    this.byName.set(name.toLowerCase(), id);
    this.recalcAll();
  }

  // ── Inputs ───────────────────────────────────────────────────────────────

  private compile(id: CellId, input: string): void {
    if (!isFormula(input)) {
      this.compiled.delete(id);
      return;
    }
    try {
      const ast = parseFormula(input.slice(1));
      const t = new Set<string>();
      tablesIn(ast, t);
      const u = new Set<string>();
      unknownFunctions(ast, u);
      this.compiled.set(id, {
        ast,
        volatile: VOLATILE.test(input),
        tables: [...t],
        ...(u.size ? { unknown: [...u] } : {}),
      });
    } catch (e) {
      const msg = e instanceof FormulaSyntaxError ? e.message : "Invalid formula";
      this.compiled.set(id, { syntax: msg, volatile: false, tables: [] });
    }
  }

  getInput(sheetId: string, row: number, col: number): CellInput | undefined {
    return this.sheets.get(sheetId)?.grid?.cells[cellKey(row, col)];
  }

  /**
   * Set (or clear, with "") a cell's input and recalculate what depends on
   * it. Returns the ids of cells whose values may have changed.
   */
  setInput(sheetId: string, row: number, col: number, input: string, format?: string | null): void {
    this.setInputs(sheetId, [{ row, col, input, format }]);
  }

  setInputs(
    sheetId: string,
    edits: {
      row: number;
      col: number;
      input: string;
      format?: string | null;
      style?: CellStyle | null;
      link?: string | null;
    }[],
  ): void {
    const s = this.sheets.get(sheetId);
    if (!s?.grid) return;
    const changed: CellId[] = [];
    for (const e of edits) {
      const key = cellKey(e.row, e.col);
      const prev = s.grid.cells[key];
      const next: CellInput = { ...(prev ?? { i: "" }), i: e.input };
      // Excel's saved value belonged to the formula that was there.
      if (prev && prev.i !== e.input) delete next.c;
      if (e.format !== undefined) {
        if (e.format === null) delete next.f;
        else next.f = e.format;
      }
      if (e.style !== undefined) {
        if (e.style === null) delete next.s;
        else next.s = e.style;
      }
      if (e.link !== undefined) {
        if (e.link === null) delete next.l;
        else next.l = e.link;
      }
      if (next.i === "" && !next.f && !next.s && !next.l) delete s.grid.cells[key];
      else s.grid.cells[key] = next;
      const id = cid(sheetId, e.row, e.col);
      if (!prev || prev.i !== e.input) {
        this.compile(id, e.input);
        changed.push(id);
      }
    }
    if (changed.length) this.recalc(changed);
  }

  /** Formats and styles only (no recalculation needed). */
  setFormat(sheetId: string, cells: { row: number; col: number }[], format: string | null): void {
    const s = this.sheets.get(sheetId);
    if (!s?.grid) return;
    for (const { row, col } of cells) {
      const key = cellKey(row, col);
      const cur = s.grid.cells[key] ?? { i: "" };
      const next = { ...cur };
      if (format === null) delete next.f;
      else next.f = format;
      if (next.i === "" && !next.f && !next.s && !next.l) delete s.grid.cells[key];
      else s.grid.cells[key] = next;
    }
  }

  setStyle(sheetId: string, cells: { row: number; col: number }[], patch: CellStyle): void {
    const s = this.sheets.get(sheetId);
    if (!s?.grid) return;
    for (const { row, col } of cells) {
      const key = cellKey(row, col);
      const cur = s.grid.cells[key] ?? { i: "" };
      const style = { ...(cur.s ?? {}), ...patch };
      for (const k of Object.keys(style) as (keyof CellStyle)[]) {
        if (style[k] === undefined || style[k] === false || style[k] === "") delete style[k];
      }
      const next: CellInput = { ...cur, s: Object.keys(style).length ? style : undefined };
      if (!next.s) delete next.s;
      if (next.i === "" && !next.f && !next.s && !next.l) delete s.grid.cells[key];
      else s.grid.cells[key] = next;
    }
  }

  // ── Values ───────────────────────────────────────────────────────────────

  /** The value shown in a cell (spills included). */
  getValue(sheetId: string, row: number, col: number): Scalar {
    const id = cid(sheetId, row, col);
    return this.valueOf(id);
  }

  /** Why a cell is an error, when the engine knows more than the code. */
  getErrorDetail(sheetId: string, row: number, col: number): string | undefined {
    const c = this.compiled.get(cid(sheetId, row, col));
    if (c?.syntax && !this.cachedIds.has(cid(sheetId, row, col))) return c.syntax;
    const v = this.getValue(sheetId, row, col);
    return isError(v) ? v.detail : undefined;
  }

  /** The anchor a cell's value spills from, if it is part of a spill. */
  spillAnchor(sheetId: string, row: number, col: number): { row: number; col: number } | undefined {
    const a = this.spillOwner.get(cid(sheetId, row, col));
    if (!a) return undefined;
    const p = splitId(a);
    return { row: p.row, col: p.col };
  }

  /** The extent of the data in a sheet (inputs and spills), for whole-column refs and scrolling. */
  used(sheetId: string): { rows: number; cols: number } {
    const s = this.sheets.get(sheetId);
    let rows = 0;
    let cols = 0;
    for (const key of Object.keys(s?.grid?.cells ?? {})) {
      const { row, col } = parseKey(key);
      rows = Math.max(rows, row + 1);
      cols = Math.max(cols, col + 1);
    }
    for (const t of this.spillOwner.keys()) {
      if (!t.startsWith(`${sheetId}|`)) continue;
      const { row, col } = splitId(t);
      rows = Math.max(rows, row + 1);
      cols = Math.max(cols, col + 1);
    }
    return { rows, cols };
  }

  private valueOf(id: CellId): Scalar {
    const c = this.compiled.get(id);
    if (c) {
      if (this.memo.has(id)) return this.memo.get(id)!;
      return this.compute(id);
    }
    const owner = this.spillOwner.get(id);
    if (owner) {
      const arr = this.arrays.get(owner);
      const a = splitId(owner);
      const t = splitId(id);
      return arr?.[t.row - a.row]?.[t.col - a.col] ?? null;
    }
    const { sheetId, row, col } = splitId(id);
    const input = this.sheets.get(sheetId)?.grid?.cells[cellKey(row, col)];
    return input ? literalValue(input.i) : null;
  }

  private recordDep(formula: CellId, dep: CellId): void {
    let d = this.deps.get(formula);
    if (!d) this.deps.set(formula, (d = { cells: new Set(), ranges: [] }));
    d.cells.add(dep);
    let r = this.rdepCells.get(dep);
    if (!r) this.rdepCells.set(dep, (r = new Set()));
    r.add(formula);
  }

  private recordRangeDep(formula: CellId, range: RangeRef & { sheetId: string }): void {
    let d = this.deps.get(formula);
    if (!d) this.deps.set(formula, (d = { cells: new Set(), ranges: [] }));
    d.ranges.push(range);
  }

  private clearDeps(formula: CellId): void {
    const d = this.deps.get(formula);
    if (!d) return;
    for (const dep of d.cells) this.rdepCells.get(dep)?.delete(formula);
    this.deps.delete(formula);
  }

  private clearSpill(anchor: CellId): CellId[] {
    const targets = this.spillOf.get(anchor) ?? [];
    for (const t of targets) this.spillOwner.delete(t);
    this.spillOf.delete(anchor);
    this.arrays.delete(anchor);
    return targets;
  }

  private compute(id: CellId): Scalar {
    const c = this.compiled.get(id)!;
    if (c.syntax) {
      const v = err("#NAME?", c.syntax);
      const at = splitId(id);
      const cached = this.cachedFallback(at.sheetId, at.row, at.col, v);
      if (cached !== undefined) {
        this.cachedIds.add(id);
        this.memo.set(id, cached);
        return cached;
      }
      this.memo.set(id, v);
      return v;
    }
    // A formula calling a function this engine lacks shows Excel's saved value
    // without being evaluated: an IFERROR around it would otherwise hide the gap.
    if (c.unknown) {
      const at = splitId(id);
      const cached = this.cachedFallback(at.sheetId, at.row, at.col, err("#NAME?", ""));
      if (cached !== undefined) {
        this.cachedIds.add(id);
        this.memo.set(id, cached);
        return cached;
      }
    }
    if (this.computing.has(id)) return err("#CYCLE!", "This formula refers to itself");
    this.computing.add(id);
    const { sheetId, row, col } = splitId(id);
    const sheetName = this.sheets.get(sheetId)?.name ?? "";
    this.clearDeps(id);
    for (const t of c.tables) {
      let set = this.tableReaders.get(t);
      if (!set) this.tableReaders.set(t, (set = new Set()));
      set.add(id);
    }
    const env: EvalEnv = {
      sheet: sheetName,
      row,
      col,
      now: this.now,
      hasSheet: (name) => this.byName.has(name.toLowerCase()),
      used: (name) => this.used(this.byName.get(name.toLowerCase()) ?? ""),
      cell: (sheet, r, cc) => {
        const sid = this.byName.get(sheet.toLowerCase());
        if (!sid) return err("#REF!", `No sheet "${sheet}"`);
        if (this.sheets.get(sid)?.kind === "table")
          return err("#REF!", "Refer to a table sheet by its columns, e.g. Orders[amount]");
        const dep = cid(sid, r, cc);
        this.recordDep(id, dep);
        const v = this.valueOf(dep);
        return v;
      },
      range: (ref) => {
        const sid = this.byName.get(ref.sheet.toLowerCase());
        if (!sid) return [[err("#REF!", `No sheet "${ref.sheet}"`)]];
        // A whole column depends on every row of it, not just the rows used
        // today: a value typed in row 50 must reach =SUM(A:A).
        this.recordRangeDep(id, {
          ...ref,
          sheetId: sid,
          r1: ref.whole === "cols" ? MAX_ROWS - 1 : ref.r1,
          c1: ref.whole === "rows" ? MAX_COLS - 1 : ref.c1,
        });
        const out: Matrix = [];
        for (let r = ref.r0; r <= ref.r1; r++) {
          const line: Scalar[] = [];
          for (let cc = ref.c0; cc <= ref.c1; cc++) {
            const dep = cid(sid, r, cc);
            line.push(
              dep === id
                ? err("#CYCLE!", "This formula's range includes itself")
                : this.valueOf(dep),
            );
          }
          out.push(line);
        }
        return out;
      },
      table: this.resolver ? (node) => this.resolver!.resolve(node, sheetName) : undefined,
      isTable: this.resolver?.isTable ? (name) => this.resolver!.isTable!(name) : undefined,
      tableCall: this.resolver?.call ? (req) => this.resolver!.call!(req) : undefined,
    };
    let result: Value;
    try {
      result = evaluate(c.ast!, env);
    } catch (e) {
      if (e instanceof PendingValue) result = err("#BUSY!", "Waiting for the table's answer");
      else result = err("#VALUE!", e instanceof Error ? e.message : "Could not compute");
    }
    this.computing.delete(id);
    // A formula from a file this engine cannot compute shows what Excel saved.
    const cached = this.cachedFallback(sheetId, row, col, result);
    if (cached !== undefined) {
      this.clearSpill(id);
      this.cachedIds.add(id);
      this.memo.set(id, cached);
      return cached;
    }
    this.cachedIds.delete(id);
    const scalar = this.place(id, result);
    this.memo.set(id, scalar);
    return scalar;
  }

  private cachedIds = new Set<CellId>();

  private cachedFallback(
    sheetId: string,
    row: number,
    col: number,
    result: Value,
  ): Scalar | undefined {
    if (isMatrix(result) || !isError(result) || result.err !== "#NAME?") return undefined;
    const c = this.sheets.get(sheetId)?.grid?.cells[cellKey(row, col)]?.c;
    if (c === undefined) return undefined;
    if (
      typeof c === "string" &&
      /^#(N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|NULL!|SPILL!|CALC!)$/.test(c)
    ) {
      return err(c as "#N/A", "Excel's saved value");
    }
    return c;
  }

  /** Whether a cell shows the value Excel saved rather than one computed here. */
  isCached(sheetId: string, row: number, col: number): boolean {
    return this.cachedIds.has(cid(sheetId, row, col));
  }

  /** The functions a formula uses that this engine does not have. */
  unknownFunctions(sheetId: string, row: number, col: number): string[] {
    return this.compiled.get(cid(sheetId, row, col))?.unknown ?? [];
  }

  /** How far a formula's array spills, when it does. */
  spillSize(sheetId: string, row: number, col: number): { rows: number; cols: number } | undefined {
    const a = this.arrays.get(cid(sheetId, row, col));
    if (!a) return undefined;
    return { rows: a.length, cols: a[0]?.length ?? 0 };
  }

  /** Store a result: a scalar stays; an array spills into empty neighbours or is #SPILL!. */
  private place(anchor: CellId, result: Value): Scalar {
    this.clearSpill(anchor);
    if (!isMatrix(result)) return result;
    const rows = result.length;
    const cols = result[0]?.length ?? 0;
    if (rows === 0 || cols === 0) return err("#CALC!", "Empty array");
    if (rows === 1 && cols === 1) return result[0][0];
    const { sheetId, row, col } = splitId(anchor);
    const grid = this.sheets.get(sheetId)?.grid;
    const targets: CellId[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        const t = cid(sheetId, row + r, col + c);
        const input = grid?.cells[cellKey(row + r, col + c)];
        const owner = this.spillOwner.get(t);
        if ((input && input.i !== "") || (owner && owner !== anchor)) {
          let set = this.blockedBy.get(t);
          if (!set) this.blockedBy.set(t, (set = new Set()));
          set.add(anchor);
          return err(
            "#SPILL!",
            `The result needs ${rows}×${cols} cells and ${input && input.i !== "" ? "a typed cell" : "another spill"} is in the way`,
          );
        }
        targets.push(t);
      }
    }
    for (const t of targets) this.spillOwner.set(t, anchor);
    this.spillOf.set(anchor, targets);
    this.arrays.set(anchor, result);
    return result[0][0];
  }

  // ── Recalculation ────────────────────────────────────────────────────────

  /** Everything, from scratch (load, sheet added/removed/renamed, F9). */
  recalcAll(): void {
    this.memo.clear();
    this.arrays.clear();
    this.spillOwner.clear();
    this.spillOf.clear();
    this.blockedBy.clear();
    this.deps.clear();
    this.rdepCells.clear();
    this.tableReaders.clear();
    this.settle([...this.compiled.keys()]);
  }

  /** The formulas that read `id` (directly or through a range). */
  private readersOf(id: CellId): CellId[] {
    const out = new Set(this.rdepCells.get(id) ?? []);
    const { sheetId, row, col } = splitId(id);
    for (const [f, d] of this.deps) {
      for (const r of d.ranges) {
        if (r.sheetId === sheetId && row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1) {
          out.add(f);
          break;
        }
      }
    }
    return [...out];
  }

  private recalc(changed: CellId[]): void {
    const queue: CellId[] = [];
    for (const id of changed) {
      queue.push(id);
      if (!this.compiled.has(id)) {
        // A formula that became a literal (or blank) leaves its spill: those cells change too.
        this.memo.delete(id);
        this.clearDeps(id);
        for (const t of this.clearSpill(id)) queue.push(t);
      }
      // Typing into a spill blocks it; clearing a blocker lets it spill again.
      // Neither anchor READS this cell, so the reader walk would miss them.
      const owner = this.spillOwner.get(id);
      if (owner) queue.push(owner);
      for (const a of this.blockedBy.get(id) ?? []) queue.push(a);
      this.blockedBy.delete(id);
    }
    // Everything downstream of the edits, spills included, is dirty.
    const dirty = new Set<CellId>();
    const seen = new Set<CellId>();
    while (queue.length) {
      const x = queue.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (this.compiled.has(x)) {
        dirty.add(x);
        for (const t of this.spillOf.get(x) ?? []) queue.push(t);
      }
      for (const r of this.readersOf(x)) queue.push(r);
    }
    for (const id of dirty) {
      this.memo.delete(id);
      this.clearSpill(id);
      this.clearDeps(id);
    }
    this.settle([...dirty]);
  }

  /**
   * Compute the given formulas; then, because a spill that lands can change
   * what an earlier formula read as empty, recompute the readers of any new
   * spill until nothing moves (bounded).
   */
  private settle(ids: CellId[]): void {
    let pending = ids;
    for (let round = 0; round < 8 && pending.length; round++) {
      const spillsBefore = new Map(this.spillOf);
      for (const id of pending) if (!this.memo.has(id) && this.compiled.has(id)) this.compute(id);
      const next = new Set<CellId>();
      for (const [anchor, targets] of this.spillOf) {
        const prev = spillsBefore.get(anchor);
        if (prev && prev.length === targets.length) continue;
        for (const t of targets) for (const r of this.readersOf(t)) if (r !== anchor) next.add(r);
      }
      for (const id of next) {
        this.memo.delete(id);
        this.clearSpill(id);
        this.clearDeps(id);
      }
      pending = [...next];
    }
  }

  /** Volatile formulas (NOW, TODAY, RAND) and everything downstream. */
  recalcVolatile(): void {
    const vol = [...this.compiled].filter(([, c]) => c.volatile).map(([id]) => id);
    if (vol.length) this.recalc(vol);
  }

  /** A table's data changed (refresh, answer arrived): recompute its readers. */
  tableChanged(tableName: string): void {
    const readers = [...(this.tableReaders.get(tableName.toLowerCase()) ?? [])];
    if (readers.length) this.recalc(readers);
  }

  /** Formula cells currently waiting on a table (#BUSY!). */
  busyCount(): number {
    let n = 0;
    for (const v of this.memo.values()) if (isError(v) && v.err === "#BUSY!") n++;
    return n;
  }

  /**
   * The sheet's grid as the engine holds it, without a copy: for reading on
   * every render. Changes go through the engine's setters, never through this.
   */
  gridOf(sheetId: string): Readonly<GridData> | undefined {
    return this.sheets.get(sheetId)?.grid;
  }

  /** The grid data to persist for a sheet. */
  snapshot(sheetId: string): GridData | undefined {
    const g = this.sheets.get(sheetId)?.grid;
    return g ? { ...g, cells: { ...g.cells } } : undefined;
  }

  /**
   * Replace a sheet's whole grid (inserting/deleting rows or columns moves
   * every cell). The caller recalculates once all sheets are replaced.
   */
  replaceGrid(sheetId: string, grid: GridData): void {
    const s = this.sheets.get(sheetId);
    if (!s) return;
    for (const key of [...this.compiled.keys()]) {
      if (key.startsWith(`${sheetId}|`)) this.compiled.delete(key);
    }
    s.grid = { ...grid, cells: { ...grid.cells } };
    for (const [key, input] of Object.entries(s.grid.cells)) {
      const { row, col } = parseKey(key);
      this.compile(cid(sheetId, row, col), input.i);
    }
  }

  setGridMeta(sheetId: string, patch: Partial<Omit<GridData, "cells">>): void {
    const s = this.sheets.get(sheetId);
    if (!s?.grid) return;
    Object.assign(s.grid, patch);
  }
}
