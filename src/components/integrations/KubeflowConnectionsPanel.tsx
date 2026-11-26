// Kubeflow Pipelines servers on the Integrations page (R540).
//
// A connection is a Pipelines server's address, how to sign in to it (none,
// or a bearer token its sign-in accepts, picked from Secrets and sent only to
// that address) and, on a multi-user Kubeflow, the profile namespace. Which
// pipeline runs when is chosen in a workflow's Kubeflow step; this page only
// says which servers there are.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
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
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { SecretSelect } from "@/components/secrets/SecretSelect";
import { savedSecretField } from "@/lib/secretRefs";
import { recordOf, textOf } from "@/lib/jsonRecord";
import { reportFailure } from "@/lib/silentFailureNet";
import { saveIntegration, testKubeflowServer } from "@/utils/integrations.functions";

type Auth = "none" | "token";

type Row = {
  id: string;
  name: string;
  is_active: boolean;
  config: Record<string, unknown>;
};

type Form = {
  id?: string;
  name: string;
  api_url: string;
  auth: Auth;
  token: string;
  namespace: string;
  tokenStored: boolean;
};

const EMPTY: Form = {
  name: "",
  api_url: "",
  auth: "none",
  token: "",
  namespace: "",
  tokenStored: false,
};

function authOf(v: unknown): Auth {
  return v === "token" ? v : "none";
}

function authLabel(a: Auth): string {
  return a === "token" ? "Token" : "No sign-in";
}

