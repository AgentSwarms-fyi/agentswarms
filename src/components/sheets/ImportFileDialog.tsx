// Bring an Excel workbook (.xlsx) or a CSV in: as a new workbook, or as more
// sheets of the one that is open. The file is read in the browser; what the
// server receives is the sheets, checked against the same rules as a save.

import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, FileSpreadsheet, Loader2, Upload } from "lucide-react";
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
import { clickable } from "@/lib/clickable";
import type { GridData } from "@/lib/sheets/engine";
import { renameSheetInFormula } from "@/lib/sheets/formula/shift";
import { sheetsImportGrids, type SheetTabRow } from "@/utils/sheets.functions";

type Parsed = {
  sheets: {
    name: string;
    grid: GridData;
    cells: number;
    cachedFormulas: number;
    hidden?: boolean;
  }[];
  warnings: string[];
  kind: "xlsx" | "csv";
};

const ACCEPT =
  ".xlsx,.xlsm,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";

function renameInGrid(grid: GridData, renamed: { from: string; to: string }[]): GridData {
  const cells: GridData["cells"] = {};
  for (const [k, cell] of Object.entries(grid.cells)) {
    let i = cell.i;
    if (i.startsWith("=")) for (const r of renamed) i = renameSheetInFormula(i, r.from, r.to);
    cells[k] = i === cell.i ? cell : { ...cell, i };
  }
  return { ...grid, cells };
}

