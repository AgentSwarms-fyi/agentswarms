// The schedules of a report (R509) or a dashboard (R510): when it is sent,
// to whom, with what values and, for a dashboard, which pages.
//
// Every change goes through a server function (biReportSchedules.functions):
// who may receive a report is the install's policy, which only the server
// can check. "Preview PDF" renders exactly what a scheduled run would send,
// on the server, so the author sees the attachment before anyone else does.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarClock, Eye, Loader2, Mail, Pencil, Plus, Send, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { useTokenRef } from "@/hooks/use-token-ref";
import { paramValueLabel, type BiParamConfig } from "@/lib/biParams";

import {
  cadenceLabel,
  hourLabel,
  isValidTimeZone,
  RELATIVE_DATES,
  REPORT_CADENCES,
  sizeLabel,
  suggestedScheduleName,
  WEEKDAYS,
  type ReportCadence,
  type ReportScheduleFields,
} from "@/lib/biReportSchedule";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  biReportScheduleDelete,
  biReportScheduleSave,
  biReportScheduleSend,
  biReportSchedulePreview,
  biReportSchedulesList,
  type ReportDeliveryView,
  type ReportScheduleView,
} from "@/utils/biReportSchedules.functions";

const DEFAULT = "__default";
const FIXED = "__fixed";

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zoneList(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    return f ? f("timeZone") : [];
  } catch {
    return [];
  }
}

function blankFields(reportName: string): ReportScheduleFields {
  const timing = { cadence: "weekly" as const, weekday: 1, month_day: 1 };
  return {
    name: suggestedScheduleName(reportName, timing),
    enabled: true,
    ...timing,
    at_hour: 8,
    timezone: browserZone(),
    recipients: [],
    subject: "",
    message: "",
    param_values: {},
    skip_empty: false,
  };
}

function fromView(v: ReportScheduleView): ReportScheduleFields {
  return {
    name: v.name,
    enabled: v.enabled,
    cadence: v.cadence,
    at_hour: v.at_hour,
    weekday: v.weekday,
    month_day: v.month_day,
    timezone: v.timezone,
    recipients: v.recipients,
    subject: v.subject,
    message: v.message,
    param_values: v.param_values,
    skip_empty: v.skip_empty,
  };
}

function statusVariant(s: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (s === "sent") return "default";
  if (s === "failed") return "destructive";
  if (s === "partial") return "secondary";
  return "outline";
}

/**
 * A moment as people read it. With a zone (a schedule's runs) it is that
 * zone's clock, as the cadence line states it, and the zone is named when it
 * is not the viewer's: "Mon 08:00" in London is not 08:00 in Dubai.
 */
function when(iso: string | null, tz?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const zone = tz && isValidTimeZone(tz) ? tz : undefined;
  const text = d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  });
  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone !== viewer ? `${text} (${zone})` : text;
}

/** A stored value as the editor shows it. */
function valueText(p: BiParamConfig, v: string | undefined): string {
  if (!v) return `default (${paramValueLabel(p, p.default)})`;
  const rel = RELATIVE_DATES.find((r) => r.value === v);
  return rel ? rel.label.toLowerCase() : paramValueLabel(p, v);
}

