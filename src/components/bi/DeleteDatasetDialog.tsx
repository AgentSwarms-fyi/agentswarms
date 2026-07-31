// Impact-aware dataset deletion.
//
// Deleting a dataset used to be a bare confirm(). Everything downstream —
// prep flows, semantic models, dashboard widgets, saved metrics — then broke
// silently: a flow would reset itself to empty on next open, a model would
// start erroring with no explanation. Enterprise tools show impact BEFORE a
// destructive change; this dialog is that, and it is the only path to
// deleting a dataset in the app.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";
import type { DatasetDependents } from "@/utils/dataPrep.functions";

export type DeleteTarget = { id: string; name: string };

export function DeleteDatasetDialog({
  target,
  onOpenChange,
  loadDependents,
  onConfirm,
}: {
  /** null closes the dialog. */
  target: DeleteTarget | null;
  onOpenChange: (open: boolean) => void;
  loadDependents: (tableId: string) => Promise<DatasetDependents>;
  onConfirm: (target: DeleteTarget) => Promise<void>;
}) {
  const [deps, setDeps] = useState<DatasetDependents | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setDeps(null);
    setLoadError(null);
    setConfirmText("");
    let cancelled = false;
    void (async () => {
      try {
        const d = await loadDependents(target.id);
        if (!cancelled) setDeps(d);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not check usage");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, loadDependents]);

  const groups = deps
    ? [
        { label: "Prep flows that read it", items: deps.flowsUsing.map((f) => f.name) },
        { label: "Prep flows that produce it", items: deps.flowsProducing.map((f) => f.name) },
        { label: "Semantic models", items: deps.semanticModels.map((m) => m.name) },
        { label: "Dashboards referencing it in SQL", items: deps.dashboards.map((d) => d.name) },
      ].filter((g) => g.items.length > 0)
    : [];
  const impactCount = groups.reduce((n, g) => n + g.items.length, 0) + (deps?.savedMetrics ?? 0);
  // A dataset nothing depends on deletes with one click; a dataset with
  // dependents requires typing its name, the standard "dangerous action" gate.
  const needsTyping = impactCount > 0;
  const canDelete = !busy && deps !== null && (!needsTyping || confirmText.trim() === target?.name);

  async function handleDelete() {
    if (!target || !canDelete) return;
    setBusy(true);
    try {
      await onConfirm(target);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Delete “{target?.name}”
          </DialogTitle>
          <DialogDescription>
            The dataset and all of its rows are removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {deps === null && !loadError ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : loadError ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            Couldn&apos;t check what depends on this dataset ({loadError}). Deleting anyway may
            break flows, models or dashboards.
          </div>
        ) : impactCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing else references this dataset — safe to delete.
          </p>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-xs text-destructive/90">
                <strong>
                  {impactCount} thing{impactCount === 1 ? "" : "s"} depend
                  {impactCount === 1 ? "s" : ""} on this dataset
                </strong>{" "}
                and will stop working. Prep flows lose their source, semantic models and dashboard
                widgets start erroring.
              </p>
            </div>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {groups.map((g) => (
                <div key={g.label}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.label}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {g.items.map((name) => (
                      <li key={name} className="truncate font-mono text-xs">
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {deps && deps.savedMetrics > 0 && (
                <p className="text-xs text-muted-foreground">
                  {deps.savedMetrics} saved metric{deps.savedMetrics === 1 ? "" : "s"} defined on
                  this table.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Type <span className="font-mono">{target?.name}</span> to confirm
              </Label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={target?.name}
                className="h-8 font-mono"
                autoComplete="off"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={!canDelete}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete dataset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
