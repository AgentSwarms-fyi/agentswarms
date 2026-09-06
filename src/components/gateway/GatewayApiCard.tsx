// Integrations -> LLM Gateway -> "API access": the inbound side of the
// gateway. Mint a key, choose what it reaches and what it may fall back to,
// copy the key once, and point any OpenAI SDK at <origin>/api/v1.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Copy, DatabaseZap, KeyRound, Loader2, Plus, ShieldOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import {
  gatewayAgentsList,
  gatewayCacheClear,
  gatewayCacheList,
  gatewayKeyCreate,
  gatewayKeyRevoke,
  gatewayKeysList,
  gatewayKeyUpdate,
  gatewaySemanticModelsList,
  type GatewayKeyListRow,
} from "@/utils/gatewayKeys.functions";
import { GATEWAY_KEY_SCOPES, type GatewayKeyScope } from "@/utils/gateway/keys";

type AgentOption = { id: string; name: string; model: string };
type CacheEntry = {
  id: string;
  question: string;
  model: string;
  hits: number;
  created_at: string;
  expires_at: string;
};
type SemanticOption = { id: string; name: string; label: string | null; shared: boolean };

const SCOPE_LABEL: Record<GatewayKeyScope, string> = {
  agents: "Agents (model = agent:<name or id>)",
  models: "Models (model = <provider>/<model>)",
  metrics: "Metrics (the semantic layer: GET /metrics, POST /metrics/query)",
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * How long until an instant. relTime above measures backwards from now, which
 * reads every future date as "just now" - a lifetime is the one value here
 * that is always ahead of us.
 */
function untilTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy; select the text and copy it by hand");
        }
      }}
    >
      {done ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
      {label ?? (done ? "Copied" : "Copy")}
    </Button>
  );
}

