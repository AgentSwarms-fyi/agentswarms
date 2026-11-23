// Data engineering -> Data monitors: standing checks on tables, their incidents and
// their history. A monitor is the question "is this table still right?",
// asked on a schedule; an incident is the open answer.
import { PageHeader } from "@/components/PageHeader";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Activity,
  Check,
  HeartPulse,
  History,
  Pencil,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { useRecordOpened } from "@/hooks/use-object-marks";
import { usePageIntent } from "@/hooks/use-page-intent";
import { announceTrashed } from "@/hooks/use-trash";
import { RESTORE_HINT } from "@/lib/trash";
import { FavouritesFilter } from "@/components/FavouritesFilter";
import { useFavouritesFilter } from "@/hooks/use-favourites-filter";
import { StarButton } from "@/components/StarButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlFormat";
import { readPageIntent } from "@/lib/pageIntent";
import { cn } from "@/lib/utils";
import {
  MONITOR_KINDS,
  MONITOR_KIND_HELP,
  MONITOR_KIND_LABEL,
  MONITOR_SCHEDULES,
  MONITOR_SEVERITIES,
  type MonitorConfig,
  type MonitorKind,
} from "@/utils/dataMonitors/core";
import {
  dataIncidentUpdate,
  dataMonitorCreate,
  dataMonitorDelete,
  dataMonitorRunNow,
  dataMonitorRuns,
  dataMonitorSources,
  dataMonitorUpdate,
  dataMonitorsList,
  type MonitorView,
} from "@/utils/dataMonitors.functions";
import type { DataIncidentRow, DataMonitorRunRow } from "@/utils/dataMonitors/run.server";
import { reportFailure } from "@/lib/silentFailureNet";

const searchSchema = z.object({
  source: z.enum(["lakehouse", "warehouse"]).optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
  create: z.boolean().optional(),
});

export const Route = createFileRoute("/_authenticated/data-monitors")({
  // The page's own keys, plus `?open=<id>` and `?new=1` — how search results
  // and the "New" menu link here (src/lib/pageIntent.ts).
  //
  // `create` is also accepted as the text "true". A link whose search is
  // written as plain strings arrives that way, and refusing it fails the whole
  // page rather than the one key.
  validateSearch: (s: Record<string, unknown>) => ({
    ...searchSchema.parse(s.create === "true" ? { ...s, create: true } : s),
    ...readPageIntent(s),
  }),
  head: () => ({
    meta: [
      { title: "Data monitors — AgentSwarms" },
      {
        name: "description",
        content:
          "Standing checks on your tables: freshness, volume with learned baselines, schema drift, null rates, uniqueness and custom SQL, with incidents and alerts.",
      },
    ],
  }),
  component: DataMonitorsPage,
});

type Sources = {
  lakehouse: {
    enabled: boolean;
    tables: { schema: string; table: string; columns: { name: string; type: string }[] }[];
  };
  warehouses: { id: string; name: string; provider: string }[];
};

function StatusChip({ status }: { status: string | null | undefined }) {
  if (status === "ok") return <Badge className="bg-emerald-600 hover:bg-emerald-600">ok</Badge>;
  if (status === "alert") return <Badge variant="destructive">alert</Badge>;
  if (status === "error") return <Badge className="bg-amber-600 hover:bg-amber-600">error</Badge>;
  return <Badge variant="secondary">not run yet</Badge>;
}

