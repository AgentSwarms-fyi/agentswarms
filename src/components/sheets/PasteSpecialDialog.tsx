// Paste Special (Ctrl+Alt+V, or the cell's menu), as Excel's (R159): what of
// the copied cells to paste, an operation with what is there, blanks
// skipped, rows and columns swapped.

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
import type { PasteOperation, PasteSpecialOptions, PasteWhat } from "@/lib/sheets/pasteSpecial";
import { openFocus } from "./focusAfterMenu";

const WHAT: { id: PasteWhat; label: string }[] = [
  { id: "all", label: "All" },
  { id: "formulas", label: "Formulas" },
  { id: "values", label: "Values" },
  { id: "values_formats", label: "Values and number formats" },
  { id: "formats", label: "Formats" },
  { id: "notes", label: "Notes" },
];

const OPS: { id: PasteOperation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "add", label: "Add" },
  { id: "subtract", label: "Subtract" },
  { id: "multiply", label: "Multiply" },
  { id: "divide", label: "Divide" },
];

export function PasteSpecialDialog({
  copied,
  at,
  onCancel,
  onPaste,
}: {
  /** The copied range, as the description says it: A1:B3. */
  copied: string;
  /** Where the paste starts: C5. */
  at: string;
  onCancel: () => void;
  onPaste: (opts: PasteSpecialOptions) => void;
}) {
  const [what, setWhat] = useState<PasteWhat>("all");
  const [operation, setOperation] = useState<PasteOperation>("none");
  const [skipBlanks, setSkipBlanks] = useState(false);
  const [transpose, setTranspose] = useState(false);
  // An operation combines values; it has nothing to do with formats or notes.
  const opsOff = what === "formats" || what === "notes";

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="paste-special-dialog"
        onOpenAutoFocus={openFocus(() => document.getElementById("paste-special-ok"))}
      >
        <DialogHeader>
          <DialogTitle>Paste special</DialogTitle>
          <DialogDescription>
            Paste part of {copied} at {at}. One Ctrl+Z takes it back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <fieldset className="space-y-1" data-testid="paste-special-what">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Paste</legend>
            {WHAT.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="paste-what"
                  value={w.id}
                  checked={what === w.id}
                  onChange={() => setWhat(w.id)}
                />
                {w.label}
              </label>
            ))}
          </fieldset>
          <fieldset
            className="space-y-1 disabled:opacity-50"
            disabled={opsOff}
            data-testid="paste-special-operation"
          >
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Operation</legend>
            {OPS.map((o) => (
              <label key={o.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="paste-op"
                  value={o.id}
                  checked={operation === o.id}
                  onChange={() => setOperation(o.id)}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={skipBlanks}
              onChange={(e) => setSkipBlanks(e.target.checked)}
              data-testid="paste-special-skip"
            />
            Skip blanks
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={transpose}
              onChange={(e) => setTranspose(e.target.checked)}
              data-testid="paste-special-transpose"
            />
            Transpose
          </label>
        </div>
        {operation !== "none" && !opsOff && (
          <p className="text-xs text-muted-foreground">
            Each copied number is combined with the cell it lands on; text and blanks leave the cell
            as it is, and the cell keeps its formats.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            id="paste-special-ok"
            type="button"
            onClick={() =>
              onPaste({ what, operation: opsOff ? "none" : operation, skipBlanks, transpose })
            }
            data-testid="paste-special-ok"
          >
            Paste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
