// Sharing an analyst with IAM groups.
//
// The caveats are not decoration. Sharing an analyst does NOT share the
// owner's data access — recipients query as themselves — which means a shared
// analyst can legitimately return different numbers to different people. That
// is surprising enough that the dialog states it BEFORE the grant is made,
// with blocking problems ranked above advisory ones.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Info, Loader2, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { rankCaveats, shareCaveats } from "@/lib/analystSharing";
import { analystGetShares, analystSetShares } from "@/utils/analyst.functions";
import { biListShareTargets } from "@/utils/bi.functions";
import type { AnalystSource } from "@/lib/aiAnalyst";

export function ShareAnalystDialog({
  open,
  onOpenChange,
  analyst,
  accessToken,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  analyst: { id: string; name: string; source: AnalystSource } | null;
  accessToken: string | null;
}) {
  const listTargetsFn = useServerFn(biListShareTargets);
  const getSharesFn = useServerFn(analystGetShares);
  const setSharesFn = useServerFn(analystSetShares);

  const [groups, setGroups] = useState<{ id: string; name: string }[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !analyst) return;
    setGroups(null);
    const [targets, shares] = await Promise.all([
      listTargetsFn({ data: { access_token: accessToken } }),
      getSharesFn({ data: { access_token: accessToken, analyst_id: analyst.id } }),
    ]);
    setGroups(targets.ok ? targets.groups : []);
    setSelected(new Set(shares.ok ? shares.group_ids : []));
  }, [accessToken, analyst, listTargetsFn, getSharesFn]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    if (!accessToken || !analyst) return;
    setBusy(true);
    const res = await setSharesFn({
      data: {
        access_token: accessToken,
        analyst_id: analyst.id,
        group_ids: [...selected],
      },
    });
    setBusy(false);
    // The server refuses a share whose groups may not use the analyst's model,
    // and says which — surfacing that verbatim beats a generic failure.
    if (!res.ok) return toast.error(res.error);
    toast.success("Group access updated");
    onOpenChange(false);
  }

  const caveats = analyst ? rankCaveats(shareCaveats({ source: analyst.source })) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" /> Share {analyst?.name ?? "analyst"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Recipients can open this analyst and ask their own questions. Every query they run is
            authorised as <strong>them</strong> — not as you.
          </p>

          <ul className="space-y-1.5">
            {caveats.map((c) => (
              <li
                key={c.text}
                className={`flex items-start gap-1.5 rounded-md border p-2 text-[11px] leading-relaxed ${
                  c.severity === "blocking"
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-border/60 bg-muted/30 text-muted-foreground"
                }`}
              >
                {c.severity === "blocking" ? (
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                ) : (
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                <span>{c.text}</span>
              </li>
            ))}
          </ul>

          <div>
            <p className="mb-1.5 text-sm font-medium">Share with groups</p>
            {groups === null ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : groups.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                No groups exist yet. Superadmins can create them under Admin → IAM.
              </p>
            ) : (
              <div className="max-h-44 space-y-1.5 overflow-y-auto">
                {groups.map((g) => (
                  <Label
                    key={g.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm font-normal hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={selected.has(g.id)}
                      onCheckedChange={(v) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(g.id);
                          else next.delete(g.id);
                          return next;
                        })
                      }
                    />
                    {g.name}
                  </Label>
                ))}
              </div>
            )}
          </div>

          {groups !== null && groups.length > 0 && (
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-[10px]">
                Individual grants are managed in Admin → IAM
              </Badge>
              <Button size="sm" className="h-7 text-xs" onClick={save} disabled={busy}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save group access"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
