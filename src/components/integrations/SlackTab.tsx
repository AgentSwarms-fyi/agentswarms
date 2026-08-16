// "Slack" tab of the Integration Hub: workspaces allowed to ask the AI Analyst.
//
// The neighbouring Notifications tab is the OUTBOUND direction — a webhook URL
// we post to. This is inbound, and a different trust problem: the endpoint is
// public because Slack has to reach it, so the signing secret is the only thing
// distinguishing a real slash command from anyone who learned the URL. That is
// why the secret is required to create a workspace, and why it is written and
// never read back.
//
// THE STATUS DISTINCTION IS THE POINT OF THIS SCREEN. A saved row proves
// somebody filled in a form. It does not prove Slack can reach this
// deployment — which fails for the ordinary reasons: the app is on localhost,
// the request URL has a typo, the app was never reinstalled after adding the
// command. So "Configured" and "Receiving commands" are shown as different
// things, and the second is backed by `last_command_at`, which only Slack can
// set.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Check, Copy, Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteSlackWorkspace,
  listSlackWorkspaces,
  saveSlackWorkspace,
  type SlackWorkspaceSummary,
} from "@/utils/slack.functions";

type AnalystOption = { id: string; name: string };

/** The URL Slack must be pointed at. Read from the browser so it is right for
 *  whatever origin this deployment is actually served from. */
function commandUrl(): string {
  if (typeof window === "undefined") return "/api/slack/command";
  return `${window.location.origin}/api/slack/command`;
}

