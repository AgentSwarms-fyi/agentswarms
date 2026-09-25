// Make (or change) a pivot of a table sheet: group its rows by some columns
// and total others. The pivot is a table sheet of its own, computed by the
// lakehouse, so it is as fast on ten million rows as on ten.

import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { suggestTableName, tableNameProblem } from "@/lib/sheets/names";
import type { PivotAgg, PivotValue, TableConfig } from "@/lib/sheets/sql/tableQuery";
import { sheetsSavePivot } from "@/utils/sheetsTables.functions";
import type { TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const AGGS: { id: PivotAgg; label: string }[] = [
  { id: "sum", label: "Sum" },
  { id: "count", label: "Count" },
  { id: "avg", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "count_distinct", label: "Count distinct" },
];

export function PivotDialog({
  open,
  onOpenChange,
  wb,
  token,
  from,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wb: Workbook;
  token: string;
  /** The table sheet being pivoted. */
  from: TabMeta;
  /** The pivot sheet whose definition is being changed, if any. */
  editing?: { tab: TabMeta; config: TableConfig };
}) {
  const saveFn = useServerFn(sheetsSavePivot);
  const fromConfig = wb.tableConfigs[from.id];
  const columns = useMemo(
    () => [
      ...(fromConfig?.columns.map((c) => c.name) ?? []),
      ...(fromConfig?.calculated.map((c) => c.name) ?? []),
    ],
    [fromConfig],
  );
  const current = editing?.config.source.kind === "pivot" ? editing.config.source : null;
  const [name, setName] = useState(
    editing?.tab.name ??
      suggestTableName(`${from.name} pivot`, new Set(wb.tabs.map((t) => t.name.toLowerCase()))),
  );
  const [rows, setRows] = useState<string[]>(current?.rows ?? []);
  const [values, setValues] = useState<PivotValue[]>(
    current?.values ?? [
      { column: columns.find((c) => c !== rows[0]) ?? columns[0] ?? "", agg: "count" },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = new Set(
    wb.tabs.filter((t) => t.id !== editing?.tab.id).map((t) => t.name.toLowerCase()),
  );
  const problem =
    tableNameProblem(name) ??
    (taken.has(name.trim().toLowerCase())
      ? `This workbook already has a sheet named "${name.trim()}"`
      : !values.length
        ? "Add at least one value to total"
        : values.some((v) => !v.column)
          ? "Pick a column for every value"
          : null);

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await saveFn({
        data: {
          access_token: token,
          workbook_id: wb.workbookId,
          name: name.trim(),
          source: { kind: "pivot", from: from.name, rows, values },
          ...(editing ? { tab_id: editing.tab.id, base_version: editing.tab.version } : {}),
        },
      });
      if (!r.ok) return setError(r.error);
      if (editing) {
        wb.applyServerTab(r.tab);
        toast.success(`Updated ${r.tab.name}`);
      } else {
        wb.addTabLocal(r.tab);
        toast.success(`Added ${r.tab.name}`);
      }
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Change ${editing.tab.name}` : `Pivot ${from.name}`}</DialogTitle>
          <DialogDescription>
            One row per combination of the grouping columns, with the totals you pick. The pivot is
            a table sheet: sort it, filter it, add formula columns, or save it to the lakehouse.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!editing && (
            <div className="grid gap-1">
              <Label htmlFor="pivot-name">Sheet name</Label>
              <Input id="pivot-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div className="grid gap-1">
            <Label>Group rows by</Label>
            <div className="flex flex-wrap gap-1.5" data-testid="pivot-rows">
              {rows.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                >
                  {r}
                  <button
                    aria-label={`Stop grouping by ${r}`}
                    onClick={() => setRows(rows.filter((x) => x !== r))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <Select value="" onValueChange={(v) => v && setRows([...rows, v])}>
                <SelectTrigger className="h-7 w-44 text-xs" aria-label="Add a grouping column">
                  <SelectValue placeholder={rows.length ? "Then by…" : "Pick a column…"} />
                </SelectTrigger>
                <SelectContent>
                  {columns
                    .filter((c) => !rows.includes(c))
                    .map((c) => (
                      <SelectItem key={c} value={c} className="text-xs">
                        {c}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {rows.length ? "" : "With no grouping, the pivot is one row of grand totals."}
            </p>
          </div>
          <div className="grid gap-1">
            <Label>Values</Label>
            <div className="grid gap-1.5" data-testid="pivot-values">
              {values.map((v, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Select
                    value={v.agg}
                    onValueChange={(a) =>
                      setValues(values.map((x, j) => (j === i ? { ...x, agg: a as PivotAgg } : x)))
                    }
                  >
                    <SelectTrigger className="h-8 w-36 text-xs" aria-label={`Value ${i + 1} total`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGGS.map((a) => (
                        <SelectItem key={a.id} value={a.id} className="text-xs">
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">of</span>
                  <Select
                    value={v.column}
                    onValueChange={(c) =>
                      setValues(values.map((x, j) => (j === i ? { ...x, column: c } : x)))
                    }
                  >
                    <SelectTrigger
                      className="h-8 flex-1 text-xs"
                      aria-label={`Value ${i + 1} column`}
                    >
                      <SelectValue placeholder="column" />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((c) => (
                        <SelectItem key={c} value={c} className="text-xs">
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Remove value ${i + 1}`}
                    onClick={() => setValues(values.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-fit gap-1 px-2 text-xs"
                onClick={() => setValues([...values, { column: columns[0] ?? "", agg: "sum" }])}
              >
                <Plus className="h-3.5 w-3.5" /> Add a value
              </Button>
            </div>
          </div>
          {(error || problem) && (
            <p className="text-sm text-destructive" role="alert">
              {error ?? problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={Boolean(problem) || busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {editing ? "Update pivot" : "Add pivot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
