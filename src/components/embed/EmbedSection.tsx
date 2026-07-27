// Web Embedding workspace content (rendered by /embeds): create and manage
// iframe embeds of standalone chat agents, multi-agent swarm tasks, and BI
// dashboards. Each embed is authorized by a generated key (a capability
// token scoped to one resource) plus a domain allow-list enforced
// server-side in /api/embed* — see src/utils/embed.server.ts for the model.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Network,
  PieChart,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

type EmbedType = "agent" | "swarm" | "bi_dashboard";

type EmbedKey = {
  id: string;
  name: string;
  key: string;
  resource_type: EmbedType;
  resource_id: string;
  allowed_domains: string[];
  allow_ai: boolean;
  is_active: boolean;
  use_count: number;
  created_at: string;
  expires_at: string | null;
  last_used_ip: string | null;
};

/** Expiry presets for new keys. `0` = never (stored as NULL). */
const EXPIRY_PRESETS: { label: string; days: number }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never expires", days: 0 },
];

function expiryLabel(k: EmbedKey): { text: string; expired: boolean; soon: boolean } {
  if (!k.expires_at) return { text: "Never", expired: false, soon: false };
  const ms = Date.parse(k.expires_at) - Date.now();
  if (ms <= 0) return { text: "Expired", expired: true, soon: false };
  const days = Math.ceil(ms / 86_400_000);
  return { text: `${days}d left`, expired: false, soon: days <= 14 };
}

type ResourceOption = { id: string; name: string };

const EMBED_META: Record<
  EmbedType,
  { title: string; desc: string; icon: typeof Bot; path: string; height: number }
> = {
  agent: {
    title: "Embed Standalone Chat Agent",
    desc: "A streaming chat widget for one of your agents — grounded in its knowledge base, guarded by its guardrails. Workspace tools stay disabled.",
    icon: Bot,
    path: "agent",
    height: 640,
  },
  swarm: {
    title: "Embed Multi-Agent Task (Swarm)",
    desc: "Visitors describe a task and watch your swarm execute it step by step. Node prompts and wiring never leave your server.",
    icon: Network,
    path: "swarm",
    height: 720,
  },
  bi_dashboard: {
    title: "Embed Dashboard (With/Without AI Analyst)",
    desc: "A live, filterable BI dashboard rendered from snapshots — optionally with the Ask-AI analyst answering viewer questions.",
    icon: PieChart,
    path: "bi",
    height: 800,
  },
};

function genKey(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "emk_" + Array.from(bytes, (b) => alphabet[b % 36]).join("");
}

function snippetFor(key: EmbedKey): string {
  const meta = EMBED_META[key.resource_type];
  const src = `${window.location.origin}/embed/${meta.path}/${key.key}`;
  return `<iframe\n  src="${src}"\n  width="100%"\n  height="${meta.height}"\n  style="border:0;border-radius:12px;overflow:hidden"\n  allow="clipboard-write"\n></iframe>`;
}

