// Data → Remove duplicates, as Excel's: which columns make two rows the same,
// and whether the first row is a header (R153).

import { useState } from "react";
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

export function DedupeDialog({
  range,
  columns,
  headers,
  guessHeader,
  onCancel,
  onRemove,
}: {
  /** The range, as the description says it: A1:E8. */
  range: string;
  /** Each column's letter, in order. */
  columns: string[];
  /** The first row's text in each column, shown when it is a header. */
  headers: string[];
  guessHeader: boolean;
  onCancel: () => void;
  onRemove: (offsets: number[], hasHeader: boolean) => void;
}) {
  const [hasHeader, setHasHeader] = useState(guessHeader);
  const [checked, setChecked] = useState<boolean[]>(() => columns.map(() => true));
  const chosen = checked.flatMap((on, i) => (on ? [i] : []));
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="dedupe-dialog"
        onOpenAutoFocus={openFocus(() => document.getElementById("dedupe-ok"))}
      >
        <DialogHeader>
          <DialogTitle>Remove duplicates</DialogTitle>
          <DialogDescription>
            In {range}, a row whose checked columns repeat an earlier row&apos;s is removed, and the
            rows below it move up. Cells are compared as they are shown, ignoring case. Nothing
            outside {range} moves.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setChecked(columns.map(() => true))}
            >
              Select all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setChecked(columns.map(() => false))}
            >
              Unselect all
            </Button>
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
                data-testid="dedupe-header"
              />
              My data has headers
            </label>
          </div>
          <fieldset className="max-h-60 space-y-1 overflow-auto rounded-md border p-2">
            <legend className="px-1 text-xs text-muted-foreground">Columns</legend>
            {columns.map((letter, i) => (
              <label key={letter} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked[i]}
                  onChange={(e) =>
                    setChecked((list) => list.map((on, j) => (j === i ? e.target.checked : on)))
                  }
                />
                {hasHeader && headers[i] ? headers[i] : `Column ${letter}`}
              </label>
            ))}
          </fieldset>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            id="dedupe-ok"
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onRemove(chosen, hasHeader)}
            data-testid="dedupe-ok"
          >
            Remove duplicates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
