// Deploy a swarm: manage API keys (run it via POST /api/swarm/run) and
// schedules (interval-based headless runs). Keys are created through a server
// function (raw key shown once); listing/revoking + schedule CRUD run under RLS.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  createSwarmApiKey,
  jsSandboxStatusFn,
  publishSwarm,
  unpublishSwarm,
} from "@/utils/swarmDeploy.functions";
import {
  deployState,
  deployStateCopy,
  graphFingerprint,
  type PublishableSwarm,
} from "@/lib/swarmPublish";
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
  UploadCloud,
  History,
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
  expires_at: string | null;
  last_used_ip: string | null;
  scopes: string[] | null;
};

/** Expiry presets. `0` = never (stored as NULL). */
const EXPIRY_PRESETS: { label: string; days: number }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never expires", days: 0 },
];

function keyExpiry(k: ApiKeyRow): { label: string; expired: boolean; soon: boolean } {
  if (!k.expires_at) return { label: "Never", expired: false, soon: false };
  const ms = Date.parse(k.expires_at) - Date.now();
  if (ms <= 0) return { label: "Expired", expired: true, soon: false };
  const days = Math.ceil(ms / 86_400_000);
  return { label: `${days}d left`, expired: false, soon: days <= 14 };
}
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
  nodes,
  edges,
  onPublishedChange,
}: {
  swarmId: string | null;
  swarmName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Current graph — used to pre-flight what will actually run headlessly. */
  nodes?: { data?: { kind?: string; label?: string } }[];
  /** Live canvas edges, for detecting unsaved work before publishing. */
  edges?: unknown[];
  /**
   * Publishing changes what the CANVAS should say about itself (the toolbar's
   * "Draft ahead" badge), so the page has to hear about it — otherwise the
   * badge sits there contradicting the dialog the user just used.
   */
  onPublishedChange?: () => void;
}) {
  // Pre-flight checks. Headless (API / scheduled) runs use the server executor,
  // which supports fewer node kinds than the canvas and decides approvals
  // without a human — surface both BEFORE the user deploys.
  const approvalNodes = (nodes ?? []).filter((n) => n.data?.kind === "approval");
  const functionNodes = (nodes ?? []).filter((n) => n.data?.kind === "function");
  const a2aNodes = (nodes ?? []).filter((n) => n.data?.kind === "a2a_remote");
  // Custom code runs headlessly only when the operator deployed the JS sandbox
  // service, so ASK this instance rather than hard-coding "canvas only".
  const [sandbox, setSandbox] = useState<{ configured: boolean; healthy: boolean } | null>(null);
  const blockedNodes = [...a2aNodes, ...(sandbox?.healthy ? [] : functionNodes)];
  const { user } = useAuth();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app";

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return;
      try {
        const res = await jsSandboxStatusFn({ data: { access_token: token } });
        if (alive) setSandbox(res);
      } catch {
        if (alive) setSandbox({ configured: false, healthy: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);
  // The SAVED draft and the published snapshot, both read from the database.
  // Drift is judged on the saved draft because that is what Publish will pin —
  // comparing against the in-memory canvas instead would promise to roll out
  // edits that were never saved.
  const [row, setRow] = useState<PublishableSwarm | null>(null);
  const [publishing, setPublishing] = useState(false);

  // New-key form
  const [keyName, setKeyName] = useState("Production key");
  const [keyReject, setKeyReject] = useState(true);
  // Default to a bounded lifetime: an unbounded credential is the exception,
  // not the default, for anything internet-facing.
  const [keyExpiryDays, setKeyExpiryDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  // Shown once alongside the key: receivers use it to verify async callbacks.
  const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);

  // New-schedule form
  const [schedName, setSchedName] = useState("Daily run");
  const [schedInput, setSchedInput] = useState("");
  const [schedInterval, setSchedInterval] = useState(1440);
  const [schedReject, setSchedReject] = useState(true);
  const [addingSched, setAddingSched] = useState(false);

  const load = useCallback(async () => {
    if (!swarmId) return;
    setLoading(true);
    const [{ data: k }, { data: s }, { data: sw }] = await Promise.all([
      supabase
        .from("swarm_api_keys")
        .select(
          "id, name, key_prefix, reject_approvals, is_active, last_used_at, created_at, expires_at, last_used_ip, scopes",
        )
        .eq("swarm_id", swarmId)
        .order("created_at", { ascending: false }),
      supabase
        .from("swarm_schedules")
        .select(
          "id, name, input, interval_minutes, reject_approvals, is_active, last_run_at, last_run_status, last_run_error",
        )
        .eq("swarm_id", swarmId)
        .order("created_at", { ascending: false }),
      supabase
        .from("swarms")
        .select("nodes, edges, published_nodes, published_edges, published_at")
        .eq("id", swarmId)
        .maybeSingle(),
    ]);
    setKeys((k ?? []) as ApiKeyRow[]);
    setSchedules((s ?? []) as ScheduleRow[]);
    setRow((sw ?? null) as PublishableSwarm | null);
    setLoading(false);
  }, [swarmId]);

  useEffect(() => {
    if (open && swarmId) void load();
    if (!open) {
      setNewRawKey(null);
      setNewWebhookSecret(null);
    }
  }, [open, swarmId, load]);

  const curl = useMemo(
    () =>
      `curl -X POST ${origin}/api/swarm/run \\\n` +
      `  -H "Authorization: Bearer ${newRawKey ?? "sk_swarm_…"}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"input": "your input here"}'`,
    [origin, newRawKey],
  );

  // `rotateFrom` set = mint a replacement for that key. Both stay live until
  // the old one is revoked, so callers can be migrated without downtime.
  const createKey = async (rotateFrom?: ApiKeyRow) => {
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
          name: rotateFrom ? `${rotateFrom.name} (rotated)` : keyName.trim() || "API key",
          reject_approvals: rotateFrom ? rotateFrom.reject_approvals : keyReject,
          expires_in_days: keyExpiryDays > 0 ? keyExpiryDays : null,
          ...(rotateFrom ? { rotated_from: rotateFrom.id } : {}),
        },
      });
      if (!res.ok) throw new Error(res.error);
      setNewRawKey(res.raw_key);
      setNewWebhookSecret(res.webhook_secret);
      if (!rotateFrom) setKeyName("Production key");
      setKeyReject(true);
      await load();
      toast.success(
        rotateFrom
          ? "Replacement key created — copy it, migrate callers, then revoke the old key."
          : "API key created — copy it now, it won't be shown again.",
      );
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

  const deployed = keys.length > 0 || schedules.length > 0;
  const state = row ? deployState(row, deployed) : "not-deployed";
  const copy = deployStateCopy(state);
  // Publish pins what is SAVED. If the canvas has moved on since the last save,
  // say so instead of letting the button appear to promote what is on screen.
  const unsaved = useMemo(() => {
    if (!row || !nodes) return false;
    return graphFingerprint(nodes, edges ?? []) !== graphFingerprint(row.nodes, row.edges);
  }, [row, nodes, edges]);

  const doPublish = async () => {
    if (!swarmId) return;
    setPublishing(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return toast.error("Session expired");
      const res = await publishSwarm({ data: { access_token: token, swarm_id: swarmId } });
      if (!res.ok) return toast.error(res.error);
      await load();
      onPublishedChange?.();
      toast.success("Published — deployed runs now use this version");
    } finally {
      setPublishing(false);
    }
  };

  const doUnpublish = async () => {
    if (!swarmId) return;
    setPublishing(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return toast.error("Session expired");
      const res = await unpublishSwarm({ data: { access_token: token, swarm_id: swarmId } });
      if (!res.ok) return toast.error(res.error);
      await load();
      onPublishedChange?.();
      toast.success("Unpinned — deployed runs follow the canvas again");
    } finally {
      setPublishing(false);
    }
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
            execute on the server, which supports fewer node types than the canvas.
          </DialogDescription>
        </DialogHeader>

        {blockedNodes.length > 0 && (
          <div className="flex gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
            <div>
              <div className="font-semibold text-foreground">
                This swarm can&apos;t run headlessly yet
              </div>
              <p className="mt-1 text-muted-foreground">
                {blockedNodes.length} node
                {blockedNodes.length > 1 ? "s" : ""} (
                {blockedNodes
                  .map((n) => `“${n.data?.label ?? n.data?.kind}”`)
                  .slice(0, 4)
                  .join(", ")}
                ){" "}
                {a2aNodes.length > 0 && functionNodes.length > 0
                  ? "use A2A Remote, or custom code with no JS sandbox deployed"
                  : a2aNodes.length > 0
                    ? "use A2A Remote, which needs your login"
                    : sandbox?.configured
                      ? "use custom code, and this instance's JS sandbox is not answering"
                      : "use custom code, which needs the JS sandbox service"}
                . Deployed and scheduled runs will fail until that is resolved.
              </p>
              {functionNodes.length > 0 && !sandbox?.healthy && (
                <p className="mt-1.5 text-muted-foreground">
                  {sandbox?.configured ? (
                    <>
                      JS_SANDBOX_URL is set but the service did not respond — check that{" "}
                      <code className="font-mono">docker compose --profile sandbox up -d</code> is
                      running.
                    </>
                  ) : (
                    <>
                      Enable it with{" "}
                      <code className="font-mono">
                        docker compose --profile sandbox up -d --build
                      </code>
                      . Until then these nodes work on the canvas only.
                    </>
                  )}
                </p>
              )}
              <p className="hidden"></p>
            </div>
          </div>
        )}

        {/* What deployed callers are actually getting, and how to change it. */}
        <div
          className={
            "rounded-md border p-3 text-xs " +
            (state === "drifted"
              ? "border-amber-500/40 bg-amber-500/10"
              : state === "unpinned"
                ? "border-sky-500/40 bg-sky-500/10"
                : "border-border bg-muted/40")
          }
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">{copy.label}</span>
                {state === "in-sync" && row?.published_at && (
                  <span className="text-muted-foreground">
                    · pinned {new Date(row.published_at).toLocaleString()}
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted-foreground">{copy.detail}</p>
              {unsaved && (
                <p className="mt-1 text-amber-600 dark:text-amber-400">
                  The canvas has unsaved edits. Publishing pins the last SAVED version — save first
                  if you meant to include them.
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Button size="sm" onClick={doPublish} disabled={publishing || !swarmId}>
                {publishing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                )}
                {state === "in-sync" ? "Republish" : "Publish"}
              </Button>
              {state !== "unpinned" && state !== "not-deployed" && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]">
                      <History className="mr-1 h-3 w-3" /> Unpin
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Let deployed runs follow the canvas?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Every save will immediately change what this swarm&apos;s API keys and
                        schedules execute, including half-finished edits. The pinned snapshot is
                        discarded.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={doUnpublish}>Unpin</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        </div>

        {approvalNodes.length > 0 && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <div className="font-semibold text-foreground">
                This swarm has {approvalNodes.length} human-approval step
                {approvalNodes.length > 1 ? "s" : ""}
              </div>
              <p className="mt-1 text-muted-foreground">
                Nobody is present to decide them on a headless run. Leave{" "}
                <strong>Reject approvals</strong> ON (the default) and those runs stop safely at the
                gate. Turning it OFF makes the swarm <strong>auto-approve</strong> every approval
                step — your human oversight is bypassed.
              </p>
            </div>
          </div>
        )}

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
                  {newWebhookSecret && (
                    <>
                      <p className="pt-1 text-[11px] font-medium text-emerald-400">
                        Webhook signing secret (for async runs)
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-background/60 px-2 py-1 font-mono text-xs">
                          {newWebhookSecret}
                        </code>
                        <CopyButton text={newWebhookSecret} />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Verify a callback by computing{" "}
                        <code className="font-mono">
                          HMAC-SHA256(secret, `${"{timestamp}"}.${"{body}"}`)
                        </code>{" "}
                        and comparing it with the{" "}
                        <code className="font-mono">X-AgentSwarms-Signature</code> header.
                      </p>
                    </>
                  )}
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
                  <div className="w-36 space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Expires</Label>
                    <Select
                      value={String(keyExpiryDays)}
                      onValueChange={(v) => setKeyExpiryDays(Number(v))}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPIRY_PRESETS.map((p) => (
                          <SelectItem key={p.days} value={String(p.days)} className="text-xs">
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground pb-1.5">
                    <Switch checked={keyReject} onCheckedChange={setKeyReject} /> Reject approvals
                  </label>
                  <Button size="sm" className="h-8" onClick={() => createKey()} disabled={creating}>
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
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">Long runs:</span> add{" "}
                  <code className="font-mono">{`"async": true, "callback_url": "https://…"`}</code>{" "}
                  to get an immediate <code className="font-mono">202</code> and have the result
                  POSTed to your endpoint when it finishes (signed with the key's webhook secret in{" "}
                  <code className="font-mono">X-AgentSwarms-Signature</code>).
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">Safe retries:</span> send an{" "}
                  <code className="font-mono">Idempotency-Key</code> header — a repeat of the same
                  key returns the original result instead of running (and billing) again.
                </p>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Chatbot mode: add{" "}
                  <code className="font-mono">
                    {`"history": [{ "role": "user"|"assistant", "content": "…" }]`}
                  </code>{" "}
                  to send prior turns — the swarm answers in context. Append each response as the
                  next assistant turn.
                </p>
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
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium truncate">{k.name}</p>
                          {(() => {
                            const e = keyExpiry(k);
                            if (e.expired)
                              return (
                                <Badge
                                  variant="outline"
                                  className="border-destructive/40 text-destructive px-1 text-[9px]"
                                >
                                  expired
                                </Badge>
                              );
                            if (e.soon)
                              return (
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/40 text-amber-600 dark:text-amber-400 px-1 text-[9px]"
                                >
                                  {e.label}
                                </Badge>
                              );
                            return null;
                          })()}
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {k.key_prefix}
                          {k.reject_approvals && " · rejects approvals"}
                          {` · expires: ${keyExpiry(k).label}`}
                          {k.last_used_at
                            ? ` · used ${new Date(k.last_used_at).toLocaleDateString()}`
                            : " · never used"}
                          {k.last_used_ip ? ` from ${k.last_used_ip}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 text-[11px]"
                        disabled={creating}
                        onClick={() => void createKey(k)}
                        title="Mint a replacement key — both stay valid until you revoke this one"
                      >
                        Rotate
                      </Button>
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
            <TabsContent
              value="schedules"
              className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1"
            >
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
                          <p className="text-[10px] text-destructive truncate">
                            {s.last_run_error}
                          </p>
                        )}
                      </div>
                      {s.is_active ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] border-emerald-500/40 text-emerald-400"
                        >
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
