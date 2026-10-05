// A global view over swarm_api_keys — real backend, not mocked. The table
// itself already exists (supabase/migrations/20260725000000_swarm_deploy.sql)
// and is per-swarm; SwarmDeployDialog.tsx manages one swarm's keys at a time
// from inside that swarm's own canvas. This panel lists every key across
// every swarm the user owns in one place, using the same createSwarmApiKey
// server function (raw key + webhook secret shown once, hash-only storage)
// and the same direct-delete revoke RLS already authorizes.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { createSwarmApiKey } from "@/utils/swarmDeploy.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { Skeleton } from "@/components/ui/skeleton";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { KeyRound, Copy, Check, Plus, Trash2, ArrowRight, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { API_KEY_CATEGORIES, type ApiKeyCategoryId } from "@/lib/apiKeyCategories";
import { ProviderCredentialsPanel } from "@/components/integrations/ProviderCredentialsPanel";
import { GatewayApiCard } from "@/components/gateway/GatewayApiCard";
import { MlModelApiKeysPanel } from "@/components/settings/MlModelApiKeysPanel";
import { SecretsManagerPanel } from "@/components/settings/SecretsManagerPanel";
import { EmbedSection } from "@/components/embed/EmbedSection";
import { McpServersPanel } from "@/components/settings/McpServersPanel";

/**
 * What each category's "Manage" button actually opens, inline, in a Dialog —
 * the real controls (connect/test/disconnect, create/edit/delete, etc.),
 * never a navigation. Every one of these is the exact same component its
 * dedicated page renders, not a second copy of that page's logic.
 */
function CategoryPanel({ id }: { id: ApiKeyCategoryId }) {
  const { session } = useAuth();
  switch (id) {
    case "providers":
      return <ProviderCredentialsPanel />;
    case "gateway":
      return session?.access_token ? (
        <GatewayApiCard token={session.access_token} />
      ) : (
        <p className="text-sm text-muted-foreground">Sign in again to manage gateway keys.</p>
      );
    case "ml":
      return <MlModelApiKeysPanel />;
    case "secrets":
      return <SecretsManagerPanel />;
    case "embeds":
      return <EmbedSection />;
    case "mcp":
      return <McpServersPanel />;
  }
}

type ApiKeyRow = {
  id: string;
  swarm_id: string;
  name: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
};

type SwarmOption = { id: string; name: string };

const EXPIRY_PRESETS: { label: string; days: number }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never expires", days: 0 },
];

