// Add or edit a table sheet's calculated column: a name and an Excel formula
// over the row ([@price]*[@qty]), checked as it is typed by the same compiler
// the server runs, so a mistake is explained before anything is saved.

import { useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  compileColumnFormula,
  kindOfSqlType,
  TABLE_FUNCTIONS,
  type SheetColumn,
} from "@/lib/sheets/sql/compile";
import type { CalculatedColumn, TableConfig } from "@/lib/sheets/sql/tableQuery";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import type { TabMeta, useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

const COLUMN_NAME_BAD = /[[\]@#'"]/;

export function CalculatedColumnDialog({
  open,
  onOpenChange,
  wb,
  tab,
  config,
  editIndex,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wb: Workbook;
  tab: TabMeta;
  config: TableConfig;
  /** The calculated column being edited, or null for a new one. */
  editIndex: number | null;
  onSave: (calculated: CalculatedColumn[]) => void;
}) {
  const editing = editIndex !== null ? config.calculated[editIndex] : undefined;
  const [name, setName] = useState(editing?.name ?? "");
  const [formula, setFormula] = useState(editing?.formula ?? "=");
  const [caret, setCaret] = useState((editing?.formula ?? "=").length);
  const [ac, setAc] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The columns this formula can use: the table's, then the calculated ones before it.
  const before = editIndex === null ? config.calculated : config.calculated.slice(0, editIndex);
  const columns: SheetColumn[] = useMemo(
    () => [
      ...config.columns.map((c) => ({ name: c.name, kind: kindOfSqlType(c.type) })),
      // A calculated column's kind is only known once compiled; "other" accepts anything.
      ...before.map((c) => ({ name: c.name, kind: "other" as const })),
    ],
    [config.columns, before],
  );

  const otherTables = useMemo(() => {
    const out = new Map<string, SheetColumn[]>();
    for (const t of wb.tabs) {
      if (t.kind !== "table" || t.id === tab.id) continue;
      const cfg = wb.tableConfigs[t.id];
      if (!cfg) continue;
      out.set(t.name.toLowerCase(), [
        ...cfg.columns.map((c) => ({ name: c.name, kind: kindOfSqlType(c.type) })),
        ...cfg.calculated.map((c) => ({ name: c.name, kind: "other" as const })),
      ]);
    }
    return out;
  }, [wb.tabs, wb.tableConfigs, tab.id]);

  const nameProblem = (() => {
    const n = name.trim();
    if (!n) return "Name the column";
    if (COLUMN_NAME_BAD.test(n)) return "A column name cannot contain [ ] @ # ' or \"";
    if (n.startsWith("__")) return "Names starting with __ are reserved";
    const taken =
      config.columns.some((c) => c.name.toLowerCase() === n.toLowerCase()) ||
      config.calculated.some((c, i) => i !== editIndex && c.name.toLowerCase() === n.toLowerCase());
    return taken ? `There is already a column named "${n}"` : null;
  })();

  const check = useMemo(() => {
    if (formula.trim() === "=" || !formula.trim()) return { error: "Write a formula", empty: true };
    try {
      const r = compileColumnFormula(formula, {
        columns,
        self: "t",
        row: "p",
        selfName: tab.name,
        table: (n) => {
          const cols = otherTables.get(n.toLowerCase());
          return cols ? { from: "o", columns: cols } : undefined;
        },
      });
      return { kind: r.kind };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [formula, columns, otherTables, tab.name]);

  // Autocomplete: a function name, or a column after "[" / "[@".
  const suggestions = useMemo(() => {
    const before = formula.slice(0, caret);
    const col = /\[@?([^\]]*)$/.exec(before);
    if (col) {
      const w = col[1].toLowerCase();
      return columns
        .filter((c) => c.name.toLowerCase().startsWith(w))
        .slice(0, 8)
        .map((c) => ({
          label: `[@${c.name}]`,
          insert: `${c.name}]`,
          at: caret - col[1].length,
          hint: c.kind === "other" ? "calculated" : c.kind,
          atPrefix: !before.slice(0, caret - col[1].length).endsWith("@"),
        }));
    }
    const fn = /([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
    if (!fn || !formula.startsWith("=")) return [];
    const w = fn[1].toUpperCase();
    return TABLE_FUNCTIONS.filter((n) => n.startsWith(w) && n !== w)
      .slice(0, 8)
      .map((n) => ({
        label: n,
        insert: `${n}(`,
        at: caret - fn[1].length,
        hint: FUNCTION_HELP[n]?.desc ?? "",
        atPrefix: false,
      }));
  }, [formula, caret, columns]);

  const accept = (s: (typeof suggestions)[number]) => {
    const insert = s.atPrefix ? `@${s.insert}` : s.insert;
    const next = formula.slice(0, s.at) + insert + formula.slice(caret);
    const pos = s.at + insert.length;
    setFormula(next);
    setCaret(pos);
    setAc(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };

  const save = () => {
    if (nameProblem || check.error) return;
    const entry = { name: name.trim(), formula: formula.trim() };
    const next = [...config.calculated];
    if (editIndex === null) next.push(entry);
    else next[editIndex] = entry;
    onSave(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit "${editing.name}"` : "Add a calculated column"}
          </DialogTitle>
          <DialogDescription>
            An Excel formula for one row. Use <code className="font-mono">[@column]</code> for this
            row&apos;s value, <code className="font-mono">[column]</code> inside SUM, COUNTIFS and
            the like for the whole column, and <code className="font-mono">Other[column]</code> to
            look up another table sheet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="calc-name">Name</Label>
            <Input
              id="calc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="margin"
              autoFocus={!editing}
            />
            {name && nameProblem && <p className="text-xs text-destructive">{nameProblem}</p>}
          </div>
          <div className="relative grid gap-1">
            <Label htmlFor="calc-formula">Formula</Label>
            <Input
              id="calc-formula"
              ref={inputRef}
              className="font-mono"
              value={formula}
              spellCheck={false}
              autoFocus={Boolean(editing)}
              onChange={(e) => {
                setFormula(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setAc(0);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? formula.length)}
              onKeyDown={(e) => {
                if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setAc(
                    (i) =>
                      (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) %
                      suggestions.length,
                  );
                } else if (suggestions.length && e.key === "Tab") {
                  e.preventDefault();
                  accept(suggestions[Math.min(ac, suggestions.length - 1)]);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              data-testid="calc-formula"
            />
            {suggestions.length > 0 && (
              <div
                className="mt-1 w-full rounded-md border border-border bg-popover p-1 shadow-sm"
                data-testid="calc-suggestions"
              >
                {suggestions.map((s, i) => (
                  <button
                    key={s.label}
                    type="button"
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs",
                      i === ac ? "bg-primary/15" : "hover:bg-muted",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      accept(s);
                    }}
                  >
                    <span className="font-mono font-semibold">{s.label}</span>
                    <span className="truncate text-muted-foreground">{s.hint}</span>
                  </button>
                ))}
                <p className="px-2 pt-1 text-[10px] text-muted-foreground">Tab to insert</p>
              </div>
            )}
            <p
              className={cn(
                "text-xs",
                check.error && !("empty" in check) ? "text-destructive" : "text-muted-foreground",
              )}
              data-testid="calc-check"
            >
              {check.error ??
                `Gives ${check.kind === "number" ? "a number" : check.kind === "bool" ? "TRUE/FALSE" : check.kind === "date" ? "a date" : check.kind === "datetime" ? "a date and time" : "text"} for each row.`}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={Boolean(nameProblem || check.error)}>
            {editing ? "Save column" : "Add column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
