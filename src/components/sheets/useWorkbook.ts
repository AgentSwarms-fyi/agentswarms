// The editor's state: one engine for the workbook, undo/redo, and autosave.
//
// Autosave is per grid sheet, debounced, one save in flight at a time, and it
// stops on a conflict: a save that finds a newer version on the server does
// not write over it; the page says so and offers to reload or overwrite.
// Nothing is saved until the workbook has loaded (an editor that never held
// the document would save an empty one over it).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  WorkbookEngine,
  type CellInput,
  type CellStyle,
  type GridData,
  type SheetDef,
} from "@/lib/sheets/engine";
import { toast } from "sonner";
import { renameSheetInFormula, renameTableInFormula } from "@/lib/sheets/formula/shift";
import { GridTableResolver } from "@/lib/sheets/gridTableResolver";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";
import {
  sheetsGet,
  sheetsSaveGrid,
  type SheetTabRow,
  type SheetsLimits,
} from "@/utils/sheets.functions";
import { sheetsSaveTableConfig, sheetsTableCalls } from "@/utils/sheetsTables.functions";

export type CellEdit = {
  row: number;
  col: number;
  input: string;
  format?: string | null;
  style?: CellStyle | null;
  link?: string | null;
};

type GridMeta = Partial<Omit<GridData, "cells">>;

type UndoEntry =
  | {
      kind?: "cells";
      tabId: string;
      before: { row: number; col: number; cell: CellInput | undefined }[];
      after: { row: number; col: number; cell: CellInput | undefined }[];
    }
  | {
      // Inserting or deleting rows/columns rewrites formulas across the
      // workbook, so its undo holds every grid sheet before and after.
      kind: "snapshot";
      tabId: string;
      before: Record<string, GridData>;
      after: Record<string, GridData>;
    }
  | {
      // A sheet setting (widths, heights, merges, hidden rows): the keys changed.
      kind: "meta";
      tabId: string;
      before: GridMeta;
      after: GridMeta;
      /** Steps of one gesture (a column dragged wider) undo as one. */
      gesture?: string;
      at: number;
    };

export type SaveState =
  | { kind: "saved"; at: number }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string; serverVersion?: number };

export type TabMeta = {
  id: string;
  name: string;
  kind: "grid" | "table";
  position: number;
  version: number;
};

const SAVE_DEBOUNCE_MS = 1200;

function toGridData(json: unknown): GridData {
  const g = (json ?? {}) as Partial<GridData>;
  return { ...g, cells: (g.cells ?? {}) as GridData["cells"] };
}