export function ReportScheduleDialog({
  open,
  onOpenChange,
  token,
  target,
  params,
  notDrawn,
  pages = [],
  unsaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  /** What the schedules send. */
  target: { kind: "report" | "dashboard"; id: string; name: string };
  params: BiParamConfig[];
  /** Titles of the visuals a scheduled PDF draws in the app only. */
  notDrawn: string[];
  /** A dashboard's pages, to choose which to send. */
  pages?: { id: string; name: string }[];
  /** The designer has changes a schedule would not send. */
  unsaved: boolean;
}) {
  const reportName = target.name;
  const noun = target.kind;
  const ref = useMemo(() => ({ kind: target.kind, id: target.id }), [target.kind, target.id]);
  const listFn = useServerFn(biReportSchedulesList);
  const saveFn = useServerFn(biReportScheduleSave);
  const deleteFn = useServerFn(biReportScheduleDelete);
  const sendFn = useServerFn(biReportScheduleSend);
  const previewFn = useServerFn(biReportSchedulePreview);

  const [loading, setLoading] = useState(false);
  const [schedules, setSchedules] = useState<ReportScheduleView[]>([]);
  const [deliveries, setDeliveries] = useState<ReportDeliveryView[]>([]);
  const [mailer, setMailer] = useState(true);
  // null until the server says: a guessed default would state the wrong policy.
  const [policy, setPolicy] = useState<{ anyDomain: boolean; domains: string[] } | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  // The server's sentence when the install lacks the tables this needs.
  const [needsMigration, setNeedsMigration] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The schedule being edited: null = the list; "new" or an id.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ReportScheduleFields>(() => blankFields(reportName));
  const [recipientsText, setRecipientsText] = useState("");
  // A new schedule's name follows its timing until the author types one.
  const [nameTyped, setNameTyped] = useState(false);
  // A dashboard schedule's pages; empty = every page.
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // A refused save or preview stays on the form until the next attempt: the
  // reason (often the recipient policy) is longer than a toast stays up.
  const [formError, setFormError] = useState<string | null>(null);
  const zones = useMemo(() => zoneList(), []);

  // Read through a ref and keyed on signed-in state (R125): a session refresh
  // changes the token about hourly, and a load keyed on it re-ran the effect
  // below, which closed the schedule being written. Found by the token sweep
  // in R510; R509 shipped it.
  const { tokenRef, signedIn } = useTokenRef(token);
  const load = useCallback(async () => {
    const accessToken = tokenRef.current;
    if (!signedIn || !accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listFn({ data: { accessToken, target: ref } });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSchedules(res.schedules);
      setDeliveries(res.deliveries);
      setMailer(res.mailer);
      setPolicy(res.policy);
      setOwnerEmail(res.ownerEmail);
      setNeedsMigration(res.needsMigration ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [listFn, signedIn, tokenRef, ref]);

  useEffect(() => {
    if (open) {
      setEditing(null);
      void load();
    }
  }, [open, load]);

  const startNew = () => {
    const f = blankFields(reportName);
    setForm(f);
    setRecipientsText(ownerEmail ?? "");
    setFormError(null);
    setNameTyped(false);
    setPageIds([]);
    setEditing("new");
  };
  const startEdit = (v: ReportScheduleView) => {
    setForm(fromView(v));
    setRecipientsText(v.recipients.join(", "));
    setPageIds(v.pages ?? []);
    setFormError(null);
    // A saved name is the author's, whatever the timing becomes.
    setNameTyped(true);
    setEditing(v.id);
  };
  const set = (patch: Partial<ReportScheduleFields>) => setForm((f) => ({ ...f, ...patch }));
  const setTiming = (
    patch: Partial<Pick<ReportScheduleFields, "cadence" | "weekday" | "month_day">>,
  ) =>
    setForm((f) => {
      const next = { ...f, ...patch };
      return nameTyped ? next : { ...next, name: suggestedScheduleName(reportName, next) };
    });
  const setValue = (name: string, v: string | null) =>
    setForm((f) => {
      const next = { ...f.param_values };
      if (v === null || v === "") delete next[name];
      else next[name] = v;
      return { ...f, param_values: next };
    });
  const recipientList = (text: string) =>
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  async function save() {
    setBusy("save");
    setFormError(null);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          target: ref,
          id: editing && editing !== "new" ? editing : null,
          fields: { ...form, recipients: recipientList(recipientsText) },
          pages: pageIds,
        },
      });
      if (!res.ok) {
        setFormError(res.error);
        return;
      }
      toast.success(`Saved. Next run ${when(res.schedule.next_run_at, res.schedule.timezone)}.`);
      setEditing(null);
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(v: ReportScheduleView) {
    const ok = await confirmAsk({
      title: `Delete the schedule "${v.name}"?`,
      body: "It stops sending. Its delivery history is deleted with it.",
      actionLabel: "Delete",
    });
    if (!ok) return;
    setBusy(`delete:${v.id}`);
    try {
      const res = await deleteFn({ data: { accessToken: token, id: v.id } });
      if (!res.ok) toast.error(res.error);
      else toast.success("Schedule deleted");
      await load();
    } catch (e) {
      reportFailure("delete the schedule", e);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(v: ReportScheduleView, enabled: boolean) {
    setBusy(`toggle:${v.id}`);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          target: ref,
          id: v.id,
          fields: { ...fromView(v), enabled },
          pages: v.pages,
        },
      });
      if (!res.ok) toast.error(res.error);
      await load();
    } catch (e) {
      reportFailure(enabled ? "turn the schedule on" : "turn the schedule off", e);
    } finally {
      setBusy(null);
    }
  }

  async function send(v: ReportScheduleView, toMe: boolean) {
    if (!toMe) {
      const ok = await confirmAsk({
        title: `Send "${reportName}" now?`,
        body: `It goes to ${v.recipients.length} ${v.recipients.length === 1 ? "address" : "addresses"}: ${v.recipients.join(", ")}.`,
        actionLabel: "Send",
      });
      if (!ok) return;
    }
    setBusy(`send:${v.id}`);
    try {
      const res = await sendFn({ data: { accessToken: token, id: v.id, toMe } });
      if (!res.ok) toast.error(res.error);
      else if (res.status === "failed") toast.error(res.detail ?? "Not sent");
      else if (res.status === "skipped") toast.info(`Not sent. ${res.detail ?? ""}`.trim());
      else {
        toast.success(
          `${res.status === "sent" ? "Sent" : "Partly sent"} to ${res.recipients} ${res.recipients === 1 ? "address" : "addresses"}${res.detail ? `. ${res.detail}` : ""}`,
        );
      }
      await load();
    } catch (e) {
      reportFailure(toMe ? "send it to you" : "send it now", e);
    } finally {
      setBusy(null);
    }
  }

  async function preview() {
    setBusy("preview");
    setFormError(null);
    try {
      const res = await previewFn({
        data: {
          accessToken: token,
          target: ref,
          param_values: form.param_values,
          timezone: form.timezone,
          pages: pageIds,
        },
      });
      if (!res.ok) {
        setFormError(res.error);
        return;
      }
      const bin = atob(res.pdf);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportName || "Report"} (preview).pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const notes = [
        res.failures.length ? `Not refreshed: ${res.failures.join("; ")}` : "",
        res.fellBack.length ? `Default used for ${res.fellBack.join(", ")}` : "",
        res.empty ? "Every query came back empty" : "",
      ].filter(Boolean);
      toast.success(
        `Preview: ${res.pages} ${res.pages === 1 ? "page" : "pages"}, ${sizeLabel(res.bytes)}${res.values ? ` · ${res.values}` : ""}${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
      );
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const policyText = !policy
    ? ""
    : policy.anyDomain
      ? "This install sends reports to any address."
      : policy.domains.length
        ? `Recipients: people with an account here, or addresses at ${policy.domains.join(", ")}.`
        : "Recipients: people with an account here. An administrator can allow other domains with REPORT_EMAIL_DOMAINS.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-y-auto"
        data-testid="report-schedule-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" /> Schedule “{reportName}”
          </DialogTitle>
          <DialogDescription>
            Sends the saved {noun} as a PDF attachment. It runs as you, so recipients get the
            numbers you can see.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-xs">
          {needsMigration && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
              {needsMigration}
            </p>
          )}
          {!mailer && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
              No mail transport is set up on this install, so nothing can be sent yet. An
              administrator sets SMTP_HOST (or RESEND_API_KEY). Preview PDF still works.
            </p>
          )}
          {unsaved && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
              The {noun} has unsaved changes. A schedule sends the saved {noun}: save first to send
              what you see.
            </p>
          )}
          {notDrawn.length > 0 && (
            <p className="rounded-md border p-2 text-muted-foreground">
              Drawn in the app only, so a scheduled PDF shows a note in their place:{" "}
              {notDrawn.join(", ")}.
            </p>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>

        {editing === null ? (
          <div className="space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading schedules…
              </div>
            ) : schedules.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No schedules yet. Add one to send this {noun} by email.
              </p>
            ) : (
              <ul className="divide-y rounded-md border" data-testid="report-schedules">
                {schedules.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1.5 p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={s.enabled}
                        disabled={busy !== null}
                        onCheckedChange={(v) => void toggle(s, v)}
                        aria-label={`Send "${s.name}" on its schedule`}
                      />
                      <span className="font-medium">{s.name}</span>
                      {s.last_status && (
                        <Badge variant={statusVariant(s.last_status)} className="text-[10px]">
                          {s.last_status}
                        </Badge>
                      )}
                      <div className="ml-auto flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void send(s, true)}
                          title={ownerEmail ? `Send a copy to ${ownerEmail} only` : "Send to me"}
                          aria-label={`Send "${s.name}" to me`}
                        >
                          {busy === `send:${s.id}` ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Mail className="mr-1 h-3.5 w-3.5" />
                          )}
                          Send to me
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void send(s, false)}
                          aria-label={`Send "${s.name}" now`}
                        >
                          <Send className="mr-1 h-3.5 w-3.5" /> Send now
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          disabled={busy !== null}
                          onClick={() => startEdit(s)}
                          aria-label={`Edit "${s.name}"`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          disabled={busy !== null}
                          onClick={() => void remove(s)}
                          aria-label={`Delete "${s.name}"`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {cadenceLabel(s)} · to {s.recipients.join(", ")}
                    </p>
                    {noun === "dashboard" && s.pages.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Pages:{" "}
                        {s.pages
                          .map((id) => pages.find((p) => p.id === id)?.name ?? "a deleted page")
                          .join(", ")}
                      </p>
                    )}
                    {params.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Runs for{" "}
                        {params
                          .map(
                            (p) => `${p.label || p.name}: ${valueText(p, s.param_values[p.name])}`,
                          )
                          .join(" · ")}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {s.enabled ? `Next: ${when(s.next_run_at, s.timezone)}` : "Off"}
                      {s.last_run_at ? ` · Last: ${when(s.last_run_at, s.timezone)}` : ""}
                    </p>
                    {s.last_error && s.last_status !== "sent" && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">{s.last_error}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={startNew} disabled={!!needsMigration || loading}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add schedule
              </Button>
              <span className="text-xs text-muted-foreground">{policyText}</span>
            </div>

            {deliveries.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">Recent deliveries</p>
                <ul
                  className="max-h-48 overflow-y-auto rounded-md border text-xs"
                  data-testid="report-deliveries"
                >
                  {deliveries.slice(0, 15).map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 last:border-0"
                    >
                      <Badge variant={statusVariant(d.status)} className="text-[10px]">
                        {d.status}
                      </Badge>
                      <span>{when(d.ran_at)}</span>
                      <span className="text-muted-foreground">
                        {[
                          schedules.find((s) => s.id === d.schedule_id)?.name,
                          d.trigger === "manual" ? "by hand" : "on schedule",
                          d.recipients
                            ? `${d.recipients} ${d.recipients === 1 ? "recipient" : "recipients"}`
                            : "",
                          d.pages ? `${d.pages} ${d.pages === 1 ? "page" : "pages"}` : "",
                          d.bytes ? sizeLabel(d.bytes) : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {d.detail && <span className="w-full text-muted-foreground">{d.detail}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3" data-testid="report-schedule-form">
            <div className="space-y-1">
              <Label htmlFor="rs-name">Name</Label>
              <Input
                id="rs-name"
                value={form.name}
                maxLength={120}
                onChange={(e) => {
                  setNameTyped(true);
                  set({ name: e.target.value });
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-1 sm:col-span-2">
                <Label>How often</Label>
                <Select
                  value={form.cadence}
                  onValueChange={(v) => setTiming({ cadence: v as ReportCadence })}
                >
                  <SelectTrigger aria-label="How often">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_CADENCES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.cadence === "weekly" && (
                <div className="space-y-1">
                  <Label>On</Label>
                  <Select
                    value={String(form.weekday)}
                    onValueChange={(v) => setTiming({ weekday: Number(v) })}
                  >
                    <SelectTrigger aria-label="Weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.cadence === "monthly" && (
                <div className="space-y-1">
                  <Label>On day</Label>
                  <Select
                    value={String(form.month_day)}
                    onValueChange={(v) => setTiming({ month_day: Number(v) })}
                  >
                    <SelectTrigger aria-label="Day of the month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}
                        </SelectItem>
                      ))}
                      <SelectItem value="0">Last day</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label>At</Label>
                <Select
                  value={String(form.at_hour)}
                  onValueChange={(v) => set({ at_hour: Number(v) })}
                >
                  <SelectTrigger aria-label="Hour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {hourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-tz">Time zone</Label>
              <Input
                id="rs-tz"
                list="rs-tz-list"
                value={form.timezone}
                onChange={(e) => set({ timezone: e.target.value })}
              />
              <datalist id="rs-tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <p className="text-[11px] text-muted-foreground">{cadenceLabel(form)}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-to">Recipients</Label>
              <Textarea
                id="rs-to"
                rows={2}
                value={recipientsText}
                placeholder="name@example.com, another@example.com"
                onChange={(e) => setRecipientsText(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Up to 25, separated by commas. Each gets their own email. {policyText}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-subject">Subject</Label>
              <Input
                id="rs-subject"
                value={form.subject}
                maxLength={200}
                placeholder={reportName}
                onChange={(e) => set({ subject: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Empty sends the {noun}&apos;s name. {"{{date}}"} is the day it runs
                {params.length
                  ? `; ${params.map((p) => `{{${p.name}}}`).join(", ")} ${params.length === 1 ? "prints the value" : "print the values"} it ran with`
                  : ""}
                .
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-message">Message</Label>
              <Textarea
                id="rs-message"
                rows={3}
                maxLength={2000}
                value={form.message}
                onChange={(e) => set({ message: e.target.value })}
              />
            </div>

            {noun === "dashboard" && pages.length > 1 && (
              <fieldset
                className="space-y-1.5 rounded-md border p-3"
                data-testid="report-schedule-pages"
              >
                <legend className="px-1 text-xs font-medium">Pages</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={pageIds.length === 0}
                    onChange={() => setPageIds([])}
                  />
                  Every page
                </label>
                {pages.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={pageIds.includes(p.id)}
                      onChange={(e) =>
                        setPageIds((ids) => {
                          const next = e.target.checked
                            ? [...ids, p.id]
                            : ids.filter((id) => id !== p.id);
                          // Every page ticked one by one is "every page".
                          return next.length === pages.length
                            ? []
                            : pages.map((q) => q.id).filter((id) => next.includes(id));
                        })
                      }
                    />
                    {p.name}
                  </label>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Each page prints on landscape sheets, cards where they are on the screen.
                </p>
              </fieldset>
            )}

            {params.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">Runs with</p>
                {params.map((p) => {
                  const v = form.param_values[p.name] ?? "";
                  const label = p.label || p.name;
                  if (p.control === "date") {
                    const relative = RELATIVE_DATES.some((r) => r.value === v);
                    const mode = !v ? DEFAULT : relative ? v : FIXED;
                    return (
                      <div
                        key={p.name}
                        className="grid grid-cols-[120px_1fr_150px] items-center gap-2"
                      >
                        <Label className="text-xs">{label}</Label>
                        <Select
                          value={mode}
                          onValueChange={(m) =>
                            setValue(p.name, m === DEFAULT ? null : m === FIXED ? p.default : m)
                          }
                        >
                          <SelectTrigger aria-label={`${label} on a scheduled run`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={DEFAULT}>Default ({p.default})</SelectItem>
                            <SelectItem value={FIXED}>A fixed date</SelectItem>
                            {RELATIVE_DATES.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {mode === FIXED ? (
                          <Input
                            type="date"
                            value={v}
                            aria-label={`${label}, fixed date`}
                            onChange={(e) => setValue(p.name, e.target.value)}
                          />
                        ) : (
                          <span />
                        )}
                      </div>
                    );
                  }
                  if (p.control === "radio" || p.control === "dropdown") {
                    return (
                      <div key={p.name} className="grid grid-cols-[120px_1fr] items-center gap-2">
                        <Label className="text-xs">{label}</Label>
                        <Select
                          value={v || DEFAULT}
                          onValueChange={(m) => setValue(p.name, m === DEFAULT ? null : m)}
                        >
                          <SelectTrigger aria-label={`${label} on a scheduled run`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={DEFAULT}>
                              Default ({paramValueLabel(p, p.default)})
                            </SelectItem>
                            {(p.options ?? []).map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  }
                  return (
                    <div key={p.name} className="grid grid-cols-[120px_1fr] items-center gap-2">
                      <Label className="text-xs">{label}</Label>
                      <Input
                        type={p.control === "number" || p.control === "slider" ? "number" : "text"}
                        value={v}
                        placeholder={`Default: ${p.default}`}
                        aria-label={`${label} on a scheduled run`}
                        onChange={(e) => setValue(p.name, e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
                On
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={form.skip_empty} onCheckedChange={(v) => set({ skip_empty: v })} />
                Skip when every query is empty
              </label>
            </div>

            {formError && (
              <p
                role="alert"
                data-testid="report-schedule-error"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive"
              >
                {formError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" disabled={busy !== null} onClick={() => void save()}>
                {busy === "save" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save schedule
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void preview()}
              >
                {busy === "preview" ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Eye className="mr-1 h-3.5 w-3.5" />
                )}
                Preview PDF
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
