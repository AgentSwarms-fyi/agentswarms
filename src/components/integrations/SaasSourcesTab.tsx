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
  syncSaasConnection,
} from "@/utils/saas.functions";

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  type?: "password" | "textarea";
  hint?: string;
};

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

/**
 * Per-provider copy and form fields.
 *
 * Field-driven rather than a hand-written form per provider: the dialog below
 * renders whatever is listed here, so a new connector is an entry in this
 * table and its config type — not another branch in the JSX.
 */
const PROVIDER_HELP: Record<
  SaasProvider,
  { description: string; setup: string; unit: string; fields: Field[] }
> = {
  google_sheets: {
    description: "Sync worksheets from a Google spreadsheet into datasets.",
    setup:
      "Create a service account in Google Cloud, download its JSON key, then SHARE the " +
      "spreadsheet with the key's client_email address (Share → paste it → Viewer). " +
      "Without that share step Google returns 403 no matter how valid the key is.",
    unit: "worksheet",
    fields: [
      {
        key: "spreadsheet_id",
        label: "Spreadsheet URL or id",
        placeholder: "https://docs.google.com/spreadsheets/d/…",
      },
      {
        key: "service_account_json",
        label: "Service account key JSON",
        type: "textarea",
        placeholder: '{ "type": "service_account", … }',
      },
    ],
  },
  stripe: {
    description: "Sync charges, invoices, subscriptions and more into datasets.",
    setup:
      "Use a RESTRICTED key with read-only permissions (Developers → API keys → Create " +
      "restricted key). A full secret key works but grants far more than this needs — " +
      "nothing here ever writes to Stripe.",
    unit: "object type",
    fields: [
      {
        key: "api_key",
        label: "Secret or restricted key",
        type: "password",
        placeholder: "rk_live_… or sk_live_…",
        hint: "Not the publishable key (pk_…) — that cannot read these endpoints.",
      },
    ],
  },
  hubspot: {
    description: "Sync contacts, companies, deals and tickets into datasets.",
    setup:
      "Settings → Integrations → Private Apps → create an app, grant it the read scopes for " +
      "the objects you want (crm.objects.contacts.read and so on), then copy its access token. " +
      "A private app is used rather than OAuth because that needs a public redirect URL.",
    unit: "object type",
    fields: [
      {
        key: "access_token",
        label: "Private app access token",
        type: "password",
        placeholder: "pat-na1-…",
      },
    ],
  },
  salesforce: {
    description: "Sync accounts, contacts, leads, opportunities and cases into datasets.",
    setup:
      "Create a connected app with the Client Credentials flow enabled and a 'run as' user set " +
      "(Setup → App Manager → New Connected App → OAuth Settings). Copy its consumer key and " +
      "secret. No redirect URL is needed — this is a server-to-server flow.",
    unit: "object",
    fields: [
      {
        key: "instance_url",
        label: "Instance URL",
        placeholder: "https://acme.my.salesforce.com",
        hint: "Your My Domain address. A sandbox uses its own domain.",
      },
      { key: "client_id", label: "Consumer key", type: "password", placeholder: "3MVG9…" },
      { key: "client_secret", label: "Consumer secret", type: "password" },
    ],
  },
  shopify: {
    description: "Sync orders, customers and products into datasets.",
    setup:
      "In your Shopify admin: Settings → Apps and sales channels → Develop apps → create an " +
      "app, grant it read_orders, read_customers and read_products, then install it and copy " +
      "the Admin API access token.",
    unit: "resource",
    fields: [
      {
        key: "shop_domain",
        label: "Shop domain",
        placeholder: "acme.myshopify.com",
      },
      {
        key: "access_token",
        label: "Admin API access token",
        type: "password",
        placeholder: "shpat_…",
      },
    ],
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
  /** Whatever the selected provider's fields are, keyed by field. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<SyncSchedule>("daily");
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

  /** Every field for the chosen provider has a value. */
  const fieldsComplete = () =>
    !!dialogProvider && PROVIDER_HELP[dialogProvider].fields.every((f) => values[f.key]?.trim());

  const onDiscover = async () => {
    setBusy(true);
    try {
      const found = await discover({ data: { access_token: token, config: configFor() } });
      setStreams(found);
      // Pre-select everything: the common case is "sync this spreadsheet", and
      // an empty selection saves a source that does nothing.
      setPicked(found.map((s) => s.id));
      const unit = dialogProvider ? PROVIDER_HELP[dialogProvider].unit : "item";
      toast.success(`Found ${found.length} ${unit}${found.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that source");
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!name.trim()) return toast.error("Give this source a name");
    const unit = dialogProvider ? PROVIDER_HELP[dialogProvider].unit : "item";
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
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/50 bg-white p-1.5">
                  <ProviderMark provider={p} />
                </div>
                <CardTitle className="text-base">{SAAS_LABELS[p]}</CardTitle>
              </div>
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
                      {/* Shared sources belong to someone else. The server
                          refuses regardless; a button that always errors is
                          its own bug. Sync stays available — noticing stale
                          data and re-running it is the point of sharing. */}
                      {!c.shared && (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(c)}>
                          <Trash2 className="h-3.5 w-3.5" />
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
                placeholder="Finance spreadsheet"
              />
              <p className="text-[11px] text-muted-foreground">
                Prefixes the dataset names, so two sources with a “Sheet1” cannot overwrite each
                other.
              </p>
            </div>
            {dialogProvider &&
              PROVIDER_HELP[dialogProvider].fields.map((f) => (
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
              Connect and list {dialogProvider ? `${PROVIDER_HELP[dialogProvider].unit}s` : ""}
            </Button>

            {streams && (
              <div className="space-y-1">
                <Label className="text-xs">
                  Sync these {dialogProvider ? `${PROVIDER_HELP[dialogProvider].unit}s` : "items"}
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
