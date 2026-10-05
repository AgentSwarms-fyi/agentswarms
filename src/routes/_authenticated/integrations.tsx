import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { integrationsReadNotice, type StatusReadState } from "@/lib/integrationStatusClaim";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WarehousesTab } from "@/components/integrations/WarehousesTab";
import { SaasSourcesTab } from "@/components/integrations/SaasSourcesTab";
import { SlackTab } from "@/components/integrations/SlackTab";
import { TeamsTab } from "@/components/integrations/TeamsTab";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import {
  Zap,
  Cloud,
  Brain,
  Server,
  Globe,
  Shield,
  Check,
  X,
  Settings2,
  Loader2,
  Boxes,
  Sparkles,
  HardDrive,
  Bell,
  Users,
  HelpCircle,
} from "lucide-react";
import {
  testN8nInstance,
  testFirecrawlKey,
  testLlmGateway,
  testNotificationChannel,
  saveIntegration,
} from "@/utils/integrations.functions";
import { GatewayApiCard } from "@/components/gateway/GatewayApiCard";
import { ProviderCredentialsPanel } from "@/components/integrations/ProviderCredentialsPanel";

export const Route = createFileRoute("/_authenticated/integrations")({
  component: IntegrationsPage,
});

const GATEWAY_PROVIDERS = [
  { value: "litellm", label: "LiteLLM" },
  { value: "portkey", label: "Portkey" },
  { value: "helicone", label: "Helicone" },
  { value: "custom", label: "Custom Gateway" },
];

type Integration = {
  id: string;
  type: string;
  name: string;
  provider: string | null;
  config: Record<string, any>;
  is_active: boolean;
};

