// Publish & share a BI project: toggle the public read-only link and manage
// which IAM groups can see the dashboard inside the app.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Copy, Cpu, Globe, Loader2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import {
  makePublicSlug,
  publicDashboardUrl,
  updateDashboard,
  type BiDashboardRow,
} from "@/lib/biDashboards";
import {
  biGetShares,
  biListShareTargets,
  biSetReaderModel,
  biSetShares,
} from "@/utils/bi.functions";

export function PublishDialog({
  open,
  onOpenChange,
  dashboard,
  accessToken,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dashboard: BiDashboardRow;
  accessToken: string | null;
  onUpdated: (patch: Partial<BiDashboardRow>) => void;
}) {
  const listTargetsFn = useServerFn(biListShareTargets);
  const getSharesFn = useServerFn(biGetShares);
  const setSharesFn = useServerFn(biSetShares);
  const setModelFn = useServerFn(biSetReaderModel);

  const [groups, setGroups] = useState<{ id: string; name: string }[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [userGrants, setUserGrants] = useState(0);
  const [busyPublish, setBusyPublish] = useState(false);
  const [busyShares, setBusyShares] = useState(false);
  const [busyModel, setBusyModel] = useState(false);
  const [copied, setCopied] = useState(false);

  async function saveReaderModel(model: string | null) {
    if (!accessToken) return;
    setBusyModel(true);
    try {
      const res = await setModelFn({
        data: { access_token: accessToken, dashboard_id: dashboard.id, model },
      });
      if (!res.ok) return toast.error(res.error);
      onUpdated({ ai_model: model });
      toast.success(model ? "Reader AI model set" : "Reader AI model reset to default");
    } finally {
      setBusyModel(false);
    }
  }

  useEffect(() => {
    if (!open || !accessToken) return;
    setGroups(null);
    Promise.all([
      listTargetsFn({ data: { access_token: accessToken } }),
      getSharesFn({ data: { access_token: accessToken, dashboard_id: dashboard.id } }),
    ]).then(([targets, shares]) => {
      setGroups(targets.ok ? targets.groups : []);
      if (!targets.ok) toast.error(targets.error);
      if (shares.ok) {
        setSelected(new Set(shares.group_ids));
        setUserGrants(shares.user_grants);
      } else {
        toast.error(shares.error);
      }
    });
  }, [open, accessToken, dashboard.id, listTargetsFn, getSharesFn]);

  async function togglePublish(next: boolean) {
    setBusyPublish(true);
    try {
      const patch = next
        ? {
            published: true,
            public_slug: dashboard.public_slug ?? makePublicSlug(),
            published_at: new Date().toISOString(),
          }
        : { published: false };
      await updateDashboard(dashboard.id, patch);
      onUpdated(patch);
      toast.success(next ? "Dashboard published" : "Dashboard unpublished — the link is disabled");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyPublish(false);
    }
  }

  async function saveShares() {
    if (!accessToken) return;
    setBusyShares(true);
    try {
      const res = await setSharesFn({
        data: {
          access_token: accessToken,
          dashboard_id: dashboard.id,
          group_ids: [...selected],
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success("Group access updated");
    } finally {
      setBusyShares(false);
    }
  }

  const link = dashboard.public_slug ? publicDashboardUrl(dashboard.public_slug) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish &amp; share</DialogTitle>
          <DialogDescription>
            Viewers see the saved data snapshots — never your connections or credentials.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: this is a CSS-grid child of DialogContent; without it a long
            public link's intrinsic width propagates up and overflows the dialog. */}
        <div className="min-w-0 space-y-5">
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary" />
                <div>
                  <p className="text-sm font-medium">Public link</p>
                  <p className="text-xs text-muted-foreground">
                    Anyone with the link can view this dashboard, read-only.
                  </p>
                </div>
              </div>
              {busyPublish ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Switch checked={dashboard.published} onCheckedChange={togglePublish} />
              )}
            </div>
            {dashboard.published && link && (
              <div className="mt-3 flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-[11px]">
                  {link}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 shrink-0 gap-1 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  Copy
                </Button>
              </div>
            )}
            {dashboard.published && link && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1.5 h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `<iframe src="${link}?embed=1" width="100%" height="640" style="border:0;border-radius:8px" loading="lazy"></iframe>`,
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                title="Copy an <iframe> snippet that renders the dashboard chrome-less"
              >
                <Copy className="h-3 w-3" /> Copy embed code
              </Button>
            )}
          </div>

          <div className="rounded-lg border border-border/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-medium">Reader AI model</p>
                <p className="text-xs text-muted-foreground">
                  Signed-in viewers use this text model to ask AI questions about the dashboard's
                  data. Shared groups must be allowed this model under IAM.
                </p>
              </div>
            </div>
            <BiModelSelect
              value={dashboard.ai_model}
              onChange={(m) => void saveReaderModel(m)}
              disabled={busyModel}
              className="w-full"
              allowUnset
            />
            <p className="mt-2 text-[10px] text-muted-foreground">
              The anonymous public link shows data only — AI Q&amp;A is for signed-in viewers.
            </p>
          </div>

          <div className="rounded-lg border border-border/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-medium">Share with groups</p>
                <p className="text-xs text-muted-foreground">
                  Members see it read-only in their BI Workspace.
                </p>
              </div>
            </div>
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
            {userGrants > 0 && (
              <Badge variant="outline" className="mt-2 text-[10px]">
                +{userGrants} individual grant{userGrants === 1 ? "" : "s"} managed in Admin → IAM
              </Badge>
            )}
            {groups !== null && groups.length > 0 && (
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={saveShares}
                  disabled={busyShares}
                >
                  {busyShares ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save group access"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
