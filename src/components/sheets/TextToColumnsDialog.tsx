// Data → Text to columns…, as Excel's (R157): which characters split the
// text, whether two in a row count once, the quotes that keep a piece whole,
// and where the pieces go, with a preview of the first rows.

import { useMemo, useState } from "react";
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
import { splitColumn, type SplitOptions } from "@/lib/sheets/textToColumns";
import { openFocus } from "./focusAfterMenu";

const DELIMS: { id: string; label: string; ch: string }[] = [
  { id: "tab", label: "Tab", ch: "\t" },
  { id: "semicolon", label: "Semicolon", ch: ";" },
  { id: "comma", label: "Comma", ch: "," },
  { id: "space", label: "Space", ch: " " },
];

const PREVIEW_ROWS = 5;

export function TextToColumnsDialog({
  range,
  texts,
  initialDest,
  onCancel,
  onSplit,
}: {
  /** The column's cells, as the description says them: A2:A8. */
  range: string;
  /** Each cell's text, top to bottom. */
  texts: string[];
  /** Where the pieces start: the first cell, unless changed (A1 reference). */
  initialDest: string;
  onCancel: () => void;
  onSplit: (opts: SplitOptions, dest: string) => void;
}) {
  const [on, setOn] = useState<Record<string, boolean>>(() => {
    // Excel starts with Tab; a column of comma-separated text reads better with Comma.
    const comma = texts.some((t) => t.includes(","));
    return { tab: !comma, comma, semicolon: false, space: false };
  });
  const [other, setOther] = useState("");
  const [consecutive, setConsecutive] = useState(false);
  const [qualifier, setQualifier] = useState<'"' | "'" | "">('"');
  const [dest, setDest] = useState(initialDest);
  const opts: SplitOptions = useMemo(
    () => ({
      delimiters: [...DELIMS.filter((d) => on[d.id]).map((d) => d.ch), ...(other ? [other] : [])],
      consecutive,
      qualifier: qualifier || null,
    }),
    [on, other, consecutive, qualifier],
  );
  const preview = useMemo(() => splitColumn(texts.slice(0, PREVIEW_ROWS), opts), [texts, opts]);
  const none = opts.delimiters.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="sm:max-w-xl"
        data-testid="split-dialog"
        onOpenAutoFocus={openFocus(() => document.getElementById("split-ok"))}
      >
        <DialogHeader>
          <DialogTitle>Text to columns</DialogTitle>
          <DialogDescription>
            Split each cell of {range} at the characters below, into the cells to the right of the
            destination. Numbers and dates become numbers and dates; text that would read as a
            formula stays text.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <legend className="mb-1 text-xs text-muted-foreground">Split at</legend>
            {DELIMS.map((d) => (
              <label key={d.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!!on[d.id]}
                  onChange={(e) => setOn((o) => ({ ...o, [d.id]: e.target.checked }))}
                  data-testid={`split-${d.id}`}
                />
                {d.label}
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              Other
              <Input
                className="h-7 w-12 px-2 font-mono"
                maxLength={1}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                aria-label="Other character to split at"
                data-testid="split-other"
              />
            </label>
          </fieldset>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={consecutive}
                onChange={(e) => setConsecutive(e.target.checked)}
                data-testid="split-consecutive"
              />
              Treat several in a row as one
            </label>
            <label className="flex items-center gap-1.5">
              Text in
              <select
                className="h-7 rounded-md border border-input bg-background px-1"
                value={qualifier}
                onChange={(e) => setQualifier(e.target.value as '"' | "'" | "")}
                aria-label="Quotes that keep a piece whole"
              >
                <option value={'"'}>&quot;double quotes&quot;</option>
                <option value="'">&apos;single quotes&apos;</option>
                <option value="">no quotes</option>
              </select>
              stays whole
            </label>
            <label className="flex items-center gap-1.5">
              Destination
              <Input
                className="h-7 w-20 px-2 font-mono"
                value={dest}
                onChange={(e) => setDest(e.target.value.toUpperCase())}
                aria-label="Destination"
                data-testid="split-dest"
              />
            </label>
          </div>
          <div className="max-h-40 overflow-auto rounded-md border" data-testid="split-preview">
            <table className="w-full text-xs">
              <tbody>
                {preview.rows.map((pieces, r) => (
                  <tr key={r} className="border-b last:border-0">
                    {Array.from({ length: preview.width }, (_, k) => (
                      <td key={k} className="whitespace-pre border-r px-2 py-0.5 last:border-0">
                        {pieces[k] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {none
              ? "Pick a character to split at."
              : `${preview.width} column${preview.width === 1 ? "" : "s"} in the first ${Math.min(texts.length, PREVIEW_ROWS)} rows.`}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            id="split-ok"
            type="button"
            disabled={none || !dest.trim()}
            onClick={() => onSplit(opts, dest.trim())}
            data-testid="split-ok"
          >
            Split
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
