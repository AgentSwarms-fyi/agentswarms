// Dashboard version history: automatic snapshots (throttled on autosave)
// plus named manual saves, with one-click restore. Owner-only — versions
// live in bi_dashboard_versions under owner RLS.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, RotateCcw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listDashboardVersions,
  parseWidgets,
  restoreDashboardVersion,
  saveDashboardVersion,
  type BiDashboardRow,
  type BiVersionRow,
} from "@/lib/biDashboards";

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function BiHistoryDialog({
  open,
  onOpenChange,
  row,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The dashboard's current persisted state (what a manual save snapshots). */
  row: BiDashboardRow;
  /** Called after a successful restore so the editor reloads its state. */
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<BiVersionRow[] | null>(null);
  const [label, setLabel] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    listDashboardVersions(row.id)
      .then(setVersions)
      .catch((e) => {
        toast.error((e as Error).message);
        setVersions([]);
      });
  }, [open, row.id]);

  async function saveNow() {
    setSaving(true);
    try {
      await saveDashboardVersion(row, label.trim() || "Manual save");
      setLabel("");
      setVersions(await listDashboardVersions(row.id));
      toast.success("Version saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function restore(v: BiVersionRow) {
    setBusyId(v.id);
    try {
      // Snapshot the current state first so the restore itself is undoable.
      await saveDashboardVersion(row, "Before restore");
      await restoreDashboardVersion(v);
      toast.success(`Restored version from ${relTime(v.created_at)}`);
      onOpenChange(false);
      onRestored();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" /> Version history
          </DialogTitle>
          <DialogDescription className="text-xs">
            Snapshots are captured automatically as you edit (at most every 10 minutes) and whenever
            you save one manually. Restoring first snapshots the current state.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !saving && void saveNow()}
            placeholder="Label this version (optional)"
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={saveNow}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save version
          </Button>
        </div>

        <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          {versions === null ? (
            <>
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No versions yet — keep editing, or save one above.
            </p>
          ) : (
            versions.map((v) => {
              const widgetCount = parseWidgets(v.widgets).length;
              return (
                <div
                  key={v.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{v.label ?? "Auto-save"}</span>
                      {!v.label && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                          auto
                        </Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {relTime(v.created_at)} · {widgetCount} widget{widgetCount === 1 ? "" : "s"} ·{" "}
                      {v.name}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={() => void restore(v)}
                    disabled={busyId !== null}
                  >
                    {busyId === v.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Restore
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
