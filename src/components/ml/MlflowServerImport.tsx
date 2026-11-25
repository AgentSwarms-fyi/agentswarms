// Import a registered model from an MLflow server (R535): choose one of your
// MLflow connections, find the registered model, choose a version (its
// aliases beside it), and it becomes the next version here, through the same
// checks and sandbox job as a zip.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { recordOf, textOf } from "@/lib/jsonRecord";
import { reportFailure } from "@/lib/silentFailureNet";
import { mlImportFromMlflow, mlMlflowBrowse } from "@/utils/mlTracking.functions";

type Connection = { id: string; name: string; tracking_uri: string };
type Registered = {
  name: string;
  description: string | null;
  aliases: { alias: string; version: string }[];
  latest: string | null;
};
type Version = {
  version: string;
  aliases: string[];
  run_id: string | null;
  status: string;
  created: number | null;
};

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

export function MlflowServerImportDialog({
  open,
  onOpenChange,
  token,
  modelId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
  modelId: string;
  onStarted: (version: number) => void;
}) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [connId, setConnId] = useState("");
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<Registered[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The connections, each time it opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setPicked(null);
    setVersions(null);
    setVersion(null);
    void (async () => {
      const { data, error: e } = await supabase
        .from("integrations")
        .select("id, name, is_active, config")
        .eq("type", "mlflow")
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      if (!live) return;
      if (e) {
        setError(`Could not read your MLflow connections: ${e.message}`);
        setConns([]);
        return;
      }
      const rows = (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        tracking_uri: textOf(recordOf(r.config).tracking_uri),
      }));
      setConns(rows);
      setConnId((cur) => (rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? "")));
    })();
    return () => {
      live = false;
    };
  }, [open]);

  // The registered models on the chosen server, searched as you type.
  useEffect(() => {
    if (!open || !connId) return;
    let live = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const out = await mlMlflowBrowse({
            data: { access_token: token, integration_id: connId, query },
          });
          if (!live) return;
          if (!out.ok) {
            setError(out.error);
            setModels([]);
            return;
          }
          setError(null);
          setModels(out.models ?? []);
        } catch (e) {
          if (live) reportFailure("read the MLflow server's registered models", e);
        }
      })();
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // The token is read when the search runs; a refreshed session must not
    // search again on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connId, query]);

  async function pick(name: string) {
    setPicked(name);
    setVersions(null);
    setVersion(null);
    try {
      const out = await mlMlflowBrowse({
        data: { access_token: token, integration_id: connId, name, query: "" },
      });
      if (!out.ok) {
        setError(out.error);
        return;
      }
      const vs = out.versions ?? [];
      setVersions(vs);
      // Production first, if it has an alias; otherwise the newest.
      setVersion(
        vs.find((v) => v.aliases.includes("production"))?.version ?? vs[0]?.version ?? null,
      );
    } catch (e) {
      reportFailure("read the registered model's versions", e);
    }
  }

  async function importIt() {
    if (!picked || !version) return;
    setBusy(true);
    try {
      const out = await mlImportFromMlflow({
        data: {
          access_token: token,
          model_id: modelId,
          integration_id: connId,
          name: picked,
          version,
        },
      });
      if (!out.ok) {
        toast.error(out.error);
        return;
      }
      toast.success(`Importing ${out.from} as v${out.version}. It is ready when its job finishes.`);
      onOpenChange(false);
      onStarted(out.version);
    } catch (e) {
      reportFailure("import the model from MLflow", e);
    } finally {
      setBusy(false);
    }
  }

  const none = conns !== null && conns.length === 0 && !error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from an MLflow server</DialogTitle>
          <DialogDescription>
            A registered model&apos;s version becomes the next version here. Only its MLmodel file
            and the model file it names are read, and the model is opened in a sandbox, as with a
            zip.
          </DialogDescription>
        </DialogHeader>
        {none ? (
          <p className="text-sm text-muted-foreground">
            Connect an MLflow server first, under{" "}
            <Link to="/integrations" search={{ tab: "mlflow" }} className="underline">
              Integrations → MLflow
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-import-server">MLflow server</Label>
                <Select value={connId} onValueChange={(v) => setConnId(v)}>
                  <SelectTrigger id="mlflow-import-server">
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {(conns ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} · {hostOf(c.tracking_uri)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-import-search">Registered model</Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    id="mlflow-import-search"
                    className="pl-8"
                    value={query}
                    maxLength={100}
                    placeholder="Search by name"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="max-h-48 overflow-y-auto rounded-md border">
              {models === null ? (
                <p className="p-3 text-xs text-muted-foreground">Loading…</p>
              ) : models.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  {query ? "No registered model matches." : "This server has no registered models."}
                </p>
              ) : (
                <ul role="listbox" aria-label="Registered models">
                  {models.map((m) => (
                    <li key={m.name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={picked === m.name}
                        onClick={() => void pick(m.name)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent",
                          picked === m.name && "bg-accent",
                        )}
                      >
                        <span className="truncate font-medium">{m.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {m.aliases.map((a) => `@${a.alias} → ${a.version}`).join(" · ") ||
                            (m.latest ? `latest ${m.latest}` : "")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {picked ? (
              <div className="space-y-1.5">
                <Label htmlFor="mlflow-import-version">Version of {picked}</Label>
                {versions === null ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : versions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">It has no versions.</p>
                ) : (
                  <Select value={version ?? ""} onValueChange={(v) => setVersion(v)}>
                    <SelectTrigger id="mlflow-import-version">
                      <SelectValue placeholder="Choose a version" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v) => (
                        <SelectItem
                          key={v.version}
                          value={v.version}
                          disabled={v.status !== "READY"}
                        >
                          Version {v.version}
                          {v.aliases.length ? ` · @${v.aliases.join(", @")}` : ""}
                          {v.created ? ` · ${new Date(v.created).toLocaleDateString()}` : ""}
                          {v.status !== "READY" ? ` · ${v.status.toLowerCase()}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !picked || !version} onClick={() => void importIt()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
