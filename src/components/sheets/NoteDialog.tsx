// A cell's note (Excel's comment): Shift+F2, or New note… on the cell's
// menu. Excel marks a cell with a note by a red corner and shows the note
// on hover (R152).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** The longest note, as Excel's own limit on a cell's text. */
const MAX_NOTE = 32767;

export function NoteDialog({
  open,
  cell,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  open: boolean;
  /** The cell's address, as the title says it: B3. */
  cell: string;
  initial: string;
  onSave: (text: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="note-dialog">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit note" : "New note"} on {cell}
          </DialogTitle>
          <DialogDescription>
            A note stays with its cell when rows move, sorts or the workbook goes to Excel. The cell
            shows a red corner, and the note on hover.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(text.trim());
          }}
        >
          <Textarea
            aria-label="Note"
            autoFocus
            rows={6}
            maxLength={MAX_NOTE}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Enter saves; Enter alone is a new line, as in a note.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onSave(text.trim());
              }
            }}
          />
          <DialogFooter className="mt-3 gap-2 sm:justify-between">
            {onDelete ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={onDelete}>
                Delete note
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" data-testid="note-save">
                Save note
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
