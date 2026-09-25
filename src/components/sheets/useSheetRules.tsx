// Conditional formatting, data validation and the grid filter, for the
// editor: what the grid draws per cell, which rows the filter hides, the
// check a typed value passes before it is kept, the ribbon's menus, and the
// buttons and boxes drawn over the grid (filter arrows, a list's dropdown, a
// cell's input message).

import { useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  Filter,
  FilterX,
  ListChecks,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseRangeA1, rangeA1, type RangeAddr } from "@/lib/sheets/a1";
import { cellView } from "@/lib/sheets/cellView";
import { CondFormatter, type CfRule, type CondFormat } from "@/lib/sheets/condFormat";
import type { GridData, WorkbookEngine } from "@/lib/sheets/engine";
import {
  columnValues,
  currentRegion,
  filteredRows,
  sortEdits,
  type AutoFilter,
  type ColumnFilter,
} from "@/lib/sheets/filter";
import { isMatrix, todaySerial, type Scalar } from "@/lib/sheets/formula/values";
import {
  checkValidation,
  listItems,
  validationAt,
  type DvEnv,
  type Validation,
} from "@/lib/sheets/validation";
import {
  CondFormatMenu,
  CondRuleDialog,
  ManageRulesDialog,
  type RuleDraft,
} from "./CondFormatMenu";
import { GridFilterMenu } from "./GridFilterMenu";
import type { GridGeometry } from "./SheetGrid";
import type { useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;
import { DvAlertDialog, ValidationDialog } from "./ValidationDialog";

const newId = () => Math.random().toString(36).slice(2, 10);

/** A range with another taken out of it: up to four rectangles (none when covered). */
export function subtractRange(r: RangeAddr, cut: RangeAddr): RangeAddr[] {
  if (cut.r1 < r.r0 || cut.r0 > r.r1 || cut.c1 < r.c0 || cut.c0 > r.c1) return [r];
  const out: RangeAddr[] = [];
  if (cut.r0 > r.r0) out.push({ ...r, r1: cut.r0 - 1 });
  if (cut.r1 < r.r1) out.push({ ...r, r0: cut.r1 + 1 });
  const r0 = Math.max(r.r0, cut.r0);
  const r1 = Math.min(r.r1, cut.r1);
  if (cut.c0 > r.c0) out.push({ r0, r1, c0: r.c0, c1: cut.c0 - 1 });
  if (cut.c1 < r.c1) out.push({ r0, r1, c0: cut.c1 + 1, c1: r.c1 });
  return out;
}

/** Rules with the selection taken out of their ranges; a rule left with none goes. */
export function withoutRange<T extends { ranges: string[] }>(
  list: readonly T[],
  cut: RangeAddr,
): T[] {
  return list
    .map((x) => ({
      ...x,
      ranges: x.ranges.flatMap((a) => {
        const r = parseRangeA1(a.replace(/\$/g, ""));
        return r ? subtractRange(r, cut).map(rangeA1) : [];
      }),
    }))
    .filter((x) => x.ranges.length > 0);
}

type Pending = {
  validation: Validation;
  message: string;
  /** Keep the typed value anyway (Warning's Yes, Information's OK). */
  keep: () => void;
  /** Go back to the edit (Stop's Retry, Warning's No). */
  retry: () => void;
  /** Drop the edit. */
  cancel: () => void;
};

export function useSheetRules({
  wb,
  engine,
  tabId,
  grid,
  rev,
  range,
  focus,
  editing,
  onDone,
}: {
  wb: Workbook;
  engine: WorkbookEngine | null;
  tabId: string | null;
  grid: GridData | undefined;
  rev: number;
  range: RangeAddr;
  focus: { row: number; col: number };
  editing: boolean;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [managing, setManaging] = useState(false);
  const [validating, setValidating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // ── Conditional formatting ──────────────────────────────────────────────
  const formatter = useMemo(() => {
    if (!engine || !tabId || !grid?.cond?.length) return null;
    const today = todaySerial();
    return new CondFormatter(grid.cond, {
      value: (r, c) => engine.getValue(tabId, r, c),
      evaluate: (f, r, c) => {
        const v = engine.evaluateAt(tabId, r, c, f);
        return (isMatrix(v) ? (v[0]?.[0] ?? null) : v) as Scalar;
      },
      today,
    });
    // A new formatter per recalculation: rules read values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tabId, grid?.cond, rev]);

  const decorate = formatter ? (r: number, c: number) => formatter.at(r, c) : undefined;

  const setCond = (cond: CondFormat[]) => {
    if (!tabId) return;
    wb.setGridMeta(tabId, { cond: cond.length ? cond : undefined });
  };
  /** A new rule goes first (highest priority), as in Excel. */
  const addRule = (rule: CfRule) => {
    setCond([{ id: newId(), ranges: [rangeA1(range)], rule }, ...(grid?.cond ?? [])]);
    toast.success(`Rule added to ${rangeA1(range)}`);
  };

  // ── Data validation ─────────────────────────────────────────────────────
  const dvEnv: DvEnv | null =
    engine && tabId
      ? {
          evaluate: (f, r, c, self) => {
            const v = engine.evaluateAt(tabId, r, c, f, self === undefined ? {} : { self });
            return (isMatrix(v) ? (v[0]?.[0] ?? null) : v) as Scalar;
          },
          rangeValues: (ref, r, c) => {
            const v = engine.evaluateAt(tabId, r, c, ref.startsWith("=") ? ref : `=${ref}`, {
              array: true,
            });
            return (isMatrix(v) ? v.flat() : [v]) as Scalar[];
          },
        }
      : null;

  const activeRule = validationAt(grid?.validations, focus.row, focus.col);

  /**
   * Before a typed value is kept: true to go ahead; false when an alert is
   * up and will finish (or drop) the edit itself.
   */
  const checkEdit = (
    row: number,
    col: number,
    text: string,
    then: { keep: () => void; retry: () => void; cancel: () => void },
  ): boolean => {
    const v = validationAt(grid?.validations, row, col);
    if (!v || !dvEnv) return true;
    const res = checkValidation(v, text, dvEnv, row, col);
    if (res.ok) return true;
    setPending({ validation: v, message: res.message, ...then });
    return false;
  };

  const applyValidation = (v: Omit<Validation, "id" | "ranges">) => {
    if (!tabId) return;
    const rest = withoutRange(grid?.validations ?? [], range);
    wb.setGridMeta(tabId, {
      validations: [...rest, { id: newId(), ranges: [rangeA1(range)], ...v }],
    });
    setValidating(false);
    toast.success(`Validation set on ${rangeA1(range)}`);
    onDone();
  };
  const clearValidation = () => {
    if (!tabId) return;
    const rest = withoutRange(grid?.validations ?? [], range);
    wb.setGridMeta(tabId, { validations: rest.length ? rest : undefined });
    setValidating(false);
    toast.success(`Validation cleared from ${rangeA1(range)}`);
    onDone();
  };

  const pickFromList = (item: string) => {
    if (!tabId) return;
    const cur = engine?.getInput(tabId, focus.row, focus.col);
    wb.applyEdits(tabId, [{ row: focus.row, col: focus.col, input: item, format: cur?.f ?? null }]);
    setListOpen(false);
    onDone();
  };

  // ── The filter ──────────────────────────────────────────────────────────
  const filter = grid?.filter;
  const filterRange = filter ? parseRangeA1(filter.range) : null;
  const shownText = (r: number, c: number) => {
    if (!engine || !tabId) return "";
    const v = engine.getValue(tabId, r, c);
    return cellView(v, engine.getInput(tabId, r, c)).text;
  };
  const filterEnv =
    engine && tabId
      ? { value: (r: number, c: number) => engine.getValue(tabId, r, c), text: shownText }
      : null;

  const setFilter = (f: AutoFilter | undefined) => {
    if (!tabId) return;
    wb.setGridMeta(tabId, { filter: f });
  };
  /** Data > Filter: on over the data around the selection, or off (every row shows again). */
  const toggleFilter = () => {
    if (!engine || !tabId) return;
    if (filter) {
      setFilter(undefined);
      toast.success("Filter removed");
      onDone();
      return;
    }
    const single = range.r0 === range.r1 && range.c0 === range.c1;
    const region = single
      ? currentRegion(range.r0, range.c0, (r, c) => engine.getValue(tabId, r, c) !== null)
      : range;
    if (region.r1 <= region.r0) {
      toast.error("Select a cell in a table of data (a header row and rows under it) first.");
      onDone();
      return;
    }
    setFilter({ range: rangeA1(region), cols: {} });
    toast.success(`Filter on ${rangeA1(region)}`);
    onDone();
  };
  const applyColumn = (offset: number, cf: ColumnFilter | null) => {
    if (!filter || !filterEnv) return;
    const cols = { ...filter.cols };
    if (cf) cols[String(offset)] = cf;
    else delete cols[String(offset)];
    const next = { ...filter, cols };
    const hidden = filteredRows(next, filterEnv);
    setFilter({ ...next, ...(hidden.length ? { hidden } : { hidden: undefined }) });
  };
  const reapply = () => {
    if (!filter || !filterEnv) return;
    const hidden = filteredRows(filter, filterEnv);
    setFilter({ ...filter, hidden: hidden.length ? hidden : undefined });
    onDone();
  };
  const clearFilters = () => {
    if (!filter) return;
    setFilter({ range: filter.range, cols: {} });
    onDone();
  };

  /** Sort a block's rows by one column, header row kept; formulas move with their rows. */
  const sortBlock = (block: RangeAddr, col: number, desc: boolean, header: boolean) => {
    if (!engine || !tabId) return;
    const edits = sortEdits(
      block,
      [{ col, desc }],
      {
        value: (r, c) => engine.getValue(tabId, r, c),
        input: (r, c) => engine.getInput(tabId, r, c),
      },
      header,
    );
    wb.changeGrid(tabId, (g) => {
      for (const e of edits) {
        const key = `${e.row},${e.col}`;
        if (!e.input && !e.format && !e.style && !e.link) delete g.cells[key];
        else
          g.cells[key] = {
            i: e.input,
            ...(e.format ? { f: e.format } : {}),
            ...(e.style ? { s: e.style } : {}),
            ...(e.link ? { l: e.link } : {}),
          };
      }
      return g;
    });
  };
  const sortFiltered = (offset: number, desc: boolean) => {
    if (!filterRange || !filter) return;
    sortBlock(filterRange, filterRange.c0 + offset, desc, true);
    // The filter's criteria hold for the rows' new places.
    requestAnimationFrame(() => {
      const f = engine?.gridOf(tabId ?? "")?.filter;
      if (!f || !filterEnv) return;
      const hidden = filteredRows(f, filterEnv);
      wb.setGridMeta(tabId!, { filter: { ...f, hidden: hidden.length ? hidden : undefined } });
    });
  };
  /** Data > Sort: the data around the active cell by its column (a text header row stays on top). */
  const sortByActive = (desc: boolean) => {
    if (!engine || !tabId) return;
    if (
      filterRange &&
      focus.row >= filterRange.r0 &&
      focus.row <= filterRange.r1 &&
      focus.col >= filterRange.c0 &&
      focus.col <= filterRange.c1
    ) {
      sortFiltered(focus.col - filterRange.c0, desc);
      onDone();
      return;
    }
    const single = range.r0 === range.r1 && range.c0 === range.c1;
    const block = single
      ? currentRegion(range.r0, range.c0, (r, c) => engine.getValue(tabId, r, c) !== null)
      : range;
    if (block.r1 <= block.r0) {
      toast.error("Select a cell in a table of data first.");
      onDone();
      return;
    }
    // A header row is one of text over a column that is not all text.
    let header = true;
    for (let c = block.c0; c <= block.c1; c++) {
      const v = engine.getValue(tabId, block.r0, c);
      if (typeof v !== "string" || !v.trim()) header = false;
    }
    sortBlock(block, focus.col, desc, header);
    toast.success(
      `Sorted ${rangeA1(block)} by column ${rangeA1({ r0: 0, r1: 0, c0: focus.col, c1: focus.col }).replace(/\d+/, "")}${desc ? ", largest first" : ""}`,
    );
    onDone();
  };

  const filterHidden = filter?.hidden;

  // ── What the ribbon adds ─────────────────────────────────────────────────
  const tool = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    testId: string,
    on = false,
  ) => (
    <Button
      size="sm"
      variant={on ? "secondary" : "ghost"}
      className="h-7 gap-1 px-2 text-xs"
      title={label}
      aria-pressed={on || undefined}
      data-testid={testId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon} {label}
    </Button>
  );
  const ribbon = {
    home: (
      <CondFormatMenu
        onAdd={addRule}
        onDraft={setDraft}
        onClearSelection={() => {
          setCond(withoutRange(grid?.cond ?? [], range));
          toast.success(`Rules cleared from ${rangeA1(range)}`);
        }}
        onClearSheet={() => {
          setCond([]);
          toast.success("Every rule on this sheet cleared");
        }}
        onManage={() => setManaging(true)}
        onDone={onDone}
      />
    ),
    data: (
      <>
        {tool(
          "Sort A to Z",
          <ArrowDownAZ className="h-4 w-4" />,
          () => sortByActive(false),
          "tool-sort-asc",
        )}
        {tool(
          "Sort Z to A",
          <ArrowUpAZ className="h-4 w-4" />,
          () => sortByActive(true),
          "tool-sort-desc",
        )}
        {tool("Filter", <Filter className="h-4 w-4" />, toggleFilter, "tool-filter", !!filter)}
        {filter &&
          tool("Clear", <FilterX className="h-4 w-4" />, clearFilters, "tool-filter-clear")}
        {filter &&
          tool("Reapply", <RotateCw className="h-4 w-4" />, reapply, "tool-filter-reapply")}
        {tool(
          "Data validation…",
          <ListChecks className="h-4 w-4" />,
          () => setValidating(true),
          "tool-validation",
        )}
      </>
    ),
  };

  // ── Drawn over the grid ──────────────────────────────────────────────────
  const overlay = (geo: GridGeometry) => {
    const nodes: React.ReactNode[] = [];
    if (filterRange && filterEnv) {
      const r0 = filterRange.r0;
      const h = geo.rows.size(r0);
      if (h > 0) {
        for (let c = filterRange.c0; c <= Math.min(filterRange.c1, filterRange.c0 + 200); c++) {
          const w = geo.cols.size(c);
          if (!w) continue;
          const offset = c - filterRange.c0;
          const size = Math.min(16, h - 4);
          nodes.push(
            <GridFilterMenu
              key={`f${c}`}
              header={shownText(r0, c) || `Column ${offset + 1}`}
              getValues={() => columnValues(filter!, offset, filterEnv)}
              current={filter!.cols[String(offset)]}
              onSort={(desc) => sortFiltered(offset, desc)}
              onApply={(cf) => applyColumn(offset, cf)}
              onDone={onDone}
              style={{
                left: geo.cols.end(c) - size - 2,
                top: geo.rows.start(r0) + (h - size) / 2,
                width: size,
                height: size,
              }}
            />,
          );
        }
      }
    }
    // The active cell's list, and its input message.
    if (!editing && activeRule && dvEnv && tabId) {
      const left = geo.cols.start(focus.col);
      const right = geo.cols.end(focus.col);
      const top = geo.rows.start(focus.row);
      const bottom = geo.rows.end(focus.row);
      if (activeRule.rule.kind === "list" && activeRule.rule.dropdown !== false) {
        const items = listOpen ? listItems(activeRule, dvEnv, focus.row, focus.col) : [];
        nodes.push(
          <Popover
            key="dv-list"
            open={listOpen}
            onOpenChange={(o) => {
              setListOpen(o);
              if (!o) onDone();
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="absolute z-30 flex items-center justify-center rounded-sm border border-border bg-background shadow-sm hover:bg-muted"
                style={{
                  left: right + 1,
                  top: top + Math.max(0, (bottom - top - 18) / 2),
                  width: 16,
                  height: 18,
                }}
                aria-label="Choose from the list"
                title="Choose from the list (Alt+Down)"
                data-testid="dv-list-button"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="max-h-64 w-48 overflow-y-auto p-1"
              align="start"
              data-testid="dv-list"
              onMouseDown={(e) => e.stopPropagation()}
              // Up and Down move through the choices, as Excel's list does.
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const opts = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
                const i = opts.indexOf(document.activeElement as HTMLElement);
                const next =
                  e.key === "ArrowDown" ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
                opts[next]?.focus();
              }}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                onDone();
              }}
            >
              {items.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">The list is empty.</p>
              ) : (
                items.map((it) => (
                  <button
                    key={it}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    onClick={() => pickFromList(it)}
                  >
                    {it}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>,
        );
      }
      if (activeRule.prompt?.message) {
        nodes.push(
          <div
            key="dv-prompt"
            role="note"
            className="pointer-events-none absolute z-20 max-w-xs rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-950 shadow-md dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            style={{ left: left + 12, top: bottom + 6 }}
            data-testid="dv-prompt"
          >
            {activeRule.prompt.title && (
              <div className="font-semibold">{activeRule.prompt.title}</div>
            )}
            <div className="whitespace-pre-wrap">{activeRule.prompt.message}</div>
          </div>,
        );
      }
    }
    return nodes.length ? <>{nodes}</> : null;
  };

  // ── Dialogs ─────────────────────────────────────────────────────────────
  const dialogs = (
    <>
      {draft && (
        <CondRuleDialog
          draft={draft}
          range={rangeA1(range)}
          onCancel={() => {
            setDraft(null);
            onDone();
          }}
          onApply={(rule) => {
            addRule(rule);
            setDraft(null);
            onDone();
          }}
        />
      )}
      {managing && (
        <ManageRulesDialog
          rules={grid?.cond ?? []}
          onClose={() => {
            setManaging(false);
            onDone();
          }}
          onChange={(list) => {
            setCond(list);
            setManaging(false);
            toast.success("Rules saved");
            onDone();
          }}
        />
      )}
      {validating && (
        <ValidationDialog
          range={rangeA1(range)}
          current={validationAt(grid?.validations, range.r0, range.c0)}
          onCancel={() => {
            setValidating(false);
            onDone();
          }}
          onApply={applyValidation}
          onClear={clearValidation}
        />
      )}
      {pending && (
        <DvAlertDialog
          style={pending.validation.error?.style ?? "stop"}
          title={pending.validation.error?.title}
          message={pending.message}
          onKeep={() => {
            const p = pending;
            setPending(null);
            p.keep();
          }}
          onRetry={() => {
            const p = pending;
            setPending(null);
            p.retry();
          }}
          onCancel={() => {
            const p = pending;
            setPending(null);
            p.cancel();
          }}
        />
      )}
    </>
  );

  /** Alt+Down on a cell with a list opens it. */
  const openList = () => {
    if (activeRule?.rule.kind === "list" && activeRule.rule.dropdown !== false) {
      setListOpen(true);
      return true;
    }
    return false;
  };

  return {
    decorate,
    filterHidden,
    checkEdit,
    ribbon,
    overlay,
    dialogs,
    toggleFilter,
    openList,
  };
}

export type SheetRules = ReturnType<typeof useSheetRules>;
