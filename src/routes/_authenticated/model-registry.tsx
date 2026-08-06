// Browsable catalog of LLM providers and their currently-shipping models.
// Data is refreshed weekly from AIMLAPI's public /models endpoint via
// /api/public/hooks/refresh-model-registry. Users can filter by developer,
// modality, and capability, search by name/id, and copy a model id to
// paste into the Agent Builder or Swarm node config.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Search,
  Copy,
  RefreshCw,
  ExternalLink,
  Boxes,
  Loader2,
  Check,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  getModelRegistry,
  triggerModelRegistrySync,
  type RegistryModel,
  type RegistryMeta,
} from "@/utils/modelRegistry.functions";
import { isProviderSupported, isModelSupported } from "@/lib/providerSupport";
import { useIsSuperadmin } from "@/hooks/use-iam";

// Real provider logos (Simple Icons via jsdelivr — open-source SVGs).
// Anything not listed falls back to the Boxes icon. Slugs match devToSlug
// in src/utils/modelRegistry.functions.ts.
const LOGO: Record<string, string> = {
  openai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/openai.svg",
  anthropic: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/anthropic.svg",
  google: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/google.svg",
  alibaba: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/alibabacloud.svg",
  deepseek: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/deepseek.svg",
  xai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/x.svg",
  meta: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/meta.svg",
  mistral: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/mistralai.svg",
  cohere: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/cohere.svg",
  perplexity: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/perplexity.svg",
  nvidia: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/nvidia.svg",
  bytedance: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/bytedance.svg",
  baidu: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/baidu.svg",
  elevenlabs: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/elevenlabs.svg",
};

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86_400_000);
  if (d < 1) {
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return "just now";
    return `${h}h ago`;
  }
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

export const Route = createFileRoute("/_authenticated/model-registry")({
  component: ModelRegistryPage,
});

