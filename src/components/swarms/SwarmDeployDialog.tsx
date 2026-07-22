// Deploy a swarm: manage API keys (run it via POST /api/swarm/run) and
// schedules (interval-based headless runs). Keys are created through a server
// function (raw key shown once); listing/revoking + schedule CRUD run under RLS.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { createSwarmApiKey } from "@/utils/swarmDeploy.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  KeyRound,
  Clock,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Rocket,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  reject_approvals: boolean;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
};
type ScheduleRow = {
  id: string;
  name: string;
  input: string;
  interval_minutes: number;
  reject_approvals: boolean;
  is_active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
};

const INTERVAL_PRESETS: { label: string; minutes: number }[] = [
  { label: "Every 15 minutes", minutes: 15 },
  { label: "Every hour", minutes: 60 },
  { label: "Every 6 hours", minutes: 360 },
  { label: "Daily", minutes: 1440 },
  { label: "Weekly", minutes: 10080 },
];

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy — select and copy manually.");
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
      {copied ? "Copied" : (label ?? "Copy")}
    </Button>
  );
}

export function SwarmDeployDialog({
  swarmId,
  swarmName,
  open,
  onOpenChange,
}: {
  swarmId: string | null;
  swarmName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app";

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);

  // New-key form
  const [keyName, setKeyName] = useState("Production key");
  const [keyReject, setKeyReject] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);

  // New-schedule form
  const [schedName, setSchedName] = useState("Daily run");
  const [schedInput, setSchedInput] = useState("");
  const [schedInterval, setSchedInterval] = useState(1440);
  const [schedReject, setSchedReject] = useState(false);
  const [addingSched, setAddingSched] = useState(false);

  const load = useCallback(async () => {
    if (!swarmId) return;
    setLoading(true);
    const [{ data: k }, { data: s }] = await Promise.all([
      supabase
        .from("swarm_api_keys")
        .select("id, name, key_prefix, reject_approvals, is_active, last_used_at, created_at")
        .eq("swarm_id", swarmId)
        .order("created_at", { ascending: false }),
      supabase
        .from("swarm_schedules")
        .select(
          "id, name, input, interval_minutes, reject_approvals, is_active, last_run_at, last_run_status, last_run_error",
        )
        .eq("swarm_id", swarmId)
        .order("created_at", { ascending: false }),
    ]);
    setKeys((k ?? []) as ApiKeyRow[]);
    setSchedules((s ?? []) as ScheduleRow[]);
    setLoading(false);
  }, [swarmId]);

  useEffect(() => {
    if (open && swarmId) void load();
    if (!open) setNewRawKey(null);
  }, [open, swarmId, load]);

  const curl = useMemo(
    () =>
      `curl -X POST ${origin}/api/swarm/run \\\n` +
      `  -H "Authorization: Bearer ${newRawKey ?? "sk_swarm_…"}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"input": "your input here"}'`,
    [origin, newRawKey],
  );

  const createKey = async () => {
    if (!swarmId) return;
    setCreating(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await createSwarmApiKey({
        data: {
          access_token: token,
          swarm_id: swarmId,
          name: keyName.trim() || "API key",
          reject_approvals: keyReject,
        },
      });
      if (!res.ok) throw new Error(res.error);
      setNewRawKey(res.raw_key);
      setKeyName("Production key");
      setKeyReject(false);
      await load();
      toast.success("API key created — copy it now, it won't be shown again.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create key");
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (id: string) => {
    const { error } = await supabase.from("swarm_api_keys").delete().eq("id", id);
    if (error) return toast.error("Could not revoke key");
    setKeys((prev) => prev.filter((k) => k.id !== id));
    toast.success("Key revoked");
  };

  const addSchedule = async () => {
    if (!swarmId || !user) return;
    setAddingSched(true);
    const { error } = await supabase.from("swarm_schedules").insert({
      user_id: user.id,
      swarm_id: swarmId,
      name: schedName.trim() || "Scheduled run",
      input: schedInput,
      interval_minutes: schedInterval,
      reject_approvals: schedReject,
    });
    setAddingSched(false);
    if (error) return toast.error(error.message);
    setSchedInput("");
    await load();
    toast.success("Schedule added");
  };

  const toggleSchedule = async (row: ScheduleRow) => {
    const { error } = await supabase
      .from("swarm_schedules")
      .update({ is_active: !row.is_active })
      .eq("id", row.id);
    if (error) return toast.error("Could not update schedule");
    setSchedules((prev) =>
      prev.map((s) => (s.id === row.id ? { ...s, is_active: !s.is_active } : s)),
    );
  };

  const deleteSchedule = async (id: string) => {
    const { error } = await supabase.from("swarm_schedules").delete().eq("id", id);
    if (error) return toast.error("Could not delete schedule");
    setSchedules((prev) => prev.filter((s) => s.id !== id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4 text-primary" /> Deploy “{swarmName}”
          </DialogTitle>
          <DialogDescription className="text-xs">
            Run this swarm outside the canvas — via an API key or on a schedule. Headless runs
            auto-approve human-approval steps (toggle to reject) and can&apos;t use KB/SQL tools yet.
          </DialogDescription>
        </DialogHeader>

        {!swarmId ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            Save this swarm first (it&apos;s a template until saved), then reopen Deploy.
          </div>
        ) : (
          <Tabs defaultValue="keys" className="flex-1 min-h-0 flex flex-col">
            <TabsList>
              <TabsTrigger value="keys" className="gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> API keys
              </TabsTrigger>
              <TabsTrigger value="schedules" className="gap-1.5">
                <Clock className="h-3.5 w-3.5" /> Schedules
              </TabsTrigger>
            </TabsList>

            {/* ── API keys ── */}
            <TabsContent value="keys" className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
              {newRawKey && (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <AlertTriangle className="h-3.5 w-3.5" /> Copy your key now — it won&apos;t be
                    shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-background/60 px-2 py-1 font-mono text-xs">
                      {newRawKey}
                    </code>
                    <CopyButton text={newRawKey} />
                  </div>
                </div>
              )}

              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                <p className="text-xs font-semibold">Create an API key</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[10rem]">
                    <Label className="text-[10px] text-muted-foreground">Name</Label>
                    <Input
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground pb-1.5">
                    <Switch checked={keyReject} onCheckedChange={setKeyReject} /> Reject approvals
                  </label>
                  <Button size="sm" className="h-8" onClick={createKey} disabled={creating}>
                    {creating ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Create
                  </Button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-semibold text-muted-foreground">Example request</p>
                  <CopyButton text={curl} label="Copy curl" />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border/60 bg-background/60 p-2.5 text-[11px] leading-relaxed font-mono">
                  {curl}
                </pre>
              </div>

              <div className="space-y-1.5">
                {loading ? (
                  <p className="text-xs text-muted-foreground py-2">Loading…</p>
                ) : keys.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No keys yet.</p>
                ) : (
                  keys.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{k.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {k.key_prefix}
                          {k.reject_approvals && " · rejects approvals"}
                          {k.last_used_at
                            ? ` · used ${new Date(k.last_used_at).toLocaleDateString()}`
                            : " · never used"}
                        </p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke “{k.name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Any integration using this key will immediately stop working. This
                              can&apos;t be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => revokeKey(k.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>

            {/* ── Schedules ── */}
            <TabsContent value="schedules" className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
                <p className="text-xs font-semibold">Add a schedule</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Name</Label>
                    <Input
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Runs</Label>
                    <Select
                      value={String(schedInterval)}
                      onValueChange={(v) => setSchedInterval(Number(v))}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERVAL_PRESETS.map((p) => (
                          <SelectItem key={p.minutes} value={String(p.minutes)}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">Input</Label>
                  <Input
                    value={schedInput}
                    onChange={(e) => setSchedInput(e.target.value)}
                    placeholder="Input passed to the swarm on each run"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Switch checked={schedReject} onCheckedChange={setSchedReject} /> Reject
                    approvals
                  </label>
                  <Button size="sm" className="h-8" onClick={addSchedule} disabled={addingSched}>
                    {addingSched ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Add
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                {loading ? (
                  <p className="text-xs text-muted-foreground py-2">Loading…</p>
                ) : schedules.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No schedules yet.</p>
                ) : (
                  schedules.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-3 py-2"
                    >
                      <Switch
                        checked={s.is_active}
                        onCheckedChange={() => toggleSchedule(s)}
                        className="shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{s.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          every {s.interval_minutes} min
                          {s.last_run_at
                            ? ` · last ${new Date(s.last_run_at).toLocaleString()}`
                            : " · not run yet"}
                          {s.last_run_status && (
                            <span
                              className={
                                s.last_run_status === "error"
                                  ? "text-destructive"
                                  : "text-emerald-400"
                              }
                            >
                              {" "}
                              · {s.last_run_status}
                            </span>
                          )}
                        </p>
                        {s.last_run_error && (
                          <p className="text-[10px] text-destructive truncate">{s.last_run_error}</p>
                        )}
                      </div>
                      {s.is_active ? (
                        <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-400">
                          active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px]">
                          paused
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => deleteSchedule(s.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Schedules run on the server's cron tick. Scheduled + API runs appear in the{" "}
                <strong>Recent runs</strong> tab.
              </p>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