export function KubeflowConnectionsPanel() {
  const { session } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [saved, setSaved] = useState<{ name: string; detail: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("integrations")
      .select("id, name, is_active, config")
      .eq("type", "kubeflow")
      .order("created_at", { ascending: true });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setRows(
      (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        is_active: r.is_active,
        config: recordOf(r.config),
      })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(r: Row) {
    const token = savedSecretField(r.config, "token");
    setResult(null);
    setForm({
      id: r.id,
      name: r.name,
      api_url: textOf(r.config.api_url),
      auth: authOf(r.config.auth),
      token: token.ref,
      namespace: textOf(r.config.namespace),
      tokenStored: token.stored,
    });
  }

  async function testAndSave() {
    if (!form) return;
    const token = session?.access_token;
    if (!token) {
      toast.error("Your session expired. Please sign in again.");
      return;
    }
    const url = form.api_url.trim();
    if (!url) {
      toast.error("Enter the address the Pipelines UI opens at.");
      return;
    }
    if (form.auth === "token" && !form.token.trim() && !form.tokenStored) {
      toast.error("Choose the secret holding the token.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const tested = await testKubeflowServer({
        data: {
          access_token: token,
          id: form.id,
          api_url: url,
          auth: form.auth,
          token: form.auth === "token" ? form.token.trim() : "",
          namespace: form.namespace.trim(),
        },
      });
      setResult({ ok: tested.ok, detail: tested.detail });
      if (!tested.ok) return;
      const saved = await saveIntegration({
        data: {
          access_token: token,
          id: form.id,
          type: "kubeflow",
          provider: "kubeflow",
          name: form.name.trim() || new URL(url).host,
          config: {
            api_url: url.replace(/\/+$/, ""),
            auth: form.auth,
            token: form.auth === "token" ? form.token.trim() : "",
            namespace: form.namespace.trim(),
          },
          is_active: true,
        },
      });
      if (!saved.ok) {
        // A database without migration 20261203000000 refuses the type by its
        // constraint name: say what to run, not the constraint.
        toast.error(
          /integrations_type_check/.test(saved.error)
            ? "Kubeflow connections need a database update first (migration 20261203000000, for example npx supabase db push --remote)."
            : `Could not save it: ${saved.error}`,
        );
        return;
      }
      toast.success(form.id ? "Kubeflow connection saved" : "Kubeflow connection added");
      setSaved({ name: form.name.trim() || new URL(url).host, detail: tested.detail });
      setForm(null);
      await load();
    } catch (e) {
      reportFailure("save the Kubeflow connection", e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Row) {
    const ok = await confirmAsk({
      title: `Remove ${r.name}?`,
      body: "Its address and stored token are deleted. Pipeline steps that run on it fail from their next run, saying the connection was removed. Nothing on the Kubeflow server is touched.",
      actionLabel: "Remove",
    });
    if (!ok) return;
    const { error } = await supabase.from("integrations").delete().eq("id", r.id);
    if (error) {
      toast.error(`Could not remove it: ${error.message}. It is still saved.`);
      return;
    }
    toast.success(`${r.name} removed`);
    await load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Kubeflow Pipelines</CardTitle>
        <CardDescription>
          Run the pipelines your team keeps on Kubeflow from an ML pipeline here: a Kubeflow step
          starts one with parameters and waits for it, beside training, scoring and approvals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="text-sm text-destructive">
            Could not read your Kubeflow connections: {loadError}
          </p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 && !form ? (
          <p className="text-sm text-muted-foreground">No Kubeflow server connected yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((r) => {
              const health = textOf(r.config.health_status);
              const detail = textOf(r.config.health_detail);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{r.name}</span>
                      {health === "error" ? (
                        <Badge variant="destructive" title={detail || undefined}>
                          Not reachable
                        </Badge>
                      ) : health === "ok" ? (
                        <Badge variant="secondary">Connected</Badge>
                      ) : null}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {textOf(r.config.api_url)} · {authLabel(authOf(r.config.auth))}
                      {textOf(r.config.namespace) ? ` · ${textOf(r.config.namespace)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      aria-label={`Edit ${r.name}`}
                      title={`Edit ${r.name}`}
                      onClick={() => edit(r)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      aria-label={`Remove ${r.name}`}
                      title={`Remove ${r.name}`}
                      onClick={() => void remove(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {saved && !form ? (
          <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {saved.name}: {saved.detail}
            </span>
          </p>
        ) : null}

        {form ? (
          <div className="space-y-3 rounded-md border bg-muted/30 p-4">
            <p className="text-sm font-medium">
              {form.id ? `Edit ${form.name}` : "Add a Kubeflow server"}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="kubeflow-name">Name</Label>
                <Input
                  id="kubeflow-name"
                  value={form.name}
                  maxLength={120}
                  placeholder="Team Kubeflow"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kubeflow-url">Pipelines address</Label>
                <Input
                  id="kubeflow-url"
                  value={form.api_url}
                  maxLength={500}
                  placeholder="https://kubeflow.example.com/pipeline"
                  onChange={(e) => setForm({ ...form, api_url: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="kubeflow-auth">Sign-in</Label>
                <Select
                  value={form.auth}
                  onValueChange={(v) => setForm({ ...form, auth: authOf(v) })}
                >
                  <SelectTrigger id="kubeflow-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No sign-in</SelectItem>
                    <SelectItem value="token">Token</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.auth === "token" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="kubeflow-token">Token</Label>
                  <SecretSelect
                    id="kubeflow-token"
                    value={form.token}
                    onChange={(v) => setForm({ ...form, token: v })}
                    storedKey={form.tokenStored}
                    destination={form.api_url.trim() || undefined}
                    suggestedName="KUBEFLOW_TOKEN"
                    purpose="For the Kubeflow Pipelines server's sign-in."
                  />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="kubeflow-namespace">Namespace (multi-user Kubeflow)</Label>
                <Input
                  id="kubeflow-namespace"
                  value={form.namespace}
                  maxLength={63}
                  placeholder="team-ml"
                  onChange={(e) => setForm({ ...form, namespace: e.target.value })}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The address the Pipelines UI opens at: on a full Kubeflow it ends in /pipeline. The
              namespace is the profile your pipelines and runs belong to, needed only on a
              multi-user Kubeflow.
              {form.auth !== "none"
                ? " The token is sent only to this address, by this server; its value stays encrypted in Secrets and is never shown."
                : ""}
            </p>
            {result ? (
              <p
                className={`flex items-start gap-1.5 text-xs ${result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}
              >
                {result.ok ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span>{result.detail}</span>
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void testAndSave()}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Test and save
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setResult(null);
              setForm({ ...EMPTY });
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add a Kubeflow server
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
