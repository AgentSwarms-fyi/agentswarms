// CSV upload modal — drag-and-drop, parse with PapaParse, schema preview,
// then persist via saveDataset.
import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, FileText, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { parseCsv, saveDataset, safeTableName, type ParsedCsv } from "@/lib/sqlEngine";

export function CsvUploadDialog({
  open,
  onOpenChange,
  userId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: string;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null); setParsed(null); setTableName(""); setBusy(false);
  }

  async function handleFile(f: File) {
    if (!f.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a .csv file");
      return;
    }
    setFile(f);
    setBusy(true);
    try {
      const p = await parseCsv(f);
      if (p.rows.length === 0) {
        toast.error("CSV is empty");
        setBusy(false);
        return;
      }
      setParsed(p);
      const guess = f.name.replace(/\.csv$/i, "");
      setTableName(safeTableName(guess));
    } catch (e) {
      toast.error(`Parse failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!parsed || !tableName.trim()) return;
    setBusy(true);
    try {
      await saveDataset({
        userId,
        tableName,
        sourceFilename: file?.name ?? null,
        rows: parsed.rows,
        columns: parsed.columns,
        versionReason: "upload",
      });
      toast.success(`Created table ${safeTableName(tableName)} with ${parsed.rows.length} rows`);
      onUploaded();
      onOpenChange(false);
      reset();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload CSV</DialogTitle>
        </DialogHeader>

        {!parsed ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => inputRef.current?.click()}
            className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {busy ? (
              <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground" />
            ) : (
              <>
                <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Drop a CSV here, or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">Tables are stored in your account and persist across sessions.</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3 flex items-start gap-2">
              <FileText className="h-4 w-4 text-primary mt-0.5" />
              <div className="text-xs">
                <p className="font-medium">{file?.name}</p>
                <p className="text-muted-foreground">{parsed.rows.length.toLocaleString()} rows · {parsed.columns.length} columns</p>
              </div>
            </div>

            <div>
              <Label className="text-xs">Table name</Label>
              <Input
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                className="font-mono text-xs mt-1"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Will be sanitized to: <code>{safeTableName(tableName || "table")}</code>
              </p>
            </div>

            <div>
              <Label className="text-xs mb-1 block">Schema preview</Label>
              <div className="rounded-md border border-border max-h-48 overflow-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {parsed.columns.map((c) => (
                      <tr key={c.name} className="border-b border-border/50 last:border-0">
                        <td className="px-2 py-1 font-mono">{c.name}</td>
                        <td className="px-2 py-1 text-right text-muted-foreground">{c.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={reset}>Choose another</Button>
              <Button size="sm" onClick={handleSave} disabled={busy || !tableName.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
                Create table
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
