// Editor for one MCP server: write the Python, deploy it to a sandboxed
// kernel, watch what it exposes, test a tool, and decide who may call it.
//
// The right rail is ordered by what you actually do in sequence — Deploy,
// Tools, Test, then Access — rather than by how the data is stored.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Flame,
  Globe,
  History,
  KeyRound,
  Loader2,
  Play,
  Plug,
  Rocket,
  ScrollText,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { useTheme } from "@/hooks/use-theme";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { generateMcpServer } from "@/lib/mcpCodegen";
import { listSecrets, type SecretSummary } from "@/utils/secrets.functions";
import {
  mcpAppApproveTools,
  mcpAppDeploy,
  mcpAppGet,
  mcpAppKeyCreate,
  mcpAppKeyRevoke,
  mcpAppKeysList,
  mcpAppLogs,
  mcpAppRegisterInternal,
  mcpAppRestoreVersion,
  mcpAppSave,
  mcpAppSetPublic,
  mcpAppStop,
  mcpAppTest,
  mcpAppUnregisterInternal,
  mcpAppVersions,
  type McpAppSummary,
  type McpKeyRow,
  type McpVersionRow,
} from "@/utils/mcpApps.functions";

export const Route = createFileRoute("/_authenticated/mcp-builder_/$appId")({
  component: McpAppEditor,
});

