// Five-field cron (minute hour day-of-month month day-of-week), evaluated in
// an IANA timezone. Pure module — the scheduler computes next_run_at with it,
// the UI validates what the user typed, and the tests hammer it.
//
// Supported field syntax: "*", numbers, ranges (1-5), lists (1,3,5), steps
// (*/15, 2-10/2). Day-of-week 0-7 with both 0 and 7 meaning Sunday. Names are
// NOT supported ("MON", "JAN") — a validation error names the numeric form,
// which beats silently guessing at locale-dependent abbreviations.
//
// Matching semantics follow Vixie cron: when BOTH day-of-month and day-of-week
// are restricted, a time matches if EITHER matches (the historical OR rule).
//
// Timezone handling leans on Intl instead of a bundled zone database: the
// candidate instant is converted into wall-clock parts in the target zone and
// matched there. DST is therefore handled the way the platform handles it —
// a 02:30 job on a spring-forward day fires at the first instant the wall
// clock shows a matching time again, and repeated wall-times in autumn fire
// on their first occurrence.

export type CronField = { any: boolean; values: Set<number> };

export type CronSpec = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

const BOUNDS: Record<keyof CronSpec, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
};

function parseField(raw: string, name: keyof CronSpec): CronField {
  const [lo, hi] = BOUNDS[name];
  if (raw === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron ${name} field: "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Invalid cron step in ${name}: "${part}"`);
    let start = lo;
    let end = hi;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      start = a;
      end = b ?? (m[2] ? hi : a); // "5/10" means 5,15,25…; plain "5" means 5
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`Cron ${name} out of range (${lo}-${hi}): "${part}"`);
    }
    for (let v = start; v <= end; v += step) values.add(name === "dow" && v === 7 ? 0 : v);
  }
  return { any: false, values };
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("A cron expression needs 5 fields: minute hour day month weekday");
  }
  return {
    minute: parseField(fields[0], "minute"),
    hour: parseField(fields[1], "hour"),
    dom: parseField(fields[2], "dom"),
    month: parseField(fields[3], "month"),
    dow: parseField(fields[4], "dow"),
  };
}

/** Throws with a human-readable reason when invalid; returns normally when ok. */
export function validateCron(expr: string, timezone?: string | null): void {
  parseCron(expr);
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new Error(`Unknown timezone "${timezone}" — use an IANA name like Europe/Berlin`);
    }
  }
}

type WallClock = { minute: number; hour: number; dom: number; month: number; dow: number };

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      minute: "numeric",
      hour: "numeric",
      hour12: false,
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")) % 24, // Intl may render midnight as 24
    dom: Number(get("day")),
    month: Number(get("month")),
    dow: DOW[get("weekday")] ?? 0,
  };
}

function dayMatches(spec: CronSpec, w: WallClock): boolean {
  if (!(spec.month.any || spec.month.values.has(w.month))) return false;
  // Vixie OR rule for the two day fields.
  if (spec.dom.any && spec.dow.any) return true;
  if (spec.dom.any) return spec.dow.values.has(w.dow);
  if (spec.dow.any) return spec.dom.values.has(w.dom);
  return spec.dom.values.has(w.dom) || spec.dow.values.has(w.dow);
}

function matches(spec: CronSpec, w: WallClock): boolean {
  const hit = (f: CronField, v: number) => f.any || f.values.has(v);
  return hit(spec.minute, w.minute) && hit(spec.hour, w.hour) && dayMatches(spec, w);
}

const MINUTE_MS = 60_000;

/**
 * The next instant strictly after `from` matching the expression in the zone.
 *
 * Minute-by-minute scan, with two accelerations that keep it cheap without
 * risking correctness across odd UTC offsets (:30/:45 zones included): a
 * 15-minute stride while the wall-clock DATE cannot match, and an hour stride
 * while the date matches but the hour does not. Every candidate is re-checked
 * against its own wall clock, so a stride can never skip a match by more than
 * the stride width — and the fine scan resumes as soon as the coarse
 * condition changes. Bounded at 366 days: a spec that matches nothing inside
 * a year (e.g. "0 0 31 2 *") returns null rather than looping.
 */
export function nextCronOccurrence(
  expr: string,
  timezone?: string | null,
  from: Date = new Date(),
): Date | null {
  const spec = parseCron(expr);
  const tz = timezone || "UTC";
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = t + 366 * 86_400_000;
  const QUARTER = 15 * MINUTE_MS;
  while (t <= limit) {
    const w = wallClockIn(new Date(t), tz);
    if (matches(spec, w)) return new Date(t);
    if (!dayMatches(spec, w) || !(spec.hour.any || spec.hour.values.has(w.hour))) {
      // Wrong date or wrong hour: snap to the NEXT quarter-hour boundary.
      // Every real UTC offset is a multiple of 15 minutes, so wall-clock hour
      // and date transitions land exactly on these boundaries — a snapped
      // stride can therefore never hop over the first minute of a matching
      // hour, which an unsnapped "+15min from wherever we are" did.
      t = Math.floor(t / QUARTER) * QUARTER + QUARTER;
    } else {
      t += MINUTE_MS;
    }
  }
  return null;
}
