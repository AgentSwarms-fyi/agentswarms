// Scheduled report delivery: the rules, without the I/O (R509).
//
// A schedule says when a report runs (daily, on weekdays, weekly or monthly,
// at an hour in a time zone), who it goes to, and what its parameters are.
// Everything here is pure so that the scheduler, the "send now" button and
// the dialog that edits a schedule all read the same rules, and the tests
// exercise them without a clock or a mail server.
//
// Three decisions shape it:
//
// - TIME IS LOCAL. "8 in the morning" is stored as the hour and the IANA
//   zone, and the next run is worked out in that zone every time. A UTC hour
//   drifts by an hour twice a year, which for a report that lands before a
//   meeting is the difference between useful and late.
// - DATES CAN BE RELATIVE. A monthly report is about LAST month; a fixed date
//   would send the same month forever. A date parameter can hold "@prev_month_start"
//   and the like, worked out on the day it runs, in the schedule's zone.
// - WHO IT GOES TO IS AN INSTANCE POLICY, checked when the schedule is saved
//   and again when it sends: accounts on this install, and any address in a
//   domain the operator listed in REPORT_EMAIL_DOMAINS ("*" for any).
import {
  isValidParamValue,
  paramValueLabel,
  type BiParamConfig,
  type BiParamValues,
} from "@/lib/biParams";

export type ReportCadence = "daily" | "weekdays" | "weekly" | "monthly";

export const REPORT_CADENCES: { value: ReportCadence; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Monday to Friday)" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
];

/**
 * The name a new schedule starts with: the report and when it goes, as a
 * list of schedules reads best ("Sales every Monday", "Sales at month end").
 * It follows the timing until the author types a name of their own.
 */
export function suggestedScheduleName(
  reportName: string,
  f: Pick<ReportScheduleFields, "cadence" | "weekday" | "month_day">,
): string {
  const base = reportName.trim() || "Report";
  const when =
    f.cadence === "daily"
      ? "every day"
      : f.cadence === "weekdays"
        ? "on weekdays"
        : f.cadence === "weekly"
          ? `every ${WEEKDAYS[f.weekday] ?? "week"}`
          : f.month_day === 0
            ? "at month end"
            : "every month";
  // The timing is the part that tells two schedules apart: keep it whole.
  return `${base.slice(0, SCHEDULE_NAME_MAX - when.length - 1)} ${when}`;
}

export const MAX_RECIPIENTS = 25;
export const MAX_SCHEDULES_PER_REPORT = 10;
/** The largest PDF sent as an attachment; most mail relays refuse more. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const SUBJECT_MAX = 200;
export const MESSAGE_MAX = 2000;
export const SCHEDULE_NAME_MAX = 120;

export type ReportScheduleFields = {
  name: string;
  enabled: boolean;
  cadence: ReportCadence;
  /** 0-23, in `timezone`. */
  at_hour: number;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekday: number;
  /** 1-28, or 0 for the last day of the month. Monthly only. */
  month_day: number;
  timezone: string;
  recipients: string[];
  subject: string;
  message: string;
  param_values: Record<string, string>;
  skip_empty: boolean;
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// ── Time zones ─────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
};

const partsFormat = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time at an instant, in a zone. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  let f = partsFormat.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      weekday: "short",
    });
    partsFormat.set(tz, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(at)) out[p.type] = p.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday);
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: wd < 0 ? 0 : wd,
  };
}

/**
 * The run's day and time as the schedule's zone reads them: "2026-11-18",
 * "08:00". A server's own locale and zone are nobody's: a 06:00 Tokyo run is
 * 21:00 the day before in UTC, and "11/18/2026" reads as a different day to
 * half the recipients. The subject, the file name and the PDF's {{date}} and
 * {{time}} all print these, so the three agree.
 */
