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

import { StreamStateDialog } from "./StreamStateDialog";
import { Check, ListTree, Loader2, Plug2, RefreshCw, Trash2, Unplug, X } from "lucide-react";

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
import { CredentialAgeBadge, HealthBadge } from "@/components/integrations/ConnectionHealthBadges";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { providerInitials } from "@/components/integrations/WarehousesTab";
import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";
import { SAAS_CARDS } from "@/utils/saas/catalog";
import type {
  SaasConfig,
  SaasConnectionSummary,
  SaasProvider,
  SaasStream,
  SyncSchedule,
} from "@/utils/saas/types";
import {
  deleteSaasConnection,
  discoverSaasStreams,
  listSaasConnections,
  saveSaasConnection,
  setSaasSchedule,
  syncSaasConnection,
} from "@/utils/saas.functions";
import { SCHEDULE_LABELS, scheduleSummary } from "@/lib/saasSchedule";

/**
 * App logos, discovered from the assets directory.
 *
 * Same contract as the warehouse tab: drop `src/assets/saas/<provider>.svg`
 * in and it appears. There are none bundled yet — these are trademarked marks
 * the project may not have the right to redistribute — so every card currently
 * renders initials, which is deliberate rather than missing.
 */
const LOGO_FILES = import.meta.glob<{ default: string }>("../../assets/saas/*.svg", {
  eager: true,
});

/** The logo tile, or the provider's initials when no logo is bundled. */
function ProviderMark({ provider }: { provider: SaasProvider }) {
  const hit = Object.entries(LOGO_FILES).find(([path]) => path.endsWith(`/${provider}.svg`));
  if (hit) {
    return (
      <img
        src={hit[1].default}
        alt={`${SAAS_LABELS[provider]} logo`}
        className="h-full w-full object-contain"
      />
    );
  }
  return (
    <span aria-hidden className="text-[11px] font-semibold tracking-tight text-muted-foreground">
      {providerInitials(SAAS_LABELS[provider])}
    </span>
  );
}

