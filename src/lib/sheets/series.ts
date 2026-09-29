// What the fill handle continues, as Excel's AutoFill does (R165).
//
// A run of cells continues when it is a series: numbers with a step, dates
// by the day (or by the month, or the year, when that is how they go), the
// months and days of the week by name, quarters (Q1 to Q4, then Q1 again),
// and text ending in a number ("Item 9", "Item 10"). Anything else repeats.

import type { CellInput } from "./engine";
import { isDateFormat } from "./format";
import { dateSerial, parseDateText, parseTimeText, serialParts } from "./formula/values";

/** The k-th value after the source's last (k = 1, 2, …), as the input to write. */
export type Series = (k: number) => string;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A number series, if the values are one: [2, 4, 6] → step 2. */
function stepOf(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const step = nums[1] - nums[0];
  for (let i = 2; i < nums.length; i++) {
    if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) return null;
  }
  return step;
}

/** The same step around a cycle of `size` (a list, the quarters): [11, 0] in months is 1. */
function cycleStepOf(idx: number[], size: number): number | null {
  if (idx.length < 2) return 1;
  const step = (((idx[1] - idx[0]) % size) + size) % size;
  for (let i = 2; i < idx.length; i++) {
    if ((((idx[i] - idx[i - 1]) % size) + size) % size !== step) return null;
  }
  return step;
}

// ── Dates ──────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A cell's date or time: typed (2023-03-15, 15-Mar-2023, 9:00 AM), or a
 * number shown with a date or time format.
 */
function dateOf(c: CellInput): number | null {
  const t = c.i.trim();
  const n = Number(t);
  if (t !== "" && Number.isFinite(n)) return c.f && isDateFormat(c.f) ? n : null;
  return parseDateText(t) ?? parseTimeText(t);
}