export function runClock(at: Date, tz: string): { date: string; time: string } {
  const p = zonedParts(at, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${p.year}-${two(p.month)}-${two(p.day)}`,
    time: `${two(p.hour)}:${two(p.minute)}`,
  };
}

/** How far ahead of UTC a zone's clock is at an instant, in ms. */
function zoneOffset(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * The instant a zone's clock reads year-month-day hour:00. On the morning
 * the clocks go forward an hour that does not exist resolves to the first
 * hour that does; on the night they go back the earlier of the two is used.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const off1 = zoneOffset(new Date(guess), tz);
  let t = guess - off1;
  const off2 = zoneOffset(new Date(t), tz);
  if (off2 !== off1) {
    const t2 = guess - off2;
    // Prefer the candidate whose wall clock really reads the hour asked for.
    const p2 = zonedParts(new Date(t2), tz);
    t = p2.hour === hour ? t2 : Math.max(t, t2);
  }
  return new Date(t);
}

/** A calendar day stepped by n days (no zone: pure date arithmetic). */
function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

type When = Pick<
  ReportScheduleFields,
  "cadence" | "at_hour" | "weekday" | "month_day" | "timezone"
>;

function runsOn(s: When, y: number, m: number, d: number): boolean {
  const wd = weekdayOf(y, m, d);
  switch (s.cadence) {
    case "daily":
      return true;
    case "weekdays":
      return wd >= 1 && wd <= 5;
    case "weekly":
      return wd === s.weekday;
    case "monthly":
      return s.month_day === 0 ? d === daysInMonth(y, m) : d === s.month_day;
  }
}

/** The first run strictly after `from`. */
export function nextReportRun(s: When, from: Date): Date {
  const tz = isValidTimeZone(s.timezone) ? s.timezone : "UTC";
  const today = zonedParts(from, tz);
  for (let i = 0; i <= 400; i++) {
    const [y, m, d] = addDays(today.year, today.month, today.day, i);
    if (!runsOn(s, y, m, d)) continue;
    const t = zonedToUtc(y, m, d, s.at_hour, tz);
    if (t.getTime() > from.getTime()) return t;
  }
  // Unreachable for a valid schedule (every cadence runs within 31 days);
  // a day later is a safe answer for an invalid one.
  return new Date(from.getTime() + 86_400_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function hourLabel(h: number): string {
  return `${pad(h)}:00`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** "Every Monday at 08:00 (Europe/London)". */
export function cadenceLabel(s: When): string {
  const at = `at ${hourLabel(s.at_hour)} (${s.timezone})`;
  switch (s.cadence) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Every weekday ${at}`;
    case "weekly":
      return `Every ${WEEKDAYS[s.weekday] ?? "Monday"} ${at}`;
    case "monthly":
      return s.month_day === 0
        ? `On the last day of every month ${at}`
        : `On the ${ordinal(s.month_day)} of every month ${at}`;
  }
}

// ── Relative dates ─────────────────────────────────────────────────────────

/** Values a date parameter can hold on a schedule instead of a fixed day. */
export const RELATIVE_DATES: { value: string; label: string }[] = [
  { value: "@today", label: "The day it runs" },
  { value: "@yesterday", label: "The day before it runs" },
  { value: "@week_start", label: "Monday of this week" },
  { value: "@prev_week_start", label: "Monday of last week" },
  { value: "@prev_week_end", label: "Sunday of last week" },
  { value: "@month_start", label: "First day of this month" },
  { value: "@prev_month_start", label: "First day of last month" },
  { value: "@prev_month_end", label: "Last day of last month" },
  { value: "@quarter_start", label: "First day of this quarter" },
  { value: "@prev_quarter_start", label: "First day of last quarter" },
  { value: "@prev_quarter_end", label: "Last day of last quarter" },
  { value: "@year_start", label: "1 January this year" },
  { value: "@prev_year_start", label: "1 January last year" },
  { value: "@prev_year_end", label: "31 December last year" },
];

const RELATIVE = new Set(RELATIVE_DATES.map((r) => r.value));

export function isRelativeDate(v: string): boolean {
  return RELATIVE.has(v);
}

const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** A relative date as the ISO day it means on `today` (a calendar day). */
export function resolveRelativeDate(
  token: string,
  today: { year: number; month: number; day: number },
): string | null {
  const { year: y, month: m, day: d } = today;
  const wd = weekdayOf(y, m, d);
  const mondayBack = (wd + 6) % 7;
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  switch (token) {
    case "@today":
      return iso(y, m, d);
    case "@yesterday":
      return iso(...addDays(y, m, d, -1));
    case "@week_start":
      return iso(...addDays(y, m, d, -mondayBack));
    case "@prev_week_start":
      return iso(...addDays(y, m, d, -mondayBack - 7));
    case "@prev_week_end":
      return iso(...addDays(y, m, d, -mondayBack - 1));
    case "@month_start":
      return iso(y, m, 1);
    case "@prev_month_start":
      return m === 1 ? iso(y - 1, 12, 1) : iso(y, m - 1, 1);
    case "@prev_month_end":
      return iso(...addDays(y, m, 1, -1));
    case "@quarter_start":
      return iso(y, q0, 1);
    case "@prev_quarter_start":
      return q0 === 1 ? iso(y - 1, 10, 1) : iso(y, q0 - 3, 1);
    case "@prev_quarter_end":
      return iso(...addDays(y, q0, 1, -1));
    case "@year_start":
      return iso(y, 1, 1);
    case "@prev_year_start":
      return iso(y - 1, 1, 1);
    case "@prev_year_end":
      return iso(y - 1, 12, 31);
    default:
      return null;
  }
}