function ModelRegistryPage() {
  const { user, session } = useAuth();
  const isAdmin = useIsSuperadmin();
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [meta, setMeta] = useState<RegistryMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<string>("all");
  const [modality, setModality] = useState<string>("text");
  const [capability, setCapability] = useState<string>("all");
  const [supportFilter, setSupportFilter] = useState<"all" | "supported" | "unsupported">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [session?.access_token]);

  async function load() {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await getModelRegistry({ data: { access_token: session.access_token } });
      setModels(res.models);
      setMeta(res.meta);
    } catch (e) {
      toast.error(`Failed to load registry: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function manualSync() {
    if (!session?.access_token) return toast.error("Sign in again to sync");
    setSyncing(true);
    try {
      const res = await triggerModelRegistrySync({ data: { access_token: session.access_token } });
      if (res.ok) {
        toast.success(`Synced ${res.count} models from AIMLAPI`);
        await load();
      } else {
        toast.error(res.error || "Sync failed");
      }
    } finally {
      setSyncing(false);
    }
  }

  const providers = useMemo(() => {
    const map = new Map<string, { slug: string; label: string; count: number }>();
    for (const m of models) {
      const cur = map.get(m.provider_slug);
      if (cur) cur.count += 1;
      else map.set(m.provider_slug, { slug: m.provider_slug, label: m.developer, count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [models]);

  const modalities = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of models) map.set(m.modality, (map.get(m.modality) || 0) + 1);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [models]);

  const capabilities = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) for (const c of m.capabilities) set.add(c);
    return Array.from(set).sort();
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (modality !== "all" && m.modality !== modality) return false;
      if (provider !== "all" && m.provider_slug !== provider) return false;
      if (capability !== "all" && !m.capabilities.includes(capability)) return false;
      if (supportFilter !== "all") {
        const supp = isModelSupported(m.provider_slug, m.modality);
        if (supportFilter === "supported" && !supp) return false;
        if (supportFilter === "unsupported" && supp) return false;
      }
      if (q) {
        const hay =
          `${m.display_name} ${m.model_id} ${m.developer} ${m.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [models, search, provider, modality, capability, supportFilter]);

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      toast.success(`Copied "${id}"`);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      toast.error("Could not access clipboard");
    }
  }

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Integrations
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
              <Boxes className="h-7 w-7 text-primary" /> Model Registry
            </h1>
            <p className="text-muted-foreground mt-1 max-w-2xl">
              Browse {models.length.toLocaleString()} live models across all major providers. Filter
              by capability, copy the exact model id, and paste it into the Agent Builder or any
              swarm node.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Source:{" "}
              <a className="underline" href="https://aimlapi.com" target="_blank" rel="noreferrer">
                AIMLAPI
              </a>{" "}
              · Last refreshed {timeAgo(meta?.last_synced_at || null)}
              {meta?.last_sync_status === "error" && (
                <span className="text-destructive">
                  {" "}
                  · last attempt failed: {meta.last_sync_error}
                </span>
              )}
            </p>
          </div>
          {isAdmin && (
            <Button variant="outline" onClick={manualSync} disabled={syncing}>
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh now
            </Button>
          )}
        </div>

        <Card className="border-border/50">
          <CardContent className="pt-6 grid gap-3 md:grid-cols-4">
            <div className="relative md:col-span-2">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search by name, id, developer, or description"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All providers ({models.length})</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.slug} value={p.slug}>
                    {p.label} ({p.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={capability} onValueChange={setCapability}>
              <SelectTrigger>
                <SelectValue placeholder="Capability" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">Any capability</SelectItem>
                {capabilities.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="md:col-span-4 flex flex-wrap gap-1.5">
              <Badge
                variant={modality === "all" ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setModality("all")}
              >
                All ({models.length})
              </Badge>
              {modalities.map(([m, n]) => (
                <Badge
                  key={m}
                  variant={modality === m ? "default" : "outline"}
                  className="cursor-pointer capitalize"
                  onClick={() => setModality(m)}
                >
                  {m.replace("-", " ")} ({n})
                </Badge>
              ))}
            </div>
            <div className="md:col-span-4 flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/40 mt-1">
              <span className="text-xs text-muted-foreground mr-1">Integration:</span>
              <Badge
                variant={supportFilter === "all" ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setSupportFilter("all")}
              >
                All
              </Badge>
              <Badge
                variant={supportFilter === "supported" ? "default" : "outline"}
                className="cursor-pointer gap-1"
                onClick={() => setSupportFilter("supported")}
              >
                <CheckCircle2 className="h-3 w-3" /> Available
              </Badge>
              <Badge
                variant={supportFilter === "unsupported" ? "default" : "outline"}
                className="cursor-pointer gap-1"
                onClick={() => setSupportFilter("unsupported")}
              >
                <XCircle className="h-3 w-3" /> Not yet supported
              </Badge>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          /* Skeleton in the grid's own shape: the page loads looking like
             itself, and nothing jumps when the data lands. */
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Loading model catalog"
          >
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-xl border border-border/50 bg-card p-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-8 rounded-md" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed border-2 border-border/50">
            <CardContent className="py-12 text-center text-muted-foreground">
              No models match these filters.{" "}
              {models.length === 0 && isAdmin && (
                <Button variant="link" onClick={manualSync}>
                  Run a sync now
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <ScrollArea className="h-[calc(100vh-22rem)] pr-2">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((m) => (
                <Card
                  key={m.id}
                  className="border-border/50 hover:border-primary/40 transition-colors"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start gap-3">
                      <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                        {LOGO[m.provider_slug] ? (
                          <img
                            src={LOGO[m.provider_slug]}
                            alt={m.developer}
                            className="h-5 w-5 dark:invert opacity-80"
                            loading="lazy"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <Boxes className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-sm leading-tight truncate">
                          {m.display_name}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground truncate">{m.developer}</p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0 capitalize">
                        {m.modality.replace("-", " ")}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {isModelSupported(m.provider_slug, m.modality) ? (
                      <Badge className="text-[10px] gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">
                        <CheckCircle2 className="h-3 w-3" /> Integration available
                      </Badge>
                    ) : isProviderSupported(m.provider_slug) ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] gap-1 text-amber-700 dark:text-amber-400 border-amber-500/40 border-dashed"
                      >
                        <XCircle className="h-3 w-3" /> {m.modality.replace("-", " ")} not yet
                        supported
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[10px] gap-1 text-muted-foreground border-dashed"
                      >
                        <XCircle className="h-3 w-3" /> Provider not yet supported
                      </Badge>
                    )}
                    {m.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{m.description}</p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {m.capabilities.slice(0, 4).map((c) => (
                        <Badge key={c} variant="secondary" className="text-[10px]">
                          {c}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-[11px] text-muted-foreground flex gap-3">
                      <span>ctx {fmtNum(m.context_length)}</span>
                      <span>out {fmtNum(m.output_max)}</span>
                    </div>
                    <div
                      className="rounded border bg-muted/40 px-2 py-1 font-mono text-[11px] truncate"
                      title={m.model_id}
                    >
                      {m.model_id}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => copyId(m.model_id)}
                      >
                        {copiedId === m.model_id ? (
                          <Check className="h-3 w-3 mr-1" />
                        ) : (
                          <Copy className="h-3 w-3 mr-1" />
                        )}
                        {copiedId === m.model_id ? "Copied" : "Copy id"}
                      </Button>
                      {m.docs_url && (
                        <Button size="sm" variant="ghost" asChild>
                          <a href={m.docs_url} target="_blank" rel="noreferrer" title="Docs">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
