// Admin UI for the Developer-workspace server runtime (/admin/runtime).
// Superadmins enable it, tune limits + the egress allowlist, and grant access —
// no environment editing required.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Server, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { normalizeEgressHost } from "@/utils/notebookRuntime/egress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  nbRuntimeAddGrant,
  nbRuntimeGetState,
  nbRuntimePreflight,
  nbRuntimeRemoveGrant,
  nbRuntimeUpdateSettings,
  type NbRuntimeSettings,
  type NbRuntimeState,
  type PreflightCheck,
} from "@/utils/notebookRuntimeAdmin.functions";

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8"
      />
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function RuntimeTab({ token }: { token: string }) {
  const getStateFn = useServerFn(nbRuntimeGetState);
  const updateFn = useServerFn(nbRuntimeUpdateSettings);
  const addGrantFn = useServerFn(nbRuntimeAddGrant);
  const removeGrantFn = useServerFn(nbRuntimeRemoveGrant);

  const [state, setState] = useState<NbRuntimeState | null>(null);
  const [form, setForm] = useState<NbRuntimeSettings | null>(null);
  const [egressText, setEgressText] = useState("");
  // Lines the squid ACL renderer will drop. Uses the SAME function that does
  // the dropping, so the warning cannot disagree with the behaviour.
  const rejectedEgress = egressText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && normalizeEgressHost(s) === null);
  const [saving, setSaving] = useState(false);
  const [grantType, setGrantType] = useState<"user" | "group">("group");
  const [grantId, setGrantId] = useState("");
  const [busyGrant, setBusyGrant] = useState(false);
  const preflightFn = useServerFn(nbRuntimePreflight);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    getStateFn({ data: { access_token: token } }).then((res) => {
      if (!res.ok) return toast.error(res.error);
      setState(res);
      setForm(res.settings);
      setEgressText(res.settings.egress_allowlist.join("\n"));
    });
  }, [getStateFn, token]);

  useEffect(() => {
    load();
  }, [load]);

  if (!state || !form) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const set = <K extends keyof NbRuntimeSettings>(k: K, v: NbRuntimeSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save() {
    if (!form) return;
    setSaving(true);
    const egress_allowlist = egressText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await updateFn({ data: { access_token: token, ...form, egress_allowlist } });
      if (!res.ok) return toast.error(res.error);

      // Saving the list and APPLYING it to the proxy are different things, and
      // the old behaviour silently did only the first. Say which happened.
      const eg = res.egress;
      if (!eg) {
        toast.success("Runtime settings saved");
      } else if (eg.applied) {
        toast.success(`Runtime settings saved — egress applied (${eg.hosts} hosts)`);
      } else {
        toast.warning(
          eg.pendingRestart ? "Saved — egress pending proxy restart" : "Saved — egress NOT applied",
          { description: eg.reason, duration: 12000 },
        );
      }
      load();
    } finally {
      setSaving(false);
    }
  }

  async function runPreflight() {
    if (!form) return;
    setChecking(true);
    try {
      const res = await preflightFn({
        data: { access_token: token, backend: form.backend as "docker" | "k8s" | "e2b" },
      });
      if (!res.ok) return toast.error(res.error);
      setChecks(res.checks);
    } finally {
      setChecking(false);
    }
  }

  async function addGrant() {
    if (!grantId) return;
    setBusyGrant(true);
    try {
      const res = await addGrantFn({
        data: { access_token: token, principal_type: grantType, principal_id: grantId },
      });
      if (!res.ok) return toast.error(res.error);
      setGrantId("");
      load();
    } finally {
      setBusyGrant(false);
    }
  }

  async function removeGrant(id: string) {
    const res = await removeGrantFn({ data: { access_token: token, id } });
    if (!res.ok) return toast.error(res.error);
    load();
  }

  const targets = grantType === "group" ? state.groups : state.users;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Server className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">Server runtime</h3>
          <p className="text-xs text-muted-foreground">
            Developer-workspace notebooks run on secure server kernels — real CPython with{" "}
            <code>pip install</code> and the actual frameworks. Off by default: a notebook shows a{" "}
            &ldquo;runtime required&rdquo; prompt until you enable it here.
          </p>
        </div>
      </div>

      {!state.secretConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p>
            <strong>Runtime not fully set up yet.</strong> Enabling it below mints a signing secret
            automatically — no env var needed. To actually start kernels you also need the runtime
            services running (<code>docker compose --profile notebooks up -d --build</code>). Only
            set <code>NOTEBOOK_RUNTIME_SECRET</code> yourself if you run replicas that don&apos;t
            share a database. See docs/DEVELOPER_WORKSPACE_RUNTIME.md.
          </p>
        </div>
      )}

      {/* Enablement */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium">Enable server runtime</span>
            <span className="block text-xs text-muted-foreground">
              Allow Developer-workspace notebooks to launch server kernels.
            </span>
          </span>
          <Switch
            checked={form.server_runtime_enabled}
            onCheckedChange={(v) => set("server_runtime_enabled", v)}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium">Require an access grant</span>
            <span className="block text-xs text-muted-foreground">
              When on, only superadmins and granted users/groups (below) may start a kernel.
            </span>
          </span>
          <Switch checked={form.require_grant} onCheckedChange={(v) => set("require_grant", v)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Backend</Label>
            <Select value={form.backend} onValueChange={(v) => set("backend", v)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="docker">Docker — needs Docker on this host</SelectItem>
                <SelectItem value="k8s">Kubernetes — needs app running in-cluster</SelectItem>
                <SelectItem value="e2b">E2B — not implemented yet</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Selecting a backend does <strong>not</strong> install anything — it only chooses which
              API the orchestrator calls. Run the preflight below to confirm it can actually launch
              kernels here.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Kernel image</Label>
            <Input
              value={form.default_image}
              onChange={(e) => set("default_image", e.target.value)}
              className="h-8"
            />
          </div>
        </div>
      </div>

      {/* Limits */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium">Limits</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label="Max sessions / user"
            value={form.max_sessions_per_user}
            onChange={(n) => set("max_sessions_per_user", n)}
          />
          <NumberField
            label="Max sessions (total)"
            value={form.max_sessions_total}
            onChange={(n) => set("max_sessions_total", n)}
          />
          <NumberField
            label="Cell timeout (s)"
            value={form.cell_timeout_seconds}
            onChange={(n) => set("cell_timeout_seconds", n)}
          />
          <NumberField
            label="Idle TTL (min)"
            value={form.idle_ttl_minutes}
            onChange={(n) => set("idle_ttl_minutes", n)}
          />
          <NumberField
            label="Session max (min)"
            value={form.session_max_minutes}
            onChange={(n) => set("session_max_minutes", n)}
          />
          <div />
          <NumberField
            label="Interactive CPU"
            value={Number(form.cpu_limit)}
            onChange={(n) => set("cpu_limit", String(n))}
            hint="cores"
          />
          <NumberField
            label="Interactive memory (MB)"
            value={form.mem_limit_mb}
            onChange={(n) => set("mem_limit_mb", n)}
          />
          <div />
          <NumberField
            label="Batch CPU"
            value={Number(form.batch_cpu_limit)}
            onChange={(n) => set("batch_cpu_limit", String(n))}
            hint="cores"
          />
          <NumberField
            label="Batch memory (MB)"
            value={form.batch_mem_limit_mb}
            onChange={(n) => set("batch_mem_limit_mb", n)}
          />
          <NumberField
            label="Batch max (min)"
            value={form.batch_max_minutes}
            onChange={(n) => set("batch_max_minutes", n)}
          />
        </div>
      </div>

      {/* Egress */}
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium">Egress allowlist</p>
        <p className="text-xs text-muted-foreground">
          Domains kernels may reach (one per line). Everything else is denied. Keep the egress
          proxy&apos;s allowlist file in sync when you change this.
        </p>
        <Textarea
          value={egressText}
          onChange={(e) => setEgressText(e.target.value)}
          rows={5}
          className="font-mono text-xs"
        />
        {/*
          SAY WHICH LINES WILL BE DISCARDED. The list is normalised into a squid
          dstdomain ACL, and anything that is not a usable hostname is dropped —
          IP addresses in particular, since dstdomain matches by DNS suffix and
          could never match an address. Until now that happened silently: an
          operator typed 10.0.0.1, watched it save, and believed egress to it
          was permitted. It was not, and nothing said so. Rejecting an entry
          correctly is only half the job on a security control; the other half
          is telling the person who typed it.
        */}
        {rejectedEgress.length > 0 && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            Ignored — not a hostname the proxy can match:{" "}
            <span className="font-mono">{rejectedEgress.join(", ")}</span>. An IP address cannot be
            used here; the allow-list matches domains and their subdomains.
          </p>
        )}
        <label className="flex items-center gap-2 pt-1 text-xs">
          <Switch checked={form.pip_allowed} onCheckedChange={(v) => set("pip_allowed", v)} />
          Allow runtime <code>pip install</code>
        </label>
      </div>

      {/* Preflight — probes the selected backend instead of failing later. */}
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Backend readiness</p>
            <p className="text-xs text-muted-foreground">
              Checks whether the selected backend can actually start a kernel right now.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={runPreflight}
            disabled={checking}
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run preflight
          </Button>
        </div>
        {checks && (
          <ul className="space-y-1 pt-1">
            {checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-xs">
                <span
                  className={cn(
                    "mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full",
                    c.status === "pass"
                      ? "bg-emerald-500"
                      : c.status === "warn"
                        ? "bg-amber-500"
                        : "bg-destructive",
                  )}
                />
                <span className="min-w-0">
                  <span className="font-medium">{c.name}</span>{" "}
                  <span className="text-muted-foreground">— {c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save settings
        </Button>
      </div>

      {/* Grants */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <div>
          <p className="text-sm font-medium">Access grants</p>
          <p className="text-xs text-muted-foreground">
            Used only when &ldquo;Require an access grant&rdquo; is on. Superadmins always have
            access.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <Select
              value={grantType}
              onValueChange={(v) => {
                setGrantType(v as "user" | "group");
                setGrantId("");
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <Label className="text-xs">{grantType === "group" ? "Group" : "User"}</Label>
            <Select value={grantId} onValueChange={setGrantId}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder={`Select a ${grantType}…`} />
              </SelectTrigger>
              <SelectContent>
                {targets.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">None available</div>
                ) : (
                  targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {"name" in t ? t.name : (t.email ?? t.id)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            onClick={addGrant}
            disabled={busyGrant || !grantId}
            className="h-8 gap-1"
          >
            <Plus className="h-3.5 w-3.5" /> Grant
          </Button>
        </div>

        {state.grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">No grants yet.</p>
        ) : (
          <ul className="space-y-1">
            {state.grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {g.principal_type}
                  </Badge>
                  {g.name}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void removeGrant(g.id)}
                  title="Remove grant"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
