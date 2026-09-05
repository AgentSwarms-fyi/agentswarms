// A model's automation: retrain on a cadence (promoted when better) and
// score a lakehouse table on a cadence. Owner-only; the list says what each
// schedule did last and when it runs next.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlUi";
import {
  mlScheduleCreate,
  mlScheduleDelete,
  mlScheduleRunNow,
  mlScheduleUpdate,
  mlSchedulesList,
  type MlScheduleView,
} from "@/utils/mlOps.functions";
import { mlListSources, type MlSourceTable } from "@/utils/ml.functions";
import { ML_TUNING_LABEL, ML_TUNINGS, type MlTuning } from "@/utils/ml/types";

const CADENCE: Record<string, string> = {
  hourly: "every hour",
  daily: "every day",
  weekly: "every week",
  cron: "cron",
};

/** "in 23h", "in 4m", or "due" once the time has passed; relTime only looks backwards. */
function inTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "due";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function statusTone(s: string | null) {
  return s === "promoted"
    ? "text-emerald-600 dark:text-emerald-400"
    : s === "failed"
      ? "text-red-600 dark:text-red-400"
      : "text-muted-foreground";
}

export function SchedulesPanel({
  token,
  modelId,
  task,
  shared,
}: {
  token: string;
  modelId: string;
  task: string;
  shared: boolean;
}) {
  const listFn = useServerFn(mlSchedulesList);
  const updateFn = useServerFn(mlScheduleUpdate);
  const deleteFn = useServerFn(mlScheduleDelete);
  const runFn = useServerFn(mlScheduleRunNow);
  const [rows, setRows] = useState<MlScheduleView[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    listFn({ data: { access_token: token, model_id: modelId } })
      .then((r) => setRows(r.schedules))
      .catch((e) => toast.error((e as Error).message));
  }, [listFn, token, modelId]);
  useEffect(() => load(), [load]);

  async function toggle(s: MlScheduleView) {
    const r = await updateFn({ data: { access_token: token, id: s.id, is_active: !s.is_active } });
    if (!r.ok) return toast.error(r.error);
    toast.success(s.is_active ? "Schedule paused" : "Schedule resumed");
    load();
  }
  async function remove(s: MlScheduleView) {
    if (!(await confirmAsk({ title: `Delete the schedule "${s.name}"?` }))) return;
    const r = await deleteFn({ data: { access_token: token, id: s.id } });
    if (!r.ok) return toast.error(r.error);
    toast.success("Schedule deleted");
    load();
  }
  async function runNow(s: MlScheduleView) {
    const r = await runFn({ data: { access_token: token, id: s.id } });
    if (!r.ok) return toast.error(r.error);
    toast.success(s.kind === "retrain" ? "Training started" : "Batch prediction started");
    load();
  }

  if (shared) {
    return (
      <p className="text-sm text-muted-foreground">Schedules belong to the model&apos;s owner.</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-medium">
            <CalendarClock className="h-4 w-4 text-primary" /> Automation
          </p>
          <p className="text-xs text-muted-foreground">
            Retrain on a cadence and promote the new version when it beats production; score a
            lakehouse table on a cadence. Runs as you, audited, in the same sweep as pipelines.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New schedule
        </Button>
      </div>
      {rows === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No schedules yet. A nightly retrain keeps a model current; a daily batch prediction
            keeps a scored table fresh for dashboards and agents.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Cadence</th>
                <th className="px-3 py-2 font-medium">Next run</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const cfg = (s.config ?? {}) as {
                  input?: { schema: string; table: string; where?: string };
                  output?: { schema: string; table: string };
                  tuning?: string;
                };
                return (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {s.kind === "retrain"
                          ? `retrain · ${ML_TUNING_LABEL[(cfg.tuning as MlTuning) ?? "none"]}${s.promote_if_better ? " · promote when better" : ""}`
                          : `batch predict · ${cfg.input?.schema}.${cfg.input?.table} → ${cfg.output?.schema}.${cfg.output?.table}`}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.schedule === "cron" ? (
                        <code className="text-xs">{s.cron_expr}</code>
                      ) : (
                        CADENCE[s.schedule]
                      )}
                      {!s.is_active ? <span className="ml-1 text-[10px]">(paused)</span> : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.is_active && s.next_run_at ? inTime(s.next_run_at) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {s.last_run_at ? (
                        <>
                          <span className={statusTone(s.last_status)}>{s.last_status}</span>
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            {relTime(s.last_run_at)}
                          </span>
                          {s.last_error ? (
                            <p className="text-[11px] text-red-600 dark:text-red-400">
                              {s.last_error}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">never</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => void runNow(s)}>
                        <Play className="mr-1 h-3 w-3" /> Run now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1"
                        onClick={() => void toggle(s)}
                        title={s.is_active ? "Pause" : "Resume"}
                      >
                        {s.is_active ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-600"
                        onClick={() => void remove(s)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <NewScheduleDialog
        open={open}
        onOpenChange={setOpen}
        token={token}
        modelId={modelId}
        task={task}
        onCreated={() => {
          setOpen(false);
          load();
        }}
      />
    </div>
  );
}

function NewScheduleDialog({
  open,
  onOpenChange,
  token,
  modelId,
  task,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string;
  modelId: string;
  task: string;
  onCreated: () => void;
}) {
  const createFn = useServerFn(mlScheduleCreate);
  const sourcesFn = useServerFn(mlListSources);
  const [kind, setKind] = useState<"retrain" | "batch_predict">("retrain");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState<"hourly" | "daily" | "weekly" | "cron">("daily");
  const [cron, setCron] = useState("0 6 * * 1-5");
  const [timezone, setTimezone] = useState(
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
  );
  const [promote, setPromote] = useState(true);
  const [budget, setBudget] = useState<number | "">("");
  const [tuning, setTuning] = useState<MlTuning>("none");
  const [tables, setTables] = useState<MlSourceTable[]>([]);
  const [input, setInput] = useState("");
  const [where, setWhere] = useState("");
  const [outSchema, setOutSchema] = useState("");
  const [outTable, setOutTable] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    sourcesFn({ data: { access_token: token } })
      .then((r) => {
        setTables(r.tables);
        const first = r.tables[0];
        if (first && !input) {
          setInput(`${first.schema}.${first.table}`);
          setOutSchema(first.schema);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token, sourcesFn]);

  useEffect(() => {
    if (!open) return;
    setName(kind === "retrain" ? "Nightly retrain" : "Daily scoring");
  }, [kind, open]);

  async function create() {
    setBusy(true);
    try {
      const [inSchema, inTable] = input.split(".");
      const r = await createFn({
        data: {
          access_token: token,
          model_id: modelId,
          name: name.trim() || (kind === "retrain" ? "Retrain" : "Batch prediction"),
          kind,
          schedule,
          cron_expr: schedule === "cron" ? cron.trim() : undefined,
          timezone: timezone || undefined,
          promote_if_better: promote,
          time_budget_minutes: budget === "" ? undefined : Number(budget),
          tuning: kind === "retrain" ? tuning : undefined,
          input:
            kind === "batch_predict" && inSchema && inTable
              ? { schema: inSchema, table: inTable, where: where.trim() || undefined }
              : undefined,
          output:
            kind === "batch_predict" && outSchema && outTable.trim()
              ? { schema: outSchema, table: outTable.trim() }
              : undefined,
        },
      });
      if (!r.ok) return toast.error(r.error);
      toast.success(`Scheduled — next run ${r.next_run_at ? inTime(r.next_run_at) : "soon"}`);
      onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const schemas = Array.from(new Set(tables.map((t) => t.schema)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            Runs as you, in the platform&apos;s sweep, and is audited like a manual run.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setKind("retrain")}
              className={`rounded-lg border p-3 text-left text-sm ${kind === "retrain" ? "border-primary bg-primary/10" : "hover:border-primary/40"}`}
            >
              <p className="font-medium">Retrain</p>
              <p className="text-xs text-muted-foreground">
                A new version from the current table; promoted when it beats production.
              </p>
            </button>
            <button
              type="button"
              disabled={task === "forecast"}
              onClick={() => setKind("batch_predict")}
              className={`rounded-lg border p-3 text-left text-sm ${kind === "batch_predict" ? "border-primary bg-primary/10" : task === "forecast" ? "cursor-not-allowed opacity-50" : "hover:border-primary/40"}`}
            >
              <p className="font-medium">Batch prediction</p>
              <p className="text-xs text-muted-foreground">
                Score a lakehouse table into a table you own, with the production version.
              </p>
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cadence</Label>
              <select
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as typeof schedule)}
              >
                <option value="hourly">every hour</option>
                <option value="daily">every day</option>
                <option value="weekly">every week</option>
                <option value="cron">cron expression</option>
              </select>
            </div>
            {schedule === "cron" ? (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Expression</Label>
                  <Input
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    className="h-8 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Timezone</Label>
                  <Input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="h-8"
                  />
                </div>
              </>
            ) : null}
          </div>
          {kind === "retrain" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Time budget (min)</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="default"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value === "" ? "" : Number(e.target.value))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tuning</Label>
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={tuning}
                  onChange={(e) => setTuning(e.target.value as MlTuning)}
                >
                  {ML_TUNINGS.map((t) => (
                    <option key={t} value={t}>
                      {ML_TUNING_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs sm:col-span-2">
                <input
                  type="checkbox"
                  checked={promote}
                  onChange={(e) => setPromote(e.target.checked)}
                />
                Promote the new version when its primary metric beats production
              </label>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Input table</Label>
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                >
                  {tables.map((t) => (
                    <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                      {t.schema}.{t.table}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Row filter (optional SQL WHERE)</Label>
                <Input
                  value={where}
                  onChange={(e) => setWhere(e.target.value)}
                  placeholder="placed_at >= current_date - 1"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Output schema</Label>
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={outSchema}
                  onChange={(e) => setOutSchema(e.target.value)}
                >
                  {schemas.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Output table</Label>
                <Input
                  value={outTable}
                  onChange={(e) => setOutTable(e.target.value)}
                  placeholder="revenue_scored"
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