function IntegrationsPage() {
  const { user, session } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [gatewayProvider, setGatewayProvider] = useState("litellm");
  const [gatewayRoute, setGatewayRoute] = useState(false);
  const [gatewayRouteAll, setGatewayRouteAll] = useState(false);
  const [gatewayHasKey, setGatewayHasKey] = useState(false);
  const [gatewayTesting, setGatewayTesting] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [n8nUrl, setN8nUrl] = useState("");
  const [n8nToken, setN8nToken] = useState("");
  const [n8nAuthType, setN8nAuthType] = useState("header");
  const [n8nTesting, setN8nTesting] = useState(false);
  const [n8nStatus, setN8nStatus] = useState<{
    ok: boolean;
    detail: string;
    workflowCount?: number;
  } | null>(null);
  const [firecrawlKey, setFirecrawlKey] = useState("");
  const [firecrawlTesting, setFirecrawlTesting] = useState(false);
  const [firecrawlStatus, setFirecrawlStatus] = useState<{ ok: boolean; detail: string } | null>(
    null,
  );
  // Notification channels: per-kind URL drafts + test state.
  const [notifUrls, setNotifUrls] = useState<Record<string, string>>({});
  const [notifTesting, setNotifTesting] = useState<string | null>(null);
  const [notifStatus, setNotifStatus] = useState<
    Record<string, { ok: boolean; detail: string } | undefined>
  >({});
  // How the integrations read went — the page says so when it fails rather
  // than silently rendering an account with nothing configured.
  const [readState, setReadState] = useState<StatusReadState>({ loaded: false, error: null });

  useEffect(() => {
    loadIntegrations();
  }, []);

  async function loadIntegrations() {
    // LLM provider credentials (incl. the encrypted provider_credentials
    // table) are owned by ProviderCredentialsPanel now — this fetch only
    // needs the plaintext `integrations` rows the other tabs read directly.
    const { data: integ, error: integError } = await supabase.from("integrations").select("*");
    setReadState({ loaded: true, error: integError ? integError.message : null });

    const merged: Integration[] = integ ? (integ as Integration[]) : [];
    setIntegrations(merged);
    const gw = merged.find((i) => i.type === "llm_gateway");
    if (gw) {
      const c = gw.config as Record<string, any>;
      setGatewayUrl(c?.base_url || "");
      // The key is write-only: encrypted rows never ship it back, and legacy
      // plaintext rows are no longer pre-filled into the form either.
      setGatewayKey("");
      setGatewayHasKey(Boolean(c?.api_key_enc || c?.api_key));
      setGatewayProvider(c?.provider || "litellm");
      setGatewayRoute(gw.is_active);
      setGatewayRouteAll(c?.route_all === true);
    }
    const n8n = merged.find((i) => i.type === "n8n");
    if (n8n) {
      const c = n8n.config as Record<string, any>;
      setN8nUrl(c?.instance_url || "");
      setN8nToken(c?.webhook_token || "");
      setN8nAuthType(c?.auth_type || "header");
    }
  }

  async function saveGateway() {
    if (!user) return;
    if (!session?.access_token) {
      toast.error("Your session expired. Please sign in again.");
      return;
    }
    if (!gatewayUrl.trim()) {
      toast.error("Gateway base URL is required");
      return;
    }
    setGatewayTesting(true);
    setGatewayStatus(null);

    // Activating a gateway (especially route-all) can redirect every LLM call
    // on this account, so ENABLING requires a passing live test — the same
    // honesty bar as every other connector. A disabled gateway saves untested
    // (parked config). Blank key = server tests against the saved key.
    let activate = gatewayRoute;
    let testResult: { ok: boolean; detail: string } | null = null;
    if (gatewayRoute) {
      try {
        testResult = await testLlmGateway({
          data: {
            access_token: session.access_token,
            base_url: gatewayUrl,
            api_key: gatewayKey,
            provider: gatewayProvider,
          },
        });
      } catch (e) {
        testResult = { ok: false, detail: e instanceof Error ? e.message : "Test request failed" };
      }
      setGatewayStatus(testResult);
      if (!testResult.ok) activate = false;
    }

    const existing = integrations.find((i) => i.type === "llm_gateway");
    // api_key is encrypted server-side; leaving the key field blank on an
    // existing gateway keeps the previously-saved key.
    const res = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "llm_gateway",
        provider: gatewayProvider,
        name: "LLM Gateway",
        config: {
          base_url: gatewayUrl,
          api_key: gatewayKey,
          provider: gatewayProvider,
          route_all: gatewayRouteAll,
        },
        is_active: activate,
      },
    });
    setGatewayTesting(false);
    if (!res.ok) {
      toast.error(`Could not save gateway: ${res.error}`);
      return;
    }
    if (gatewayRoute && testResult && !testResult.ok) {
      setGatewayRoute(false);
      toast.error(`Gateway saved but left disabled — validation failed: ${testResult.detail}`);
    } else if (activate) {
      toast.success(`Gateway connected — ${testResult?.detail ?? "saved"}`);
    } else {
      toast.success("Gateway saved (disabled)");
    }
    if (gatewayKey.trim()) setGatewayHasKey(true);
    setGatewayKey("");
    loadIntegrations();
  }

  async function saveN8n() {
    if (!user) return;
    if (!session?.access_token) {
      toast.error("Please sign in again before testing n8n");
      return;
    }
    setN8nTesting(true);
    setN8nStatus(null);

    // Live-validate against /api/v1/workflows before persisting active=true,
    // so the "Connected" state on the n8n card reflects a real auth roundtrip.
    let testResult: { ok: boolean; detail: string; workflowCount?: number };
    try {
      testResult = await testN8nInstance({
        data: {
          access_token: session.access_token,
          instance_url: n8nUrl,
          webhook_token: n8nToken,
          auth_type: n8nAuthType as "header" | "basic" | "none",
        },
      });
    } catch (e) {
      testResult = { ok: false, detail: e instanceof Error ? e.message : "Test request failed" };
    }
    setN8nStatus(testResult);
    setN8nTesting(false);

    const existing = integrations.find((i) => i.type === "n8n");
    // webhook_token is encrypted server-side; a blank token on an existing n8n
    // integration keeps the previously-saved token.
    const n8nSave = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "n8n",
        provider: "n8n",
        name: "n8n",
        config: {
          instance_url: n8nUrl,
          webhook_token: n8nToken,
          auth_type: n8nAuthType,
          last_test_status: testResult.ok ? "success" : "error",
          last_test_detail: testResult.detail,
          last_tested_at: new Date().toISOString(),
          workflow_count: testResult.workflowCount ?? null,
        },
        is_active: testResult.ok,
      },
    });
    if (!n8nSave.ok) {
      toast.error(`Could not save n8n: ${n8nSave.error}`);
    } else if (testResult.ok) {
      toast.success(`n8n connected — ${testResult.detail}`);
    } else {
      toast.error(`Could not connect to n8n: ${testResult.detail}`);
    }
    loadIntegrations();
  }

  async function saveFirecrawl() {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      toast.error("Please sign in again before saving Firecrawl");
      return;
    }
    const existing = integrations.find((i) => i.type === "firecrawl");
    const key = firecrawlKey.trim();
    // No new key + already connected ⇒ nothing to do (key is write-only).
    if (!key && !existing) {
      toast.error("Paste your Firecrawl API key first");
      return;
    }
    setFirecrawlTesting(true);
    setFirecrawlStatus(null);
    // Only live-test when a new key was entered (we can't read the stored one back).
    const testResult: { ok: boolean; detail: string } = key
      ? await testFirecrawlKey({ data: { access_token: session.access_token, api_key: key } })
      : { ok: true, detail: "Kept the saved key." };
    setFirecrawlStatus(testResult);
    if (key && !testResult.ok) {
      setFirecrawlTesting(false);
      toast.error(`Firecrawl: ${testResult.detail}`);
      return;
    }
    // api_key is encrypted server-side; a blank key on an existing row keeps
    // the previously-saved key.
    const fcSave = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "firecrawl",
        provider: "firecrawl",
        name: "Firecrawl",
        config: {
          api_key: key,
          last_test_status: testResult.ok ? "success" : "error",
          last_test_detail: testResult.detail,
          last_tested_at: new Date().toISOString(),
        },
        is_active: true,
      },
    });
    setFirecrawlKey("");
    setFirecrawlTesting(false);
    if (!fcSave.ok) {
      toast.error(`Could not save Firecrawl: ${fcSave.error}`);
      return;
    }
    toast.success("Firecrawl connected — web_search and web_browse are ready.");
    loadIntegrations();
  }

  async function saveNotifChannel(kind: "slack" | "teams" | "discord" | "webhook", label: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error("Please sign in again.");
      return;
    }
    const url = (notifUrls[kind] || "").trim();
    const existing = integrations.find((i) => i.type === "notification" && i.provider === kind);
    if (!url && !existing) {
      toast.error("Paste the webhook URL first.");
      return;
    }
    setNotifTesting(kind);
    setNotifStatus((s) => ({ ...s, [kind]: undefined }));
    // Always live-test before (re)activating — the test posts a visible
    // message with the exact payload real sends use. Blank URL re-tests the
    // saved (encrypted) one.
    let result: { ok: boolean; detail: string };
    try {
      result = await testNotificationChannel({
        data: { access_token: token, provider: kind, webhook_url: url },
      });
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : "Test failed" };
    }
    setNotifStatus((s) => ({ ...s, [kind]: result }));
    const res = await saveIntegration({
      data: {
        access_token: token,
        id: existing?.id,
        type: "notification",
        provider: kind,
        name: label,
        config: { webhook_url: url },
        is_active: result.ok,
      },
    });
    setNotifTesting(null);
    if (!res.ok) {
      toast.error(`Could not save: ${res.error}`);
      return;
    }
    if (result.ok) {
      toast.success(`${label} connected — check the channel for the test message.`);
      setNotifUrls((u) => ({ ...u, [kind]: "" }));
    } else {
      toast.error(`${label}: ${result.detail}`);
    }
    loadIntegrations();
  }

  async function disconnectNotifChannel(kind: string) {
    const existing = integrations.find((i) => i.type === "notification" && i.provider === kind);
    if (!existing) return;
    const { error } = await supabase
      .from("integrations")
      .update({ is_active: false })
      .eq("id", existing.id);
    if (error) {
      toast.error("Could not disconnect the channel", {
        description: `${error.message}. The channel is still connected.`,
      });
      return;
    }
    toast.success("Channel disconnected");
    loadIntegrations();
  }

  // Scheduled health checks stamp health_status/health_detail into config
  // (see utils/integrations/health.server.ts). Non-null = last check FAILED.
  const healthErrorFor = (match: (i: Integration) => boolean): string | null => {
    const i = integrations.find((x) => match(x) && x.is_active);
    if (!i || i.config?.health_status !== "error") return null;
    return String(i.config?.health_detail || "The last scheduled credential check failed.");
  };
  const readNotice = integrationsReadNotice(readState);

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Integrations
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Integration Hub</h1>
          <p className="text-muted-foreground mt-1">
            Connect your LLM providers, gateways, and workflow tools.
          </p>
        </div>

        {readNotice && (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning"
          >
            {readNotice}
          </div>
        )}

        <Tabs defaultValue="llm" className="space-y-4">
          <TabsList>
            <TabsTrigger value="llm">LLM Providers</TabsTrigger>
            <TabsTrigger value="warehouses">Data Sources</TabsTrigger>
            <TabsTrigger value="apps">Apps</TabsTrigger>
            <TabsTrigger value="gateway">LLM Gateway</TabsTrigger>
            <TabsTrigger value="websearch">Web Search</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            {/* Beside Notifications because they are the two Slack-shaped
                surfaces — but opposite directions. Notifications posts OUT to
                a webhook; this authenticates an inbound caller. */}
            <TabsTrigger value="slack">Slack</TabsTrigger>
            {/* Beside Slack for the same reason: the other inbound chat
                surface, authenticated a completely different way. */}
            <TabsTrigger value="teams">Teams</TabsTrigger>
            <TabsTrigger value="n8n">n8n Workflows</TabsTrigger>
          </TabsList>

          <TabsContent value="slack" className="space-y-4">
            <SlackTab />
          </TabsContent>

          <TabsContent value="teams" className="space-y-4">
            <TeamsTab />
          </TabsContent>

          <TabsContent value="warehouses" className="space-y-4">
            <WarehousesTab />
          </TabsContent>

          {/* Apps are SaaS sources pulled into datasets, as opposed to the
              Data Sources tab's databases, which are queried live. */}
          <TabsContent value="apps" className="space-y-4">
            <SaasSourcesTab />
          </TabsContent>

          <TabsContent value="llm" className="space-y-4">
            <ProviderCredentialsPanel />
          </TabsContent>

          <TabsContent value="gateway" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <CardTitle>LLM Gateway</CardTitle>
                <CardDescription>
                  Route LLM traffic through a centralized gateway (LiteLLM, Portkey, Helicone, or
                  any OpenAI-compatible proxy) for logging, caching, and rate limiting. Two modes:
                  agents can opt in individually (agent editor → &ldquo;Route through
                  gateway&rdquo;), or flip the switch below to route <em>every</em> LLM call from
                  every surface.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Gateway Provider</Label>
                  <Select value={gatewayProvider} onValueChange={setGatewayProvider}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GATEWAY_PROVIDERS.map((gp) => (
                        <SelectItem key={gp.value} value={gp.value}>
                          {gp.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Gateway Base URL</Label>
                  <Input
                    placeholder="https://gateway.example.com"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Gateway API Key</Label>
                  <Input
                    type="password"
                    placeholder={
                      gatewayHasKey ? "(a key is saved — leave blank to keep it)" : "gw-key-..."
                    }
                    value={gatewayKey}
                    onChange={(e) => setGatewayKey(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted, never shown again. Leave blank to keep the saved key.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable gateway</Label>
                    <p className="text-xs text-muted-foreground">
                      Agents with &ldquo;Route through gateway&rdquo; in their tool settings will
                      use it. Enabling runs a live validation first.
                    </p>
                  </div>
                  <Switch checked={gatewayRoute} onCheckedChange={setGatewayRoute} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Route ALL LLM traffic</Label>
                    <p className="text-xs text-muted-foreground">
                      Every LLM call on this account — chat, swarms, BI answers, embeds, skill
                      generation, notebooks, model listings and embeddings — goes through the
                      gateway. Your gateway must be able to route every model you use.
                    </p>
                  </div>
                  <Switch
                    checked={gatewayRouteAll}
                    onCheckedChange={setGatewayRouteAll}
                    disabled={!gatewayRoute}
                  />
                </div>
                {gatewayStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${gatewayStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${gatewayStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {gatewayStatus.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {gatewayStatus.ok ? "Gateway validated" : "Validation failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${gatewayStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {gatewayStatus.detail}
                    </p>
                  </div>
                )}
                {!gatewayStatus && healthErrorFor((i) => i.type === "llm_gateway") && (
                  <Badge
                    variant="outline"
                    className="w-fit text-warning border-warning/40"
                    title={healthErrorFor((i) => i.type === "llm_gateway") ?? undefined}
                  >
                    <X className="h-3 w-3 mr-1" /> Gateway failing health checks
                  </Badge>
                )}
                <Button onClick={saveGateway} disabled={gatewayTesting}>
                  {gatewayTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : gatewayRoute ? (
                    "Validate & Save"
                  ) : (
                    "Save (disabled)"
                  )}
                </Button>
              </CardContent>
            </Card>

            {session?.access_token ? <GatewayApiCard token={session.access_token} /> : null}
          </TabsContent>

          <TabsContent value="websearch" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <Globe className="h-4 w-4 text-primary" />
                  </div>
                  <CardTitle>Firecrawl (web search &amp; browsing)</CardTitle>
                </div>
                <CardDescription>
                  Powers the agent <code>web_search</code> and <code>web_browse</code> tools for
                  every agent on this instance. Get a key at{" "}
                  <a
                    href="https://firecrawl.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    firecrawl.dev
                  </a>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  Without a key, <code>web_search</code> still works but falls back to DuckDuckGo
                  (limited results) and <code>web_browse</code> is unavailable. A key set here is
                  the workspace default; the <code>FIRECRAWL_API_KEY</code> env var, or a per-agent
                  key in the agent editor, override it.
                </div>
                <div className="space-y-2">
                  <Label>Firecrawl API Key</Label>
                  <Input
                    type="password"
                    placeholder="fc-..."
                    value={firecrawlKey}
                    onChange={(e) => setFirecrawlKey(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted, never shown again. Leave blank to keep the saved key.
                  </p>
                </div>
                {firecrawlStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${firecrawlStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${firecrawlStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {firecrawlStatus.ok ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                      {firecrawlStatus.ok ? "Connected" : "Connection failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${firecrawlStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {firecrawlStatus.detail}
                    </p>
                  </div>
                )}
                {integrations.find((i) => i.type === "firecrawl" && i.is_active) &&
                  !firecrawlStatus &&
                  (healthErrorFor((i) => i.type === "firecrawl") ? (
                    <Badge
                      variant="outline"
                      className="w-fit text-warning border-warning/40"
                      title={healthErrorFor((i) => i.type === "firecrawl") ?? undefined}
                    >
                      <X className="h-3 w-3 mr-1" /> Connected — key failing health checks
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="w-fit text-primary border-primary/30">
                      <Check className="h-3 w-3 mr-1" /> Currently connected
                    </Badge>
                  ))}
                <Button onClick={saveFirecrawl} disabled={firecrawlTesting}>
                  {firecrawlTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : (
                    "Validate & Save"
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground max-w-2xl">
              Connected channels receive <strong>system alerts</strong> (failing credentials,
              scheduled-refresh errors, BI data alerts) and power the <code>send_notification</code>{" "}
              agent tool (enable it per agent in the Agent Builder). Webhook URLs are stored
              encrypted — treat them like passwords.
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  {
                    kind: "slack" as const,
                    label: "Slack",
                    hint: "Incoming webhook from api.slack.com/messaging/webhooks",
                    placeholder: "https://hooks.slack.com/services/T…/B…/…",
                  },
                  {
                    kind: "teams" as const,
                    label: "Microsoft Teams",
                    hint: "Channel → Connectors → Incoming Webhook",
                    placeholder: "https://outlook.office.com/webhook/…",
                  },
                  {
                    kind: "discord" as const,
                    label: "Discord",
                    hint: "Channel settings → Integrations → Webhooks",
                    placeholder: "https://discord.com/api/webhooks/…",
                  },
                  {
                    kind: "webhook" as const,
                    label: "Custom webhook",
                    hint: "Any HTTPS endpoint accepting a JSON POST",
                    placeholder: "https://example.com/hooks/agentswarms",
                  },
                ] as const
              ).map((ch) => {
                const connected = integrations.find(
                  (i) => i.type === "notification" && i.provider === ch.kind && i.is_active,
                );
                const status = notifStatus[ch.kind];
                const health = healthErrorFor(
                  (i) => i.type === "notification" && i.provider === ch.kind,
                );
                return (
                  <Card key={ch.kind} className="border-border/50">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Bell className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-base">{ch.label}</CardTitle>
                      </div>
                      <p className="text-xs text-muted-foreground">{ch.hint}</p>
                      {connected && !status && (
                        <Badge
                          variant="outline"
                          className={
                            health
                              ? "w-fit text-warning border-warning/40"
                              : "w-fit text-primary border-primary/30"
                          }
                          title={health ?? undefined}
                        >
                          {health ? (
                            <>
                              <X className="h-3 w-3 mr-1" /> Connected — delivery failing
                            </>
                          ) : (
                            <>
                              <Check className="h-3 w-3 mr-1" /> Connected
                            </>
                          )}
                        </Badge>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <Label>Webhook URL</Label>
                        <Input
                          type="password"
                          placeholder={
                            connected ? "(saved — leave blank to keep it)" : ch.placeholder
                          }
                          value={notifUrls[ch.kind] || ""}
                          onChange={(e) =>
                            setNotifUrls((u) => ({ ...u, [ch.kind]: e.target.value }))
                          }
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Stored encrypted, never shown again.
                        </p>
                      </div>
                      {status && (
                        <div
                          className={`rounded-md border p-2.5 ${status.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                        >
                          <p
                            className={`text-xs font-semibold flex items-center gap-1.5 ${status.ok ? "text-primary" : "text-destructive"}`}
                          >
                            {status.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                            {status.ok ? "Test message delivered" : "Delivery failed"}
                          </p>
                          <p
                            className={`text-xs mt-0.5 ${status.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                          >
                            {status.detail}
                          </p>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveNotifChannel(ch.kind, ch.label)}
                          disabled={notifTesting !== null}
                        >
                          {notifTesting === ch.kind ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Testing…
                            </>
                          ) : (
                            "Send test & Save"
                          )}
                        </Button>
                        {connected && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => disconnectNotifChannel(ch.kind)}
                          >
                            <X className="h-3 w-3 mr-1" /> Disconnect
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="n8n" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <CardTitle>n8n Workflow Automation</CardTitle>
                <CardDescription>
                  Connect your n8n instance for workflow triggers and tool actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>n8n Instance URL</Label>
                  <Input
                    placeholder="https://n8n.example.com"
                    value={n8nUrl}
                    onChange={(e) => setN8nUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Authentication Type</Label>
                  <Select value={n8nAuthType} onValueChange={setN8nAuthType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="header">Header Auth Token</SelectItem>
                      <SelectItem value="basic">Basic Auth</SelectItem>
                      <SelectItem value="none">No Authentication</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {n8nAuthType === "header" && (
                  <p className="text-xs text-muted-foreground -mt-2">
                    Use an n8n API key (Settings → API). Validation hits{" "}
                    <code>GET /api/v1/workflows</code>.
                  </p>
                )}
                {n8nAuthType !== "none" && (
                  <div className="space-y-2">
                    <Label>{n8nAuthType === "basic" ? "Credentials (user:pass)" : "API Key"}</Label>
                    <Input
                      type="password"
                      placeholder={n8nAuthType === "basic" ? "admin:password" : "n8n_api_..."}
                      value={n8nToken}
                      onChange={(e) => setN8nToken(e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Stored encrypted, never shown again. Leave blank to keep the saved token.
                    </p>
                  </div>
                )}
                {n8nStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${n8nStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${n8nStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {n8nStatus.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {n8nStatus.ok ? "Connected" : "Connection failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${n8nStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {n8nStatus.detail}
                    </p>
                  </div>
                )}
                {integrations.find((i) => i.type === "n8n" && i.is_active) &&
                  !n8nStatus &&
                  (healthErrorFor((i) => i.type === "n8n") ? (
                    <Badge
                      variant="outline"
                      className="w-fit text-warning border-warning/40"
                      title={healthErrorFor((i) => i.type === "n8n") ?? undefined}
                    >
                      <X className="h-3 w-3 mr-1" /> Connected — instance failing health checks
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="w-fit text-primary border-primary/30">
                      <Check className="h-3 w-3 mr-1" /> Currently connected
                    </Badge>
                  ))}
                <Button onClick={saveN8n} disabled={n8nTesting || !n8nUrl}>
                  {n8nTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : (
                    "Validate & Save"
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
