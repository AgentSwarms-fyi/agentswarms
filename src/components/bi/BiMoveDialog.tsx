// "Move to…" dialog for a BI dashboard: pick a target workspace (or Personal)
// and an optional folder within it, then persist via moveDashboard. Only the
// dashboard owner can move it (writes are owner-only under RLS), so the caller
// should only surface this for owned dashboards.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FolderInput, Loader2 } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BiDashboardRow } from "@/lib/biDashboards";
import { moveDashboard, type BiFolder, type BiWorkspace } from "@/lib/biWorkspaces";

const PERSONAL = "__personal__";
const NO_FOLDER = "__none__";

export function BiMoveDialog({
  dashboard,
  workspaces,
  folders,
  onClose,
  onMoved,
}: {
  dashboard: BiDashboardRow | null;
  workspaces: BiWorkspace[];
  folders: BiFolder[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState<string>(PERSONAL);
  const [folderId, setFolderId] = useState<string>(NO_FOLDER);
  const [busy, setBusy] = useState(false);

  // Seed from the dashboard's current placement each time it opens.
  useEffect(() => {
    if (dashboard) {
      setWorkspaceId(dashboard.workspace_id ?? PERSONAL);
      setFolderId(dashboard.folder_id ?? NO_FOLDER);
    }
  }, [dashboard]);

  // Folders belonging to the chosen scope (personal = no workspace).
  const scopedFolders = useMemo(
    () =>
      folders.filter((f) =>
        workspaceId === PERSONAL ? f.workspace_id === null : f.workspace_id === workspaceId,
      ),
    [folders, workspaceId],
  );

  async function submit() {
    if (!dashboard) return;
    setBusy(true);
    try {
      await moveDashboard(dashboard.id, {
        workspace_id: workspaceId === PERSONAL ? null : workspaceId,
        folder_id: folderId === NO_FOLDER ? null : folderId,
      });
      toast.success("Dashboard moved");
      onMoved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={dashboard !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-4 w-4 text-primary" /> Move “{dashboard?.name}”
          </DialogTitle>
          <DialogDescription>
            Place this dashboard in a shared workspace (its members can view it) or keep it
            personal.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Workspace</Label>
            <Select
              value={workspaceId}
              onValueChange={(v) => {
                setWorkspaceId(v);
                setFolderId(NO_FOLDER); // folders are scoped to a workspace
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONAL}>Personal (only you)</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Folder</Label>
            <Select value={folderId} onValueChange={setFolderId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FOLDER}>No folder</SelectItem>
                {scopedFolders.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
