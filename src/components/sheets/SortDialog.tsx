// Data → Sort…, as Excel's Custom Sort (R156): sort a range by several
// columns in turn, each A to Z or Z to A, with or without a header row.

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openFocus } from "./focusAfterMenu";

/** Most levels one sort takes (Excel allows 64; a sheet rarely wants more than a few). */
const MAX_SORT_LEVELS = 8;

export type SortLevel = { offset: number; desc: boolean };

const select = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export function SortDialog({
  range,
  columns,
  headers,
  guessHeader,
  first,
  onCancel,
  onSort,
}: {
  /** The range, as the description says it: A1:E8. */
  range: string;
  /** Each column's letter, in order. */
  columns: string[];
  /** The first row's text in each column, shown when it is a header. */
  headers: string[];
  guessHeader: boolean;
  /** The column the first level starts on: the active cell's. */
  first: number;
  onCancel: () => void;
  onSort: (levels: SortLevel[], hasHeader: boolean) => void;
}) {
  const [hasHeader, setHasHeader] = useState(guessHeader);
  const [levels, setLevels] = useState<SortLevel[]>([{ offset: first, desc: false }]);
  const label = (i: number) =>
    hasHeader && headers[i] ? headers[i] : `Column ${columns[i] ?? i + 1}`;
  const set = (i: number, patch: Partial<SortLevel>) =>
    setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, by: -1 | 1) =>
    setLevels((ls) => {
      const next = [...ls];
      const [l] = next.splice(i, 1);
      next.splice(i + by, 0, l);
      return next;
    });
  const unused = columns.findIndex((_, i) => !levels.some((l) => l.offset === i));
  // A column sorted twice changes nothing the second time; Excel refuses it too.
  const repeated = levels.find((l, i) => levels.findIndex((m) => m.offset === l.offset) !== i);

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="sort-dialog"
        onOpenAutoFocus={openFocus(() => document.getElementById("sort-ok"))}
      >
        <DialogHeader>
          <DialogTitle>Sort</DialogTitle>
          <DialogDescription>
            Sort {range} by the first column, then rows that tie by the next, and so on. Rows move
            whole, with their formats and notes; nothing outside {range} moves.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={levels.length >= MAX_SORT_LEVELS || unused < 0}
              onClick={() => setLevels((ls) => [...ls, { offset: unused, desc: false }])}
              data-testid="sort-add-level"
            >
              <Plus className="h-3.5 w-3.5" /> Add level
            </Button>
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
                data-testid="sort-header"
              />
              My data has headers
            </label>
          </div>
          <ol className="space-y-2" data-testid="sort-levels">
            {levels.map((l, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="w-14 shrink-0 text-muted-foreground">
                  {i === 0 ? "Sort by" : "Then by"}
                </span>
                <select
                  className={`${select} min-w-0 flex-1`}
                  aria-label={`Level ${i + 1} column`}
                  value={l.offset}
                  onChange={(e) => set(i, { offset: Number(e.target.value) })}
                >
                  {columns.map((_, c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </select>
                <select
                  className={select}
                  aria-label={`Level ${i + 1} order`}
                  value={l.desc ? "desc" : "asc"}
                  onChange={(e) => set(i, { desc: e.target.value === "desc" })}
                >
                  <option value="asc">A to Z</option>
                  <option value="desc">Z to A</option>
                </select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move level ${i + 1} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={i === levels.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move level ${i + 1} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={levels.length === 1}
                  onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}
                  aria-label={`Delete level ${i + 1}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ol>
          {repeated && (
            <p className="text-sm text-destructive" role="alert">
              {label(repeated.offset)} is sorted by more than once; pick another column or delete
              the level.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            id="sort-ok"
            type="button"
            disabled={Boolean(repeated)}
            onClick={() => onSort(levels, hasHeader)}
            data-testid="sort-ok"
          >
            Sort
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