export function SaasSourcesTab() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";

  const list = useServerFn(listSaasConnections);
  const save = useServerFn(saveSaasConnection);
  const remove = useServerFn(deleteSaasConnection);
  const discover = useServerFn(discoverSaasStreams);
  const sync = useServerFn(syncSaasConnection);
  const reschedule = useServerFn(setSaasSchedule);

  const [connections, setConnections] = useState<SaasConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogProvider, setDialogProvider] = useState<SaasProvider | null>(null);
  const [name, setName] = useState("");
  /** Whatever the selected provider's fields are, keyed by field. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<SyncSchedule>("daily");
  const [streams, setStreams] = useState<SaasStream[] | null>(null);
  const [streamsFor, setStreamsFor] = useState<{
    id: string;
    name: string;
    shared?: boolean;
  } | null>(null);
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
    setValues({});
    setSchedule("daily");
    setStreams(null);
    setPicked([]);
  };

  /**
   * The config object for the server function.
   *
   * Cast at this one point rather than typed per provider: the shape is
   * validated by the same discriminated union server-side, so a mismatch is a
   * rejected request rather than a bad row.
   */
  const configFor = () => ({ provider: dialogProvider, ...values }) as unknown as SaasConfig;

  /**
   * Every field the provider INSISTS on has a value.
   *
   * Optional ones are skipped, because they were not: Jira's project keys and
   * Asana's workspace both say "optional" on the label and both kept the
   * Connect button disabled until somebody typed into them.
   */
  const fieldsComplete = () =>
    !!dialogProvider &&
    SAAS_CARDS[dialogProvider].fields.every((f) => f.optional || values[f.key]?.trim());

  const onDiscover = async () => {
    setBusy(true);
    try {
      const found = await discover({ data: { access_token: token, config: configFor() } });
      setStreams(found);
      // Pre-select everything: the common case is "sync this spreadsheet", and
      // an empty selection saves a source that does nothing.
      setPicked(found.map((s) => s.id));
      const card = dialogProvider ? SAAS_CARDS[dialogProvider] : null;
      // The stated plural, not `${unit}s` — that is how "repositorys" shipped.
      const noun = found.length === 1 ? (card?.unit ?? "item") : (card?.units ?? "items");
      toast.success(`Found ${found.length} ${noun}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that source");
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!name.trim()) return toast.error("Give this source a name");
    const unit = dialogProvider ? SAAS_CARDS[dialogProvider].unit : "item";
    if (picked.length === 0) return toast.error(`Choose at least one ${unit} to sync`);
    setBusy(true);
    try {
      const { id } = await save({
        data: {
          access_token: token,
          name: name.trim(),
          config: configFor(),
          streams: picked,
          sync_schedule: schedule,
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
      toast.success(`Disconnected “${confirmRemove.name}”`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect it");
    } finally {
      setBusy(false);
      setConfirmRemove(null);
    }
  };

  const onSchedule = async (c: SaasConnectionSummary, next: SyncSchedule) => {
    if (c.sync_schedule === next) return;
    try {
      await reschedule({ data: { access_token: token, id: c.id, sync_schedule: next } });
      toast.success(
        next === "manual"
          ? `“${c.name}” now syncs only when you ask`
          : `“${c.name}” syncs ${next} — first run starts shortly`,
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the schedule");
      // Re-read either way: a rejected change must not leave the select
      // showing a cadence the row does not have.
      await refresh();
    }
  };

  const help = dialogProvider ? SAAS_CARDS[dialogProvider] : null;
  /**
   * One instant for every row, so two rows a second apart do not disagree
   * about what "due now" means.
   */
  const now = new Date();
  /** Connections for a provider, and the subset this user may disconnect. */
  const forProvider = (p: SaasProvider) => connections.filter((c) => c.provider === p);
  const ownedFor = (p: SaasProvider) => forProvider(p).filter((c) => !c.shared);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SAAS_PROVIDERS.map((p) => (
          <Card key={p} className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/50 bg-white p-1.5">
                  <ProviderMark provider={p} />
                </div>
                <CardTitle className="text-base">{SAAS_LABELS[p]}</CardTitle>
              </div>
              <p className="text-xs text-muted-foreground">{SAAS_CARDS[p].description}</p>
              {/* CONNECTED MEANS A CONNECTION EXISTS. This was keyed off
                  `last_sync_status === "ok"`, so a source that was connected
                  but had never synced — or whose last run failed — showed no
                  badge at all and read as "not set up". Sync health is a
                  different question, answered per row in the table below. */}
              {forProvider(p).length > 0 ? (
                <Badge variant="outline" className="w-fit border-primary/30 text-primary">
                  <Check className="mr-1 h-3 w-3" /> Connected
                  {forProvider(p).length > 1 ? ` · ${forProvider(p).length}` : ""}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog(p)}>
                <Plug2 className="h-3.5 w-3.5" />
                {forProvider(p).length > 0 ? "Add another" : "Connect"}
              </Button>
              {/* Offered only when there is ONE thing it could mean. With
                  several connections of the same provider a card-level
                  "Disconnect" would have to guess which, so the per-row
                  buttons below stay the only way to say it. */}
              {ownedFor(p).length === 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => setConfirmRemove(ownedFor(p)[0])}
                >
                  <Unplug className="h-3.5 w-3.5" /> Disconnect
                </Button>
              )}
              {ownedFor(p).length > 1 && (
                <span className="text-[11px] text-muted-foreground">
                  {ownedFor(p).length} connections — disconnect below
                </span>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-base">Connected sources</CardTitle>
          <CardDescription>
            Each synced stream becomes a dataset. A stream that can be followed is read from where
            it got to last time; one that cannot is re-read in full, replacing the dataset. Either
            way the previous contents are kept as a restorable version — open{" "}
            <strong>Streams</strong> to see which is which.
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
                  <TableHead className="w-[190px]">Schedule</TableHead>
                  <TableHead className="w-[210px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        {c.name}
                        {c.shared && (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            Shared
                          </Badge>
                        )}
                        {/* Distinct from the SYNC column: this is the scheduled
                            auth probe. A source can authenticate fine and have
                            no sync scheduled, and a sync can fail for reasons
                            unrelated to the credential. */}
                        <HealthBadge
                          status={c.last_test_status}
                          error={c.last_test_error}
                          checkedAt={c.last_tested_at}
                        />
                        <CredentialAgeBadge rotatedAt={c.credentials_rotated_at} />
                      </span>
                    </TableCell>
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
                    <TableCell>
                      {c.shared ? (
                        // A grantee may run a sync but not change the cadence:
                        // that spends the OWNER's API quota on the owner's
                        // account. Rendered as text rather than a disabled
                        // select so it reads as someone else's setting.
                        <span className="text-xs text-muted-foreground">
                          {SCHEDULE_LABELS[c.sync_schedule] ?? c.sync_schedule}
                        </span>
                      ) : (
                        <Select
                          value={c.sync_schedule}
                          onValueChange={(v) => void onSchedule(c, v as SyncSchedule)}
                        >
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(SCHEDULE_LABELS) as SyncSchedule[]).map((s) => (
                              <SelectItem key={s} value={s} className="text-xs">
                                {SCHEDULE_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {(() => {
                        const sum = scheduleSummary(c, now);
                        if (!sum.next) return null;
                        return (
                          <p
                            className={`mt-1 text-[10px] ${
                              sum.broken ? "text-destructive" : "text-muted-foreground"
                            }`}
                          >
                            {sum.next}
                          </p>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5"
                        disabled={syncingId === c.id}
                        onClick={() => runSync(c.id)}
                        title="Pull every selected stream again, replacing the datasets"
                      >
                        {syncingId === c.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        {syncingId === c.id ? "Syncing…" : "Sync now"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5"
                        onClick={() => setStreamsFor({ id: c.id, name: c.name, shared: c.shared })}
                        title="What each stream is doing, and how far it has got"
                      >
                        <ListTree className="h-3.5 w-3.5" /> Streams
                      </Button>
                      {/* Shared sources belong to someone else. The server
                          refuses regardless; a button that always errors is
                          its own bug. Sync stays available — noticing stale
                          data and re-running it is the point of sharing. */}
                      {!c.shared && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 text-destructive hover:text-destructive"
                          onClick={() => setConfirmRemove(c)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Disconnect
                        </Button>
                      )}
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
                placeholder={dialogProvider ? `My ${SAAS_LABELS[dialogProvider]}` : "My source"}
              />
              {/* FOUND FROM THE UI. Both of these were written for Google
                  Sheets and shown for every provider, so somebody connecting
                  ServiceNow was told about spreadsheets and a “Sheet1” they do
                  not have. The unit each provider syncs is already declared. */}
              <p className="text-[11px] text-muted-foreground">
                Prefixes the dataset names, so two sources with a same-named{" "}
                {dialogProvider ? SAAS_CARDS[dialogProvider].unit : "stream"} cannot overwrite each
                other.
              </p>
            </div>
            {dialogProvider &&
              SAAS_CARDS[dialogProvider].fields.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs">{f.label}</Label>
                  {f.type === "textarea" ? (
                    <Textarea
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="h-28 font-mono text-[11px]"
                    />
                  ) : (
                    <Input
                      type={f.type === "password" ? "password" : "text"}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  )}
                  {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
                </div>
              ))}

            <Button
              variant="outline"
              size="sm"
              disabled={busy || !fieldsComplete()}
              onClick={onDiscover}
            >
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Connect and list {dialogProvider ? SAAS_CARDS[dialogProvider].units : ""}
            </Button>

            {streams && (
              <div className="space-y-1">
                <Label className="text-xs">
                  Sync these {dialogProvider ? SAAS_CARDS[dialogProvider].units : "items"}
                </Label>
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

            {streams && (
              <div className="space-y-1">
                <Label className="text-xs">Sync automatically</Label>
                <Select value={schedule} onValueChange={(v) => setSchedule(v as SyncSchedule)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Only when I click sync</SelectItem>
                    <SelectItem value="hourly">Every hour</SelectItem>
                    <SelectItem value="daily">Every day</SelectItem>
                    <SelectItem value="weekly">Every week</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Each run REPLACES the datasets, keeping the previous contents as a restorable
                  version. You are notified if a run fails.
                </p>
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
            <AlertDialogTitle>
              Disconnect “{confirmRemove?.name}”
              {confirmRemove ? ` (${SAAS_LABELS[confirmRemove.provider]})` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              {/* SPELL OUT BOTH HALVES. "Removed" alone leaves the reader
                  guessing whether their dashboards are about to break, and the
                  count matters: "datasets are kept" is unhelpful when you
                  cannot tell if that means one table or forty. */}
              <div className="space-y-2 text-sm">
                <p>This cannot be undone. It stops here and now:</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>The stored credentials are deleted.</li>
                  <li>
                    {confirmRemove && confirmRemove.sync_schedule !== "manual"
                      ? `Scheduled syncs (${SCHEDULE_LABELS[confirmRemove.sync_schedule].toLowerCase()}) stop.`
                      : "No further syncs will run."}
                  </li>
                </ul>
                <p>What stays:</p>
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    {typeof confirmRemove?.dataset_count === "number" ? (
                      <>
                        <strong>
                          {confirmRemove.dataset_count} dataset
                          {confirmRemove.dataset_count === 1 ? "" : "s"}
                        </strong>{" "}
                        already synced from this source are kept, with their data and version
                        history. They stop refreshing, and go back to being filed under “Local
                        tables” in the Data Catalog.
                      </>
                    ) : (
                      // The count could not be read. Say the true thing
                      // without a number rather than print a confident zero.
                      <>
                        Datasets already synced from this source are kept, with their data and
                        version history. They stop refreshing.
                      </>
                    )}
                  </li>
                </ul>
                <p className="text-muted-foreground">
                  Delete those datasets separately from Data &amp; SQL if you want them gone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <StreamStateDialog
        connectionId={streamsFor?.id ?? null}
        connectionName={streamsFor?.name ?? ""}
        shared={streamsFor?.shared}
        open={streamsFor !== null}
        onOpenChange={(o) => {
          if (!o) setStreamsFor(null);
        }}
      />
    </div>
  );
}