export function EmbedSection() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<EmbedKey[]>([]);
  const [resources, setResources] = useState<Record<EmbedType, ResourceOption[]>>({
    agent: [],
    swarm: [],
    bi_dashboard: [],
  });
  const [dialogType, setDialogType] = useState<EmbedType | null>(null);
  const [createdKey, setCreatedKey] = useState<EmbedKey | null>(null);

  const load = useCallback(async () => {
    const [k, a, s, d] = await Promise.all([
      supabase
        .from("embed_keys")
        .select(
          "id, name, key, resource_type, resource_id, allowed_domains, allow_ai, is_active, use_count, created_at, expires_at, last_used_ip",
        )
        .order("created_at", { ascending: false }),
      supabase.from("agents").select("id, name").order("name"),
      supabase.from("swarms").select("id, name").order("name"),
      supabase.from("bi_dashboards").select("id, name").order("name"),
    ]);
    setKeys((k.data ?? []) as EmbedKey[]);
    setResources({
      agent: a.data ?? [],
      swarm: s.data ?? [],
      bi_dashboard: (d.data ?? []) as ResourceOption[],
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resourceName = useCallback(
    (k: EmbedKey) =>
      resources[k.resource_type]?.find((r) => r.id === k.resource_id)?.name ?? "(deleted)",
    [resources],
  );

  async function toggleActive(k: EmbedKey) {
    const { error } = await supabase
      .from("embed_keys")
      .update({ is_active: !k.is_active })
      .eq("id", k.id);
    if (error) return toast.error(error.message);
    setKeys((prev) => prev.map((x) => (x.id === k.id ? { ...x, is_active: !k.is_active } : x)));
    toast.success(!k.is_active ? "Embed enabled" : "Embed disabled — iframes stop working now");
  }

  async function remove(k: EmbedKey) {
    if (!window.confirm(`Delete embed "${k.name}"? Existing iframes will stop working.`)) return;
    const { error } = await supabase.from("embed_keys").delete().eq("id", k.id);
    if (error) return toast.error(error.message);
    setKeys((prev) => prev.filter((x) => x.id !== k.id));
    toast.success("Embed deleted");
  }

  function copySnippet(k: EmbedKey) {
    void navigator.clipboard.writeText(snippetFor(k));
    toast.success("Embed code copied");
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(EMBED_META) as EmbedType[]).map((t) => {
          const meta = EMBED_META[t];
          return (
            <Card key={t} className="flex flex-col border-border/50">
              <CardHeader className="pb-2">
                <div className="mb-2 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                  <meta.icon className="h-5 w-5" strokeWidth={1.6} />
                </div>
                <CardTitle className="text-sm">{meta.title}</CardTitle>
                <CardDescription className="text-xs leading-relaxed">{meta.desc}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto pt-2">
                <Button size="sm" variant="outline" onClick={() => setDialogType(t)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Create embed
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Your embeds</CardTitle>
          <CardDescription>
            Disable a key to cut off its iframes instantly; deleting is permanent. Preview opens the
            embed the way visitors see it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No embeds yet — create one above to get an iframe snippet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border/60 bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Embed</th>
                    <th className="px-3 py-2 font-medium">Resource</th>
                    <th className="px-3 py-2 font-medium">Allowed domains</th>
                    <th className="px-3 py-2 font-medium">Uses</th>
                    <th className="px-3 py-2 font-medium">Expires</th>
                    <th className="px-3 py-2 font-medium">Active</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {keys.map((k) => (
                    <tr key={k.id} className={cn(!k.is_active && "opacity-55")}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{k.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {k.resource_type === "bi_dashboard" ? "dashboard" : k.resource_type}
                          </Badge>
                          {k.resource_type === "bi_dashboard" && k.allow_ai && (
                            <Badge variant="outline" className="gap-0.5 text-[9px] text-primary">
                              <Sparkles className="h-2.5 w-2.5" /> AI
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{resourceName(k)}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Globe className="h-3 w-3 shrink-0" />
                          {(k.allowed_domains ?? []).join(", ") || "none (parked)"}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {k.use_count}
                        {k.last_used_ip ? (
                          <span className="ml-1 text-[10px]">({k.last_used_ip})</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {(() => {
                          const e = expiryLabel(k);
                          return (
                            <span
                              className={cn(
                                "text-xs",
                                e.expired && "text-destructive",
                                e.soon && "text-amber-600 dark:text-amber-400",
                                !e.expired && !e.soon && "text-muted-foreground",
                              )}
                            >
                              {e.text}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2">
                        <Switch
                          checked={k.is_active}
                          onCheckedChange={() => void toggleActive(k)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Copy iframe code"
                            onClick={() => copySnippet(k)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Preview"
                            onClick={() =>
                              window.open(
                                `/embed/${EMBED_META[k.resource_type].path}/${k.key}?preview=1`,
                                "_blank",
                              )
                            }
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            title="Delete"
                            onClick={() => void remove(k)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateEmbedDialog
        type={dialogType}
        resources={dialogType ? resources[dialogType] : []}
        userId={user?.id}
        onClose={() => setDialogType(null)}
        onCreated={(k) => {
          setDialogType(null);
          setCreatedKey(k);
          void load();
        }}
      />
      <SnippetDialog embedKey={createdKey} onClose={() => setCreatedKey(null)} />
    </div>
  );
}

function CreateEmbedDialog({
  type,
  resources,
  userId,
  onClose,
  onCreated,
}: {
  type: EmbedType | null;
  resources: ResourceOption[];
  userId: string | undefined;
  onClose: () => void;
  onCreated: (k: EmbedKey) => void;
}) {
  const [resourceId, setResourceId] = useState("");
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [allowAi, setAllowAi] = useState(false);
  // Bounded by default — an embed key is a public capability token, so an
  // unbounded lifetime should be a deliberate choice.
  const [expiryDays, setExpiryDays] = useState(90);
  // Optional per-key spend ceiling. Blank = no key-level limit (the owner's
  // personal and group caps still apply).
  const [monthlyCap, setMonthlyCap] = useState("");
  // How long we keep what visitors typed (their prompts land in the trace log).
  const [retentionDays, setRetentionDays] = useState(30);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (type) {
      setResourceId("");
      setName("");
      setDomains("");
      setAllowAi(false);
      setExpiryDays(90);
      setMonthlyCap("");
      setRetentionDays(30);
    }
  }, [type]);

  const meta = type ? EMBED_META[type] : null;
  const parsedDomains = useMemo(
    () =>
      domains
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    [domains],
  );

  async function create() {
    if (!type || !userId) return;
    if (!resourceId) return toast.error("Pick what to embed");
    if (parsedDomains.length === 0) {
      return toast.error('Add at least one allowed domain (or "*" for any site)');
    }
    setSaving(true);
    const row = {
      user_id: userId,
      name:
        name.trim() ||
        `${resources.find((r) => r.id === resourceId)?.name ?? "Embed"} · ${new Date().toLocaleDateString()}`,
      key: genKey(),
      resource_type: type,
      resource_id: resourceId,
      allowed_domains: parsedDomains,
      allow_ai: type === "bi_dashboard" ? allowAi : false,
      expires_at:
        expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : null,
      transcript_retention_days: retentionDays,
    };
    const { data, error } = await supabase
      .from("embed_keys")
      .insert(row)
      .select(
        "id, name, key, resource_type, resource_id, allowed_domains, allow_ai, is_active, use_count, created_at, expires_at, last_used_ip",
      )
      .single();
    if (error || !data) {
      setSaving(false);
      return toast.error(error?.message ?? "Could not create the embed");
    }
    // Optional per-key budget. Best-effort: the key is already usable, so a
    // failure here is surfaced but must not read as "the embed wasn't created".
    const cap = Number(monthlyCap);
    if (monthlyCap.trim() !== "" && Number.isFinite(cap) && cap > 0) {
      const { error: capErr } = await supabase.from("budget_limits").insert({
        scope_type: "embed_key",
        scope_id: (data as EmbedKey).id,
        monthly_cap_usd: cap,
      });
      if (capErr)
        toast.error(`Embed created, but its budget could not be saved: ${capErr.message}`);
    }
    setSaving(false);
    toast.success("Embed created");
    onCreated(data as EmbedKey);
  }

  return (
    <Dialog open={type !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{meta?.title}</DialogTitle>
          <DialogDescription>
            The embed works only on the domains you list. You can disable or delete the key at any
            time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">
              {type === "agent" ? "Agent" : type === "swarm" ? "Swarm" : "Dashboard"}
            </Label>
            <Select value={resourceId} onValueChange={setResourceId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {resources.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    Nothing to embed yet
                  </SelectItem>
                ) : (
                  resources.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Embed name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Support widget on acme.com"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Allowed domains</Label>
            <Input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, *.acme.com — or * for any site"
              className="h-9"
            />
            <p className="text-[11px] text-muted-foreground">
              Browsers report the embedding page's origin; the server only serves these domains. Use{" "}
              <code>*</code> to allow any site (also lets the URL open directly).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Expires</Label>
            <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_PRESETS.map((p) => (
                  <SelectItem key={p.days} value={String(p.days)}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              After this, the key stops working everywhere until you issue a new one. Embed keys are
              visible in the host page's HTML, so a bounded lifetime limits the damage if one leaks.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Keep visitor messages for</Label>
            <Select
              value={String(retentionDays)}
              onValueChange={(v) => setRetentionDays(Number(v))}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="365">1 year</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Anything visitors type is recorded in your trace log for observability and cost
              reporting. A scheduled purge deletes those records once this window passes.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Monthly AI budget (USD, optional)</Label>
            <Input
              type="number"
              min={0}
              step="1"
              value={monthlyCap}
              onChange={(e) => setMonthlyCap(e.target.value)}
              placeholder="No key-level limit"
              className="h-9"
            />
            <p className="text-[11px] text-muted-foreground">
              Caps what visitors of this embed can spend of your AI credits in a month. Once
              reached, the embed answers with a polite notice instead of calling the model.
            </p>
          </div>
          {type === "bi_dashboard" && (
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div>
                <p className="text-xs font-medium">Enable AI analyst</p>
                <p className="text-[11px] text-muted-foreground">
                  Viewers can ask questions; answers use your credentials and the dashboard's reader
                  model.
                </p>
              </div>
              <Switch checked={allowAi} onCheckedChange={setAllowAi} />
            </div>
          )}
          <Button className="w-full" onClick={() => void create()} disabled={saving}>
            {saving ? "Creating…" : "Create embed key"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SnippetDialog({ embedKey, onClose }: { embedKey: EmbedKey | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const snippet = embedKey ? snippetFor(embedKey) : "";
  return (
    <Dialog open={embedKey !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your embed is ready</DialogTitle>
          <DialogDescription>
            Paste this snippet into any page on{" "}
            {embedKey?.allowed_domains.join(", ") || "your allowed domains"}.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-56 overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 text-[11px] leading-relaxed">
          {snippet}
        </pre>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => {
              void navigator.clipboard.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? (
              <>
                <Check className="mr-1.5 h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy embed code
              </>
            )}
          </Button>
          {embedKey && (
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  `/embed/${EMBED_META[embedKey.resource_type].path}/${embedKey.key}?preview=1`,
                  "_blank",
                )
              }
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Preview
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
