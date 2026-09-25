// File → Version history: the workbook as it stood at earlier moments,
// taken automatically while people edit, by hand with a name, and before
// every restore. Open one as a new workbook to look at it, or restore it.

import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { versionPhrase } from "@/lib/sheets/versionNames";
import {
  sheetsVersionOpenCopy,
  sheetsVersionRestore,
  sheetsVersionSave,
  sheetsVersionsList,
  type VersionSummary,
} from "@/utils/sheetsVersions.functions";

const KIND: Record<VersionSummary["kind"], string> = {
  auto: "Automatic",
  named: "Named",
  before_restore: "Before a restore",
};

function size(n: number): string {
  return n > 1_000_000
    ? `${(n / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1000))} KB`;
}

export function VersionHistoryDialog({
  token,
  workbookId,
  flush,
  onRestored,
  onOpened,
  onClose,
}: {
  token: string | undefined;
  workbookId: string;
  /** Save any edit still waiting, so a version holds what is on screen. */
  flush: () => Promise<void>;
  onRestored: () => void;
  onOpened: (workbookId: string) => void;
  onClose: () => void;
}) {
  const listFn = useServerFn(sheetsVersionsList);
  const saveFn = useServerFn(sheetsVersionSave);
  const restoreFn = useServerFn(sheetsVersionRestore);
  const openFn = useServerFn(sheetsVersionOpenCopy);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const r = await listFn({ data: { access_token: token, workbook_id: workbookId } });
      if (!r.ok) setError(r.error);
      else setVersions(r.versions);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId, listFn]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!token || !label.trim()) return;
    setBusy("save");
    try {
      await flush();
      const r = await saveFn({
        data: { access_token: token, workbook_id: workbookId, label: label.trim() },
      });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(`Saved the version "${label.trim()}"`);
        setLabel("");
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const restore = async (v: VersionSummary) => {
    if (!token) return;
    const shown = new Date(v.created_at).toLocaleString();
    const ok = await confirmAsk({
      title: "Restore this version?",
      body: `Every sheet goes back to how it was in ${versionPhrase(v, shown)}. What is there now is kept as a version first, so this can be undone from here.`,
      actionLabel: "Restore",
    });
    if (!ok) return;
    setBusy(v.id);
    try {
      await flush();
      const r = await restoreFn({
        data: { access_token: token, workbook_id: workbookId, version_id: v.id, shown },
      });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(`Restored ${versionPhrase(v, shown)}`);
        onRestored();
      }
    } finally {
      setBusy(null);
    }
  };

  const openCopy = async (v: VersionSummary) => {
    if (!token) return;
    setBusy(v.id);
    try {
      const r = await openFn({
        data: {
          access_token: token,
          workbook_id: workbookId,
          version_id: v.id,
          shown: new Date(v.created_at).toLocaleString(),
        },
      });
      if (!r.ok) toast.error(r.error);
      else onOpened(r.workbook_id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="version-history">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Version history
          </DialogTitle>
          <DialogDescription>
            A version is kept automatically as you work, and before every restore. Open one as a new
            workbook to look at it, or restore it here.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name this version (e.g. Sent to finance)"
            aria-label="Version name"
            maxLength={200}
          />
          <Button type="submit" disabled={!label.trim() || !!busy} data-testid="version-save">
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save version"}
          </Button>
        </form>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!versions && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {versions && versions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No versions yet. One is taken automatically as you edit.
          </p>
        )}
        {versions && versions.length > 0 && (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded border border-border">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
                data-testid="version-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {v.label ?? new Date(v.created_at).toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {KIND[v.kind]} ·{" "}
                    {v.label ? `${new Date(v.created_at).toLocaleString()} · ` : ""}
                    {v.sheet_count} sheet{v.sheet_count === 1 ? "" : "s"} · {size(v.size_bytes)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void openCopy(v)}
                >
                  Open a copy
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void restore(v)}
                  data-testid="version-restore"
                >
                  {busy === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
