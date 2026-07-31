// Dataset upload modal — drag-and-drop CSV / TSV / JSON / NDJSON / Excel,
// streamed to the server, which parses and materialises it.
//
// The file is NOT parsed here any more. The old browser path capped a dataset
// at whatever fitted in a tab's memory and inserted rows one page at a time
// over RLS; a 200k-row CSV took minutes and a 2M-row one was impossible. The
// browser's job is now to send bytes and report progress.
//
// The schema preview therefore lands AFTER the upload rather than before it,
// which is the honest trade: we can't show a real schema without reading the
// whole file, and guessing from the first chunk would misreport types for any
// column whose interesting values come later. A mistaken upload is recoverable
// from the dataset's version history.
import { useRef, useState } from "react";
import { Check, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import {
  detectFormat,
  formatLabel,
  isStreamingFormat,
  safeTableName,
  UPLOAD_ACCEPT,
  type ColumnDef,
  type DatasetFormat,
} from "@/lib/datasetParse";

type UploadResult = {
  tableName: string;
  rowCount: number;
  columns: ColumnDef[];
  format: DatasetFormat;
  skipped: number;
};

export function CsvUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Kept for call-site compatibility; the server derives the owner from the token. */
  userId?: string;
  onUploaded: () => void;
}) {
  const { session } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<DatasetFormat | null>(null);
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentPct, setSentPct] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setFormat(null);
    setTableName("");
    setBusy(false);
    setSentPct(0);
    setResult(null);
  }

  function handleFile(f: File) {
    const fmt = detectFormat(f.name, f.type);
    if (!fmt) {
      toast.error(
        f.name.toLowerCase().endsWith(".xls")
          ? "Legacy .xls isn't supported — re-save it as .xlsx."
          : "Unsupported file type. Use CSV, TSV, JSON, NDJSON or Excel (.xlsx).",
      );
      return;
    }
    setFile(f);
    setFormat(fmt);
    setTableName(safeTableName(f.name.replace(/\.[^.]+$/, "")));
    setResult(null);
  }

  /**
   * XMLHttpRequest rather than fetch: it reports upload progress, and for a
   * large file "it's working" is the difference between waiting and reloading
   * the page. (fetch's request streaming has no progress events.)
   */
  function upload() {
    if (!file || !format || !session?.access_token) return;
    setBusy(true);
    setSentPct(0);

    const url =
      `/api/data/upload?filename=${encodeURIComponent(file.name)}` +
      `&name=${encodeURIComponent(tableName)}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setSentPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setBusy(false);
      let body: { error?: string } & Partial<UploadResult>;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        toast.error("The server returned an unreadable response.");
        return;
      }
      if (xhr.status !== 200) {
        toast.error(body.error ?? `Upload failed (${xhr.status})`);
        return;
      }
      setResult({
        tableName: body.tableName ?? tableName,
        rowCount: body.rowCount ?? 0,
        columns: body.columns ?? [],
        format: body.format ?? format,
        skipped: body.skipped ?? 0,
      });
      onUploaded();
    };
    xhr.onerror = () => {
      setBusy(false);
      toast.error("The upload could not reach the server.");
    };
    xhr.send(file);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{result ? "Dataset created" : "Upload a dataset"}</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
              <Check className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <div className="text-xs">
                <p className="font-mono font-medium">{result.tableName}</p>
                <p className="text-muted-foreground">
                  {result.rowCount.toLocaleString()} rows · {result.columns.length} columns ·{" "}
                  {formatLabel(result.format)}
                  {result.skipped > 0 && ` · ${result.skipped.toLocaleString()} empty rows skipped`}
                </p>
              </div>
            </div>

            <div>
              <Label className="mb-1 block text-xs">Detected schema</Label>
              <div className="max-h-48 overflow-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <tbody>
                    {result.columns.map((c) => (
                      <tr key={c.name} className="border-b border-border/50 last:border-0">
                        <td className="px-2 py-1 font-mono">{c.name}</td>
                        <td className="px-2 py-1 text-right text-muted-foreground">{c.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Wrong type on a column? Fix it in a data-prep flow — and if the whole file was
                wrong, the previous contents are in this dataset&rsquo;s version history.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset}>
                Upload another
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : !file ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Drop a file here, or click to browse</p>
            <p className="mt-1 text-xs text-muted-foreground">
              CSV, TSV, JSON, NDJSON or Excel (.xlsx). Parsing happens on the server, so large files
              are fine.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
              <FileText className="mt-0.5 h-4 w-4 text-primary" />
              <div className="min-w-0 text-xs">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB · {format && formatLabel(format)}
                  {format && !isStreamingFormat(format) && " · read whole-file"}
                </p>
              </div>
            </div>

            <div>
              <Label className="text-xs">Table name</Label>
              <Input
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                disabled={busy}
                className="mt-1 font-mono text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Saved as <code>{safeTableName(tableName || "dataset")}</code>. An existing dataset
                with this name is replaced — its current contents are kept as a restorable version.
              </p>
            </div>

            {busy && (
              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-200"
                    style={{ width: `${sentPct}%` }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {sentPct < 100
                    ? `Uploading — ${sentPct}%`
                    : "Uploaded. Parsing and writing rows on the server…"}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
                Choose another
              </Button>
              <Button size="sm" onClick={upload} disabled={busy || !tableName.trim()}>
                {busy ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                Create dataset
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
