// Insert cells… and Delete cells…, as Excel asks: which way the neighbours
// move, or whole rows or columns instead.

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

export type ShiftChoice = "right" | "down" | "left" | "up" | "rows" | "cols";

export function ShiftCellsDialog({
  mode,
  range,
  onCancel,
  onApply,
}: {
  mode: "insert" | "delete";
  range: string;
  onCancel: () => void;
  onApply: (c: ShiftChoice) => void;
}) {
  const options: { c: ShiftChoice; label: string }[] =
    mode === "insert"
      ? [
          { c: "right", label: "Shift cells right" },
          { c: "down", label: "Shift cells down" },
          { c: "rows", label: "Entire row" },
          { c: "cols", label: "Entire column" },
        ]
      : [
          { c: "left", label: "Shift cells left" },
          { c: "up", label: "Shift cells up" },
          { c: "rows", label: "Entire row" },
          { c: "cols", label: "Entire column" },
        ];
  const [choice, setChoice] = useState<ShiftChoice>(options[mode === "insert" ? 1 : 1].c);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-xs"
        data-testid="shift-cells-dialog"
        onOpenAutoFocus={openFocus(() =>
          document.querySelector<HTMLElement>('[data-testid="shift-cells-dialog"] input:checked'),
        )}
      >
        <DialogHeader>
          <DialogTitle>{mode === "insert" ? "Insert cells" : "Delete cells"}</DialogTitle>
          <DialogDescription>
            {mode === "insert" ? "Insert" : "Delete"} {range}. Formulas that point at the cells that
            move follow them
            {mode === "delete" ? "; one that pointed into deleted cells shows #REF!" : ""}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onApply(choice);
          }}
        >
          <fieldset className="space-y-1.5" aria-label={mode === "insert" ? "Insert" : "Delete"}>
            {options.map((o) => (
              <label key={o.c} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="shift"
                  value={o.c}
                  checked={choice === o.c}
                  onChange={() => setChoice(o.c)}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-testid="shift-cells-apply">
              {mode === "insert" ? "Insert" : "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
