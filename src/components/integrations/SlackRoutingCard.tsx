// Who answers what, per Slack workspace.
//
// The workspace card above says Slack can reach this deployment. This one
// says what happens when it does: which agent or analyst each slash command
// runs, and who answers when somebody @mentions the bot or sends it a direct
// message. A command with no route here still goes to the workspace's
// analyst, which is what every installation had before routing existed.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AtSign, Loader2, Plus, Slash, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteSlackRoute,
  listSlackRoutes,
  saveSlackRoute,
  saveSlackWorkspace,
  type SlackCommandRouteSummary,
  type SlackWorkspaceSummary,
} from "@/utils/slack.functions";
import { normalizeSlashCommand } from "@/utils/channels/core";

type Option = { id: string; name: string };
/** A target as one Select value, since the two lists share one control. */
const encode = (type: "agent" | "analyst", id: string) => `${type}:${id}`;
const decode = (v: string): { type: "agent" | "analyst"; id: string } | null => {
  const [type, id] = v.split(":", 2);
  return (type === "agent" || type === "analyst") && id ? { type, id } : null;
};

export function SlackRoutingCard({
  workspaces,
  token,
  onChanged,
}: {
  workspaces: SlackWorkspaceSummary[];
  token: string;
  onChanged: () => void | Promise<void>;
}) {
  const listRoutes = useServerFn(listSlackRoutes);
  const saveRoute = useServerFn(saveSlackRoute);
  const removeRoute = useServerFn(deleteSlackRoute);
  const saveWorkspace = useServerFn(saveSlackWorkspace);

  const [routes, setRoutes] = useState<SlackCommandRouteSummary[] | null>(null);
  const [agents, setAgents] = useState<Option[]>([]);
  const [analysts, setAnalysts] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false);
  /** The half-typed new route, per workspace. */
  const [draft, setDraft] = useState<Record<string, { command: string; target: string }>>({});

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setRoutes(await listRoutes({ data: { access_token: token } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load routes");
      setRoutes([]);
    }
    const [a, an] = await Promise.all([
      supabase.from("agents").select("id, name").eq("is_active", true).order("name"),
      supabase.from("ai_analysts").select("id, name").order("name"),
    ]);
    setAgents((a.data ?? []) as Option[]);
    setAnalysts((an.data ?? []) as Option[]);
  }, [listRoutes, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameOf = (type: "agent" | "analyst", id: string) => {
    const hit = (type === "agent" ? agents : analysts).find((x) => x.id === id);
    return hit?.name ?? `${type} that no longer exists`;
  };

  /** One control over both lists, grouped so the two are told apart. */
  const targetSelect = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {analysts.map((a) => (
          <SelectItem key={`analyst-${a.id}`} value={encode("analyst", a.id)}>
            {a.name}
            <span className="ml-2 text-[11px] text-muted-foreground">analyst</span>
          </SelectItem>
        ))}
        {agents.map((a) => (
          <SelectItem key={`agent-${a.id}`} value={encode("agent", a.id)}>
            {a.name}
            <span className="ml-2 text-[11px] text-muted-foreground">agent</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const addRoute = async (workspaceId: string) => {
    const d = draft[workspaceId];
    const target = d ? decode(d.target) : null;
    const command = normalizeSlashCommand(d?.command);
    if (!command) return toast.error("A command looks like /ask — letters, digits, - or _.");
    if (!target) return toast.error("Pick an agent or an analyst to answer it.");
    setBusy(true);
    try {
      await saveRoute({
        data: {
          access_token: token,
          workspace_id: workspaceId,
          command,
          target_type: target.type,
          target_id: target.id,
        },
      });
      setDraft((p) => ({ ...p, [workspaceId]: { command: "", target: "" } }));
      toast.success(`${command} routed`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the route");
    } finally {
      setBusy(false);
    }
  };

  const dropRoute = async (id: string, command: string) => {
    setBusy(true);
    try {
      await removeRoute({ data: { access_token: token, id } });
      toast.success(`${command} unrouted — it falls back to the analyst`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the route");
    } finally {
      setBusy(false);
    }
  };

  const setMention = async (w: SlackWorkspaceSummary, value: string) => {
    const target = decode(value);
    setBusy(true);
    try {
      await saveWorkspace({
        data: {
          access_token: token,
          id: w.id,
          team_id: w.team_id,
          team_name: w.team_name ?? undefined,
          analyst_id: w.analyst_id,
          mention_target_type: target?.type ?? null,
          mention_target_id: target?.id ?? null,
        },
      });
      toast.success("Mention target saved");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (workspaces.length === 0) return null;

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Slash className="h-4 w-4" /> Who answers what
        </CardTitle>
        <CardDescription>
          Route each slash command to its own agent or analyst, and choose who answers when someone
          mentions the bot. A command with no route here goes to the workspace&apos;s analyst.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {workspaces.map((w) => {
          const mine = (routes ?? []).filter((r) => r.workspace_id === w.id);
          const d = draft[w.id] ?? { command: "", target: "" };
          return (
            <div key={w.id} className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{w.team_name || w.team_id}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {w.team_id}
                </Badge>
              </div>

              <div className="grid gap-2 sm:grid-cols-[1fr_2fr] sm:items-center">
                <Label className="flex items-center gap-1.5 text-xs">
                  <AtSign className="h-3.5 w-3.5" /> Mentions and DMs
                </Label>
                {targetSelect(
                  w.mention_target_type && w.mention_target_id
                    ? encode(w.mention_target_type, w.mention_target_id)
                    : "",
                  (v) => void setMention(w, v),
                  w.analyst_id ? "The workspace analyst" : "Nobody yet",
                )}
              </div>
              {!w.hasBotToken && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Mentions need a bot token on this workspace — a slash command answers through
                  Slack&apos;s reply URL, an @mention has none.
                </p>
              )}

              <div className="space-y-2">
                <Label className="text-xs">Slash commands</Label>
                {mine.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No routes. Every command goes to{" "}
                    {w.analyst_id ? "the workspace analyst" : "nobody — pick an analyst above"}.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {mine.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5 text-sm"
                      >
                        <code className="font-mono text-xs">{r.command}</code>
                        <span className="text-muted-foreground">→</span>
                        <span className="flex-1 truncate">
                          {nameOf(r.target_type, r.target_id)}
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            {r.target_type}
                          </span>
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive"
                          disabled={busy}
                          onClick={() => void dropRoute(r.id, r.command)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 w-32 font-mono text-xs"
                    placeholder="/support"
                    value={d.command}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, [w.id]: { ...d, command: e.target.value } }))
                    }
                  />
                  <div className="min-w-48 flex-1">
                    {targetSelect(
                      d.target,
                      (v) => setDraft((p) => ({ ...p, [w.id]: { ...d, target: v } })),
                      "Answered by…",
                    )}
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => void addRoute(w.id)}>
                    {busy ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-3.5 w-3.5" />
                    )}
                    Add
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