export function useWorkbook(args: {
  token: string | undefined;
  workbookId: string;
  tabs: SheetTabRow[] | null;
  limits: SheetsLimits | null;
}) {
  const saveFn = useServerFn(sheetsSaveGrid);
  const saveTableFn = useServerFn(sheetsSaveTableConfig);
  const callsFn = useServerFn(sheetsTableCalls);
  // Read through a ref: the engine is built once per load, not per render.
  const callsFnRef = useRef(callsFn);
  callsFnRef.current = callsFn;
  const resolverRef = useRef<GridTableResolver | null>(null);
  const getFn = useServerFn(sheetsGet);
  // A table sheet's settings (source, calculated columns, sort, filters).
  const [tableConfigs, setTableConfigs] = useState<Record<string, TableConfig>>({});
  const tableConfigsRef = useRef<Record<string, TableConfig>>({});
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((r) => r + 1), []);
  const engineRef = useRef<WorkbookEngine | null>(null);
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const tabsRef = useRef<TabMeta[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const dirty = useRef<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const hydrated = useRef(false);
  const tokenRef = useRef(args.token);
  tokenRef.current = args.token;

  // Build the engine once per load of the workbook's tabs.
  useEffect(() => {
    if (!args.tabs) return;
    const defs: SheetDef[] = args.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      grid: t.kind === "grid" ? toGridData(t.grid) : undefined,
    }));
    // Grid formulas over table sheets are answered by the lakehouse.
    const resolver = new GridTableResolver({
      isTable: (name) =>
        tabsRef.current.some(
          (t) => t.kind === "table" && t.name.toLowerCase() === name.toLowerCase(),
        ),
      fetch: async (calls) => {
        const token = tokenRef.current;
        if (!token) throw new Error("Not signed in");
        const r = await callsFnRef.current({
          data: { access_token: token, workbook_id: args.workbookId, calls },
        });
        if (!r.ok) throw new Error(r.error);
        return r.answers;
      },
      onAnswers: (tables) => {
        for (const t of tables) engineRef.current?.tableChanged(t);
        bump();
      },
      onError: (m) => toast.error(`Formulas over tables could not be computed: ${m}`),
    });
    resolverRef.current = resolver;
    engineRef.current = new WorkbookEngine(defs, resolver);
    const meta = args.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      position: t.position,
      version: t.version,
    }));
    tabsRef.current = meta;
    setTabs(meta);
    const configs: Record<string, TableConfig> = {};
    for (const t of args.tabs) {
      if (t.kind === "table" && t.table_config)
        configs[t.id] = t.table_config as unknown as TableConfig;
    }
    tableConfigsRef.current = configs;
    setTableConfigs(configs);
    setActiveTabId((cur) => (cur && meta.some((m) => m.id === cur) ? cur : (meta[0]?.id ?? null)));
    undoStack.current = [];
    redoStack.current = [];
    dirty.current.clear();
    setSaveState({});
    hydrated.current = true;
    bump();
  }, [args.tabs, args.workbookId, bump]);

  const setTabsBoth = useCallback((next: TabMeta[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  // ── Saving ───────────────────────────────────────────────────────────────

  const saveTab = useCallback(
    async (tabId: string, force = false) => {
      const engine = engineRef.current;
      const token = tokenRef.current;
      if (!engine || !token || !hydrated.current) return;
      if (inFlight.current.has(tabId)) {
        // Another save is running; try again once it has landed.
        schedule(tabId);
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const tableConfig = tab.kind === "table" ? tableConfigsRef.current[tabId] : undefined;
      const grid = tab.kind === "grid" ? engine.snapshot(tabId) : undefined;
      if (!grid && !tableConfig) return;
      const cells = grid ? Object.keys(grid.cells).length : 0;
      if (grid && args.limits && cells > args.limits.maxCells) {
        setSaveState((s) => ({
          ...s,
          [tabId]: {
            kind: "error",
            message: `${cells.toLocaleString()} cells is over this instance's limit of ${args.limits!.maxCells.toLocaleString()} for a grid sheet. Nothing past it is saved.`,
          },
        }));
        return;
      }
      dirty.current.delete(tabId);
      inFlight.current.add(tabId);
      setSaveState((s) => ({ ...s, [tabId]: { kind: "saving" } }));
      try {
        const base = force
          ? ((saveState[tabId] as { serverVersion?: number } | undefined)?.serverVersion ??
            tab.version)
          : tab.version;
        const r = tableConfig
          ? await saveTableFn({
              data: { access_token: token, tab_id: tabId, base_version: base, config: tableConfig },
            })
          : await saveFn({
              data: { access_token: token, tab_id: tabId, base_version: base, grid: grid! },
            });
        if (r.ok) {
          // The server now reads this table's new formulas; grid answers from
          // before the save may have used the old ones.
          if (tableConfig) {
            resolverRef.current?.invalidate(tab.name);
            engine.tableChanged(tab.name);
            bump();
          }
          setTabsBoth(
            tabsRef.current.map((t) => (t.id === tabId ? { ...t, version: r.version } : t)),
          );
          setSaveState((s) => ({
            ...s,
            [tabId]: dirty.current.has(tabId)
              ? { kind: "pending" }
              : { kind: "saved", at: Date.now() },
          }));
        } else if ("conflict" in r && r.conflict) {
          dirty.current.add(tabId);
          setSaveState((s) => ({
            ...s,
            [tabId]: { kind: "conflict", message: r.error, serverVersion: r.version },
          }));
        } else {
          dirty.current.add(tabId);
          setSaveState((s) => ({ ...s, [tabId]: { kind: "error", message: r.error } }));
        }
      } catch (e) {
        dirty.current.add(tabId);
        setSaveState((s) => ({
          ...s,
          [tabId]: { kind: "error", message: `Not saved: ${(e as Error).message}` },
        }));
      } finally {
        inFlight.current.delete(tabId);
      }
    },
    [saveFn, saveTableFn, args.limits, setTabsBoth, saveState, bump],
  );

  const saveTabRef = useRef(saveTab);
  saveTabRef.current = saveTab;

  function schedule(tabId: string) {
    const prev = timers.current.get(tabId);
    if (prev) clearTimeout(prev);
    timers.current.set(
      tabId,
      setTimeout(() => {
        timers.current.delete(tabId);
        void saveTabRef.current(tabId);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  const markDirty = useCallback((tabId: string) => {
    if (!hydrated.current) return;
    dirty.current.add(tabId);
    setSaveState((s) => {
      // A conflict is not cleared by more typing; the person must choose.
      if (s[tabId]?.kind === "conflict") return s;
      return { ...s, [tabId]: { kind: "pending" } };
    });
    const cur = saveStateRef.current[tabId];
    if (cur?.kind !== "conflict") schedule(tabId);
  }, []);

  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty.current.size || inFlight.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  /**
   * Throw away this sheet's local changes and read the saved version (the
   * "Reload theirs" answer to a conflict). Other sheets keep their edits.
   * Returns an error message, or null once the sheet shows the saved cells.
   */
  const reloadTab = useCallback(
    async (tabId: string): Promise<string | null> => {
      const engine = engineRef.current;
      const token = tokenRef.current;
      if (!engine || !token) return "The workbook is not open";
      let r;
      try {
        r = await getFn({ data: { access_token: token, id: args.workbookId } });
      } catch (e) {
        return `Could not read the saved sheet: ${(e as Error).message}`;
      }
      if (!r.ok) return `Could not read the saved sheet: ${r.error}`;
      const row = r.tabs.find((t) => t.id === tabId);
      if (!row) return "This sheet was deleted elsewhere";
      const t = timers.current.get(tabId);
      if (t) clearTimeout(t);
      timers.current.delete(tabId);
      dirty.current.delete(tabId);
      if (row.kind === "table" && row.table_config) {
        const cfg = row.table_config as unknown as TableConfig;
        tableConfigsRef.current = { ...tableConfigsRef.current, [tabId]: cfg };
        setTableConfigs(tableConfigsRef.current);
      } else {
        engine.replaceGrid(tabId, toGridData(row.grid));
      }
      engine.recalcAll();
      setTabsBoth(
        tabsRef.current.map((x) => (x.id === tabId ? { ...x, version: row.version } : x)),
      );
      // Undo steps for this sheet describe cells that are no longer there.
      const touches = (e: UndoEntry) =>
        e.tabId === tabId || (e.kind === "snapshot" && tabId in e.before);
      undoStack.current = undoStack.current.filter((e) => !touches(e));
      redoStack.current = redoStack.current.filter((e) => !touches(e));
      setSaveState((s) => ({ ...s, [tabId]: { kind: "saved", at: Date.now() } }));
      bump();
      return null;
    },
    [getFn, args.workbookId, setTabsBoth, bump],
  );

  /** Save everything pending now (leaving the page, Ctrl+S). */
  const flush = useCallback(async () => {
    for (const [id, t] of timers.current) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    await Promise.all([...dirty.current].map((id) => saveTabRef.current(id)));
  }, []);

  // ── Editing ──────────────────────────────────────────────────────────────

  const applyEdits = useCallback(
    (tabId: string, edits: CellEdit[], opts: { record?: boolean } = {}) => {
      const engine = engineRef.current;
      if (!engine || !edits.length) return;
      const before = edits.map((e) => ({
        row: e.row,
        col: e.col,
        cell: engine.getInput(tabId, e.row, e.col),
      }));
      engine.setInputs(tabId, edits);
      const after = edits.map((e) => ({
        row: e.row,
        col: e.col,
        cell: engine.getInput(tabId, e.row, e.col),
      }));
      if (opts.record !== false) {
        undoStack.current.push({ tabId, before, after });
        if (undoStack.current.length > 500) undoStack.current.shift();
        redoStack.current = [];
      }
      markDirty(tabId);
      bump();
    },
    [bump, markDirty],
  );

  const restore = (entry: UndoEntry, which: "before" | "after") => {
    const engine = engineRef.current;
    if (!engine) return;
    if (entry.kind === "snapshot") {
      const grids = entry[which];
      for (const [id, g] of Object.entries(grids)) engine.replaceGrid(id, g);
      engine.recalcAll();
      for (const id of Object.keys(grids)) markDirty(id);
      setActiveTabId(entry.tabId);
      bump();
      return;
    }
    if (entry.kind === "meta") {
      engine.setGridMeta(entry.tabId, entry[which]);
      setActiveTabId(entry.tabId);
      markDirty(entry.tabId);
      bump();
      return;
    }
    const cells = entry[which];
    engine.setInputs(
      entry.tabId,
      cells.map((c) => ({
        row: c.row,
        col: c.col,
        input: c.cell?.i ?? "",
        format: c.cell?.f ?? null,
        style: c.cell?.s ?? null,
        link: c.cell?.l ?? null,
      })),
    );
    setActiveTabId(entry.tabId);
    markDirty(entry.tabId);
    bump();
  };

  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    if (!e) return false;
    restore(e, "before");
    redoStack.current.push(e);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redo = useCallback(() => {
    const e = redoStack.current.pop();
    if (!e) return false;
    restore(e, "after");
    undoStack.current.push(e);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A structural change (insert/delete rows or columns) across the workbook, undoable. */
  const structural = useCallback(
    (tabId: string, mutate: (engine: WorkbookEngine) => void) => {
      const engine = engineRef.current;
      if (!engine) return;
      const snap = () => {
        const out: Record<string, GridData> = {};
        for (const s of engine.listSheets()) {
          const g = engine.snapshot(s.id);
          if (g) out[s.id] = JSON.parse(JSON.stringify(g)) as GridData;
        }
        return out;
      };
      const before = snap();
      mutate(engine);
      engine.recalcAll();
      const after = snap();
      undoStack.current.push({ kind: "snapshot", tabId, before, after });
      if (undoStack.current.length > 500) undoStack.current.shift();
      redoStack.current = [];
      for (const id of Object.keys(after)) {
        if (JSON.stringify(after[id]) !== JSON.stringify(before[id])) markDirty(id);
      }
      bump();
    },
    [bump, markDirty],
  );

  /**
   * Change sheet settings (widths, heights, merges, hidden rows, gridlines),
   * undoably. Steps sharing a `gesture` within a second (a drag) undo as one.
   */
  const setGridMeta = useCallback(
    (tabId: string, patch: GridMeta, opts: { gesture?: string } = {}) => {
      const engine = engineRef.current;
      if (!engine) return;
      const grid = engine.gridOf(tabId);
      if (!grid) return;
      const before: GridMeta = {};
      for (const k of Object.keys(patch) as (keyof GridMeta)[]) {
        (before as Record<string, unknown>)[k] = structuredClone(grid[k]);
      }
      engine.setGridMeta(tabId, patch);
      const top = undoStack.current[undoStack.current.length - 1];
      const now = Date.now();
      if (
        opts.gesture &&
        top?.kind === "meta" &&
        top.tabId === tabId &&
        top.gesture === opts.gesture &&
        now - top.at < 1000
      ) {
        top.after = { ...top.after, ...patch };
        top.at = now;
      } else {
        undoStack.current.push({
          kind: "meta",
          tabId,
          before,
          after: structuredClone(patch),
          gesture: opts.gesture,
          at: now,
        });
        if (undoStack.current.length > 500) undoStack.current.shift();
      }
      redoStack.current = [];
      markDirty(tabId);
      bump();
    },
    [bump, markDirty],
  );

  /**
   * A change to one sheet's cells and settings together (merging clears the
   * cells it covers), undone as one step.
   */
  const changeGrid = useCallback(
    (tabId: string, mutate: (grid: GridData) => GridData) => {
      const engine = engineRef.current;
      const cur = engine?.snapshot(tabId);
      if (!engine || !cur) return;
      const before = structuredClone(cur);
      const after = mutate(structuredClone(cur));
      engine.replaceGrid(tabId, after);
      engine.recalcAll();
      undoStack.current.push({
        kind: "snapshot",
        tabId,
        before: { [tabId]: before },
        after: { [tabId]: structuredClone(after) },
      });
      if (undoStack.current.length > 500) undoStack.current.shift();
      redoStack.current = [];
      markDirty(tabId);
      bump();
    },
    [bump, markDirty],
  );

  /** Change a table sheet's settings; they autosave like cells do. */
  const setTableConfig = useCallback(
    (tabId: string, next: TableConfig, opts: { save?: boolean } = {}) => {
      const prev = tableConfigsRef.current[tabId];
      tableConfigsRef.current = { ...tableConfigsRef.current, [tabId]: next };
      setTableConfigs(tableConfigsRef.current);
      if (opts.save !== false) markDirty(tabId);
      const shape = (c?: TableConfig) =>
        c ? JSON.stringify([c.source, c.columns, c.calculated]) : "";
      if (shape(prev) !== shape(next)) tableDataChanged(tabId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markDirty],
  );

  /** A table's rows or formulas changed: grid formulas that read it ask again. */
  const tableDataChanged = (tabId: string) => {
    const name = tabsRef.current.find((t) => t.id === tabId)?.name;
    if (!name) return;
    resolverRef.current?.invalidate(name);
    engineRef.current?.tableChanged(name);
    bump();
  };

  /** Ask every table formula again (F9): the lakehouse may hold new rows. */
  const recalculate = useCallback(() => {
    resolverRef.current?.invalidate();
    const engine = engineRef.current;
    if (!engine) return;
    for (const t of tabsRef.current) if (t.kind === "table") engine.tableChanged(t.name);
    engine.recalcVolatile();
    bump();
  }, [bump]);

  /** A table sheet the server changed (a pivot's new definition): take its settings and version. */
  const applyServerTab = useCallback(
    (row: SheetTabRow) => {
      if (row.kind !== "table" || !row.table_config) return;
      tableConfigsRef.current = {
        ...tableConfigsRef.current,
        [row.id]: row.table_config as unknown as TableConfig,
      };
      setTableConfigs(tableConfigsRef.current);
      setTabsBoth(
        tabsRef.current.map((t) => (t.id === row.id ? { ...t, version: row.version } : t)),
      );
      resolverRef.current?.invalidate(row.name);
      engineRef.current?.tableChanged(row.name);
      bump();
    },
    [bump, setTabsBoth],
  );

  // ── Sheets ───────────────────────────────────────────────────────────────

  const addTabLocal = useCallback(
    (row: SheetTabRow) => {
      engineRef.current?.addSheet({
        id: row.id,
        name: row.name,
        kind: row.kind,
        grid: row.kind === "grid" ? toGridData(row.grid) : undefined,
      });
      if (row.kind === "table" && row.table_config) {
        tableConfigsRef.current = {
          ...tableConfigsRef.current,
          [row.id]: row.table_config as unknown as TableConfig,
        };
        setTableConfigs(tableConfigsRef.current);
      }
      setTabsBoth([
        ...tabsRef.current,
        {
          id: row.id,
          name: row.name,
          kind: row.kind,
          position: row.position,
          version: row.version,
        },
      ]);
      setActiveTabId(row.id);
      bump();
    },
    [bump, setTabsBoth],
  );

  /**
   * A sheet was renamed on the server: rename it in the engine and rewrite
   * every formula that referred to it (Excel does the same), then save the
   * sheets whose formulas changed.
   */
  const renameTabLocal = useCallback(
    (tabId: string, oldName: string, newName: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const isTable = tabsRef.current.find((t) => t.id === tabId)?.kind === "table";
      const rewrite = (f: string) =>
        isTable
          ? renameTableInFormula(f, oldName, newName)
          : renameSheetInFormula(f, oldName, newName);
      if (isTable) {
        // Other tables' calculated columns may look this one up (Customers[id]).
        for (const [id, cfg] of Object.entries(tableConfigsRef.current)) {
          if (id === tabId) continue;
          const calculated = cfg.calculated.map((c) => ({ ...c, formula: rewrite(c.formula) }));
          if (calculated.some((c, i) => c.formula !== cfg.calculated[i].formula)) {
            tableConfigsRef.current = { ...tableConfigsRef.current, [id]: { ...cfg, calculated } };
            markDirty(id);
          }
        }
        setTableConfigs(tableConfigsRef.current);
        resolverRef.current?.invalidate();
      }
      for (const s of engine.listSheets()) {
        if (!s.grid) continue;
        const edits: CellEdit[] = [];
        for (const [key, cell] of Object.entries(s.grid.cells)) {
          if (!cell.i.startsWith("=")) continue;
          const next = rewrite(cell.i);
          if (next !== cell.i) {
            const [r, c] = key.split(",").map(Number);
            edits.push({ row: r, col: c, input: next });
          }
        }
        if (edits.length) {
          engine.setInputs(s.id, edits);
          markDirty(s.id);
        }
      }
      engine.renameSheet(tabId, newName);
      setTabsBoth(tabsRef.current.map((t) => (t.id === tabId ? { ...t, name: newName } : t)));
      bump();
    },
    [bump, markDirty, setTabsBoth],
  );

  const removeTabLocal = useCallback(
    (tabId: string) => {
      const removed = tabsRef.current.find((x) => x.id === tabId);
      if (removed?.kind === "table") resolverRef.current?.invalidate(removed.name);
      engineRef.current?.removeSheet(tabId);
      dirty.current.delete(tabId);
      const t = timers.current.get(tabId);
      if (t) clearTimeout(t);
      const next = tabsRef.current.filter((x) => x.id !== tabId);
      setTabsBoth(next);
      setActiveTabId((cur) => (cur === tabId ? (next[0]?.id ?? null) : cur));
      undoStack.current = undoStack.current.filter((e) => e.tabId !== tabId);
      redoStack.current = redoStack.current.filter((e) => e.tabId !== tabId);
      bump();
    },
    [bump, setTabsBoth],
  );

  const reorderLocal = useCallback(
    (order: string[]) => {
      const byId = new Map(tabsRef.current.map((t) => [t.id, t]));
      setTabsBoth(order.map((id, i) => ({ ...byId.get(id)!, position: i })));
    },
    [setTabsBoth],
  );

  const anyDirty = useMemo(
    () => Object.values(saveState).some((s) => s.kind !== "saved"),
    [saveState],
  );

  return {
    engine: engineRef.current,
    rev,
    bump,
    tabs,
    activeTabId,
    setActiveTabId,
    saveState,
    anyDirty,
    applyEdits,
    structural,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    setGridMeta,
    changeGrid,
    flush,
    saveTab,
    reloadTab,
    tableConfigs,
    setTableConfig,
    limits: args.limits,
    workbookId: args.workbookId,
    recalculate,
    tableDataChanged,
    applyServerTab,
    addTabLocal,
    renameTabLocal,
    removeTabLocal,
    reorderLocal,
    markDirty,
  };
}
