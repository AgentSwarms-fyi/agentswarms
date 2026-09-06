// "Teams" tab of the Integration Hub: bot registrations allowed to ask an
// agent or the analyst a question from Microsoft Teams.
//
// The mirror of the Slack tab, and the same distinction is the point of the
// screen: a saved row proves somebody filled in a form, not that Teams can
// reach this deployment. That fails for the ordinary reasons — the app is on
// localhost, the messaging endpoint has a typo, the manifest was never
// uploaded — so "Configured" and "Receiving messages" are shown as different
// things, and only Microsoft can set the second.
//
// One difference from Slack worth stating on the screen: every Teams answer
// needs the app password, because Bot Framework has no equivalent of a
// response_url. A bot with no password can receive questions and cannot answer
// them, which is a confusing failure unless the form says so up front.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Check, Copy, Loader2, MessagesSquare, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  deleteTeamsBot,
  listTeamsBots,
  saveTeamsBot,
  type TeamsBotSummary,
} from "@/utils/teams.functions";
import { supabase } from "@/integrations/supabase/client";

type Draft = {
  id?: string;
  app_id: string;
  display_name: string;
  tenant_id: string;
  target_type: "agent" | "analyst" | "";
  target_id: string;
  app_password: string;
  is_active: boolean;
};

const empty: Draft = {
  app_id: "",
  display_name: "",
  tenant_id: "",
  target_type: "",
  target_id: "",
  app_password: "",
  is_active: true,
};