type App = McpAppSummary & { source_code: string };

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "13px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "hsl(var(--muted-foreground))",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 text-[11px]">
        {value}
      </code>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 shrink-0 gap-1 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function McpAppEditor() {
  const { appId } = Route.useParams();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const { session } = useAuth();

  const getFn = useServerFn(mcpAppGet);
  const saveFn = useServerFn(mcpAppSave);
  const deployFn = useServerFn(mcpAppDeploy);
  const stopFn = useServerFn(mcpAppStop);
  const logsFn = useServerFn(mcpAppLogs);
  const testFn = useServerFn(mcpAppTest);
  const approveFn = useServerFn(mcpAppApproveTools);
  const keysListFn = useServerFn(mcpAppKeysList);
  const keyCreateFn = useServerFn(mcpAppKeyCreate);
  const keyRevokeFn = useServerFn(mcpAppKeyRevoke);
  const setPublicFn = useServerFn(mcpAppSetPublic);
  const registerFn = useServerFn(mcpAppRegisterInternal);
  const unregisterFn = useServerFn(mcpAppUnregisterInternal);
  const versionsFn = useServerFn(mcpAppVersions);
  const restoreFn = useServerFn(mcpAppRestoreVersion);
  const secretsFn = useServerFn(listSecrets);

  const [app, setApp] = useState<App | null>(null);
  const [source, setSource] = useState("");
  const [requirements, setRequirements] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [deploying, setDeploying] = useState(false);
  const [logs, setLogs] = useState("");
  const [keys, setKeys] = useState<McpKeyRow[]>([]);
  const [versions, setVersions] = useState<McpVersionRow[]>([]);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);

  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    const res = await getFn({ data: { id: appId } });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setApp(res.app);
    // Only adopt server text when the user has nothing unsaved, otherwise a
    // background refresh would silently discard what they are typing.
    if (!dirtyRef.current) {
      setSource(res.app.source_code ?? "");
      setRequirements(res.app.requirements ?? "");
    }
  }, [appId, getFn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveState("saving");
    const res = await saveFn({ data: { id: appId, source_code: source, requirements } });
    dirtyRef.current = false;
    if (!res.ok) {
      setSaveState("idle");
      toast.error(res.error);
      return;
    }
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  }, [appId, requirements, saveFn, source]);

  // Debounced autosave. The editor is the primary surface here, so an explicit
  // save button would be one more thing to forget before pressing Deploy.
  useEffect(() => {
    if (!app) return;
    if (source === (app.source_code ?? "") && requirements === (app.requirements ?? "")) return;
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), 1200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [source, requirements, app, flush]);

  const patch = async (fields: Record<string, unknown>) => {
    const res = await saveFn({ data: { id: appId, ...fields } as never });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    void reload();
  };

  const deploy = async () => {
    await flush();
    setDeploying(true);
    const res = await deployFn({ data: { id: appId } });
    setDeploying(false);
    if (!res.ok) {
      toast.error(res.error, { duration: 8000 });
      void loadLogs();
      void reload();
      return;
    }
    toast.success(
      res.toolsChanged
        ? `Deployed — ${res.tools.length} tools. The tool list changed; approve it below.`
        : `Deployed — ${res.tools.length} ${res.tools.length === 1 ? "tool" : "tools"}.`,
    );
    void reload();
  };

  const loadLogs = async () => {
    const res = await logsFn({ data: { id: appId } });
    if (res.ok) setLogs(res.logs || "(no output yet)");
  };

  const loadKeys = useCallback(async () => {
    const res = await keysListFn({ data: { id: appId } });
    if (res.ok) setKeys(res.keys);
  }, [appId, keysListFn]);

  const loadVersions = async () => {
    const res = await versionsFn({ data: { id: appId } });
    if (res.ok) setVersions(res.versions);
  };

  const loadSecrets = async () => {
    const token = session?.access_token;
    if (!token) return;
    const res = await secretsFn({ data: { access_token: token } });
    if (res.ok) setSecrets(res.secrets);
  };

  const publicUrl = useMemo(
    () => (app ? `${window.location.origin}/api/mcp/s/${app.slug}` : ""),
    [app],
  );

  const toolsNeedApproval =
    !!app?.tools_changed_at &&
    (!app.tools_approved_at ||
      new Date(app.tools_changed_at).getTime() > new Date(app.tools_approved_at).getTime());

  if (!app) {
    return (
      <div className="p-6 sm:p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-[60vh] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Button asChild size="icon" variant="ghost" className="h-8 w-8">
          <Link to="/mcp-builder" aria-label="Back to MCP Builder">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <Input
            value={app.name}
            onChange={(e) => setApp({ ...app, name: e.target.value })}
            onBlur={(e) => void patch({ name: e.target.value.trim() || app.name })}
            className="h-8 w-64 border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:border-input"
          />
          <div className="px-1 font-mono text-[11px] text-muted-foreground">/{app.slug}</div>
        </div>
        <StatusPill status={app.status} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
          </span>
          {app.status === "ready" && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={async () => {
                await stopFn({ data: { id: appId } });
                toast.success("Stopped");
                void reload();
              }}
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          )}
          <Button size="sm" className="gap-1.5" onClick={() => void deploy()} disabled={deploying}>
            {deploying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            Deploy
          </Button>
        </div>
      </header>

      {toolsNeedApproval && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="flex-1">
            <span className="font-medium text-foreground">The tool list changed.</span>{" "}
            <span className="text-muted-foreground">
              Tool names, descriptions and schemas are instructions the calling model reads, so
              calls are blocked until you review them on the Tools tab.
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="h-7"
            onClick={async () => {
              // Send the fingerprint THIS view rendered. If a deploy landed
              // while the diff was open, the server refuses rather than
              // approving a tool list nobody read.
              const res = await approveFn({
                data: { id: appId, tools_hash: app?.tools_hash ?? undefined },
              });
              if (res.ok) {
                toast.success("Tools approved");
                void reload();
              } else toast.error(res.error);
            }}
          >
            Approve
          </Button>
        </div>
      )}

      <div className="grid flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 border-r border-border">
          <div className="border-b border-border bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">
            server.py
          </div>
          <CodeMirror
            value={source}
            onChange={setSource}
            extensions={[python(), editorTheme, EditorView.lineWrapping]}
            theme={isDark ? vscodeDark : vscodeLight}
            basicSetup={{ lineNumbers: true, foldGutter: true }}
            height="calc(100vh - 190px)"
          />
        </div>

        <aside className="min-w-0 p-4">
          <Tabs defaultValue="deploy">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="deploy" className="text-xs">
                Deploy
              </TabsTrigger>
              <TabsTrigger value="tools" className="text-xs">
                Tools
              </TabsTrigger>
              <TabsTrigger value="access" className="text-xs" onClick={() => void loadKeys()}>
                Access
              </TabsTrigger>
              <TabsTrigger value="ai" className="text-xs">
                AI
              </TabsTrigger>
            </TabsList>

            <TabsContent value="deploy" className="mt-4 space-y-4">
              <DeployTab
                app={app}
                requirements={requirements}
                setRequirements={setRequirements}
                secrets={secrets}
                onLoadSecrets={loadSecrets}
                onPatch={patch}
                logs={logs}
                onLoadLogs={loadLogs}
                versions={versions}
                onLoadVersions={loadVersions}
                onRestore={async (versionId) => {
                  const res = await restoreFn({ data: { id: appId, version_id: versionId } });
                  if (!res.ok) {
                    toast.error(res.error);
                    return;
                  }
                  dirtyRef.current = false;
                  await reload();
                  toast.success("Source restored — deploy to make it live.");
                }}
              />
            </TabsContent>

            <TabsContent value="tools" className="mt-4">
              <ToolsTab
                app={app}
                onTest={(tool, args) => testFn({ data: { id: appId, tool, args } })}
              />
            </TabsContent>

            <TabsContent value="access" className="mt-4 space-y-5">
              <AccessTab
                app={app}
                keys={keys}
                publicUrl={publicUrl}
                onReloadKeys={loadKeys}
                onSetPublic={async (isPublic) => {
                  const res = await setPublicFn({ data: { id: appId, is_public: isPublic } });
                  if (!res.ok) {
                    toast.error(res.error);
                    return;
                  }
                  void reload();
                }}
                onRegister={async () => {
                  const res = await registerFn({ data: { id: appId } });
                  if (!res.ok) {
                    toast.error(res.error);
                    return;
                  }
                  toast.success("Registered — your agents can call it now.");
                  void reload();
                }}
                onUnregister={async () => {
                  await unregisterFn({ data: { id: appId } });
                  toast.success("Unregistered");
                  void reload();
                }}
                onCreateKey={(input) => keyCreateFn({ data: { id: appId, ...input } })}
                onRevokeKey={async (keyId) => {
                  await keyRevokeFn({ data: { id: appId, key_id: keyId } });
                  void loadKeys();
                }}
                onPatch={patch}
              />
            </TabsContent>

            <TabsContent value="ai" className="mt-4">
              <AiTab
                source={source}
                onApply={(code, reqs) => {
                  setSource(code);
                  if (reqs) setRequirements(reqs);
                }}
              />
            </TabsContent>
          </Tabs>
          <div className="mt-6 text-[11px] text-muted-foreground">
            Not sure where to start?{" "}
            <Link to="/docs/mcp" className="text-primary hover:underline">
              Read the MCP Builder guide
            </Link>
            .
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ready: { label: "Running", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
    deploying: { label: "Deploying", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
    error: { label: "Error", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
    stopped: { label: "Stopped", cls: "bg-muted text-muted-foreground" },
    draft: { label: "Not deployed", cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status] ?? map.draft;
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", s.cls)}>{s.label}</span>
  );
}

// ── Deploy tab ──────────────────────────────────────────────────────────────

function DeployTab({
  app,
  requirements,
  setRequirements,
  secrets,
  onLoadSecrets,
  onPatch,
  logs,
  onLoadLogs,
  versions,
  onLoadVersions,
  onRestore,
}: {
  app: App;
  requirements: string;
  setRequirements: (v: string) => void;
  secrets: SecretSummary[];
  onLoadSecrets: () => void;
  onPatch: (fields: Record<string, unknown>) => Promise<void>;
  logs: string;
  onLoadLogs: () => void;
  versions: McpVersionRow[];
  onLoadVersions: () => void;
  onRestore: (versionId: string) => Promise<void>;
}) {
  const [envName, setEnvName] = useState("");
  const [secretName, setSecretName] = useState("");

  useEffect(() => {
    onLoadSecrets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bindings = app.secret_refs ?? [];

  return (
    <div className="space-y-5">
      {app.status === "error" && app.deploy_error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {app.deploy_error}
        </div>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Flame className="h-3.5 w-3.5" /> Keep warm
          </Label>
          <Switch checked={app.keep_warm} onCheckedChange={(v) => void onPatch({ keep_warm: v })} />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Off by default: the server starts on the first call (a few seconds) and stops again after{" "}
          {app.idle_ttl_minutes} minutes idle. Turn this on for latency-sensitive servers — it holds
          a container permanently.
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="ttl" className="text-xs text-muted-foreground">
            Idle timeout
          </Label>
          <Input
            id="ttl"
            type="number"
            min={1}
            max={1440}
            value={app.idle_ttl_minutes}
            disabled={app.keep_warm}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n <= 1440) void onPatch({ idle_ttl_minutes: n });
            }}
            className="h-7 w-20 text-xs"
          />
          <span className="text-xs text-muted-foreground">minutes</span>
        </div>
      </section>

      <section className="space-y-1.5">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Extra packages
        </Label>
        <Textarea
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          placeholder={"stripe\nboto3==1.34.0"}
          className="min-h-[70px] font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          One per line, installed at start. httpx, pydantic, pandas, numpy, langchain, llama_index
          and <code>agentswarms</code> are already available.
        </p>
      </section>

      <section className="space-y-2">
        <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" /> Secrets
        </Label>
        {bindings.length > 0 && (
          <div className="space-y-1">
            {bindings.map((b) => (
              <div key={b} className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[11px]">
                  {b}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => void onPatch({ secret_refs: bindings.filter((x) => x !== b) })}
                  aria-label={`Remove ${b}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Input
            value={envName}
            onChange={(e) => setEnvName(e.target.value.toUpperCase())}
            placeholder="ENV_NAME"
            className="h-7 flex-1 font-mono text-xs"
          />
          <select
            value={secretName}
            onChange={(e) => setSecretName(e.target.value)}
            className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">Secret…</option>
            {secrets.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) || !secretName}
            onClick={() => {
              const entry = `${envName}={{secret:${secretName}}}`;
              if (!bindings.includes(entry)) void onPatch({ secret_refs: [...bindings, entry] });
              setEnvName("");
              setSecretName("");
            }}
          >
            Bind
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Read with <code>os.environ["ENV_NAME"]</code>. Values are resolved only when the container
          starts and travel over an authenticated call — they never appear in the container
          environment, the database, or the logs. Manage the secrets themselves under{" "}
          <Link to="/secrets" className="text-primary hover:underline">
            Secrets
          </Link>
          .
        </p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ScrollText className="h-3.5 w-3.5" /> Logs
          </Label>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onLoadLogs}>
            Refresh
          </Button>
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono text-[11px] leading-relaxed">
          {logs || "Press Refresh to read the container output."}
        </pre>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <History className="h-3.5 w-3.5" /> Versions
          </Label>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onLoadVersions}>
            Load
          </Button>
        </div>
        {versions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            A snapshot is taken on every successful deploy.
          </p>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <span className="font-medium">v{v.version}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {new Date(v.created_at).toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px]"
                  onClick={() => void onRestore(v.id)}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Tools tab ───────────────────────────────────────────────────────────────

function ToolsTab({
  app,
  onTest,
}: {
  app: App;
  onTest: (
    tool: string | undefined,
    args: Record<string, unknown> | undefined,
  ) => Promise<{ ok: true; result: any } | { ok: false; error: string }>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("{}");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string>("");

  const run = async () => {
    let args: Record<string, unknown> = {};
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch {
      toast.error("Arguments must be valid JSON.");
      return;
    }
    setRunning(true);
    setOutput("");
    const res = await onTest(selected ?? undefined, args);
    setRunning(false);
    setOutput(res.ok ? JSON.stringify(res.result, null, 2) : `Error: ${res.error}`);
  };

  if (app.tools.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        <Wrench className="mx-auto mb-2 h-5 w-5" />
        No tools yet. Deploy the server to read its tool list.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {app.tools.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => {
              setSelected(t.name);
              // Prefill the argument object from the schema so the first test
              // click is not a guess at the parameter names.
              const props = (t.inputSchema?.properties ?? {}) as Record<string, any>;
              const stub: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(props)) {
                stub[k] =
                  v?.type === "number" || v?.type === "integer"
                    ? 0
                    : v?.type === "boolean"
                      ? false
                      : "";
              }
              setArgsText(JSON.stringify(stub, null, 2));
            }}
            className={cn(
              "w-full rounded-lg border p-2.5 text-left transition",
              selected === t.name
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40",
            )}
          >
            <div className="font-mono text-xs font-medium text-foreground">{t.name}</div>
            {t.description && (
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {t.description}
              </div>
            )}
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <Label className="text-[11px] text-muted-foreground">Arguments (JSON)</Label>
          <Textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            className="min-h-[80px] font-mono text-xs"
          />
          <Button
            size="sm"
            className="w-full gap-1.5"
            onClick={() => void run()}
            disabled={running}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Call {selected}
          </Button>
          {output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Access tab ──────────────────────────────────────────────────────────────

function AccessTab({
  app,
  keys,
  publicUrl,
  onReloadKeys,
  onSetPublic,
  onRegister,
  onUnregister,
  onCreateKey,
  onRevokeKey,
  onPatch,
}: {
  app: App;
  keys: McpKeyRow[];
  publicUrl: string;
  onReloadKeys: () => void;
  onSetPublic: (isPublic: boolean) => Promise<void>;
  onRegister: () => Promise<void>;
  onUnregister: () => Promise<void>;
  onCreateKey: (input: {
    name: string;
    tool_allowlist?: string[];
    ip_allowlist?: string[];
  }) => Promise<{ ok: true; key: string; id: string } | { ok: false; error: string }>;
  onRevokeKey: (keyId: string) => Promise<void>;
  onPatch: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [keyName, setKeyName] = useState("");
  const [allowTools, setAllowTools] = useState<string[]>([]);
  const [minted, setMinted] = useState<string | null>(null);
  const [origins, setOrigins] = useState((app.allowed_origins ?? []).join(", "));

  useEffect(() => {
    onReloadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <section className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Plug className="h-3.5 w-3.5" /> Your agents
          </Label>
          <Switch
            checked={!!app.registered_server_id}
            disabled={app.status !== "ready"}
            onCheckedChange={(v) => void (v ? onRegister() : onUnregister())}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Adds this server to{" "}
          <Link to="/mcp" className="text-primary hover:underline">
            Connected servers
          </Link>{" "}
          so agents and swarms in this instance can call its tools. Nothing is exposed to the
          internet. {app.status !== "ready" && "Deploy the server first."}
        </p>
      </section>

      <section className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Globe className="h-3.5 w-3.5" /> Public endpoint
          </Label>
          <Switch checked={app.is_public} onCheckedChange={(v) => void onSetPublic(v)} />
        </div>
        {app.is_public ? (
          <>
            <CopyRow value={publicUrl} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Anyone holding a key below can call this from anywhere. Point an MCP client at the URL
              with <code>Authorization: Bearer mcps_…</code>.
            </p>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Off: the endpoint answers 404 to everything except your own agents. Turn it on to let
            external MCP clients — Claude Desktop, your own systems — reach it with an API key.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" /> API keys
        </Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Key name"
            className="h-7 flex-1 text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={!keyName.trim()}
            onClick={async () => {
              const res = await onCreateKey({
                name: keyName.trim(),
                tool_allowlist: allowTools,
              });
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              setMinted(res.key);
              setKeyName("");
              setAllowTools([]);
              onReloadKeys();
            }}
          >
            Create
          </Button>
        </div>
        {app.tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {app.tools.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() =>
                  setAllowTools((prev) =>
                    prev.includes(t.name) ? prev.filter((n) => n !== t.name) : [...prev, t.name],
                  )
                }
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px] transition",
                  allowTools.includes(t.name)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Select tools to limit the next key to them. Nothing selected = every tool. A limited key
          cannot even list the tools it is not allowed to call.
        </p>

        {keys.length > 0 && (
          <div className="divide-y divide-border/60 rounded-lg border border-border">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{k.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {k.key_prefix}… · {k.use_count} calls
                    {k.last_used_at
                      ? ` · last ${new Date(k.last_used_at).toLocaleDateString()}`
                      : ""}
                    {k.tool_allowlist.length ? ` · ${k.tool_allowlist.length} tools` : ""}
                  </div>
                </div>
                {k.revoked_at ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Revoked
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={() => void onRevokeKey(k.id)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Browser origins
        </Label>
        <Input
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          onBlur={() =>
            void onPatch({
              allowed_origins: origins
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="app.example.com, *.example.com"
          className="h-7 text-xs"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Only needed for browser-based MCP clients. A request with no Origin header (curl, Claude
          Desktop, server-to-server) is unaffected — this is the DNS-rebinding check the MCP spec
          requires, not an authentication boundary.
        </p>
      </section>

      <Dialog open={!!minted} onOpenChange={(o) => !o && setMinted(null)}>
        <DialogContent className="max-w-lg [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
            <DialogDescription>
              This is the only time it is shown. It is stored hashed and cannot be recovered — only
              revoked and replaced.
            </DialogDescription>
          </DialogHeader>
          {minted && <CopyRow value={minted} />}
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── AI tab ──────────────────────────────────────────────────────────────────

function AiTab({
  source,
  onApply,
}: {
  source: string;
  onApply: (code: string, requirements: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");

  const generate = async (mode: "new" | "edit") => {
    if (!prompt.trim()) return;
    setBusy(true);
    setNotes("");
    try {
      const out = await generateMcpServer({
        description: prompt.trim(),
        model: model ?? undefined,
        existingCode: mode === "edit" ? source : undefined,
      });
      onApply(out.code, out.requirements);
      setNotes(out.notes);
      toast.success("Code generated — review it, then deploy.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" /> Describe the server
      </Label>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Tools to look up an order by id and to refund it, using our internal orders API at ORDERS_API_URL."
        className="min-h-[110px] text-xs"
      />
      <BiModelSelect value={model} onChange={setModel} className="w-full" />
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 gap-1.5"
          onClick={() => void generate("new")}
          disabled={busy || !prompt.trim()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Write it
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => void generate("edit")}
          disabled={busy || !prompt.trim()}
        >
          Change existing
        </Button>
      </div>
      {notes && (
        <p className="rounded-lg bg-muted p-2 text-[11px] leading-relaxed text-muted-foreground">
          {notes}
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Generated code replaces the editor contents. It runs in the same sandbox as anything you
        write yourself — read it before deploying, especially the network calls.
      </p>
    </div>
  );
}