function keyExpiryLabel(k: ApiKeyRow): { label: string; expired: boolean } {
  if (!k.expires_at) return { label: "Never", expired: false };
  const ms = Date.parse(k.expires_at) - Date.now();
  if (ms <= 0) return { label: "Expired", expired: true };
  return { label: `${Math.ceil(ms / 86_400_000)}d left`, expired: false };
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              toast.success("Copied to clipboard");
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error("Couldn't copy — select and copy manually.");
            }
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * One category card: label/description from the static registry, count
 * fetched live and independently — a failed or slow count on one category
 * (e.g. a table an older self-hosted deployment hasn't migrated yet) never
 * blocks or blanks out the others, it just shows "—" for that one card.
 */
function CategoryCard({
  category,
  onManage,
}: {
  category: (typeof API_KEY_CATEGORIES)[number];
  onManage: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // category.table is a plain string (the registry lists tables the
      // generated Database type may not even know about on every
      // deployment) — bypass the strict literal-union overload the same
      // way the rest of this codebase does for a dynamic table name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = supabase
        .from(category.table as never)
        .select("id", { count: "exact", head: true });
      if (category.filter)
        query = query[category.filter.op](category.filter.column, category.filter.value);
      const { count: n, error } = await query;
      if (cancelled) return;
      // `head: true` means a failed request (e.g. this table doesn't exist
      // on an older self-hosted deployment that hasn't run every migration)
      // comes back with NO body — HTTP HEAD responses never have one — so
      // PostgREST's error details never reach `error`, and `count` is left
      // null rather than populated from the (absent) Content-Range header.
      // Treating null the same as a thrown error, instead of defaulting it
      // to 0, is the difference between "unavailable" and a false "you have
      // none of these" — confirmed against this exact failure mode live:
      // ml_api_keys/gateway_keys 404 on a deployment missing those
      // migrations, and silently rendered "0" before this check existed.
      if (error || n === null) setFailed(true);
      else setCount(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [category]);

  const Icon = category.icon;
  return (
    <button
      type="button"
      onClick={onManage}
      className="group flex flex-col gap-2 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-2">
        <Icon className="h-4 w-4 text-primary" />
        {failed ? (
          <span
            className="text-xs text-muted-foreground"
            title="Count unavailable — this deployment may not have run the migration this feature needs yet"
          >
            —
          </span>
        ) : (
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {count === null ? "…" : count}
          </Badge>
        )}
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{category.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{category.description}</p>
      </div>
      <span className="mt-auto flex items-center gap-1 pt-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
        <Settings2 className="h-3 w-3" /> Manage
      </span>
    </button>
  );
}

export function ApiKeysSettingsPanel() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [swarms, setSwarms] = useState<SwarmOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [openCategory, setOpenCategory] = useState<ApiKeyCategoryId | null>(null);
  const activeCategory = API_KEY_CATEGORIES.find((c) => c.id === openCategory) ?? null;

  const [createOpen, setCreateOpen] = useState(false);
  const [targetSwarmId, setTargetSwarmId] = useState<string>("");
  const [keyName, setKeyName] = useState("Production key");
  const [expiryDays, setExpiryDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{
    raw_key: string;
    webhook_secret: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const [swarmsRes, keysRes] = await Promise.all([
      supabase.from("swarms").select("id, name").order("name", { ascending: true }),
      supabase
        .from("swarm_api_keys")
        .select("id, swarm_id, name, key_prefix, is_active, last_used_at, created_at, expires_at")
        .order("created_at", { ascending: false }),
    ]);
    if (swarmsRes.error || keysRes.error) {
      setLoadError(swarmsRes.error?.message ?? keysRes.error?.message ?? "Could not load API keys");
      setLoading(false);
      return;
    }
    setSwarms((swarmsRes.data ?? []) as SwarmOption[]);
    setKeys((keysRes.data ?? []) as ApiKeyRow[]);
    if (!targetSwarmId && swarmsRes.data?.[0]) setTargetSwarmId(swarmsRes.data[0].id);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const swarmName = (id: string) => swarms.find((s) => s.id === id)?.name ?? "Unknown swarm";

  const handleCreate = async () => {
    if (!targetSwarmId) {
      toast.error("Pick a swarm for this key first");
      return;
    }
    setCreating(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await createSwarmApiKey({
        data: {
          access_token: token,
          swarm_id: targetSwarmId,
          name: keyName.trim() || "API key",
          expires_in_days: expiryDays > 0 ? expiryDays : null,
        },
      });
      if (!res.ok) throw new Error(res.error);
      setJustCreated({ raw_key: res.raw_key, webhook_secret: res.webhook_secret });
      setKeyName("Production key");
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

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="h-4 w-4 text-primary" /> AgentSwarms API keys
            </h3>
            <p className="text-xs text-muted-foreground">
              Run a swarm headlessly via <code className="font-mono">POST /api/swarm/run</code>.
              Every key belongs to one swarm — pick which one when you create it.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => {
              setJustCreated(null);
              setCreateOpen(true);
            }}
            disabled={swarms.length === 0}
          >
            <Plus className="h-3.5 w-3.5" /> Generate key
          </Button>
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            {swarms.length === 0
              ? "Create a swarm first — a key deploys one specific swarm."
              : "No API keys yet."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Swarm</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const exp = keyExpiryLabel(k);
                  return (
                    <TableRow key={k.id}>
                      <TableCell className="text-sm font-medium">{k.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {swarmName(k.swarm_id)}
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs text-muted-foreground">
                          {k.key_prefix}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={exp.expired ? "destructive" : "outline"}
                          className="text-[10px]"
                        >
                          {exp.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-destructive hover:text-destructive"
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" /> Revoke
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Revoke "{k.name}"?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Anything still using this key will start failing immediately. This
                                cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => void revokeKey(k.id)}
                              >
                                Revoke
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {createOpen && (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            {justCreated ? (
              <div className="space-y-3">
                <p className="text-xs font-medium text-foreground">
                  Copy this now — it won't be shown again.
                </p>
                <CopyField value={justCreated.raw_key} label="API key" />
                {justCreated.webhook_secret && (
                  <CopyField value={justCreated.webhook_secret} label="Webhook signing secret" />
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false);
                    setJustCreated(null);
                  }}
                >
                  Done
                </Button>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Swarm</Label>
                    <Select value={targetSwarmId} onValueChange={setTargetSwarmId}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Pick a swarm" />
                      </SelectTrigger>
                      <SelectContent>
                        {swarms.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Name</Label>
                    <Input
                      className="h-9"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      placeholder="Production key"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs">Expires</Label>
                    <Select
                      value={String(expiryDays)}
                      onValueChange={(v) => setExpiryDays(Number(v))}
                    >
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
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCreateOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleCreate()}
                    disabled={creating}
                  >
                    {creating ? "Creating…" : "Create key"}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Approval nodes auto-reject by default on headless runs, and every schedule/rotation option
          lives in that swarm's own Deploy dialog —{" "}
          <Link to="/swarms" className="text-primary hover:underline">
            open a swarm's canvas <ArrowRight className="inline h-3 w-3" />
          </Link>
        </p>
      </div>

      <Separator />

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Everywhere else in AgentSwarms</h3>
          <p className="text-xs text-muted-foreground">
            Every other credential store in the app, with a live count — click a category to
            connect, test or revoke its keys right here.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {API_KEY_CATEGORIES.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              onManage={() => setOpenCategory(category.id)}
            />
          ))}
        </div>
      </div>

      <Dialog open={openCategory !== null} onOpenChange={(v) => !v && setOpenCategory(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {activeCategory && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <activeCategory.icon className="h-4 w-4 text-primary" /> {activeCategory.label}
                </DialogTitle>
                <DialogDescription>{activeCategory.description}</DialogDescription>
              </DialogHeader>
              <CategoryPanel id={activeCategory.id} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
