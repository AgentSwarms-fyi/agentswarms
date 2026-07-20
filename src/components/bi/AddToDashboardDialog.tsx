// "Add to dashboard" picker: inserts a finished BI-agent visual into an
// existing BI project or a brand-new one. Used from the Data & SQL page.
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { LayoutDashboard, Loader2 } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { BiTurn } from "@/lib/biAgent";
import {
  appendWidgetToDashboard,
  createDashboard,
  listDashboards,
  widgetFromBiTurn,
  type BiDashboardRow,
  type BiWidgetSource,
} from "@/lib/biDashboards";

const NEW_PROJECT = "__new__";

export function AddToDashboardDialog({
  open,
  onOpenChange,
  turn,
  source,
  userId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  turn: BiTurn | null;
  source: BiWidgetSource;
  userId: string | null;
}) {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<BiDashboardRow[] | null>(null);
  const [target, setTarget] = useState<string>(NEW_PROJECT);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDashboards(null);
    listDashboards()
      .then((rows) => {
        const mine = rows.filter((r) => r.user_id === userId);
        setDashboards(mine);
        setTarget(mine[0]?.id ?? NEW_PROJECT);
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setDashboards([]);
      });
    setNewName("");
  }, [open, userId]);

  async function submit() {
    if (!turn || !userId) return;
    const widget = widgetFromBiTurn(turn, source);
    if (!widget) return toast.error("This answer has no result to insert");
    if (target === NEW_PROJECT && !newName.trim()) {
      return toast.error("Name the new BI project");
    }
    setBusy(true);
    try {
      let dashboardId = target;
      let dashboardName = dashboards?.find((d) => d.id === target)?.name ?? "";
      if (target === NEW_PROJECT) {
        const row = await createDashboard({ userId, name: newName.trim() });
        dashboardId = row.id;
        dashboardName = row.name;
      }
      await appendWidgetToDashboard(dashboardId, widget);
      onOpenChange(false);
      toast.success(`Added to "${dashboardName}"`, {
        action: {
          label: "Open",
          onClick: () => void navigate({ to: "/bi/$dashboardId", params: { dashboardId } }),
        },
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-primary" /> Add to dashboard
          </DialogTitle>
          <DialogDescription>
            Insert this visual (chart, SQL and data snapshot) into a BI project.
          </DialogDescription>
        </DialogHeader>

        {dashboards === null ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>BI project</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dashboards.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_PROJECT}>＋ New BI project…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {target === NEW_PROJECT && (
              <div className="space-y-1.5">
                <Label>New project name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Sales overview"
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || dashboards === null}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Insert widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
