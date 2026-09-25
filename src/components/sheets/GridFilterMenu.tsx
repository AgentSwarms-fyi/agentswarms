// The button on a filtered range's header cell, as Excel's: sort the range
// by this column, tick the values to keep (search among them), or keep the
// rows meeting a condition. Applying hides the other rows; Clear shows them.

import { useMemo, useState } from "react";
import { ArrowDownAZ, ArrowUpAZ, ChevronDown, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ColumnFilter, FilterCond } from "@/lib/sheets/filter";
import { cn } from "@/lib/utils";

const CONDS: { op: FilterCond["op"]; label: string; needs: 0 | 1 | 2 }[] = [
  { op: "eq", label: "Equals", needs: 1 },
  { op: "ne", label: "Does not equal", needs: 1 },
  { op: "gt", label: "Greater than", needs: 1 },
  { op: "ge", label: "Greater than or equal to", needs: 1 },
  { op: "lt", label: "Less than", needs: 1 },
  { op: "le", label: "Less than or equal to", needs: 1 },
  { op: "between", label: "Between", needs: 2 },
  { op: "top", label: "Top N", needs: 1 },
  { op: "bottom", label: "Bottom N", needs: 1 },
  { op: "aboveAverage", label: "Above average", needs: 0 },
  { op: "belowAverage", label: "Below average", needs: 0 },
  { op: "contains", label: "Contains", needs: 1 },
  { op: "notContains", label: "Does not contain", needs: 1 },
  { op: "begins", label: "Begins with", needs: 1 },
  { op: "ends", label: "Ends with", needs: 1 },
  { op: "blank", label: "Is blank", needs: 0 },
  { op: "notBlank", label: "Is not blank", needs: 0 },
];

export function GridFilterMenu({
  header,
  getValues,
  current,
  onSort,
  onApply,
  onDone,
  style,
}: {
  header: string;
  /** The column's distinct values, read when the menu opens (not on every render). */
  getValues: () => { text: string; count: number }[];
  current: ColumnFilter | undefined;
  onSort: (desc: boolean) => void;
  onApply: (f: ColumnFilter | null) => void;
  onDone: () => void;
  style: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<{ text: string; count: number }[]>([]);
  const [mode, setMode] = useState<"values" | "cond">(current?.cond ? "cond" : "values");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [op, setOp] = useState<FilterCond["op"]>(current?.cond?.op ?? "gt");
  const [a, setA] = useState(current?.cond?.a ?? "");
  const [b, setB] = useState(current?.cond?.b ?? "");
  const shown = useMemo(
    () => values.filter((v) => (v.text || "(Blanks)").toLowerCase().includes(search.toLowerCase())),
    [values, search],
  );
  const active = !!current && (!!current.cond || !!current.values);
  const needs = CONDS.find((c) => c.op === op)?.needs ?? 1;
  const allShownPicked = shown.every((v) => picked.has(v.text));

  const apply = () => {
    if (mode === "values") {
      onApply(
        picked.size === values.length
          ? null
          : { values: values.map((v) => v.text).filter((t) => picked.has(t)) },
      );
    } else {
      onApply({ cond: { op, ...(needs >= 1 ? { a } : {}), ...(needs === 2 ? { b } : {}) } });
    }
    close();
  };

  const close = () => {
    setOpen(false);
    onDone();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          const vals = getValues();
          setValues(vals);
          setPicked(new Set(current?.values ?? vals.map((v) => v.text)));
          setMode(current?.cond ? "cond" : "values");
          setSearch("");
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "absolute z-20 flex h-4 w-4 items-center justify-center rounded-sm border border-border bg-background shadow-sm hover:bg-muted",
            active && "border-primary text-primary",
          )}
          style={style}
          aria-label={`Filter ${header}`}
          title={active ? `Filtered: ${header}` : `Filter or sort by ${header}`}
          data-testid="grid-filter-button"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {active ? <Filter className="h-2.5 w-2.5" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        align="start"
        data-testid="grid-filter-menu"
        onMouseDown={(e) => e.stopPropagation()}
        // Enter in the search or a condition's box applies, as Excel's OK does.
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            e.target instanceof HTMLInputElement &&
            e.target.type !== "checkbox"
          ) {
            e.preventDefault();
            apply();
          }
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onDone();
        }}
      >
        <div className="flex flex-col gap-1 border-b border-border pb-2">
          <button
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
            onClick={() => {
              onSort(false);
              close();
            }}
          >
            <ArrowDownAZ className="h-4 w-4" /> Sort A to Z
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
            onClick={() => {
              onSort(true);
              close();
            }}
          >
            <ArrowUpAZ className="h-4 w-4" /> Sort Z to A
          </button>
        </div>
        <div className="mt-2 flex gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "values"}
            className={cn(
              "rounded px-2 py-0.5 text-xs",
              mode === "values" ? "bg-muted font-medium" : "text-muted-foreground",
            )}
            onClick={() => setMode("values")}
          >
            By value
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "cond"}
            className={cn(
              "rounded px-2 py-0.5 text-xs",
              mode === "cond" ? "bg-muted font-medium" : "text-muted-foreground",
            )}
            onClick={() => setMode("cond")}
          >
            By condition
          </button>
        </div>
        {mode === "values" ? (
          <div className="mt-2 space-y-1">
            <Input
              placeholder="Search"
              className="h-8 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search values"
            />
            <label className="flex items-center gap-2 px-1 text-sm">
              <input
                type="checkbox"
                checked={allShownPicked}
                onChange={() => {
                  const next = new Set(picked);
                  for (const v of shown) {
                    if (allShownPicked) next.delete(v.text);
                    else next.add(v.text);
                  }
                  setPicked(next);
                }}
              />
              (Select all{search ? " shown" : ""})
            </label>
            <ul
              className="max-h-48 overflow-y-auto rounded border border-border p-1"
              data-testid="grid-filter-values"
            >
              {shown.map((v) => (
                <li key={v.text}>
                  <label className="flex items-center gap-2 px-1 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.has(v.text)}
                      onChange={() => {
                        const next = new Set(picked);
                        if (next.has(v.text)) next.delete(v.text);
                        else next.add(v.text);
                        setPicked(next);
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">{v.text || "(Blanks)"}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{v.count}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <select
              aria-label="Condition"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={op}
              onChange={(e) => setOp(e.target.value as FilterCond["op"])}
            >
              {CONDS.map((c) => (
                <option key={c.op} value={c.op}>
                  {c.label}
                </option>
              ))}
            </select>
            {needs >= 1 && (
              <Input
                aria-label="Value"
                className="h-8 text-sm"
                value={a}
                onChange={(e) => setA(e.target.value)}
                placeholder={op === "top" || op === "bottom" ? "10" : "Value"}
              />
            )}
            {needs === 2 && (
              <Input
                aria-label="And"
                className="h-8 text-sm"
                value={b}
                onChange={(e) => setB(e.target.value)}
                placeholder="and"
              />
            )}
          </div>
        )}
        <div className="mt-2 flex justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={!active}
            onClick={() => {
              onApply(null);
              close();
            }}
          >
            Clear filter
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={apply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