export function TeamsTab() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(listTeamsBots);
  const saveFn = useServerFn(saveTeamsBot);
  const deleteFn = useServerFn(deleteTeamsBot);

  const [bots, setBots] = useState<TeamsBotSummary[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [analysts, setAnalysts] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copied, setCopied] = useState(false);

  const endpoint =
    typeof window === "undefined"
      ? "/api/teams/messages"
      : `${window.location.origin}/api/teams/messages`;

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const rows = await listFn({ data: { access_token: token } });
      setBots(rows);
      // Through the RLS client: a bot may only be pointed at something the
      // signed-in owner can already reach.
      const [{ data: ags }, { data: ans }] = await Promise.all([
        supabase.from("agents").select("id, name").order("name"),
        supabase.from("ai_analysts").select("id, name").order("name"),
      ]);
      setAgents((ags ?? []) as { id: string; name: string }[]);
      setAnalysts((ans ?? []) as { id: string; name: string }[]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [listFn, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await saveFn({
        data: {
          access_token: token,
          id: draft.id,
          app_id: draft.app_id,
          display_name: draft.display_name || undefined,
          tenant_id: draft.tenant_id || null,
          target_type: draft.target_type || null,
          target_id: draft.target_id || null,
          // Only sent when typed: an omitted password keeps the stored one, so
          // changing which agent answers cannot disarm the bot.
          app_password: draft.app_password || undefined,
          is_active: draft.is_active,
        },
      });
      toast.success(draft.id ? "Bot updated" : "Bot registered");
      setDraft(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(bot: TeamsBotSummary) {
    const ok = await confirmAsk({
      title: `Remove ${bot.display_name || bot.app_id}?`,
      body: "Teams will keep sending activities to this deployment, and they will be refused. Remove the bot in the Azure portal too if that is not what you want.",
      actionLabel: "Remove registration",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteFn({ data: { access_token: token, id: bot.id } });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const targets = draft?.target_type === "agent" ? agents : analysts;

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Teams bots…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessagesSquare className="h-4 w-4 text-primary" /> Microsoft Teams
            </CardTitle>
            <CardDescription>
              Point a Bot Framework registration at this deployment and an agent or the analyst
              answers questions asked in Teams — as you, with your model rules, budgets and traces.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setDraft({ ...empty })}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Register a bot
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Messaging endpoint</Label>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                {endpoint}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(endpoint);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Paste this into the bot&apos;s <strong>Messaging endpoint</strong> in the Azure
              portal. Microsoft has to reach it, so a bot on{" "}
              <code className="font-mono">localhost</code> will not receive anything.
            </p>
          </div>
        </CardContent>
      </Card>

      {bots.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No Teams bots yet. Register one in the Azure portal, then add its App id here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {bots.map((b) => (
            <Card key={b.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {b.display_name || b.app_id}
                    {!b.is_active ? (
                      <Badge variant="outline" className="text-[10px]">
                        paused
                      </Badge>
                    ) : null}
                    {b.tenant_id ? (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        single tenant
                      </Badge>
                    ) : null}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{b.app_id}</p>
                  <div className="flex flex-wrap items-center gap-3 text-[11px]">
                    <span
                      className={cn(b.hasAppPassword ? "text-muted-foreground" : "text-amber-600")}
                    >
                      {b.hasAppPassword ? "Configured" : "No app password — it cannot answer"}
                    </span>
                    <span className="text-muted-foreground">
                      {b.last_activity_at
                        ? `Receiving messages · last ${formatDistanceToNow(new Date(b.last_activity_at), { addSuffix: true })}`
                        : "Never reached by Teams"}
                    </span>
                    {b.target_type ? (
                      <span className="text-muted-foreground">answers with an {b.target_type}</span>
                    ) : (
                      <span className="text-amber-600">nothing chosen to answer</span>
                    )}
                  </div>
                  {b.last_error ? (
                    <p className="flex items-start gap-1 text-[11px] text-destructive">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {b.last_error}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        id: b.id,
                        app_id: b.app_id,
                        display_name: b.display_name ?? "",
                        tenant_id: b.tenant_id ?? "",
                        target_type: b.target_type ?? "",
                        target_id: b.target_id ?? "",
                        app_password: "",
                        is_active: b.is_active,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(b)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit bot" : "Register a Teams bot"}</DialogTitle>
            <DialogDescription>
              From the Azure portal: the bot&apos;s App id, and a client secret it can use to post
              answers back. Teams gives a bot no way to reply without one.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="tb-app">Microsoft App id</Label>
                <Input
                  id="tb-app"
                  className="font-mono text-xs"
                  value={draft.app_id}
                  onChange={(e) => setDraft({ ...draft, app_id: e.target.value })}
                  placeholder="11111111-2222-3333-4444-555555555555"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="tb-name">Name</Label>
                  <Input
                    id="tb-name"
                    value={draft.display_name}
                    onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                    placeholder="Analyst bot"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tb-tenant">Tenant id (optional)</Label>
                  <Input
                    id="tb-tenant"
                    className="font-mono text-xs"
                    value={draft.tenant_id}
                    onChange={(e) => setDraft({ ...draft, tenant_id: e.target.value })}
                    placeholder="single-tenant bots only"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tb-secret">
                  Client secret {draft.id ? "(leave empty to keep the stored one)" : ""}
                </Label>
                <Input
                  id="tb-secret"
                  type="password"
                  autoComplete="new-password"
                  value={draft.app_password}
                  onChange={(e) => setDraft({ ...draft, app_password: e.target.value })}
                  placeholder="written, never read back"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Answers with</Label>
                  <Select
                    value={draft.target_type || "none"}
                    onValueChange={(v) =>
                      setDraft({
                        ...draft,
                        target_type: v === "none" ? "" : (v as "agent" | "analyst"),
                        target_id: "",
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Nothing yet</SelectItem>
                      <SelectItem value="analyst">An AI Analyst</SelectItem>
                      <SelectItem value="agent">An agent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.target_type ? (
                  <div className="space-y-1">
                    <Label>Which one</Label>
                    <Select
                      value={draft.target_id}
                      onValueChange={(v) => setDraft({ ...draft, target_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick…" />
                      </SelectTrigger>
                      <SelectContent>
                        {targets.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="tb-active"
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                />
                <Label htmlFor="tb-active" className="text-sm font-normal">
                  Active — a paused bot refuses everything Teams sends it
                </Label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !draft?.app_id} onClick={() => void save()}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {draft?.id ? "Save" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