/** A time of day with no date (9:00, or a number under 1 in a format with no day, month or year). */
function timeOnly(c: CellInput, serial: number): boolean {
  if (serial >= 1) return false;
  if (parseTimeText(c.i) !== null) return true;
  const f = (c.f ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
  return /[hs]/i.test(f) && !/[yd]/i.test(f) && !/m{3,}/i.test(f);
}

/** A serial as the source typed it: 2023-03-15 (with its time, if it had one), or the number. */
function dateInput(serial: number, like: CellInput): string {
  if (!ISO_DATE.test(like.i.trim())) return String(+serial.toFixed(10));
  const p = serialParts(serial);
  const day = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return /\d:\d{2}/.test(like.i) ? `${day} ${pad(p.h)}:${pad(p.mi)}` : day;
}

/** A month's length, for 31 January + 1 month = 28 February. */
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function dateSeries(src: CellInput[]): Series | null {
  const serials = src.map(dateOf);
  if (serials.some((s) => s === null)) return null;
  const s = serials as number[];
  const last = src[src.length - 1];
  const at = (serial: number) => dateInput(serial, last);
  // A time goes on by the hour (R166), a date by the day.
  if (s.length === 1) return (k) => at(s[0] + (timeOnly(src[0], s[0]) ? k / 24 : k));
  // By the month (or year) when every date is on the same day of its month:
  // 15 Jan, 15 Feb → 15 Mar, not the 18th (31 days on).
  const parts = s.map(serialParts);
  const sameDay = parts.every((p) => p.d === parts[0].d);
  const months = parts.map((p) => p.y * 12 + (p.m - 1));
  const monthStep = sameDay ? stepOf(months) : null;
  if (monthStep !== null && monthStep !== 0) {
    const p = parts[parts.length - 1];
    const lastMonth = months[months.length - 1];
    const time = s[s.length - 1] - Math.floor(s[s.length - 1]);
    return (k) => {
      const mm = lastMonth + monthStep * k;
      const y = Math.floor(mm / 12);
      const m = (mm % 12) + 1;
      return at(dateSerial(y, m, Math.min(p.d, daysIn(y, m))) + time);
    };
  }
  const step = stepOf(s);
  return step === null ? null : (k) => at(s[s.length - 1] + step * k);
}

// ── Lists: months and days of the week ─────────────────────────────────────

type ListItem = { list: string[]; i: number; short: boolean; style: "upper" | "lower" | "title" };

function listItem(t: string): ListItem | null {
  const low = t.trim().toLowerCase();
  if (!low) return null;
  for (const list of [MONTHS, DAYS]) {
    const i = list.findIndex((x) => x.toLowerCase() === low || x.slice(0, 3).toLowerCase() === low);
    if (i < 0) continue;
    const short = low.length === 3 && list[i].length > 3;
    const trimmed = t.trim();
    const style =
      trimmed === trimmed.toUpperCase() && trimmed.length > 1
        ? "upper"
        : trimmed === trimmed.toLowerCase()
          ? "lower"
          : "title";
    return { list, i, short, style };
  }
  return null;
}

function listSeries(src: CellInput[]): Series | null {
  const items = src.map((c) => listItem(c.i));
  if (items.some((x) => !x) || items.some((x) => x!.list !== items[0]!.list)) return null;
  const list = items[0]!.list;
  const step = cycleStepOf(
    items.map((x) => x!.i),
    list.length,
  );
  if (step === null) return null;
  const last = items[items.length - 1]!;
  return (k) => {
    const name = list[(last.i + step * k) % list.length];
    const word = last.short ? name.slice(0, 3) : name;
    return last.style === "upper"
      ? word.toUpperCase()
      : last.style === "lower"
        ? word.toLowerCase()
        : word;
  };
}

// ── Quarters ───────────────────────────────────────────────────────────────

const QUARTER = /^(Q|Qtr ?|Quarter )([1-4])$/i;

function quarterSeries(src: CellInput[]): Series | null {
  const ms = src.map((c) => QUARTER.exec(c.i.trim()));
  if (ms.some((m) => !m) || ms.some((m) => m![1] !== ms[0]![1])) return null;
  const step = cycleStepOf(
    ms.map((m) => Number(m![2]) - 1),
    4,
  );
  if (step === null) return null;
  const last = Number(ms[ms.length - 1]![2]) - 1;
  return (k) => `${ms[0]![1]}${((last + step * k) % 4) + 1}`;
}

// ── Numbers, and text ending in one ────────────────────────────────────────

const TEXT_NUM = /^(.*?)(\d+)$/;

const numbersOf = (src: CellInput[]) => src.map((c) => Number(c.i.replace(/,/g, "")));

/** Numbers with a step; one number alone repeats, as in Excel. */
function numberSeries(src: CellInput[]): Series | null {
  const nums = numbersOf(src);
  const step = stepOf(nums);
  return step === null ? null : (k) => String(+(nums[nums.length - 1] + step * k).toFixed(10));
}

function textNumberSeries(src: CellInput[]): Series | null {
  const ms = src.map((c) => TEXT_NUM.exec(c.i));
  if (ms.some((m) => !m) || ms.some((m) => m![1] !== ms[0]![1])) return null;
  const step = ms.length === 1 ? 1 : stepOf(ms.map((m) => Number(m![2])));
  if (step === null) return null;
  const lastNum = Number(ms[ms.length - 1]![2]);
  const width = ms[ms.length - 1]![2].length;
  return (k) => ms[0]![1] + String(lastNum + step * k).padStart(width, "0");
}

/**
 * The series a line of typed values continues (a column when filling down,
 * a row when filling right), or null when they repeat. Formulas are not
 * series: they shift.
 */
export function seriesOf(src: (CellInput | undefined)[]): Series | null {
  if (!src.length || !src.every((c) => c && c.i !== "" && !c.i.startsWith("="))) return null;
  const cells = src as CellInput[];
  // FOUND IN R165: a date typed as 2023-01-30 was continued as text ending
  // in a number, so the fill ran 31, then 2023-01-32; months and days of the
  // week repeated, and Q3 ran on to Q7.
  const dated = dateSeries(cells);
  if (dated) return dated;
  // Plain numbers are a number series or none: "5" is not text ending in 5.
  if (numbersOf(cells).every((n) => Number.isFinite(n))) return numberSeries(cells);
  return listSeries(cells) ?? quarterSeries(cells) ?? textNumberSeries(cells);
}
