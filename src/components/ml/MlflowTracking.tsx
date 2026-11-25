// Tracking a model on an MLflow server, on its Versions tab (R534).
//
// The strip says where the model is tracked (or offers to track it), and each
// version's cell links to its run in MLflow, or says why it was not sent and
// sends it again. Links are built here from checked parts only: the stored
// tracking columns are writable by the model's owner, and a link a person
// the model is shared with clicks must never be anything but an http(s)
// address with plain ids in it.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertTriangle, ExternalLink, Loader2, UploadCloud } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { recordOf, textOf } from "@/lib/jsonRecord";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  DEFAULT_ALIAS,
  defaultExperiment,
  defaultRegisteredModel,
  parseModelTracking,
  parseVersionTracking,
  runLink,
  trackingProblem,
  type ModelTracking,
  type VersionTracking,
} from "@/lib/mlflowTracking";
import { mlSetTracking, mlSyncToMlflow } from "@/utils/mlTracking.functions";

type Connection = { id: string; name: string; tracking_uri: string; is_active: boolean };

type VersionLike = { id: string; version: number; status: string; tracking?: unknown };

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

function useMlflowConnections(): { rows: Connection[] | null; error: string | null } {
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const { data, error: e } = await supabase
        .from("integrations")
        .select("id, name, is_active, config")
        .eq("type", "mlflow")
        .order("created_at", { ascending: true });
      if (!live) return;
      if (e) {
        setError(e.message);
        return;
      }
      setRows(
        (data ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          is_active: r.is_active,
          tracking_uri: textOf(recordOf(r.config).tracking_uri),
        })),
      );
    })();
    return () => {
      live = false;
    };
  }, []);
  return { rows, error };
}

