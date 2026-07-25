// "Promote" dialog: publish a dashboard's current state into a target
// workspace (dev→prod). The first promotion creates a copy in that workspace;
// a later promotion re-syncs the same copy. Only offered for owned dashboards
// (the promoter owns the resulting copy).
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Rocket } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BiDashboardRow } from "@/lib/biDashboards";
import { promoteDashboard, type BiWorkspace } from "@/lib/biWorkspaces";

export function BiPromoteDialog({
  dashboard,
  workspaces,
  userId,
  onClose,
  onDone,
}: {
  dashboard: BiDashboardRow | null;
  workspaces: BiWorkspace[];
  userId: string | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const [targetWs, setTargetWs] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!dashboard || !userId || !targetWs) return;
    setBusy(true);
    try {
      const outcome = await promoteDashboard({
        userId,
        source: dashboard,
        targetWorkspaceId: targetWs,
        note: note.trim() || undefined,
      });
      toast.success(
        outcome === "created"
          ? "Promoted — a copy was created in the workspace"
          : "Re-synced the promoted copy in the workspace",
      );
      setNote("");
      setTargetWs("");
      onDone();
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
            <Rocket className="h-4 w-4 text-primary" /> Promote “{dashboard?.name}”
          </DialogTitle>
          <DialogDescription>
            Publishes this dashboard&apos;s current state into a workspace as a governed copy.
            Promoting again to the same workspace re-syncs that copy (its own publish link is kept).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Target workspace</Label>
            <Select value={targetWs} onValueChange={setTargetWs}>
              <SelectTrigger>
                <SelectValue
                  placeholder={workspaces.length ? "Pick a workspace…" : "No workspaces available"}
                />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="What changed in this release"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !targetWs}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