/**
 * The values a scheduled run uses, and what had to be put back to a default.
 *
 * A stored value the report no longer accepts (an option removed, a parameter
 * renamed) falls back to the parameter's default, and the run SAYS so in its
 * delivery record: a report that quietly ran for other values than the
 * schedule names is a report someone acts on wrongly.
 */
export function scheduledValues(
  params: BiParamConfig[],
  stored: Record<string, string>,
  runAt: Date,
  tz: string,
): { values: BiParamValues; fellBack: string[] } {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const today = zonedParts(runAt, zone);
  const values: BiParamValues = {};
  const fellBack: string[] = [];
  for (const p of params) {
    const raw = stored[p.name];
    if (raw === undefined || raw === "") {
      values[p.name] = p.default;
      continue;
    }
    const v = p.control === "date" && isRelativeDate(raw) ? resolveRelativeDate(raw, today) : raw;
    if (v !== null && isValidParamValue(p, v)) {
      values[p.name] = v;
    } else {
      values[p.name] = p.default;
      fellBack.push(p.name);
    }
  }
  return { values, fellBack };
}

/** "Region: Europe · From: 2025-10-01", for the email and the delivery log. */
export function valuesSummary(params: BiParamConfig[], values: BiParamValues): string {
  return params
    .map((p) => `${p.label || p.name}: ${paramValueLabel(p, values[p.name] ?? p.default)}`)
    .join(" · ");
}

/** Only the stored values for parameters the report has, as strings. */
export function cleanStoredValues(
  params: BiParamConfig[],
  raw: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const v = raw?.[p.name];
    if (typeof v === "string" && v.length <= 500) out[p.name] = v;
  }
  return out;
}

// ── Recipients ─────────────────────────────────────────────────────────────

// One address, no display name, no list: what a person types into a box.
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** Addresses split on commas, semicolons and whitespace, cleaned and de-duplicated. */
export function parseRecipients(input: string | string[]): { valid: string[]; invalid: string[] } {
  const parts = (Array.isArray(input) ? input : input.split(/[\s,;]+/))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (p.length <= 254 && EMAIL.test(p)) {
      if (!valid.includes(p)) valid.push(p);
    } else if (!invalid.includes(p)) invalid.push(p);
  }
  return { valid, invalid };
}

/**
 * REPORT_EMAIL_DOMAINS as a predicate. "*" allows any address; otherwise each
 * comma-separated entry allows that exact domain, and an entry written
 * ".example.com" or "*.example.com" also allows its subdomains. Unset or
 * empty allows no domain at all, leaving only accounts on this install.
 */
export function domainPolicy(setting: string | undefined): (email: string) => boolean {
  const entries = (setting ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes("*")) return () => true;
  return (email: string) => {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return entries.some((e) => {
      if (e.startsWith("*.") || e.startsWith(".")) {
        const base = e.replace(/^\*?\./, "");
        return domain === base || domain.endsWith(`.${base}`);
      }
      return domain === e;
    });
  };
}

/** Which recipients may receive a report, given the accounts and the domains. */
export function recipientVerdict(
  recipients: string[],
  accounts: Set<string>,
  domainsSetting: string | undefined,
): { allowed: string[]; refused: string[] } {
  const inDomain = domainPolicy(domainsSetting);
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const r of recipients) {
    const e = r.toLowerCase();
    if (accounts.has(e) || inDomain(e)) allowed.push(e);
    else refused.push(e);
  }
  return { allowed, refused };
}

export function refusedRecipientsMessage(refused: string[]): string {
  return (
    `${refused.join(", ")} cannot receive reports from this install. A report can go to ` +
    "people with an account here, or to addresses in a domain the administrator lists in " +
    "REPORT_EMAIL_DOMAINS."
  );
}