/** The strip above the versions table: where this model is tracked, or Track in MLflow. */
export function MlflowTrackingStrip({
  token,
  model,
  versions,
  productionVersionId,
  onChanged,
}: {
  token: string;
  model: { id: string; name: string; tracking?: unknown };
  versions: VersionLike[];
  productionVersionId: string | null;
  onChanged: () => void;
}) {
  const link = parseModelTracking(model.tracking);
  const { rows, error } = useMlflowConnections();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const conn = link ? rows?.find((r) => r.id === link.integration_id) : undefined;
  const ready = versions.filter((v) => v.status === "ready");
  const prod = versions.find((v) => v.id === productionVersionId) ?? null;
  const prodTracking = parseVersionTracking(prod?.tracking);
  // Where the alias points, as last moved: said from the record, not assumed
  // from production (a move can fail, and then they differ).
  const prodRegistered =
    prodTracking?.registered_model === link?.registered_model
      ? prodTracking?.registered_version
      : undefined;
  // No record (an alias moved before there was one) is not "not set": say
  // what the production version's own record says, and "set once sent" only
  // when it has none (found in the UI test: it said v1 was unsent).
  const aliasText =
    link?.alias_version === undefined
      ? prod
        ? prodRegistered
          ? ` on registered version ${prodRegistered} (v${prod.version}, production here)`
          : ` (set once v${prod.version}, production here, is sent)`
        : ""
      : link.alias_version === null
        ? " (not set: production here has no registered version)"
        : ` on registered version ${link.alias_version}${
            prod && prodRegistered === link.alias_version
              ? ` (v${prod.version}, production here)`
              : ""
          }`;

  async function moveAlias() {
    setBusy(true);
    try {
      const out = await mlSyncToMlflow({
        data: { access_token: token, model_id: model.id, move_alias: true },
      });
      if (out.ok) toast.success("The alias is on the production version");
      else toast.error(out.error);
      onChanged();
    } catch (e) {
      reportFailure("move the MLflow alias", e);
    } finally {
      setBusy(false);
    }
  }
  const unsent = ready.filter((v) => {
    const t = parseVersionTracking(v.tracking);
    return !t?.synced_at || Boolean(t.error);
  });

  async function sendAll() {
    setBusy(true);
    try {
      const out = await mlSyncToMlflow({ data: { access_token: token, model_id: model.id } });
      if (!out.ok) {
        toast.error(out.error);
        return;
      }
      toast.success(
        `Sending ${unsent.length} version${unsent.length === 1 ? "" : "s"} to MLflow. Each one's row says when it is there.`,
      );
      setTimeout(onChanged, 4000);
    } catch (e) {
      reportFailure("send the versions to MLflow", e);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!link) return;
    const ok = await confirmAsk({
      title: "Stop tracking this model on MLflow?",
      body: "New versions are no longer sent there, and promotions no longer move the alias. Nothing already in MLflow is touched.",
      actionLabel: "Stop tracking",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const out = await mlSetTracking({
        data: { access_token: token, model_id: model.id, tracking: null, send_existing: false },
      });
      if (!out.ok) {
        toast.error(out.error);
        return;
      }
      toast.success("No longer tracked on MLflow");
      onChanged();
    } catch (e) {
      reportFailure("stop tracking the model", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      {link?.enabled ? (
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Tracked on MLflow</span>
          {conn ? (
            <>
              {" "}
              at <span className="font-medium text-foreground">{conn.name}</span> (
              {hostOf(conn.tracking_uri)})
            </>
          ) : rows ? (
            <span className="text-destructive">
              {" "}
              through a connection that was removed. Choose another.
            </span>
          ) : null}
          . Experiment <span className="font-mono text-foreground">{link.experiment}</span>,
          registered as <span className="font-mono text-foreground">{link.registered_model}</span>,
          alias <span className="font-mono text-foreground">{link.alias}</span>
          {aliasText}.
          {link.alias_error ? (
            <span className="mt-1 block text-amber-700 dark:text-amber-400">
              At the last promotion the alias could not be moved: {link.alias_error}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Track on MLflow.</span> Send each version to
          an MLflow server you run: its run with parameters and metrics, its model, and a registered
          version whose alias follows production here.
        </p>
      )}
      <div className="flex items-center gap-2">
        {link?.enabled && link.alias_error ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void moveAlias()}>
            Move the alias again
          </Button>
        ) : null}
        {link?.enabled && unsent.length > 0 ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void sendAll()}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Send {unsent.length} unsent
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
          {link?.enabled ? "Change" : "Track on MLflow"}
        </Button>
        {link?.enabled ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>
            Stop
          </Button>
        ) : null}
      </div>
      <TrackingDialog
        open={open}
        onOpenChange={setOpen}
        token={token}
        model={model}
        link={link}
        connections={rows}
        connectionsError={error}
        readyCount={ready.length}
        onSaved={() => {
          setOpen(false);
          onChanged();
          setTimeout(onChanged, 5000);
        }}
      />
    </div>
  );
}

function TrackingDialog({
  open,
  onOpenChange,
  token,
  model,
  link,
  connections,
  connectionsError,
  readyCount,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
  model: { id: string; name: string };
  link: ModelTracking | null;
  connections: Connection[] | null;
  connectionsError: string | null;
  readyCount: number;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ModelTracking & { send: boolean }>({
    integration_id: "",
    experiment: "",
    registered_model: "",
    alias: DEFAULT_ALIAS,
    enabled: true,
    send: true,
  });
  const [busy, setBusy] = useState(false);

  // Fill the form each time it opens, from the saved link or the defaults.
  // Keyed on strings: the parsed link is a new object on every render.
  const linkKey = link ? JSON.stringify(link) : "";
  const firstActive = connections?.find((c) => c.is_active)?.id ?? "";
  useEffect(() => {
    if (!open) return;
    setForm({
      integration_id: link?.integration_id ?? firstActive,
      experiment: link?.experiment || defaultExperiment(model.name),
      registered_model: link?.registered_model || defaultRegisteredModel(model.name),
      alias: link?.alias || DEFAULT_ALIAS,
      enabled: true,
      send: !link?.enabled,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `link` is read through linkKey
  }, [open, linkKey, firstActive, model.name]);

  const problem = trackingProblem(form);

  async function save() {
    if (!form.integration_id) {
      toast.error("Choose the MLflow server.");
      return;
    }
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      const out = await mlSetTracking({
        data: {
          access_token: token,
          model_id: model.id,
          tracking: {
            integration_id: form.integration_id,
            experiment: form.experiment,
            registered_model: form.registered_model,
            alias: form.alias,
            enabled: true,
          },
          send_existing: form.send && readyCount > 0,
        },
      });
      if (!out.ok) {
        toast.error(out.error);
        return;
      }
      toast.success(
        form.send && readyCount > 0
          ? `Tracked on MLflow. Sending ${readyCount} ready version${readyCount === 1 ? "" : "s"}.`
          : "Tracked on MLflow. New versions are sent when they are ready.",
      );
      onSaved();
    } catch (e) {
      reportFailure("track the model on MLflow", e);
    } finally {
      setBusy(false);
    }
  }

  const none = connections !== null && connections.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Track on MLflow</DialogTitle>
          <DialogDescription>
            Each ready version becomes a run in the experiment, with its parameters, metrics and
            model, and a version of the registered model. The alias follows the production version.
          </DialogDescription>
        </DialogHeader>
        {connectionsError ? (
          <p className="text-sm text-destructive">
            Could not read your MLflow connections: {connectionsError}
          </p>
        ) : none ? (
          <p className="text-sm text-muted-foreground">
            Connect an MLflow server first, under{" "}
            <Link to="/integrations" search={{ tab: "mlflow" }} className="underline">
              Integrations → MLflow
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="track-server">MLflow server</Label>
              <Select
                value={form.integration_id}
                onValueChange={(v) => setForm({ ...form, integration_id: v })}
              >
                <SelectTrigger id="track-server">
                  <SelectValue placeholder="Choose a server" />
                </SelectTrigger>
                <SelectContent>
                  {(connections ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id} disabled={!c.is_active}>
                      {c.name} · {hostOf(c.tracking_uri)}
                      {c.is_active ? "" : " (turned off)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="track-experiment">Experiment</Label>
              <Input
                id="track-experiment"
                value={form.experiment}
                maxLength={250}
                onChange={(e) => setForm({ ...form, experiment: e.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <div className="space-y-1.5">
                <Label htmlFor="track-registered">Registered model</Label>
                <Input
                  id="track-registered"
                  value={form.registered_model}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, registered_model: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="track-alias">Alias for production</Label>
                <Input
                  id="track-alias"
                  value={form.alias}
                  maxLength={64}
                  onChange={(e) => setForm({ ...form, alias: e.target.value })}
                />
              </div>
            </div>
            {readyCount > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.send}
                  onCheckedChange={(c) => setForm({ ...form, send: c === true })}
                />
                Send the {readyCount} ready version{readyCount === 1 ? "" : "s"} now (unsent ones
                only)
              </label>
            ) : null}
            {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || none || !form.integration_id || Boolean(problem)}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A version's MLflow state, as an icon in its Actions cell. */
export function MlflowVersionCell({
  token,
  modelId,
  version,
  canSend,
  onChanged,
}: {
  token: string;
  modelId: string;
  version: VersionLike;
  /** The viewer owns the model and it is tracked. */
  canSend: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const t = parseVersionTracking(version.tracking);
  const href = runLink(t);
  const v = `v${version.version}`;

  async function send() {
    setBusy(true);
    try {
      const out = await mlSyncToMlflow({
        data: { access_token: token, model_id: modelId, version_id: version.id },
      });
      if (out.ok) {
        toast.success(
          out.tracking?.registered_version
            ? `${v} is in MLflow, registered as version ${out.tracking.registered_version}`
            : `${v} is in MLflow`,
        );
      } else {
        toast.error(out.error);
      }
      onChanged();
    } catch (e) {
      reportFailure(`send ${v} to MLflow`, e);
    } finally {
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <span className="ml-1 inline-flex h-8 w-8 items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  }
  if (t?.error && canSend) {
    const reason = t.error.trim().replace(/[.!?]?$/, ".");
    const label = `${v} was not sent to MLflow: ${reason} Send it again.`;
    return (
      <Button
        size="sm"
        variant="ghost"
        className="ml-1 h-8 w-8 p-0 text-amber-600 hover:text-amber-700 dark:text-amber-400"
        aria-label={label}
        title={label}
        onClick={() => void send()}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
      </Button>
    );
  }
  if (href && t?.synced_at) {
    const label = `Open ${v}'s run in MLflow${
      t.registered_version ? ` (registered as version ${t.registered_version})` : ""
    }${t.note ? `. ${t.note}` : ""}`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={label}
        title={label}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    );
  }
  if (canSend && version.status === "ready") {
    const label = `Send ${v} to MLflow`;
    return (
      <Button
        size="sm"
        variant="ghost"
        className="ml-1 h-8 w-8 p-0"
        aria-label={label}
        title={label}
        onClick={() => void send()}
      >
        <UploadCloud className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return null;
}