/** A sheet name this workbook accepts: Excel's apostrophes and brackets dropped, made unique. */
export function importSheetName(raw: string, taken: Set<string>): string {
  let n =
    raw
      .replace(/[\\/?*[\]:']/g, "")
      .trim()
      .slice(0, 100) || "Sheet";
  if (/^[A-Za-z]{1,3}\d+$/.test(n) || /^(true|false)$/i.test(n)) n = `${n} sheet`;
  let out = n;
  for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${n} (${k})`;
  taken.add(out.toLowerCase());
  return out;
}

export function ImportFileDialog({
  open,
  onOpenChange,
  token,
  maxCells,
  workbookId,
  takenNames,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
  maxCells: number;
  /** Add to this workbook; without it, the import makes a new one. */
  workbookId?: string;
  takenNames?: string[];
  onImported: (r: { workbookId: string; tabs: SheetTabRow[] }) => void;
}) {
  const importFn = useServerFn(sheetsImportGrids);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const read = async (f: File) => {
    setFile(f);
    setParsed(null);
    setError(null);
    setName(f.name.replace(/\.(xlsx|xlsm|csv|tsv|txt)$/i, ""));
    setReading(true);
    try {
      const lower = f.name.toLowerCase();
      if (/\.(xlsx|xlsm)$/.test(lower)) {
        const { readXlsx } = await import("@/lib/sheets/xlsx");
        const r = await readXlsx(await f.arrayBuffer(), { maxCells });
        setParsed({ ...r, kind: "xlsx" });
      } else if (/\.(csv|tsv|txt)$/.test(lower)) {
        const { parseCsv, rowsToGrid } = await import("@/lib/sheets/csv");
        const p = parseCsv(await f.text(), maxCells);
        const grid = rowsToGrid(p.rows);
        setParsed({
          kind: "csv",
          sheets: [
            {
              name: f.name.replace(/\.[^.]+$/, "") || "Sheet1",
              grid,
              cells: Object.keys(grid.cells).length,
              cachedFormulas: 0,
            },
          ],
          warnings: p.truncated
            ? [
                `The file has more than ${maxCells.toLocaleString()} cells (SHEETS_MAX_CELLS); only the rows up to that came in. Open a file this large as a table sheet, which lives in the lakehouse.`,
              ]
            : [],
        });
      } else if (/\.xls$/.test(lower)) {
        setError(
          `${f.name} is an Excel 97–2003 workbook (.xls), which cannot be read here. Open it in Excel and save it as .xlsx, then import that.`,
        );
      } else {
        setError("Choose an Excel workbook (.xlsx) or a CSV file");
      }
    } catch (e) {
      const m = (e as Error).message;
      // An .xlsx is a zip; anything else fails there, in the zip reader's words.
      setError(
        /central directory|zip file|corrupted zip/i.test(m)
          ? `${f.name} is not an Excel workbook: its contents are not an .xlsx file. If it came from an older Excel, save it as .xlsx first.`
          : `Could not read ${f.name}: ${m}`,
      );
    } finally {
      setReading(false);
    }
  };

  // The names the sheets will have here, shown before anything is saved.
  const previewNames = (() => {
    if (!parsed) return [];
    const taken = new Set((takenNames ?? []).map((n) => n.toLowerCase()));
    return parsed.sheets.map((s) => importSheetName(s.name, taken));
  })();

  const submit = async () => {
    if (!parsed) return;
    setSaving(true);
    setError(null);
    try {
      const taken = new Set((takenNames ?? []).map((n) => n.toLowerCase()));
      const named = parsed.sheets.map((s) => ({
        from: s.name,
        to: importSheetName(s.name, taken),
      }));
      // A name that had to change (an apostrophe, a clash) is changed in
      // every formula that uses it too, so cross-sheet references still work.
      const renamed = named.filter((n) => n.from !== n.to);
      const sheets = parsed.sheets.map((s, i) => ({
        name: named[i].to,
        grid: renamed.length ? renameInGrid(s.grid, renamed) : s.grid,
      }));
      const r = await importFn({
        data: {
          access_token: token,
          ...(workbookId
            ? { workbook_id: workbookId }
            : { name: name.trim() || "Imported workbook" }),
          sheets,
        },
      });
      if (!r.ok) return setError(r.error);
      onImported({ workbookId: r.workbook_id, tabs: r.tabs });
      onOpenChange(false);
    } catch (e) {
      setError(`Could not import: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="import-file-dialog">
        <DialogHeader>
          <DialogTitle>
            {workbookId ? "Import sheets from a file" : "Import an Excel or CSV file"}
          </DialogTitle>
          <DialogDescription>
            An .xlsx workbook comes in with its formulas, formats, merged cells, links, column
            widths and row heights. A CSV comes in as one sheet, its numbers and dates recognised.
          </DialogDescription>
        </DialogHeader>
        <div
          {...clickable(() => inputRef.current?.click(), "Choose a file")}
          className="flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed border-border p-6 text-center text-sm hover:bg-muted/50"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void read(f);
          }}
          data-testid="import-drop"
        >
          <Upload className="h-5 w-5 text-muted-foreground" />
          {file ? (
            <span className="font-medium">{file.name}</span>
          ) : (
            <span>Drop a file here, or choose one</span>
          )}
          <span className="text-xs text-muted-foreground">.xlsx, .xlsm, .csv, .tsv</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            data-testid="import-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void read(f);
              e.target.value = "";
            }}
          />
        </div>
        {reading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the file…
          </p>
        )}
        {parsed && (
          <div className="space-y-3" data-testid="import-preview">
            {!workbookId && (
              <div className="space-y-1">
                <Label htmlFor="import-name">Workbook name</Label>
                <Input id="import-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
              {parsed.sheets.map((s, i) => (
                <li key={s.name} className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate font-medium">{previewNames[i]}</span>
                  {previewNames[i] !== s.name && (
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title="A sheet name here cannot contain \ / ? * [ ] : or ', or repeat another's; formulas that name it follow"
                    >
                      (was {s.name})
                    </span>
                  )}
                  {s.hidden && (
                    <span className="text-xs text-muted-foreground">(hidden in Excel)</span>
                  )}
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {s.cells.toLocaleString()} {s.cells === 1 ? "cell" : "cells"}
                    {s.cachedFormulas > 0 && ` · ${s.cachedFormulas} kept at Excel's value`}
                  </span>
                </li>
              ))}
            </ul>
            {parsed.sheets.some((s) => s.cachedFormulas > 0) && (
              <p className="text-xs text-muted-foreground">
                Formulas that use a function Sheets does not compute yet show the value Excel last
                saved, and say so on hover. They are kept as written, so the file goes back to Excel
                unchanged.
              </p>
            )}
            {parsed.warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                {parsed.warnings.slice(0, 8).map((w, i) => (
                  <li key={i} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {w}
                  </li>
                ))}
                {parsed.warnings.length > 8 && <li>…and {parsed.warnings.length - 8} more</li>}
              </ul>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!parsed || saving || reading}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {workbookId ? "Add sheets" : "Create workbook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
