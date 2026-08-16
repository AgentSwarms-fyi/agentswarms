// Import a dbt project's models into the semantic layer.
//
// Three steps, deliberately: pick the warehouse those tables live in → read
// target/manifest.json → review what came out before anything is saved. The
// review step is the point. A manifest holds models with no documented
// columns, ephemeral models with no table behind them, and aggregations this
// layer cannot express, and the user has to see which of their models did not
// make it and why — otherwise the import is a number they cannot check.
//
// Nothing is written until "Import". Collisions with existing models are
// listed and switched OFF, because an import that quietly replaced a certified
// model would destroy the one definition somebody had validated.
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FileJson, Loader2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  collidingNames,
  describeImport,
  parseDbtManifest,
  type DbtImportResult,
} from "@/lib/dbtManifest";

export type DbtImportConnection = { id: string; name: string };

export function DbtImportDialog({
  open,
  onOpenChange,
  connections,
  existingNames,
  onImport,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Warehouse connections — a dbt model is a table in one of them. */
  connections: DbtImportConnection[];
  /** Names already in the semantic layer, for collision marking. */
  existingNames: string[];
  /** Saves one model. Rejecting is fine — the caller reports per model. */
  onImport: (models: DbtImportResult["models"]) => Promise<{ saved: number; failed: string[] }>;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [result, setResult] = useState<DbtImportResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const collisions = useMemo(
    () => (result ? collidingNames(result, existingNames) : new Set<string>()),
    [result, existingNames],
  );

  const reset = () => {
    setResult(null);
    setParseError(null);
    setPicked(new Set());
  };

  const readFile = async (file: File) => {
    reset();
    if (!connectionId) return setParseError("Choose the warehouse these dbt models are built in.");
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setParseError("Could not read that file.");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // The parser's own message names the offset, which is what tells someone
      // they picked a truncated or half-written file.
      return setParseError(`That file is not valid JSON. ${(e as Error).message}`);
    }
    try {
      const r = parseDbtManifest(json, { connectionId });
      setResult(r);
      // Everything importable is on by default EXCEPT collisions.
      const colliding = collidingNames(r, existingNames);
      setPicked(new Set(r.models.map((m) => m.name).filter((n) => !colliding.has(n))));
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const doImport = async () => {
    if (!result) return;
    const chosen = result.models.filter((m) => picked.has(m.name));
    if (chosen.length === 0) return toast.error("Nothing selected to import.");
    setBusy(true);
    try {
      const { saved, failed } = await onImport(chosen);
      if (failed.length) {
        // Partial success is reported as a problem. A model that failed to
        // save is a model the user believes they have.
        toast.warning(
          `Imported ${saved} of ${chosen.length}. Failed: ${failed.slice(0, 3).join(", ")}${
            failed.length > 3 ? ` and ${failed.length - 3} more` : ""
          }`,
        );
      } else {
        toast.success(`Imported ${saved} model${saved === 1 ? "" : "s"} as drafts`);
      }
      onOpenChange(false);
      reset();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="h-4 w-4" /> Import from dbt
          </DialogTitle>
          <DialogDescription>
            Reads <code>target/manifest.json</code> — the file dbt writes on every run. Models,
            their documented columns and any MetricFlow measures come across as draft models.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Warehouse</Label>
            <Select
              value={connectionId}
              onValueChange={(v) => {
                setConnectionId(v);
                reset();
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Where dbt builds these tables…" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              A dbt model is a table in its target warehouse. Pick the wrong one and the models
              import cleanly and then fail to run.
            </p>
          </div>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!connectionId}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" /> Choose manifest.json
            </Button>
          </div>

          {parseError && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {parseError}
            </p>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-md border border-border/60 bg-muted/40 p-2 text-[11px]">
                <p className="font-medium">{describeImport(result)}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {[
                    result.project.name,
                    result.project.dbtVersion && `dbt ${result.project.dbtVersion}`,
                    result.project.adapter,
                    result.project.generatedAt &&
                      `generated ${new Date(result.project.generatedAt).toLocaleString()}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "This manifest records nothing about its project."}
                </p>
              </div>

              {result.models.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Import these</Label>
                  <ScrollArea className="max-h-52 rounded-md border border-border/50">
                    <div className="space-y-0.5 p-2">
                      {result.models.map((m) => {
                        const clash = collisions.has(m.name);
                        return (
                          <label
                            key={m.name}
                            className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs hover:bg-muted/60"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={picked.has(m.name)}
                              onChange={() => toggle(m.name)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="font-mono">{m.name}</span>
                              <span className="ml-1.5 text-muted-foreground">
                                {m.dimensions.length} dim · {m.metrics.length} metric
                                {m.metrics.length === 1 ? "" : "s"}
                              </span>
                              {clash && (
                                <Badge
                                  variant="outline"
                                  className="ml-1.5 border-amber-500/40 text-[9px] text-amber-600 dark:text-amber-400"
                                >
                                  replaces an existing model
                                </Badge>
                              )}
                              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                                {m.source.kind === "warehouse" ? m.source.table : ""}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {result.skipped.length > 0 && (
                <div className="space-y-1">
                  {/* NOT behind a disclosure. The skipped list is the half of
                      the result a user cannot get anywhere else — hiding it is
                      how an import comes to look complete. */}
                  <Label className="text-xs text-amber-600 dark:text-amber-400">
                    Not imported ({result.skipped.length})
                  </Label>
                  <ScrollArea className="max-h-40 rounded-md border border-amber-500/30 bg-amber-500/5">
                    <ul className="space-y-1 p-2 text-[11px]">
                      {result.skipped.map((s, i) => (
                        <li key={`${s.ref}-${i}`}>
                          <span className="font-mono">{s.ref}</span>{" "}
                          <span className="text-muted-foreground">— {s.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}

              {result.models.length === 0 && (
                <p className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
                  Nothing in this manifest could be imported. The list above says why for each —
                  most often the project has no column descriptions in <code>schema.yml</code>, so
                  dbt records no columns to turn into dimensions.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void doImport()} disabled={busy || picked.size === 0}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Import {picked.size > 0 ? picked.size : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