export function GatewayApiCard({ token }: { token: string }) {
  const listFn = useServerFn(gatewayKeysList);
  const agentsFn = useServerFn(gatewayAgentsList);
  const semanticFn = useServerFn(gatewaySemanticModelsList);
  const createFn = useServerFn(gatewayKeyCreate);
  const updateFn = useServerFn(gatewayKeyUpdate);
  const revokeFn = useServerFn(gatewayKeyRevoke);
  const cacheListFn = useServerFn(gatewayCacheList);
  const cacheClearFn = useServerFn(gatewayCacheClear);

  const [keys, setKeys] = useState<GatewayKeyListRow[] | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [semanticModels, setSemanticModels] = useState<SemanticOption[]>([]);
  const [cache, setCache] = useState<CacheEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<GatewayKeyListRow | null>(null);
  const [minted, setMinted] = useState<{
    key: string;
    name: string;
    rejected: string[];
    scopes: GatewayKeyScope[];
  } | null>(null);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<GatewayKeyScope[]>(["agents"]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [semanticModelIds, setSemanticModelIds] = useState<string[]>([]);
  const [modelAllow, setModelAllow] = useState("");
  const [fallbacks, setFallbacks] = useState("");
  const [semanticCache, setSemanticCache] = useState(false);
  const [rateLimit, setRateLimit] = useState("");
  const [budget, setBudget] = useState("");
  const [expiresDays, setExpiresDays] = useState("0");

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const baseUrl = `${origin}/api/v1`;

  const reload = useCallback(async () => {
    const [k, a, s, c] = await Promise.all([
      listFn({ data: { access_token: token } }),
      agentsFn({ data: { access_token: token } }),
      semanticFn({ data: { access_token: token } }),
      cacheListFn({ data: { access_token: token } }),
    ]);
    if (k.ok) setKeys(k.keys);
    else toast.error(k.error);
    if (a.ok) setAgents(a.agents);
    if (s.ok) setSemanticModels(s.models);
    if (c.ok) setCache(c.entries);
  }, [listFn, agentsFn, semanticFn, cacheListFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** The panel shows itself once anything can fill it, and not before. */
  const cacheOn = useMemo(() => (keys ?? []).some((k) => k.semantic_cache), [keys]);
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const semanticName = useMemo(
    () => new Map(semanticModels.map((m) => [m.id, m.label ?? m.name])),
    [semanticModels],
  );

  const lines = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

  async function create() {
    if (!name.trim()) return toast.error("Give the key a name");
    if (scopes.length === 0) return toast.error("Pick at least one scope");
    setBusy(true);
    try {
      const expires_at =
        Number(expiresDays) > 0
          ? new Date(Date.now() + Number(expiresDays) * 86400000).toISOString()
          : null;
      const res = await createFn({
        data: {
          access_token: token,
          name: name.trim(),
          scopes,
          agent_ids: scopes.includes("agents") ? agentIds : [],
          model_allow: scopes.includes("models") ? lines(modelAllow) : [],
          semantic_model_ids: scopes.includes("metrics") ? semanticModelIds : [],
          fallback_models: lines(fallbacks),
          semantic_cache: semanticCache,
          rate_limit_per_min: rateLimit.trim() ? Number(rateLimit) : null,
          monthly_cap_usd: budget.trim() ? Number(budget) : null,
          expires_at,
        },
      });
      if (!res.ok) return toast.error(res.error);
      setMinted({
        key: res.key,
        name: name.trim(),
        rejected: res.rejected_fallbacks,
        scopes: [...scopes],
      });
      setOpen(false);
      setName("");
      setAgentIds([]);
      setSemanticModelIds([]);
      setModelAllow("");
      setFallbacks("");
      setSemanticCache(false);
      setRateLimit("");
      setBudget("");
      setExpiresDays("0");
      setScopes(["agents"]);
      toast.success("Key created");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  /** Flip one key's cache. A live switch, because the answer to "is this key
   * reusing answers it should not?" is usually needed now, not next release. */
  async function toggleCache(k: GatewayKeyListRow, on: boolean) {
    setBusy(true);
    try {
      const res = await updateFn({
        data: { access_token: token, id: k.id, semantic_cache: on },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(on ? `Cache on for ${k.name}` : `Cache off for ${k.name}`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function clearCache() {
    setBusy(true);
    try {
      const res = await cacheClearFn({ data: { access_token: token } });
      if (!res.ok) return toast.error(res.error);
      toast.success(
        res.cleared === 1 ? "Cleared 1 cached answer" : `Cleared ${res.cleared} cached answers`,
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: GatewayKeyListRow) {
    setBusy(true);
    try {
      const res = await revokeFn({ data: { access_token: token, id: k.id } });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Revoked ${k.name}`);
      setRevoking(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const curl = (key: string) =>
    `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "agent:<agent name or id>", "stream": true,
       "messages": [{"role": "user", "content": "Hello"}]}'`;
  const python = (key: string) =>
    `from openai import OpenAI
client = OpenAI(base_url="${baseUrl}", api_key="${key}")
reply = client.chat.completions.create(
    model="agent:<agent name or id>",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`;
  const metricsCurl = (key: string) =>
    `curl ${baseUrl}/metrics -H "Authorization: Bearer ${key}"
curl ${baseUrl}/metrics/query \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "<semantic model name>", "metrics": ["<metric>"],
       "dimensions": ["<dimension>"], "limit": 100}'`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> API access
        </CardTitle>
        <CardDescription>
          An OpenAI-compatible endpoint in front of your agents and connected models. Point any
          OpenAI SDK at the base URL below with a key from this list; every call runs as you, under
          your model rules, budgets, guardrails, traces and audit trail. A key with the metrics
          scope also answers governed semantic-layer queries at /metrics and /metrics/query.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Base URL</span>
          <code className="font-mono text-xs">{baseUrl}</code>
          <CopyButton text={baseUrl} />
          <span className="text-xs text-muted-foreground">
            · <code className="font-mono">model</code> is{" "}
            <code className="font-mono">agent:&lt;name or id&gt;</code> or{" "}
            <code className="font-mono">&lt;provider&gt;/&lt;model&gt;</code>
          </span>
        </div>

        {minted ? (
          <div className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
            <p className="text-sm font-medium">
              Key for {minted.name} — copy it now, it will not be shown again
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
                {minted.key}
              </code>
              <CopyButton text={minted.key} />
            </div>
            {minted.rejected.length ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Ignored fallback entries (not provider/model): {minted.rejected.join(", ")}
              </p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">curl</span>
                  <CopyButton text={curl(minted.key)} />
                </div>
                <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-snug">
                  {curl(minted.key)}
                </pre>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Python (openai SDK)</span>
                  <CopyButton text={python(minted.key)} />
                </div>
                <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-snug">
                  {python(minted.key)}
                </pre>
              </div>
              {minted.scopes.includes("metrics") ? (
                <div className="space-y-1 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Metrics API (curl)</span>
                    <CopyButton text={metricsCurl(minted.key)} />
                  </div>
                  <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-snug">
                    {metricsCurl(minted.key)}
                  </pre>
                </div>
              ) : null}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setMinted(null)}>
              Done
            </Button>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Keys</p>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Create key
          </Button>
        </div>

        {keys === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No keys yet. Create one to call your agents from any OpenAI-compatible client.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Reaches</th>
                  <th className="px-3 py-2 font-medium">Fallbacks</th>
                  <th className="px-3 py-2 font-medium">Cache</th>
                  <th className="px-3 py-2 font-medium">Budget</th>
                  <th className="px-3 py-2 font-medium">Used</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const revoked = !k.is_active || Boolean(k.revoked_at);
                  const expired = k.expires_at
                    ? new Date(k.expires_at).getTime() < Date.now()
                    : false;
                  return (
                    <tr key={k.id} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">{k.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">{k.key_prefix}…</td>
                      <td className="px-3 py-2 text-xs">
                        {k.scopes.includes("agents") ? (
                          <div>
                            Agents:{" "}
                            {k.agent_ids.length === 0
                              ? "all"
                              : k.agent_ids
                                  .map((id) => agentName.get(id) ?? id.slice(0, 8))
                                  .join(", ")}
                          </div>
                        ) : null}
                        {k.scopes.includes("models") ? (
                          <div>
                            Models:{" "}
                            {k.model_allow.length ? k.model_allow.join(", ") : "any allowed"}
                          </div>
                        ) : null}
                        {k.scopes.includes("metrics") ? (
                          <div>
                            Metrics:{" "}
                            {k.semantic_model_ids.length === 0
                              ? "all"
                              : k.semantic_model_ids
                                  .map((id) => semanticName.get(id) ?? id.slice(0, 8))
                                  .join(", ")}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {k.fallback_models.length ? k.fallback_models.join(" → ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <label className="flex items-center gap-1.5">
                          <Checkbox
                            checked={k.semantic_cache}
                            disabled={busy || revoked}
                            onCheckedChange={(v) => void toggleCache(k, v === true)}
                            aria-label={`Semantic cache for ${k.name}`}
                          />
                          <span className="text-muted-foreground">
                            {k.semantic_cache ? "on" : "off"}
                          </span>
                        </label>
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums">
                        {k.monthly_cap_usd ? `$${k.monthly_cap_usd}/mo` : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums">
                        {k.use_count} · {relTime(k.last_used_at)}
                      </td>
                      <td className="px-3 py-2">
                        {revoked ? (
                          <Badge variant="secondary">revoked</Badge>
                        ) : expired ? (
                          <Badge variant="secondary">expired</Badge>
                        ) : (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">active</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!revoked ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => setRevoking(k)}
                          >
                            <ShieldOff className="mr-1 h-3.5 w-3.5" /> Revoke
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {cacheOn || cache.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <DatabaseZap className="h-4 w-4" /> Semantic cache
                <span className="font-normal text-muted-foreground">
                  {cache.length === 0
                    ? "empty"
                    : cache.length === 1
                      ? "1 answer stored"
                      : `${cache.length} answers stored`}
                </span>
              </div>
              {cache.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void clearCache()}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear cache
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              A key with the cache on answers a repeated question from here instead of calling the
              provider. Only single-question calls that used no tools are stored, and never across
              users, agents or system prompts. Clear it if an answer is being reused for a question
              it does not answer.
            </p>
            {cache.length > 0 ? (
              <div className="max-h-56 overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Question</th>
                      <th className="px-2 py-1.5 font-medium">Answered by</th>
                      <th className="px-2 py-1.5 font-medium">Reused</th>
                      <th className="px-2 py-1.5 font-medium">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cache.map((e) => (
                      <tr key={e.id} className="border-t align-top">
                        <td className="max-w-md truncate px-2 py-1.5" title={e.question}>
                          {e.question}
                        </td>
                        <td className="px-2 py-1.5 font-mono">{e.model}</td>
                        <td className="px-2 py-1.5 tabular-nums">{e.hits}×</td>
                        <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                          {untilTime(e.expires_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create a gateway key</DialogTitle>
            <DialogDescription>
              The key calls as you. Narrow what it reaches; you can revoke it at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="gw-name">Name</Label>
              <Input
                id="gw-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Support bot in Slack"
              />
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="flex flex-wrap gap-4">
                {GATEWAY_KEY_SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={scopes.includes(s)}
                      onCheckedChange={(v) =>
                        setScopes((prev) =>
                          v ? [...new Set([...prev, s])] : prev.filter((x) => x !== s),
                        )
                      }
                    />
                    {SCOPE_LABEL[s]}
                  </label>
                ))}
              </div>
            </div>
            {scopes.includes("agents") ? (
              <div className="space-y-2">
                <Label>Agents this key may call</Label>
                <p className="text-xs text-muted-foreground">None ticked = every agent you own.</p>
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                  {agents.length === 0 ? (
                    <p className="text-xs text-muted-foreground">You have no active agents yet.</p>
                  ) : (
                    agents.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={agentIds.includes(a.id)}
                          onCheckedChange={(v) =>
                            setAgentIds((prev) =>
                              v ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                            )
                          }
                        />
                        <span>{a.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{a.model}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}
            {scopes.includes("models") ? (
              <div className="space-y-1">
                <Label htmlFor="gw-allow">Models this key may call directly</Label>
                <Textarea
                  id="gw-allow"
                  value={modelAllow}
                  onChange={(e) => setModelAllow(e.target.value)}
                  rows={2}
                  className="font-mono text-xs"
                  placeholder={"openrouter/*\nanthropic/claude-*"}
                />
                <p className="text-xs text-muted-foreground">
                  One provider/model pattern per line; * matches anything. Empty = anything your
                  model rules allow.
                </p>
              </div>
            ) : null}
            {scopes.includes("metrics") ? (
              <div className="space-y-2">
                <Label>Semantic models this key may query</Label>
                <p className="text-xs text-muted-foreground">
                  None ticked = every model you own or are granted. Naming a model never grants
                  access you do not have.
                </p>
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                  {semanticModels.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No semantic models yet. Define one under Data &amp; BI → Semantic Layer.
                    </p>
                  ) : (
                    semanticModels.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={semanticModelIds.includes(m.id)}
                          onCheckedChange={(v) =>
                            setSemanticModelIds((prev) =>
                              v ? [...prev, m.id] : prev.filter((x) => x !== m.id),
                            )
                          }
                        />
                        <span>{m.label ?? m.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {m.name}
                          {m.shared ? " · shared" : ""}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="gw-fallback">Fallback chain</Label>
              <Textarea
                id="gw-fallback"
                value={fallbacks}
                onChange={(e) => setFallbacks(e.target.value)}
                rows={2}
                className="font-mono text-xs"
                placeholder={"openrouter/openai/gpt-4o-mini\nopenrouter/google/gemini-2.5-flash"}
              />
              <p className="text-xs text-muted-foreground">
                Tried in order when the requested model fails with a provider error, before the
                instance-wide chain. One provider/model per line.
              </p>
            </div>
            <label className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox
                id="gw-cache"
                checked={semanticCache}
                onCheckedChange={(v) => setSemanticCache(v === true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Answer repeated questions from the semantic cache
                <span className="block text-xs text-muted-foreground">
                  A question close enough in meaning to one this key already asked is answered from
                  the stored answer instead of the provider. Single-question calls only, nothing
                  that used a tool, and never across users, agents or system prompts. Leave off if
                  every call must reach the model.
                </span>
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="gw-rate">Calls per minute</Label>
                <Input
                  id="gw-rate"
                  type="number"
                  min={1}
                  value={rateLimit}
                  onChange={(e) => setRateLimit(e.target.value)}
                  placeholder="instance default"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gw-budget">Monthly budget (USD)</Label>
                <Input
                  id="gw-budget"
                  type="number"
                  min={0}
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="none"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gw-expiry">Expires</Label>
                <select
                  id="gw-expiry"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={expiresDays}
                  onChange={(e) => setExpiresDays(e.target.value)}
                >
                  <option value="0">never</option>
                  <option value="30">in 30 days</option>
                  <option value="90">in 90 days</option>
                  <option value="365">in a year</option>
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(revoking)} onOpenChange={(v) => !v && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              Every client using this key stops immediately. This cannot be undone; mint a new key
              instead if you need access back.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => revoking && void revoke(revoking)}
              disabled={busy}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
