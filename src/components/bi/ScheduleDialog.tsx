// Schedule & alerts dialog for a BI dashboard (owner-only). The schedule
// and alert rules are plain rows under owner RLS; the server-side processor
// (see utils/bi/refresh.server.ts) picks them up with the service role.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2, Plus, Trash2, Mail } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import type { BiWidget } from "@/lib/biDashboards";

type ScheduleRow = {
  id: string;
  enabled: boolean;
  cadence: string;
  at_hour: number;
  weekday: number;
  email_report: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
};

type AlertRow = {
  id: string;
  widget_id: string;
  label: string;
  column_name: string;
  aggregation: string;
  operator: string;
  threshold: number;
  is_active: boolean;
  email_enabled: boolean;
  last_state: string;
  last_value: number | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const OPERATORS = [
  { v: "gt", label: "> greater than" },
  { v: "gte", label: "≥ at least" },
  { v: "lt", label: "< less than" },
  { v: "lte", label: "≤ at most" },
  { v: "eq", label: "= equals" },
  { v: "neq", label: "≠ not equal" },
];
const AGGREGATIONS = ["first", "sum", "avg", "min", "max", "count"];

/** Client-side mirror of the server's next-run math (UTC). */
function nextRunIso(cadence: string, atHour: number, weekday: number): string {
  const from = new Date();
  const next = new Date(from.getTime());
  if (cadence === "hourly") {
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  next.setUTCHours(atHour, 0, 0, 0);
  if (cadence === "daily") {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  const delta = (weekday - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString();
}

export function ScheduleDialog({
  open,
  onOpenChange,
  dashboardId,
  userId,
  widgets,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dashboardId: string;
  userId: string;
  widgets: BiWidget[];
}) {
  const [loading, setLoading] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  // New-alert form
  const [aWidget, setAWidget] = useState("");
  const [aColumn, setAColumn] = useState("");
  const [aAgg, setAAgg] = useState("first");
  const [aOp, setAOp] = useState("gt");
  const [aThreshold, setAThreshold] = useState("");

  const chartWidgets = widgets.filter((w) => w.kind === "chart" && w.sql);
  const pickedWidget = chartWidgets.find((w) => w.id === aWidget);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void (async () => {
      const [{ data: s }, { data: a }] = await Promise.all([
        supabase.from("bi_schedules").select("*").eq("dashboard_id", dashboardId).maybeSingle(),
        supabase.from("bi_alerts").select("*").eq("dashboard_id", dashboardId).order("created_at"),
      ]);
      setSchedule((s as ScheduleRow) ?? null);
      setAlerts((a as AlertRow[]) ?? []);
      setLoading(false);
    })();
  }, [open, dashboardId]);

  async function upsertSchedule(patch: Partial<ScheduleRow>) {
    const merged = {
      cadence: schedule?.cadence ?? "daily",
      at_hour: schedule?.at_hour ?? 6,
      weekday: schedule?.weekday ?? 1,
      enabled: schedule?.enabled ?? true,
      ...patch,
    };
    const next_run_at = nextRunIso(merged.cadence, merged.at_hour, merged.weekday);
    if (schedule) {
      const { error } = await supabase
        .from("bi_schedules")
        .update({ ...merged, next_run_at })
        .eq("id", schedule.id);
      if (error) return toast.error(error.message);
      setSchedule({ ...schedule, ...merged });
    } else {
      const { data, error } = await supabase
        .from("bi_schedules")
        .insert({ dashboard_id: dashboardId, user_id: userId, ...merged, next_run_at })
        .select("*")
        .single();
      if (error) return toast.error(error.message);
      setSchedule(data as ScheduleRow);
    }
  }

  async function removeSchedule() {
    if (!schedule) return;
    await supabase.from("bi_schedules").delete().eq("id", schedule.id);
    setSchedule(null);
  }

  async function addAlert() {
    if (!aWidget || !aThreshold.trim() || !Number.isFinite(Number(aThreshold))) {
      return toast.error("Pick a widget and a numeric threshold");
    }
    const { data, error } = await supabase
      .from("bi_alerts")
      .insert({
        dashboard_id: dashboardId,
        user_id: userId,
        widget_id: aWidget,
        label: "",
        column_name: aAgg === "count" ? "" : aColumn,
        aggregation: aAgg,
        operator: aOp,
        threshold: Number(aThreshold),
      })
      .select("*")
      .single();
    if (error) return toast.error(error.message);
    setAlerts((prev) => [...prev, data as AlertRow]);
    setAThreshold("");
    toast.success("Alert added — it's checked after every scheduled refresh");
  }

  async function deleteAlert(id: string) {
    await supabase.from("bi_alerts").delete().eq("id", id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }

  async function toggleAlert(a: AlertRow, on: boolean) {
    setAlerts((prev) => prev.map((x) => (x.id === a.id ? { ...x, is_active: on } : x)));
    await supabase.from("bi_alerts").update({ is_active: on }).eq("id", a.id);
  }

  async function toggleAlertEmail(a: AlertRow) {
    const next = !a.email_enabled;
    await supabase.from("bi_alerts").update({ email_enabled: next }).eq("id", a.id);
    setAlerts((prev) => prev.map((x) => (x.id === a.id ? { ...x, email_enabled: next } : x)));
  }

  const widgetTitle = (id: string) => widgets.find((w) => w.id === id)?.title ?? "deleted widget";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" /> Schedule &amp; alerts
          </DialogTitle>
          <DialogDescription className="text-xs">
            Refresh this dashboard's data on a schedule (server-side, no browser needed) and get
            notified when a metric crosses a threshold. Times are UTC.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Schedule */}
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold">Scheduled refresh</Label>
                <Switch
                  checked={Boolean(schedule?.enabled)}
                  onCheckedChange={(on) => {
                    if (!schedule && on) void upsertSchedule({ enabled: true });
                    else if (schedule && !on) void removeSchedule();
                    else void upsertSchedule({ enabled: on });
                  }}
                />
              </div>
              {schedule?.enabled && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select
                    value={schedule.cadence}
                    onValueChange={(v) => void upsertSchedule({ cadence: v })}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hourly" className="text-xs">
                        Hourly
                      </SelectItem>
                      <SelectItem value="daily" className="text-xs">
                        Daily
                      </SelectItem>
                      <SelectItem value="weekly" className="text-xs">
                        Weekly
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {schedule.cadence === "weekly" && (
                    <Select
                      value={String(schedule.weekday)}
                      onValueChange={(v) => void upsertSchedule({ weekday: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((d, i) => (
                          <SelectItem key={d} value={String(i)} className="text-xs">
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {schedule.cadence !== "hourly" && (
                    <Select
                      value={String(schedule.at_hour)}
                      onValueChange={(v) => void upsertSchedule({ at_hour: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {Array.from({ length: 24 }, (_, h) => (
                          <SelectItem key={h} value={String(h)} className="text-xs">
                            {String(h).padStart(2, "0")}:00 UTC
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {schedule.last_run_at && (
                    <span className="text-[10px] text-muted-foreground">
                      Last run {new Date(schedule.last_run_at).toLocaleString()} —{" "}
                      {schedule.last_status}
                    </span>
                  )}
                </div>
              )}
              {schedule?.enabled && (
                <Label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] font-normal">
                  <Switch
                    checked={Boolean(schedule.email_report)}
                    onCheckedChange={(on) => void upsertSchedule({ email_report: on })}
                    className="scale-75"
                  />
                  Email me a report after each refresh (KPIs + refresh summary)
                </Label>
              )}
            </div>

            {/* Alerts */}
            <div className="rounded-lg border border-border p-3">
              <Label className="text-xs font-semibold">Data alerts</Label>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Checked after each scheduled refresh; a rule notifies once when it trips and re-arms
                when the condition clears.
              </p>
              <div className="mt-2 space-y-1.5">
                {alerts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11px]"
                  >
                    <Switch
                      checked={a.is_active}
                      onCheckedChange={(on) => void toggleAlert(a, on)}
                      className="scale-75"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{widgetTitle(a.widget_id)}</span>
                      {" · "}
                      {a.column_name ? `${a.aggregation}(${a.column_name})` : "row count"}{" "}
                      {OPERATORS.find((o) => o.v === a.operator)?.label.slice(0, 1)} {a.threshold}
                    </span>
                    {a.last_state === "triggered" && (
                      <Badge className="h-4 bg-red-500/15 px-1.5 text-[9px] text-red-600 hover:bg-red-500/15 dark:text-red-400">
                        triggered{a.last_value !== null ? ` · ${a.last_value}` : ""}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-6 w-6 ${a.email_enabled ? "text-primary" : "text-muted-foreground"}`}
                      title={
                        a.email_enabled
                          ? "Email on trigger: on — click to disable"
                          : "Also email me when this alert triggers"
                      }
                      onClick={() => void toggleAlertEmail(a)}
                    >
                      <Mail className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => void deleteAlert(a.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <Select value={aWidget || undefined} onValueChange={setAWidget}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Widget" />
                  </SelectTrigger>
                  <SelectContent>
                    {chartWidgets.map((w) => (
                      <SelectItem key={w.id} value={w.id} className="text-xs">
                        {w.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={aAgg} onValueChange={setAAgg}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AGGREGATIONS.map((g) => (
                      <SelectItem key={g} value={g} className="text-xs">
                        {g === "count" ? "row count" : g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {aAgg !== "count" && (
                  <Select value={aColumn || undefined} onValueChange={setAColumn}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Column" />
                    </SelectTrigger>
                    <SelectContent>
                      {(pickedWidget?.columns ?? []).map((c) => (
                        <SelectItem key={c} value={c} className="text-xs">
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Select value={aOp} onValueChange={setAOp}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATORS.map((o) => (
                      <SelectItem key={o.v} value={o.v} className="text-xs">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={aThreshold}
                  onChange={(e) => setAThreshold(e.target.value)}
                  placeholder="Threshold"
                  inputMode="decimal"
                  className="h-8 text-xs"
                />
                <Button size="sm" className="h-8 gap-1 text-xs" onClick={() => void addAlert()}>
                  <Plus className="h-3 w-3" /> Add alert
                </Button>
              </div>
              {!schedule?.enabled && alerts.length > 0 && (
                <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
                  Enable the scheduled refresh above — alerts are evaluated when it runs.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
