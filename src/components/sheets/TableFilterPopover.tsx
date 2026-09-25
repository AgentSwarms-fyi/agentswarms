// A column's filter, as Excel's filter button offers it: tick the values to
// keep (with counts, from the whole table, not just the loaded rows), or set
// a condition (greater than, contains, blank, …).

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Filter, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { FilterOp, TableColumn, TableConfig, TableFilter } from "@/lib/sheets/sql/tableQuery";
import { sheetsTableValues } from "@/utils/sheetsTables.functions";

const OP_LABEL: Record<FilterOp, string> = {
  eq: "equals",
  ne: "does not equal",
  gt: "is greater than",
  ge: "is at least",
  lt: "is less than",
  le: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  starts: "begins with",
  ends: "ends with",
  blank: "is blank",
  not_blank: "is not blank",
  in: "is one of",
};

function opsFor(kind: TableColumn["kind"]): FilterOp[] {
  if (kind === "number" || kind === "date" || kind === "datetime") {
    return ["eq", "ne", "gt", "ge", "lt", "le", "blank", "not_blank"];
  }
  if (kind === "bool") return ["eq", "blank", "not_blank"];
  return ["eq", "ne", "contains", "not_contains", "starts", "ends", "blank", "not_blank"];
}

export function TableFilterPopover({
  token,
  tabId,
  config,
  column,
  current,
  onApply,
}: {
  token: string;
  tabId: string;
  config: TableConfig;
  column: TableColumn;
  current: TableFilter | null;
  onApply: (f: TableFilter | null) => void;
}) {
  const valuesFn = useServerFn(sheetsTableValues);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"values" | "condition">(
    current && current.op !== "in" ? "condition" : "values",
  );
  const [values, setValues] = useState<{ v: string | null; n: number }[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kept, setKept] = useState<Set<string> | null>(null);
  const [keepBlank, setKeepBlank] = useState(true);
  const [op, setOp] = useState<FilterOp>(
    current && current.op !== "in" ? current.op : opsFor(column.kind)[0],
  );
  const [value, setValue] = useState(current?.value ?? "");

  useEffect(() => {
    if (!open || mode !== "values") return;
    let cancelled = false;
    setValues(null);
    setLoadError(null);
    valuesFn({ data: { access_token: token, tab_id: tabId, config, column: column.name } })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) return setLoadError(r.error);
        setValues(r.values);
        setMore(r.more);
        const inFilter = current?.op === "in";
        setKept(
          new Set(
            r.values
              .filter((x) => x.v !== null)
              .map((x) => x.v as string)
              .filter((v) => !inFilter || current!.values?.includes(v)),
          ),
        );
        setKeepBlank(inFilter ? Boolean(current!.blanks) : true);
      })
      .catch((e) => !cancelled && setLoadError((e as Error).message));
    return () => {
      cancelled = true;
    };
    // The list is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const shown = useMemo(
    () =>
      (values ?? []).filter(
        (x) => !search || (x.v ?? "(blank)").toLowerCase().includes(search.toLowerCase()),
      ),
    [values, search],
  );
  const hasBlank = (values ?? []).some((x) => x.v === null || x.v === "");

  const conditionProblem = (() => {
    if (op === "blank" || op === "not_blank") return null;
    if (!value.trim()) return "Enter a value";
    if (column.kind === "number" && !Number.isFinite(Number(value.replace(/,/g, "")))) {
      return "Enter a number";
    }
    if (
      (column.kind === "date" || column.kind === "datetime") &&
      !/^\d{4}-\d{1,2}-\d{1,2}$/.test(value.trim())
    ) {
      return "Enter a date like 2024-01-31";
    }
    if (column.kind === "bool" && !/^(true|false)$/i.test(value.trim())) return "TRUE or FALSE";
    return null;
  })();

  const apply = () => {
    if (mode === "values") {
      if (!values || !kept) return;
      const all = values.filter((x) => x.v !== null && x.v !== "").every((x) => kept.has(x.v!));
      if (all && (keepBlank || !hasBlank) && !more) onApply(null);
      else {
        onApply({
          column: column.name,
          op: "in",
          values: [...kept].filter((v) => v !== ""),
          blanks: keepBlank && hasBlank,
        });
      }
    } else {
      if (conditionProblem) return;
      onApply({
        column: column.name,
        op,
        ...(op === "blank" || op === "not_blank" ? {} : { value: value.trim() }),
      });
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "rounded p-0.5 hover:bg-background",
            current ? "text-primary opacity-100" : "opacity-0 group-hover:opacity-60",
          )}
          aria-label={`Filter ${column.name}`}
          data-testid={`filter-${column.name}`}
        >
          <Filter className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 text-xs" align="start">
        <div className="mb-2 flex gap-1">
          {(["values", "condition"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              onClick={() => setMode(m)}
            >
              {m === "values" ? "Values" : "Condition"}
            </Button>
          ))}
        </div>
        {mode === "values" ? (
          <div className="grid gap-2">
            <Input
              className="h-7 text-xs"
              placeholder="Search values"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {loadError && <p className="text-destructive">{loadError}</p>}
            {!values && !loadError && (
              <p className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Reading values…
              </p>
            )}
            {values && kept && (
              <>
                <div className="flex gap-2">
                  <button
                    className="text-primary hover:underline"
                    onClick={() =>
                      setKept(new Set(values.filter((x) => x.v).map((x) => x.v as string)))
                    }
                  >
                    Select all
                  </button>
                  <button
                    className="text-primary hover:underline"
                    onClick={() => setKept(new Set())}
                  >
                    Clear
                  </button>
                </div>
                <div
                  className="max-h-56 overflow-y-auto rounded border border-border p-1"
                  role="list"
                >
                  {hasBlank && (!search || "(blank)".includes(search.toLowerCase())) && (
                    <label className="flex items-center gap-2 px-1 py-0.5">
                      <Checkbox
                        checked={keepBlank}
                        onCheckedChange={(c) => setKeepBlank(Boolean(c))}
                      />
                      <span className="italic text-muted-foreground">(blank)</span>
                    </label>
                  )}
                  {shown
                    .filter((x) => x.v !== null && x.v !== "")
                    .map((x) => (
                      <label
                        key={x.v}
                        className="flex items-center gap-2 px-1 py-0.5"
                        role="listitem"
                      >
                        <Checkbox
                          checked={kept.has(x.v!)}
                          onCheckedChange={(c) => {
                            const next = new Set(kept);
                            if (c) next.add(x.v!);
                            else next.delete(x.v!);
                            setKept(next);
                          }}
                        />
                        <span className="truncate">{x.v}</span>
                        <span className="ml-auto tabular-nums text-muted-foreground">
                          {x.n.toLocaleString()}
                        </span>
                      </label>
                    ))}
                </div>
                {more && (
                  <p className="text-muted-foreground">
                    Showing the 1,000 most common values; use a condition for the rest.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-2">
            <Select value={op} onValueChange={(v) => setOp(v as FilterOp)}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {opsFor(column.kind).map((o) => (
                  <SelectItem key={o} value={o} className="text-xs">
                    {OP_LABEL[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {op !== "blank" && op !== "not_blank" && (
              <Input
                className="h-7 text-xs"
                value={value}
                placeholder={
                  column.kind === "number"
                    ? "100"
                    : column.kind === "date" || column.kind === "datetime"
                      ? "2024-01-31"
                      : column.kind === "bool"
                        ? "TRUE"
                        : "text"
                }
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
              />
            )}
            {conditionProblem && value && <p className="text-destructive">{conditionProblem}</p>}
          </div>
        )}
        <div className="mt-3 flex justify-between">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={!current}
            onClick={() => {
              onApply(null);
              setOpen(false);
            }}
          >
            Clear filter
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={apply}
            disabled={mode === "values" ? !values : Boolean(conditionProblem)}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