export function SlackTab() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";

  const list = useServerFn(listSlackWorkspaces);
  const save = useServerFn(saveSlackWorkspace);
  const remove = useServerFn(deleteSlackWorkspace);

  const [rows, setRows] = useState<SlackWorkspaceSummary[] | null>(null);
  const [analysts, setAnalysts] = useState<AnalystOption[]>([]);
  const [editing, setEditing] = useState<SlackWorkspaceSummary | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SlackWorkspaceSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form
  const [teamId, setTeamId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [analystId, setAnalystId] = useState<string>("");
  const [signingSecret, setSigningSecret] = useState("");
  const [botToken, setBotToken] = useState("");

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setRows(await list({ data: { access_token: token } }));
    } catch (e) {
      // A failed READ is not an empty integration. Saying so is what stops the
      // empty state below claiming nothing is connected when the truth is that
      // nothing could be read.
      toast.error(e instanceof Error ? e.message : "Could not load Slack workspaces");
      setRows([]);
    }
    const { data } = await supabase.from("ai_analysts").select("id, name").order("name");
    setAnalysts((data ?? []) as AnalystOption[]);
  }, [list, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openNew = () => {
    setEditing("new");
    setTeamId("");
    setTeamName("");
    setAnalystId("");
    setSigningSecret("");
    setBotToken("");
  };

  const openEdit = (w: SlackWorkspaceSummary) => {
    setEditing(w);
    setTeamId(w.team_id);
    setTeamName(w.team_name ?? "");
    setAnalystId(w.analyst_id ?? "");
    // Never prefilled — the server does not return them, and a masked
    // placeholder in a password field is how people believe they rotated a
    // secret they did not.
    setSigningSecret("");
    setBotToken("");
  };

  const onSave = async () => {
    setBusy(true);
    try {
      await save({
        data: {
          access_token: token,
          id: editing && editing !== "new" ? editing.id : undefined,
          team_id: teamId,
          team_name: teamName || undefined,
          analyst_id: analystId || null,
          // Omitted rather than sent empty: on an edit, a blank field means
          // "keep what is stored", and sending "" would disarm the endpoint.
          signing_secret: signingSecret || undefined,
          bot_token: botToken || undefined,
        },
      });
      toast.success(editing === "new" ? "Slack workspace connected" : "Saved");
      setEditing(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (!confirmRemove) return;
    setBusy(true);
    try {
      await remove({ data: { access_token: token, id: confirmRemove.id } });
      toast.success(`Disconnected ${confirmRemove.team_name || confirmRemove.team_id}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setBusy(false);
      setConfirmRemove(null);
    }
  };

  const copyUrl = () => {
    void navigator.clipboard.writeText(commandUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const analystName = (id: string | null) =>
    id ? (analysts.find((a) => a.id === id)?.name ?? "an analyst that no longer exists") : null;

  return (
    <div className="space-y-4">
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4" /> Ask from Slack
          </CardTitle>
          <CardDescription>
            A slash command runs one of your AI Analysts and posts the answer in the channel. The
            answer is a summary — the rows, the SQL and the lineage stay here, and every message
            links back.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Request URL for your Slack app</Label>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/50 px-2 py-1.5 font-mono text-[11px]">
                {commandUrl()}
              </code>
              <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={copyUrl}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copy
              </Button>
            </div>
            {/* Said plainly, because it is the single most common reason a
                correctly-filled form never receives anything. */}
            {typeof window !== "undefined" &&
              /^(localhost|127\.|\[::1\])/.test(window.location.hostname) && (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This is a localhost URL. Slack cannot reach it — use a tunnel (ngrok, Cloudflare
                  Tunnel) or a deployed instance, or the command will time out with no error here.
                </p>
              )}
          </div>

          <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
            <li>
              Create an app at <span className="font-mono">api.slack.com/apps</span> → From scratch,
              and pick your workspace.
            </li>
            <li>
              <strong>Slash Commands</strong> → Create New Command. Command{" "}
              <span className="font-mono">/ask</span>, Request URL as above.
            </li>
            <li>
              <strong>Basic Information</strong> → copy the <strong>Signing Secret</strong>, and
              copy your workspace id (it starts with <span className="font-mono">T</span>) from the
              app's URL or <span className="font-mono">/apps</span> page.
            </li>
            <li>Add them below with the analyst that should answer, then install the app.</li>
          </ol>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Connected workspaces</CardTitle>
            <CardDescription>
              One installation per Slack workspace, so an inbound command has exactly one analyst to
              reach.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" /> Connect workspace
          </Button>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Slack workspace connected yet. Follow the four steps above, then add it here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Answers with</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[150px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>
                      <span className="font-medium">{w.team_name || w.team_id}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {w.team_id}
                      </span>
                      {!w.is_active && (
                        <Badge variant="secondary" className="ml-1.5 text-[10px]">
                          paused
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {w.analyst_id ? (
                        analystName(w.analyst_id)
                      ) : (
                        // The endpoint refuses in this state and says why; the
                        // list should not look healthy while it does.
                        <span className="text-amber-600 dark:text-amber-400">
                          no analyst selected
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {!w.hasSigningSecret ? (
                        <span className="text-destructive">no signing secret — cannot verify</span>
                      ) : w.last_error ? (
                        <span className="text-destructive" title={w.last_error}>
                          last command failed
                        </span>
                      ) : w.last_command_at ? (
                        <span className="text-primary">
                          <Check className="mr-1 inline h-3 w-3" />
                          receiving ·{" "}
                          {formatDistanceToNow(new Date(w.last_command_at), {
                            addSuffix: true,
                          })}
                        </span>
                      ) : (
                        // NOT "connected". A saved row proves a form was
                        // filled in; only Slack can set last_command_at.
                        <span className="text-muted-foreground">
                          configured — no command received yet
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(w)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-destructive hover:text-destructive"
                        onClick={() => setConfirmRemove(w)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Disconnect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Connect a Slack workspace" : "Edit Slack workspace"}
            </DialogTitle>
            <DialogDescription>
              The signing secret is what proves an inbound request really came from Slack. It is
              stored encrypted and never shown again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Workspace ID</Label>
              <Input
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                placeholder="T01AB2CD3EF"
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Starts with <span className="font-mono">T</span>. This is how an inbound command
                finds your account — the request carries no other identity.
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Workspace name (optional)</Label>
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="Acme HQ"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Analyst that answers</Label>
              <Select value={analystId} onValueChange={setAnalystId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick an analyst…" />
                </SelectTrigger>
                <SelectContent>
                  {analysts.map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {analysts.length === 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  You have no AI Analysts yet — create one in Data &amp; BI → AI Analyst first, or
                  the command will reply that none is selected.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                Signing secret{" "}
                {editing !== "new" && editing?.hasSigningSecret && (
                  <span className="font-normal text-muted-foreground">— already set</span>
                )}
              </Label>
              <Input
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder={
                  editing !== "new" && editing?.hasSigningSecret
                    ? "Leave blank to keep the stored secret"
                    : "From Slack → Basic Information"
                }
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                Bot token (optional){" "}
                {editing !== "new" && editing?.hasBotToken && (
                  <span className="font-normal text-muted-foreground">— already set</span>
                )}
              </Label>
              <Input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-…"
              />
              <p className="text-[11px] text-muted-foreground">
                Not needed for slash commands — answers go back through Slack&apos;s own response
                URL. Only required if you later post unprompted into channels.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void onSave()} disabled={busy || !teamId.trim()}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {editing === "new" ? "Connect" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {confirmRemove?.team_name || confirmRemove?.team_id}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This cannot be undone. It stops here and now:</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>The stored signing secret is deleted.</li>
                  <li>
                    <span className="font-mono">/ask</span> in that workspace stops working —
                    requests are rejected because there is nothing left to verify them against.
                  </li>
                </ul>
                <p className="text-muted-foreground">
                  Nothing is removed from Slack itself; delete the app there too if you are done
                  with it. Analyses already run are kept.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