// ── The schedule as saved ──────────────────────────────────────────────────

/** One line, no control characters: a subject can carry no extra header. */
export function cleanSubjectLine(s: string): string {
  // Matching control characters is the point of this one.
  // eslint-disable-next-line no-control-regex
  const controls = /[\r\n\t\u0000-\u001f\u007f]+/g;
  return s.replace(controls, " ").replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);
}

/**
 * What is wrong with a schedule, or null. Recipients are checked for shape
 * here; whether they may receive reports is the server's (recipientVerdict).
 */
export function validateSchedule(s: ReportScheduleFields): string | null {
  if (!s.name.trim()) return "Give the schedule a name.";
  if (s.name.length > SCHEDULE_NAME_MAX) {
    return `A schedule name is at most ${SCHEDULE_NAME_MAX} characters.`;
  }
  if (!REPORT_CADENCES.some((c) => c.value === s.cadence)) return "Choose how often it runs.";
  if (!Number.isInteger(s.at_hour) || s.at_hour < 0 || s.at_hour > 23) {
    return "Choose an hour between 00:00 and 23:00.";
  }
  if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return "Choose a weekday.";
  if (!Number.isInteger(s.month_day) || s.month_day < 0 || s.month_day > 28) {
    return "Choose a day of the month from 1 to 28, or the last day.";
  }
  if (!isValidTimeZone(s.timezone)) return `"${s.timezone}" is not a time zone.`;
  if (s.recipients.length === 0) return "Add at least one recipient.";
  if (s.recipients.length > MAX_RECIPIENTS) {
    return `A schedule sends to at most ${MAX_RECIPIENTS} addresses.`;
  }
  const { invalid } = parseRecipients(s.recipients);
  if (invalid.length) return `Not an email address: ${invalid.join(", ")}`;
  if (s.subject.length > SUBJECT_MAX) {
    return `A subject is at most ${SUBJECT_MAX} characters.`;
  }
  if (s.message.length > MESSAGE_MAX) {
    return `A message is at most ${MESSAGE_MAX} characters.`;
  }
  return null;
}

/** The subject a delivery goes out with: the schedule's, or the report's name. */
export function deliverySubject(
  subject: string,
  reportName: string,
  fill: (s: string) => string,
): string {
  const chosen = subject.trim() ? fill(subject) : reportName;
  return cleanSubjectLine(chosen) || "Scheduled report";
}

/** "Monthly sales 2025-11-01.pdf": the report's name and the run day. */
export function attachmentName(reportName: string, runDay: string): string {
  // Control characters are among what a file name must not carry.
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\\/:*?"<>|\u0000-\u001f]+/g;
  const base = reportName.replace(unsafe, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Report";
  return `${base} ${runDay}.pdf`;
}

/** A size people read: "312 KB", "1.4 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── What a scheduled PDF draws ─────────────────────────────────────────────

export type ScheduledDraw = "svg" | "table" | "text" | "kpi";

/**
 * How each visual is drawn in a scheduled PDF. Measured, not assumed: a test
 * renders every visual on the server and holds this table to what came back.
 */
export const SCHEDULED_DRAW: Partial<Record<string, ScheduledDraw>> = {
  kpi: "kpi",
  gauge: "svg",
  insight: "text",
  bar: "svg",
  hbar: "svg",
  scolumn: "svg",
  shbar: "svg",
  line: "svg",
  area: "svg",
  combo: "svg",
  scatter: "svg",
  pie: "svg",
  nightingale: "svg",
  radialbar: "svg",
  treemap: "svg",
  pareto: "svg",
  funnel: "svg",
  waterfall: "svg",
  heatmap: "table",
  matrix: "table",
  calendar: "svg",
  bump: "svg",
  sankey: "svg",
  radar: "svg",
  boxplot: "svg",
  map: "svg",
  bubblemap: "svg",
  journey: "svg",
};

/**
 * Why a visual is not in a scheduled PDF, or null when it is. Small
 * multiples and pictograms are many pictures sized by the card's CSS; the
 * point map is street tiles fetched by the viewer's browser; a bar race is
 * an animation; cards, the word cloud and range are laid out by the browser.
 */
export function scheduledDrawProblem(type: string | undefined): string | null {
  if (!type || type === "table") return null;
  return SCHEDULED_DRAW[type] ? null : "drawn in the app only";
}