function Sparkline({ points }: { points: { value: number | null; status: string }[] }) {
  const vals = points.map((p) => p.value).filter((v): v is number => typeof v === "number");
  if (vals.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const w = 96;
  const h = 24;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / Math.max(1, points.length - 1);
  const coords = points
    .map((p, i) =>
      typeof p.value === "number"
        ? `${(i * step).toFixed(1)},${(h - 2 - ((p.value - min) / span) * (h - 4)).toFixed(1)}`
        : null,
    )
    .filter(Boolean)
    .join(" ");
  const last = points[points.length - 1];
  const stroke =
    last?.status === "alert" ? "#dc2626" : last?.status === "error" ? "#d97706" : "#059669";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="block"
      aria-label="recent values"
    >
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={coords} />
    </svg>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "bad" | "warn";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums",
            tone === "bad" && "text-destructive",
            tone === "warn" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function DataMonitorsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const search = Route.useSearch();
  const listFn = useServerFn(dataMonitorsList);
  const sourcesFn = useServerFn(dataMonitorSources);
  const createFn = useServerFn(dataMonitorCreate);
  const updateFn = useServerFn(dataMonitorUpdate);
  const deleteFn = useServerFn(dataMonitorDelete);
  const runNowFn = useServerFn(dataMonitorRunNow);
  const runsFn = useServerFn(dataMonitorRuns);
  const incidentFn = useServerFn(dataIncidentUpdate);

  const [monitors, setMonitors] = useState<MonitorView[] | null>(null);
  const [incidents, setIncidents] = useState<DataIncidentRow[]>([]);
  const [sources, setSources] = useState<Sources | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(Boolean(search.create));
  // The monitor being changed, when the dialog is open on one.
  const [editing, setEditing] = useState<MonitorView | null>(null);
  const [history, setHistory] = useState<{
    monitor: MonitorView;
    runs: DataMonitorRunRow[];
  } | null>(null);
  // Its history is the one view a monitor has, and only the reader opens it.
  useRecordOpened("data_monitor", history?.monitor.id ?? null);
  const favourites = useFavouritesFilter(
    "data_monitor",
    (monitors ?? []).map((m) => m.id),
  );
  const shownMonitors = (monitors ?? []).filter((m) => favourites.keep(m.id));

  const reload = useCallback(async () => {
    if (!token) return;
    const res = await listFn({ data: { access_token: token } });
    if (!res.ok) return toast.error(res.error);
    setMonitors(res.monitors);
    setIncidents(res.incidents);
  }, [listFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A monitor's history is the one view it has beyond its row in the list, so
  // it is what the History button and a link to the monitor both open.
  async function showHistory(monitor: MonitorView) {
    try {
      const r = await runsFn({ data: { access_token: token, id: monitor.id } });
      if (r.ok) setHistory({ monitor, runs: r.runs });
      else toast.error(r.error);
    } catch (e) {
      reportFailure("read that monitor's history", e);
    }
  }

  // A link here can ask for one monitor to be opened, or for a new one.
  usePageIntent(search, {
    ready: monitors !== null,
    noun: "monitor",
    onNew: () => setOpen(true),
    onOpen: (id) => {
      const monitor = monitors?.find((m) => m.id === id);
      if (!monitor) return false;
      void showHistory(monitor);
    },
  });

  useEffect(() => {
    if (!token) return;
    void sourcesFn({ data: { access_token: token } }).then((r) => {
      if (r.ok) setSources({ lakehouse: r.lakehouse, warehouses: r.warehouses });
    });
  }, [sourcesFn, token]);

  const stats = useMemo(() => {
    const list = monitors ?? [];
    return {
      total: list.length,
      alerting: list.filter((m) => m.last_status === "alert").length,
      errors: list.filter((m) => m.last_status === "error").length,
      open: incidents.filter((i) => i.status !== "resolved").length,
    };
  }, [monitors, incidents]);

  async function act(
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>,
    done?: (r: Record<string, unknown>) => void,
  ) {
    setBusy(id);
    try {
      const r = await fn();
      if (!r.ok) {
        toast.error(String(r.error ?? "Failed"));
        // R312: a refusal usually means the monitor changed under the page
        // (an incident resolved meanwhile), so show where it stands now.
        await reload();
        return;
      }
      done?.(r);
      await reload();
    } catch (e) {
      reportFailure("finish that on the monitor", e);
    } finally {
      setBusy(null);
    }
  }

  const monitorName = (id: string) => monitors?.find((m) => m.id === id)?.name ?? "monitor";
  const openIncidents = incidents.filter((i) => i.status !== "resolved");

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Data monitors"
        description="Scheduled checks on your tables that open an incident when one fails and close it when it passes again."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> New monitor
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Monitors" value={stats.total} />
        <Stat label="Alerting" value={stats.alerting} tone={stats.alerting ? "bad" : undefined} />
        <Stat label="Errors" value={stats.errors} tone={stats.errors ? "warn" : undefined} />
        <Stat label="Open incidents" value={stats.open} tone={stats.open ? "bad" : undefined} />
      </div>

      {openIncidents.length > 0 ? (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-sm font-medium">Open incidents</p>
            <ul className="space-y-2">
              {openIncidents.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={i.severity === "critical" ? "destructive" : "secondary"}>
                        {i.severity}
                      </Badge>
                      {i.status === "acknowledged" ? (
                        <Badge variant="outline">acknowledged</Badge>
                      ) : null}
                      <span className="text-sm font-medium">{monitorName(i.monitor_id)}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {i.title.replace(/^[^:]+:\s*/, "")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Opened {relTime(i.opened_at)} · seen {i.occurrences}{" "}
                      {i.occurrences === 1 ? "time" : "times"} · last {relTime(i.last_seen_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {i.status === "open" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === i.id}
                        onClick={() =>
                          void act(i.id, () =>
                            incidentFn({
                              data: { access_token: token, id: i.id, action: "acknowledge" },
                            }),
                          )
                        }
                      >
                        Acknowledge
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === i.id}
                      onClick={() =>
                        void act(i.id, () =>
                          incidentFn({
                            data: { access_token: token, id: i.id, action: "resolve" },
                          }),
                        )
                      }
                    >
                      <Check className="mr-1 h-3.5 w-3.5" /> Resolve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Draws nothing, and takes no room, until a monitor here is starred. */}
      <FavouritesFilter filter={favourites} className="ml-auto flex" />
      <Card>
        <CardContent className="p-0">
          {monitors === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : monitors.length === 0 ? (
            <div className="p-8 text-center">
              <HeartPulse className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No monitors yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Pick a lakehouse or warehouse table and the check that matters for it. The first run
                happens as you create it, so you see the answer before the schedule takes over.
              </p>
              <Button size="sm" className="mt-3" onClick={() => setOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" /> New monitor
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left text-xs">
                  <tr>
                    <th className="px-3 py-2 font-medium">Monitor</th>
                    <th className="px-3 py-2 font-medium">Check</th>
                    <th className="px-3 py-2 font-medium">Every</th>
                    <th className="px-3 py-2 font-medium">Last run</th>
                    <th className="px-3 py-2 font-medium">Trend</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {shownMonitors.map((m) => (
                    <tr
                      key={m.id}
                      className={cn("border-t align-top", !m.is_active && "opacity-60")}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{m.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {m.source_kind === "lakehouse" ? "lakehouse" : "warehouse"} ·{" "}
                          {m.schema_name}.{m.table_name}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{MONITOR_KIND_LABEL[m.kind as MonitorKind]}</Badge>
                        {m.severity === "critical" ? (
                          <Badge variant="destructive" className="ml-1">
                            critical
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {m.schedule === "cron" ? (
                          <code className="font-mono">{m.cron_expr}</code>
                        ) : (
                          m.schedule
                        )}
                        {!m.is_active ? <div className="text-muted-foreground">paused</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <StatusChip status={m.last_status} />
                          <span className="text-xs text-muted-foreground">
                            {m.last_run_at ? relTime(m.last_run_at) : ""}
                          </span>
                        </div>
                        {m.last_message ? (
                          <p className="mt-1 max-w-md text-xs text-muted-foreground">
                            {m.last_message}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <Sparkline
                          points={m.recent.map((r) => ({ value: r.value, status: r.status }))}
                        />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <StarButton
                          kind="data_monitor"
                          id={m.id}
                          name={m.name}
                          className="h-6 w-6"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Run now"
                          disabled={busy === m.id}
                          onClick={() =>
                            void act(
                              m.id,
                              () => runNowFn({ data: { access_token: token, id: m.id } }),
                              (r) =>
                                toast[r.status === "ok" ? "success" : "warning"](String(r.message)),
                            )
                          }
                        >
                          {busy === m.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Activity className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="History"
                          onClick={() => void showHistory(m)}
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Edit"
                          aria-label={`Edit ${m.name}`}
                          disabled={busy === m.id}
                          onClick={() => setEditing(m)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={m.is_active ? "Pause" : "Resume"}
                          disabled={busy === m.id}
                          onClick={() =>
                            void act(m.id, () =>
                              updateFn({
                                data: { access_token: token, id: m.id, is_active: !m.is_active },
                              }),
                            )
                          }
                        >
                          {m.is_active ? (
                            <Pause className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          title="Delete"
                          disabled={busy === m.id}
                          onClick={async () => {
                            const ok = await confirmAsk({
                              title: `Move “${m.name}” to the trash?`,
                              body: `Its run history and incidents go with it. Pausing keeps them. ${RESTORE_HINT}`,
                              actionLabel: "Move to trash",
                            }).catch(() => false);
                            if (ok)
                              void act(
                                m.id,
                                () => deleteFn({ data: { access_token: token, id: m.id } }),
                                (r) =>
                                  announceTrashed(m.name, String(r.trashId), () => void reload()),
                              );
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewMonitorDialog
        open={open || editing !== null}
        onOpenChange={(v) => {
          if (v) return;
          setOpen(false);
          setEditing(null);
        }}
        sources={sources}
        token={token}
        prefill={{ source: search.source, schema: search.schema, table: search.table }}
        editing={editing}
        onSave={async (id, input) => {
          const r = await updateFn({ data: { access_token: token, id, ...input } });
          if (!r.ok) {
            toast.error(r.error);
            return false;
          }
          toast.success("Saved. It runs with the new settings on the next pass.");
          await reload();
          return true;
        }}
        onCreate={async (input) => {
          const r = await createFn({ data: { access_token: token, ...input } });
          if (!r.ok) {
            toast.error(r.error);
            return false;
          }
          if (r.first_run) {
            toast[
              r.first_run.status === "ok"
                ? "success"
                : r.first_run.status === "alert"
                  ? "warning"
                  : "error"
            ](`First run: ${r.first_run.message}`);
          } else toast.success("Monitor created");
          await reload();
          return true;
        }}
      />

      <Dialog open={Boolean(history)} onOpenChange={(v) => !v && setHistory(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{history?.monitor.name}</DialogTitle>
            <DialogDescription>Every run, newest first.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {history?.runs.length ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Value</th>
                    <th className="py-1 pr-3 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {history.runs.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-xs">
                        {new Date(r.ran_at).toLocaleString()}
                        <div className="text-muted-foreground">{r.trigger}</div>
                      </td>
                      <td className="py-1.5 pr-3">
                        <StatusChip status={r.status} />
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-xs">
                        {r.value === null
                          ? "—"
                          : Number.isInteger(r.value)
                            ? r.value.toLocaleString()
                            : r.value.toFixed(2)}
                      </td>
                      <td className="py-1.5 pr-3 text-xs">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type CreateInput = {
  name?: string;
  source_kind: "lakehouse" | "warehouse";
  warehouse_id?: string | null;
  schema_name: string;
  table_name: string;
  kind: MonitorKind;
  config: MonitorConfig;
  schedule: (typeof MONITOR_SCHEDULES)[number];
  cron_expr?: string | null;
  severity: (typeof MONITOR_SEVERITIES)[number];
  run_now?: boolean;
};

function NewMonitorDialog({
  open,
  onOpenChange,
  sources,
  token,
  prefill,
  onCreate,
  editing = null,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sources: Sources | null;
  token: string;
  prefill: { source?: "lakehouse" | "warehouse"; schema?: string; table?: string };
  onCreate: (input: CreateInput) => Promise<boolean>;
  /** A monitor to change: its table and kind stay, the rest can change. */
  editing?: MonitorView | null;
  onSave?: (
    id: string,
    input: {
      name?: string;
      config: MonitorConfig;
      schedule: (typeof MONITOR_SCHEDULES)[number];
      cron_expr: string | null;
      severity: (typeof MONITOR_SEVERITIES)[number];
    },
  ) => Promise<boolean>;
}) {
  const [sourceKind, setSourceKind] = useState<"lakehouse" | "warehouse">(
    prefill.source ?? "lakehouse",
  );
  const [lakeTable, setLakeTable] = useState(
    prefill.schema && prefill.table ? `${prefill.schema}.${prefill.table}` : "",
  );
  const [warehouseId, setWarehouseId] = useState("");
  const [schema, setSchema] = useState(prefill.schema ?? "");
  const [table, setTable] = useState(prefill.table ?? "");
  const [kind, setKind] = useState<MonitorKind>("freshness");
  const [column, setColumn] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [maxAge, setMaxAge] = useState("1440");
  const [mode, setMode] = useState<"delta" | "total">("delta");
  const [minRows, setMinRows] = useState("");
  const [maxRows, setMaxRows] = useState("");
  const [anomaly, setAnomaly] = useState(true);
  const [maxNull, setMaxNull] = useState("5");
  const [sql, setSql] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [schedule, setSchedule] = useState<(typeof MONITOR_SCHEDULES)[number]>("hourly");
  const [cron, setCron] = useState("");
  const [severity, setSeverity] = useState<(typeof MONITOR_SEVERITIES)[number]>("warning");
  const [name, setName] = useState("");
  const [runNow, setRunNow] = useState(true);
  const [saving, setSaving] = useState(false);
  void token;

  useEffect(() => {
    if (!open || !editing) return;
    const c = (editing.config ?? {}) as MonitorConfig;
    const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    setSourceKind(editing.source_kind === "warehouse" ? "warehouse" : "lakehouse");
    setLakeTable(`${editing.schema_name}.${editing.table_name}`);
    setWarehouseId(editing.warehouse_id ?? "");
    setSchema(editing.schema_name);
    setTable(editing.table_name);
    setKind(editing.kind as MonitorKind);
    setColumn(c.column ?? (c.columns ?? []).join(", "));
    setColumns(c.columns ?? []);
    setMaxAge(txt(c.max_age_minutes ?? 1440));
    setMode(c.mode === "total" ? "total" : "delta");
    setMinRows(txt(c.min_rows));
    setMaxRows(txt(c.max_rows));
    setAnomaly(c.anomaly !== false);
    setMaxNull(txt(c.max_null_pct ?? 5));
    setSql(c.sql ?? "");
    setMin(txt(c.min));
    setMax(txt(c.max));
    setSchedule(editing.schedule as (typeof MONITOR_SCHEDULES)[number]);
    setCron(editing.cron_expr ?? "");
    setSeverity(editing.severity as (typeof MONITOR_SEVERITIES)[number]);
    setName(editing.name);
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lakeTables = sources?.lakehouse.tables ?? [];
  const selectedLake = lakeTables.find((t) => `${t.schema}.${t.table}` === lakeTable) ?? null;
  const columnOptions = selectedLake?.columns ?? [];
  const timestampColumns = columnOptions.filter((c) => /time|date/i.test(c.type));
  const offeredColumns =
    kind === "freshness" && timestampColumns.length ? timestampColumns : columnOptions;
  // The column a monitor being changed reads, when the list does not offer
  // it (text under a freshness check, or dropped from the table). Shown, so
  // the select never pretends nothing is picked while the old column saves.
  const strayColumn =
    editing && column && columnOptions.length && !offeredColumns.some((c) => c.name === column)
      ? { type: columnOptions.find((c) => c.name === column)?.type ?? null }
      : null;

  useEffect(() => {
    if (kind === "freshness" && !column && timestampColumns[0]) setColumn(timestampColumns[0].name);
  }, [kind, column, timestampColumns]);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  async function submit() {
    const isLake = sourceKind === "lakehouse";
    const schemaName = isLake ? (selectedLake?.schema ?? "") : schema.trim();
    const tableName = isLake ? (selectedLake?.table ?? "") : table.trim();
    if (!schemaName || !tableName)
      return toast.error(isLake ? "Pick a lakehouse table" : "Enter the schema and table");
    if (!isLake && !warehouseId) return toast.error("Pick a warehouse connection");
    const config: MonitorConfig =
      kind === "freshness"
        ? { column: column.trim(), max_age_minutes: Number(maxAge) }
        : kind === "volume"
          ? { mode, min_rows: num(minRows), max_rows: num(maxRows), anomaly }
          : kind === "nulls"
            ? { column: column.trim(), max_null_pct: Number(maxNull) }
            : kind === "uniqueness"
              ? {
                  columns: isLake
                    ? columns
                    : column
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean),
                }
              : kind === "custom_sql"
                ? { sql: sql.trim(), min: num(min), max: num(max) }
                : {};
    setSaving(true);
    if (editing && onSave) {
      try {
        const ok = await onSave(editing.id, {
          name: name.trim() || undefined,
          config,
          schedule,
          cron_expr: schedule === "cron" ? cron.trim() : null,
          severity,
        });
        if (ok) onOpenChange(false);
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const ok = await onCreate({
        name: name.trim() || undefined,
        source_kind: sourceKind,
        warehouse_id: isLake ? null : warehouseId,
        schema_name: schemaName,
        table_name: tableName,
        kind,
        config,
        schedule,
        cron_expr: schedule === "cron" ? cron.trim() : null,
        severity,
        run_now: runNow,
      });
      if (ok) {
        onOpenChange(false);
        // The table stays (several checks on one table is the common case);
        // the check itself starts over.
        setKind("freshness");
        setColumn("");
        setColumns([]);
        setMaxAge("1440");
        setMode("delta");
        setMinRows("");
        setMaxRows("");
        setAnomaly(true);
        setMaxNull("5");
        setSql("");
        setMin("");
        setMax("");
        setSeverity("warning");
        setName("");
      }
    } finally {
      setSaving(false);
    }
  }

  const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "New monitor"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "The table and the kind of check stay. Change what it checks, how often, and how loud it is."
              : "Pick the table, the check, and how often to ask."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Where the table lives</Label>
              <select
                className={selectClass}
                value={sourceKind}
                disabled={!!editing}
                onChange={(e) => setSourceKind(e.target.value as "lakehouse" | "warehouse")}
              >
                <option value="lakehouse">Lakehouse</option>
                <option value="warehouse">Connected warehouse</option>
              </select>
            </div>
            {sourceKind === "lakehouse" ? (
              <div className="space-y-1">
                <Label>Table</Label>
                <select
                  className={selectClass}
                  value={lakeTable}
                  disabled={!!editing}
                  onChange={(e) => {
                    setLakeTable(e.target.value);
                    setColumn("");
                    setColumns([]);
                  }}
                >
                  <option value="">
                    {lakeTables.length
                      ? "Pick a table…"
                      : sources
                        ? "No lakehouse tables"
                        : "Loading…"}
                  </option>
                  {lakeTables.map((t) => (
                    <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                      {t.schema}.{t.table}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Warehouse</Label>
                <select
                  className={selectClass}
                  value={warehouseId}
                  disabled={!!editing}
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  <option value="">
                    {sources?.warehouses.length ? "Pick a connection…" : "No warehouse connections"}
                  </option>
                  {(sources?.warehouses ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.provider})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {sourceKind === "warehouse" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Schema</Label>
                <Input
                  value={schema}
                  disabled={!!editing}
                  onChange={(e) => setSchema(e.target.value)}
                  placeholder="public"
                />
              </div>
              <div className="space-y-1">
                <Label>Table</Label>
                <Input
                  value={table}
                  disabled={!!editing}
                  onChange={(e) => setTable(e.target.value)}
                  placeholder="orders"
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label>Check</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {MONITOR_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={!!editing && editing.kind !== k}
                  onClick={() => {
                    setKind(k);
                    // R238: a column chosen for one check can be meaningless
                    // for another — `region` is a fine null-rate column and
                    // not a timestamp. It used to survive the switch, and the
                    // freshness picker then rendered BLANK, because a
                    // controlled select whose value matches no option shows
                    // nothing. Saving was accepted (the config validator only
                    // checks the column is named, not what it is) and the
                    // monitor alerted ever after. Dropped only when it is
                    // genuinely not on offer for the new kind.
                    if (
                      k === "freshness" &&
                      column &&
                      timestampColumns.length > 0 &&
                      !timestampColumns.some((c) => c.name === column)
                    ) {
                      setColumn("");
                    }
                  }}
                  className={cn(
                    "rounded-md border p-2 text-left text-sm transition-colors hover:bg-muted/60",
                    kind === k && "border-primary bg-primary/5",
                  )}
                >
                  <div className="font-medium">{MONITOR_KIND_LABEL[k]}</div>
                  <div className="text-xs text-muted-foreground">{MONITOR_KIND_HELP[k]}</div>
                </button>
              ))}
            </div>
          </div>

          {kind === "freshness" || kind === "nulls" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Column</Label>
                {sourceKind === "lakehouse" && columnOptions.length ? (
                  <select
                    className={selectClass}
                    value={column}
                    onChange={(e) => setColumn(e.target.value)}
                  >
                    <option value="">Pick a column…</option>
                    {strayColumn ? (
                      <option value={column}>
                        {column} · {strayColumn.type ?? "not in this table"}
                      </option>
                    ) : null}
                    {offeredColumns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} · {c.type}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={column}
                    onChange={(e) => setColumn(e.target.value)}
                    placeholder={kind === "freshness" ? "updated_at" : "customer_id"}
                  />
                )}
                {strayColumn ? (
                  <p className="text-xs text-muted-foreground">
                    {strayColumn.type
                      ? `It reads ${column}, which holds ${strayColumn.type}, not a time. Pick a timestamp column.`
                      : `It reads ${column}, which this table no longer has. Pick a column.`}
                  </p>
                ) : null}
              </div>
              {kind === "freshness" ? (
                <div className="space-y-1">
                  <Label>Newest row must be younger than (minutes)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={maxAge}
                    onChange={(e) => setMaxAge(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <Label>Maximum null share (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.1"
                    value={maxNull}
                    onChange={(e) => setMaxNull(e.target.value)}
                  />
                </div>
              )}
            </div>
          ) : null}

          {kind === "volume" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Judge</Label>
                <select
                  className={selectClass}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "delta" | "total")}
                >
                  <option value="delta">rows added since the last run</option>
                  <option value="total">the total row count</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label>Minimum rows (total)</Label>
                <Input
                  type="number"
                  min={0}
                  value={minRows}
                  onChange={(e) => setMinRows(e.target.value)}
                  placeholder="none"
                />
              </div>
              <div className="space-y-1">
                <Label>Maximum rows (total)</Label>
                <Input
                  type="number"
                  min={0}
                  value={maxRows}
                  onChange={(e) => setMaxRows(e.target.value)}
                  placeholder="none"
                />
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <Checkbox
                  aria-label="Alert when the value is unusual against the last runs"
                  checked={anomaly}
                  onCheckedChange={(v) => setAnomaly(Boolean(v))}
                />
                Alert when the value is unusual against the last runs (needs five runs of history)
              </label>
            </div>
          ) : null}

          {kind === "uniqueness" ? (
            <div className="space-y-1">
              <Label>Columns that must be unique together</Label>
              {sourceKind === "lakehouse" && columnOptions.length ? (
                <div className="grid max-h-36 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                  {columnOptions.map((c) => (
                    <label key={c.name} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        aria-label={c.name}
                        checked={columns.includes(c.name)}
                        onCheckedChange={(v) =>
                          setColumns((prev) =>
                            v ? [...prev, c.name] : prev.filter((x) => x !== c.name),
                          )
                        }
                      />
                      <span>{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.type}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Input
                  value={column}
                  onChange={(e) => setColumn(e.target.value)}
                  placeholder="order_id, line_no"
                />
              )}
            </div>
          ) : null}

          {kind === "custom_sql" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-3">
                <Label>SELECT returning one number</Label>
                <Textarea
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={`SELECT count(*) FROM ${selectedLake ? `${selectedLake.schema}.${selectedLake.table}` : "schema.table"} WHERE amount < 0`}
                />
              </div>
              <div className="space-y-1">
                <Label>Minimum</Label>
                <Input
                  type="number"
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                  placeholder="none"
                />
              </div>
              <div className="space-y-1">
                <Label>Maximum</Label>
                <Input
                  type="number"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  placeholder="none"
                />
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Every</Label>
              <select
                className={selectClass}
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as (typeof MONITOR_SCHEDULES)[number])}
              >
                {MONITOR_SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {s === "cron" ? "cron expression" : s}
                  </option>
                ))}
              </select>
            </div>
            {schedule === "cron" ? (
              <div className="space-y-1">
                <Label>Cron</Label>
                <Input
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="*/30 * * * *"
                  className="font-mono"
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label>Severity</Label>
              <select
                className={selectClass}
                value={severity}
                onChange={(e) => setSeverity(e.target.value as (typeof MONITOR_SEVERITIES)[number])}
              >
                {MONITOR_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Name (optional)</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="from the check"
              />
            </div>
          </div>
          <label className={editing ? "hidden" : "flex items-center gap-2 text-sm"}>
            <Checkbox
              aria-label="Run once now"
              checked={runNow}
              onCheckedChange={(v) => setRunNow(Boolean(v))}
            />
            Run once now, so the answer shows before the schedule takes over
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {editing ? "Save changes" : "Create monitor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
