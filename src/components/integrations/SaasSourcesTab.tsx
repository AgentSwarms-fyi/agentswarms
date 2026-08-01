// "Apps" tab of the Integration Hub: SaaS sources that are PULLED into
// datasets rather than queried live.
//
// The flow is deliberately three steps rather than one form: enter credentials
// → discover what is in there → choose what to sync. A source like a
// spreadsheet has no schema until you have authenticated, so asking the user to
// name a worksheet up front means guessing and then getting a 404.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format } from "date-fns";
import { Check, Loader2, Plug2, RefreshCw, Trash2, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";
import type { SaasConnectionSummary, SaasProvider, SaasStream } from "@/utils/saas/types";
import {
  deleteSaasConnection,
  discoverSaasStreams,
  listSaasConnections,
  saveSaasConnection,
  syncSaasConnection,
} from "@/utils/saas.functions";

const PROVIDER_HELP: Record<SaasProvider, { description: string; setup: string }> = {
  google_sheets: {
    description: "Sync worksheets from a Google spreadsheet into datasets.",
    setup:
      "Create a service account in Google Cloud, download its JSON key, then SHARE the " +
      "spreadsheet with the key's client_email address (Share → paste it → Viewer). " +
      "Without that share step Google returns 403 no matter how valid the key is.",
  },
};

export function SaasSourcesTab() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";

  const list = useServerFn(listSaasConnections);
  const save = useServerFn(saveSaasConnection);
  const remove = useServerFn(deleteSaasConnection);
  const discover = useServerFn(discoverSaasStreams);
  const sync = useServerFn(syncSaasConnection);

  const [connections, setConnections] = useState<SaasConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogProvider, setDialogProvider] = useState<SaasProvider | null>(null);
  const [name, setName] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [streams, setStreams] = useState<SaasStream[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SaasConnectionSummary | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setConnections(await list({ data: { access_token: token } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load data sources");
    } finally {
      setLoading(false);
    }
  }, [list, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openDialog = (p: SaasProvider) => {
    setDialogProvider(p);
    setName("");
    setServiceAccountJson("");
    setSpreadsheetId("");
    setStreams(null);
    setPicked([]);
  };

  const configFor = () => ({
    provider: "google_sheets" as const,
    service_account_json: serviceAccountJson,
    spreadsheet_id: spreadsheetId,
  });

  const onDiscover = async () => {
    setBusy(true);
    try {
      const found = await discover({ data: { access_token: token, config: configFor() } });
      setStreams(found);
      // Pre-select everything: the common case is "sync this spreadsheet", and
      // an empty selection saves a source that does nothing.
      setPicked(found.map((s) => s.id));
      toast.success(`Found ${found.length} worksheet${found.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that source");
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!name.trim()) return toast.error("Give this source a name");
    if (picked.length === 0) return toast.error("Choose at least one worksheet to sync");
    setBusy(true);
    try {
      const { id } = await save({
        data: {
          access_token: token,
          name: name.trim(),
          config: configFor(),
          streams: picked,
        },
      });
      setDialogProvider(null);
      await refresh();
      toast.success("Saved. Syncing now…");
      await runSync(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (id: string) => {
    setSyncingId(id);
    try {
      const res = await sync({ data: { access_token: token, id } });
      const rows = res.synced.reduce((n, s) => n + s.rowCount, 0);
      if (res.failed.length > 0) {
        // Partial success is reported as a problem, not as a success with an
        // asterisk — a tab that quietly stopped syncing is how a dashboard goes
        // stale without anyone noticing.
        toast.warning(
          `Synced ${res.synced.length}, failed ${res.failed.length}: ${res.failed[0].stream} — ${res.failed[0].error}`,
        );
      } else {
        toast.success(
          `Synced ${res.synced.length} dataset${res.synced.length === 1 ? "" : "s"}, ${rows.toLocaleString()} rows`,
        );
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
      await refresh();
    } finally {
      setSyncingId(null);
    }
  };

  const onRemove = async () => {
    if (!confirmRemove) return;
    setBusy(true);
    try {
      await remove({ data: { access_token: token, id: confirmRemove.id } });
      toast.success("Data source removed");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove it");
    } finally {
      setBusy(false);
      setConfirmRemove(null);
    }
  };

  const help = dialogProvider ? PROVIDER_HELP[dialogProvider] : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SAAS_PROVIDERS.map((p) => (
          <Card key={p} className="border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{SAAS_LABELS[p]}</CardTitle>
              <p className="text-xs text-muted-foreground">{PROVIDER_HELP[p].description}</p>
              {connections.some((c) => c.provider === p && c.last_sync_status === "ok") ? (
                <Badge variant="outline" className="w-fit border-primary/30 text-primary">
                  <Check className="mr-1 h-3 w-3" /> Connected
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog(p)}>
                <Plug2 className="h-3.5 w-3.5" /> Connect
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-base">Connected sources</CardTitle>
          <CardDescription>
            Each synced stream becomes a dataset. A sync REPLACES that dataset — the previous
            contents are kept as a restorable version.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing connected yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead className="w-[140px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {SAAS_LABELS[c.provider]}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.last_sync_status === "ok" ? (
                        <span className="text-primary">
                          <Check className="mr-1 inline h-3 w-3" />
                          {c.last_synced_at
                            ? format(new Date(c.last_synced_at), "d MMM HH:mm")
                            : ""}
                        </span>
                      ) : c.last_sync_status ? (
                        <span className="text-destructive" title={c.last_sync_error ?? ""}>
                          <X className="mr-1 inline h-3 w-3" />
                          {c.last_sync_status}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={syncingId === c.id}
                        onClick={() => runSync(c.id)}
                      >
                        {syncingId === c.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(c)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!dialogProvider} onOpenChange={(o) => !o && setDialogProvider(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect {dialogProvider ? SAAS_LABELS[dialogProvider] : ""}</DialogTitle>
            <DialogDescription>{help?.setup}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Finance spreadsheet"
              />
              <p className="text-[11px] text-muted-foreground">
                Prefixes the dataset names, so two sources with a “Sheet1” cannot overwrite each
                other.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Spreadsheet URL or id</Label>
              <Input
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Service account key JSON</Label>
              <Textarea
                value={serviceAccountJson}
                onChange={(e) => setServiceAccountJson(e.target.value)}
                placeholder='{ "type": "service_account", … }'
                className="h-28 font-mono text-[11px]"
              />
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={busy || !serviceAccountJson || !spreadsheetId}
              onClick={onDiscover}
            >
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Find worksheets
            </Button>

            {streams && (
              <div className="space-y-1">
                <Label className="text-xs">Sync these worksheets</Label>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border/50 bg-background/40 p-2">
                  {streams.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2 text-[11px]"
                    >
                      <input
                        type="checkbox"
                        checked={picked.includes(s.id)}
                        onChange={(e) =>
                          setPicked((prev) =>
                            e.target.checked
                              ? Array.from(new Set([...prev, s.id]))
                              : prev.filter((x) => x !== s.id),
                          )
                        }
                      />
                      <span className="flex-1 truncate font-mono">{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogProvider(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !streams} onClick={onSave}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Save and sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{confirmRemove?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored credentials are deleted. Datasets already synced from this source are KEPT
              — remove those separately from Data &amp; SQL if you want them gone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove} disabled={busy}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
