// Scheduling an analysis to re-run on a cadence.
//
// The dialog's job beyond the cadence fields is to be clear about what a
// scheduled run DOES: it re-runs this analysis's saved queries, it does not
// ask the question again. Users reasonably assume the latter, and the
// difference decides whether a number is comparable week to week.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { clickable } from "@/lib/clickable";
import { describeSchedule, scheduleRefusal, type ScheduleCadence } from "@/lib/analystSchedule";
import { analystRunNow } from "@/utils/analyst.functions";
import type { AnalystTurn } from "@/lib/aiAnalyst";

type ScheduleRow = {
  id: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  at_hour: number;
  weekday: number;
  email_report: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  next_run_at: string;
};

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function ScheduleAnalysisDialog({
  open,
  onOpenChange,
  threadId,
  userId,
  turn,
  accessToken,
  onRefreshed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  threadId: string | null;
  userId: string | undefined;
  /** The analysis a schedule would refresh — the thread's latest turn. */
  turn: AnalystTurn | undefined;
  accessToken: string | null;
  /** A "Run now" rewrote the stored turns; the page reloads them. */
  onRefreshed: () => void;
}) {
  const runNowFn = useServerFn(analystRunNow);
  const [row, setRow] = useState<ScheduleRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [cadence, setCadence] = useState<ScheduleCadence>("daily");
  const [atHour, setAtHour] = useState(6);
  const [weekday, setWeekday] = useState(1);
  const [emailReport, setEmailReport] = useState(false);

  const refusal = scheduleRefusal(turn);

  const load = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    const { data } = await supabase
      .from("ai_analyst_schedules")
      .select("*")
      .eq("thread_id", threadId)
      .maybeSingle();
    const r = (data ?? null) as ScheduleRow | null;
    setRow(r);
    if (r) {
      setCadence(r.cadence);
      setAtHour(r.at_hour);
      setWeekday(r.weekday);
      setEmailReport(r.email_report);
    }
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save(enabled: boolean) {
    if (!threadId || !userId) return;
    setBusy(true);
    const payload = {
      thread_id: threadId,
      user_id: userId,
      enabled,
      cadence,
      at_hour: atHour,
      weekday,
      email_report: emailReport,
    };
    const { error } = await supabase
      .from("ai_analyst_schedules")
      .upsert(payload, { onConflict: "thread_id" });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(enabled ? "Schedule saved" : "Schedule paused");
    void load();
  }

  async function remove() {
    if (!row) return;
    setBusy(true);
    const { error } = await supabase.from("ai_analyst_schedules").delete().eq("id", row.id);
    setBusy(false);
    if (error) return toast.error(error.message);
    setRow(null);
    toast.success("Schedule removed");
  }

  async function runNow() {
    if (!threadId || !accessToken) return;
    setRunning(true);
    const res = await runNowFn({ data: { access_token: accessToken, thread_id: threadId } });
    setRunning(false);
    if (!res.ok) return toast.error(res.error);
    // Say what happened, including when the honest answer is "nothing".
    toast.success(
      res.changes.length > 0
        ? `Refreshed — ${res.changes.length} change${res.changes.length === 1 ? "" : "s"}`
        : "Refreshed — nothing measurable changed",
    );
    onRefreshed();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" /> Schedule this analysis
          </DialogTitle>
        </DialogHeader>

        {refusal ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-relaxed">
            {refusal}
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              A scheduled run <strong>re-runs this analysis&apos;s saved queries</strong> — it does
              not ask the question again. That keeps the numbers comparable between runs, because
              the definition cannot drift. The findings above are marked as predating the new
              numbers until you rewrite them.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px]">How often</Label>
                <Select value={cadence} onValueChange={(v) => setCadence(v as ScheduleCadence)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {cadence !== "hourly" && (
                <div>
                  <Label className="text-[11px]">At (UTC)</Label>
                  <Select value={String(atHour)} onValueChange={(v) => setAtHour(Number(v))}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, h) => (
                        <SelectItem key={h} value={String(h)}>
                          {String(h).padStart(2, "0")}:00
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {cadence === "weekly" && (
                <div className="col-span-2">
                  <Label className="text-[11px]">On</Label>
                  <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAY_LABELS.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              {describeSchedule(cadence, atHour, weekday)}
            </p>

            <Label className={`flex items-center gap-2 text-xs font-normal ${clickable}`}>
              <Checkbox checked={emailReport} onCheckedChange={(v) => setEmailReport(Boolean(v))} />
              Also email me the digest
            </Label>

            {row && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-[11px] leading-relaxed">
                <p>
                  {row.enabled ? "Active" : "Paused"} · next run{" "}
                  {new Date(row.next_run_at).toLocaleString()}
                </p>
                {row.last_run_at && (
                  <p className="text-muted-foreground">
                    Last run {new Date(row.last_run_at).toLocaleString()} — {row.last_status}
                    {row.last_error ? `: ${row.last_error}` : ""}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={runNow}
                disabled={running}
              >
                {running ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                Run now
              </Button>
              {row && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => void save(!row.enabled)}
                    disabled={busy}
                  >
                    {row.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-destructive"
                    onClick={remove}
                    disabled={busy}
                  >
                    Remove
                  </Button>
                </>
              )}
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void save(true)}
                disabled={busy || loading}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : row ? "Update" : "Schedule"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
