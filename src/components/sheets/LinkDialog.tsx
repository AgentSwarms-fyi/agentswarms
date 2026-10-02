// Insert or edit a cell's hyperlink (Ctrl+K): the text the cell shows and
// the address it opens. Web and mail addresses only, or a place in this
// workbook (#Sheet2!A1), as Excel's "Place in this document".

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { linkProblem, normalizeLink } from "@/lib/sheets/style";

export function LinkDialog({
  open,
  onOpenChange,
  initialText,
  initialUrl,
  textLocked,
  onApply,
  onRemove,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialText: string;
  initialUrl: string;
  /** A formula cell keeps its formula; only the link changes. */
  textLocked: boolean;
  onApply: (text: string, url: string) => void;
  onRemove?: () => void;
  /** Where the keyboard goes once the dialog is gone (the grid). */
  onClosed?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setText(initialText);
      setUrl(initialUrl);
      setTouched(false);
    }
  }, [open, initialText, initialUrl]);
  const problem = linkProblem(url);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="link-dialog"
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
      >
        <DialogHeader>
          <DialogTitle>{initialUrl ? "Edit link" : "Insert link"}</DialogTitle>
          <DialogDescription>
            A web address, an email (mailto:), or a place in this workbook such as #Sheet2!A1.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (problem) return;
            const href = normalizeLink(url)!;
            onApply(textLocked ? text : text.trim() || href, href);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="link-text">Text to display</Label>
            <Input
              id="link-text"
              value={text}
              disabled={textLocked}
              onChange={(e) => setText(e.target.value)}
              placeholder="Shown in the cell"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-url">Address</Label>
            <Input
              id="link-url"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="https://example.com"
              aria-invalid={touched && !!problem}
            />
            {touched && problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          <DialogFooter className="gap-2">
            {onRemove && initialUrl && (
              <Button type="button" variant="outline" onClick={onRemove} className="mr-auto">
                Remove link
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{initialUrl ? "Update" : "Insert"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
