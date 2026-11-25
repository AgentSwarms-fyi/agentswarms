// MLflow tracking servers on the Integrations page (R534).
//
// A connection is a tracking server's address and how to sign in to it (none,
// a token, or a username and password), the secret picked from Secrets and
// sent only to that address. Which models are tracked where is chosen on each
// model's Versions tab; this page only says which servers there are.
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
import { saveIntegration, testMlflowServer } from "@/utils/integrations.functions";

type Auth = "none" | "token" | "basic";

type Row = {
  id: string;
  name: string;
  is_active: boolean;
  config: Record<string, unknown>;
};

type Form = {
  id?: string;
  name: string;
  tracking_uri: string;
  auth: Auth;
  username: string;
  token: string;
  password: string;
  tokenStored: boolean;
  passwordStored: boolean;
};

const EMPTY: Form = {
  name: "",
  tracking_uri: "",
  auth: "none",
  username: "",
  token: "",
  password: "",
  tokenStored: false,
  passwordStored: false,
};

function authOf(v: unknown): Auth {
  return v === "token" || v === "basic" ? v : "none";
}

function authLabel(a: Auth): string {
  return a === "token" ? "Token" : a === "basic" ? "Username and password" : "No sign-in";
}

export function MlflowConnectionsPanel() {
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
      .eq("type", "mlflow")
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
    const password = savedSecretField(r.config, "password");
    setResult(null);
    setForm({
      id: r.id,
      name: r.name,
      tracking_uri: textOf(r.config.tracking_uri),
      auth: authOf(r.config.auth),
      username: textOf(r.config.username),
      token: token.ref,
      password: password.ref,
      tokenStored: token.stored,
      passwordStored: password.stored,
    });
  }

  async function testAndSave() {
    if (!form) return;
    const token = session?.access_token;
    if (!token) {
      toast.error("Your session expired. Please sign in again.");
      return;
    }
    const url = form.tracking_uri.trim();
    if (!url) {
      toast.error("Enter the tracking server's address.");
      return;
    }
    if (form.auth === "token" && !form.token.trim() && !form.tokenStored) {
      toast.error("Choose the secret holding the token.");
      return;
    }
    if (form.auth === "basic" && !form.username.trim()) {
      toast.error("Enter the username.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const tested = await testMlflowServer({
        data: {
          access_token: token,
          id: form.id,
          tracking_uri: url,
          auth: form.auth,
          username: form.username.trim(),
          token: form.auth === "token" ? form.token.trim() : "",
          password: form.auth === "basic" ? form.password.trim() : "",
        },
      });
      setResult({ ok: tested.ok, detail: tested.detail });
      if (!tested.ok) return;
      const saved = await saveIntegration({
        data: {
          access_token: token,
          id: form.id,
          type: "mlflow",
          provider: "mlflow",
          name: form.name.trim() || new URL(url).host,
          config: {
            tracking_uri: url.replace(/\/+$/, ""),
            auth: form.auth,
            username: form.auth === "basic" ? form.username.trim() : "",
            token: form.auth === "token" ? form.token.trim() : "",
            password: form.auth === "basic" ? form.password.trim() : "",
          },
          is_active: true,
        },
      });
      if (!saved.ok) {
        // A database without migration 20261202000000 refuses the type by its
        // constraint name: say what to run, not the constraint.
        toast.error(
          /integrations_type_check/.test(saved.error)
            ? "MLflow connections need a database update first (migration 20261202000000, for example npx supabase db push --remote)."
            : `Could not save it: ${saved.error}`,
        );
        return;
      }
      toast.success(form.id ? "MLflow connection saved" : "MLflow connection added");
      // The test said whether the server stores artifacts (which decides
      // whether models can be sent): keep that in view, not only in the form.
      setSaved({ name: form.name.trim() || new URL(url).host, detail: tested.detail });
      setForm(null);
      await load();
    } catch (e) {
      reportFailure("save the MLflow connection", e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Row) {
    const ok = await confirmAsk({
      title: `Remove ${r.name}?`,
      body: "Its address and stored credentials are deleted. Models tracked on it stop sending new versions there, and say so on their Versions tab. Nothing already in MLflow is touched.",
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
        <CardTitle className="text-base">MLflow tracking servers</CardTitle>
        <CardDescription>
          Send a model's versions to an MLflow server you already run: each version's run with its
          parameters and metrics, its model, and a registered version whose alias follows production
          here. Choose which models go where on each model's Versions tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="text-sm text-destructive">
            Could not read your MLflow connections: {loadError}
          </p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 && !form ? (
          <p className="text-sm text-muted-foreground">No MLflow server connected yet.</p>
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
                      {textOf(r.config.tracking_uri)} · {authLabel(authOf(r.config.auth))}
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
              {form.id ? `Edit ${form.name}` : "Add an MLflow server"}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-name">Name</Label>
                <Input
                  id="mlflow-name"
                  value={form.name}
                  maxLength={120}
                  placeholder="Team MLflow"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-url">Tracking URL</Label>
                <Input
                  id="mlflow-url"
                  value={form.tracking_uri}
                  maxLength={500}
                  placeholder="https://mlflow.example.com"
                  onChange={(e) => setForm({ ...form, tracking_uri: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-auth">Sign-in</Label>
                <Select
                  value={form.auth}
                  onValueChange={(v) => setForm({ ...form, auth: authOf(v) })}
                >
                  <SelectTrigger id="mlflow-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No sign-in</SelectItem>
                    <SelectItem value="token">Token</SelectItem>
                    <SelectItem value="basic">Username and password</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.auth === "token" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="mlflow-token">Token</Label>
                  <SecretSelect
                    id="mlflow-token"
                    value={form.token}
                    onChange={(v) => setForm({ ...form, token: v })}
                    storedKey={form.tokenStored}
                    destination={form.tracking_uri.trim() || undefined}
                    suggestedName="MLFLOW_TRACKING_TOKEN"
                    purpose="For the MLflow tracking server's token."
                  />
                </div>
              ) : form.auth === "basic" ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="mlflow-username">Username</Label>
                    <Input
                      id="mlflow-username"
                      value={form.username}
                      maxLength={200}
                      autoComplete="off"
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mlflow-password">Password</Label>
                    <SecretSelect
                      id="mlflow-password"
                      value={form.password}
                      onChange={(v) => setForm({ ...form, password: v })}
                      storedKey={form.passwordStored}
                      destination={form.tracking_uri.trim() || undefined}
                      suggestedName="MLFLOW_TRACKING_PASSWORD"
                      purpose="For the MLflow tracking server's password."
                    />
                  </div>
                </>
              ) : null}
            </div>
            {form.auth !== "none" ? (
              <p className="text-[11px] text-muted-foreground">
                The credential is sent only to the tracking URL above, by this server, never to a
                model's code. Its value stays encrypted in Secrets and is never shown.
              </p>
            ) : null}
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
            Add an MLflow server
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
