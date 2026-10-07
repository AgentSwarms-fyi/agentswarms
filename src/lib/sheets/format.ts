// Excel number formats: what a cell shows, and what TEXT() returns.
//
// Supported: General; digits with 0 # , . and grouping; percent; scientific;
// fractions (# ?/?, ?/8); currency and literal text ("..." and \x, [$€-2]);
// @ for text; up to four sections (positive;negative;zero;text), or sections
// chosen by conditions ([<10], [>=100]); dates and times in either case
// (yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm ss AM/PM) and durations
// ([h]:mm, [mm]:ss, [ss]). Colours ([Red]) are the cell's colour, not text.

import { formatGeneral, serialParts, type Scalar } from "./formula/values";

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

/** Split into sections on ";" outside quotes. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') q = !q;
    if (ch === "\\" && i + 1 < code.length) {
      cur += ch + code[i + 1];
      i++;
      continue;
    }
    if (ch === ";" && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const stripBrackets = (s: string) => s.replace(/\[[^\]]*\]/g, "");

/**
 * [$€-2], [$£-809], [$USD]: a currency tag, shown as its symbol; [$-409], a
 * locale alone, shows nothing. FOUND IN R163: they were dropped with the
 * other brackets, so a euro amount showed no €.
 */
const currencyTags = (s: string) =>
  s.replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, (_m, sym: string) => (sym ? `"${sym}"` : ""));

/** [h]:mm, [mm]:ss, [ss]: a duration counted in hours, minutes or seconds, past 24 and 60. */
const ELAPSED = /\[(h+|m+|s+)\]/i;

type Condition = { op: "<" | "<=" | ">" | ">=" | "=" | "<>"; v: number };

/** A section's condition, [<10] or [>=100], when it has one. */
function conditionOf(sec: string): Condition | undefined {
  const m = /\[(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)\]/.exec(sec.replace(/"[^"]*"/g, ""));
  return m ? { op: m[1] as Condition["op"], v: Number(m[2]) } : undefined;
}

function meets(n: number, c: Condition): boolean {
  switch (c.op) {
    case "<":
      return n < c.v;
    case "<=":
      return n <= c.v;
    case ">":
      return n > c.v;
    case ">=":
      return n >= c.v;
    case "=":
      return n === c.v;
    case "<>":
      return n !== c.v;
  }
}

/**
 * Which section formats a number, and whether it writes the number's sign
 * itself. Without conditions: positive;negative;zero. With them (R163), the
 * first section whose condition holds, a section without one taking the
 * rest; -1 when none applies. A section only for negatives ([<0]) writes no
 * minus, as the negative section does not.
 */
function sectionFor(v: number, secs: string[]): { i: number; ownSign: boolean } {
  const conds = secs.slice(0, 2).map(conditionOf);
  if (conds[0] || conds[1]) {
    let i = -1;
    if (conds[0] ? meets(v, conds[0]) : true) i = 0;
    else if (secs.length > 1 && (!conds[1] || meets(v, conds[1]))) i = 1;
    else if (secs.length > 2) i = 2;
    const c = i >= 0 && i < 2 ? conds[i] : undefined;
    const negativesOnly = !!c && (c.op === "<" || c.op === "<=") && c.v <= 0;
    // A section of text alone ("small") shows no number, so no minus either.
    const digits = i >= 0 && /[0#?]/.test(secs[i].replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g, ""));
    return { i, ownSign: v < 0 && (negativesOnly || !digits) };
  }
  if (v < 0 && secs.length >= 2) return { i: 1, ownSign: true };
  if (v === 0 && secs.length >= 3) return { i: 2, ownSign: false };
  return { i: 0, ownSign: false };
}

/** A calendar date or time format; a duration ([h]:mm) is a number of hours, not a date. */
export function isDateFormat(code: string): boolean {
  if (ELAPSED.test(code)) return false;
  const s = stripBrackets(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\\.|_.|\*./g, "");
  return /[ymdhs]/i.test(s) && !/[0#]/.test(s);
}

function formatDate(serial: number, code: string): string {
  const p = serialParts(serial);
  // Brackets go, but for a duration's [h], [mm], [ss].
  const s = code.replace(/\[(?!(?:h+|m+|s+)\])[^\]]*\]/gi, "");
  const ampm = /AM\/PM|A\/P/i.test(s);
  // A duration counts whole seconds from zero (R163).
  const secondsIn = Math.round(serial * 86400);
  let out = "";
  let i = 0;
  let lastWasHour = false;
  while (i < s.length) {
    const rest = s.slice(i);
    const ch = s[i];
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      out += s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    // _x is a space as wide as x; *x fills the cell with x, which is left
    // to the cell's width here (R163).
    if (ch === "_" || ch === "*") {
      if (ch === "_") out += " ";
      i += 2;
      continue;
    }
    if (ch === "\\") {
      out += s[i + 1] ?? "";
      i += 2;
      continue;
    }
    // FOUND IN R163: tokens were read in lower case only, so a file's
    // DD/MM/YYYY (LibreOffice writes them so) showed those letters for a date.
    const m =
      /^(\[h+\]|\[m+\]|\[s+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P)/i.exec(
        rest,
      );
    if (m) {
      const tok = m[1];
      const lower = tok.toLowerCase();
      const elapsed = /^\[(h+|m+|s+)\]$/.exec(lower);
      if (elapsed) {
        // FOUND IN R163: [h] was dropped as a bracket, so 36 hours showed ":12".
        const unit = elapsed[1];
        const total =
          unit[0] === "h"
            ? Math.floor(secondsIn / 3600)
            : unit[0] === "m"
              ? Math.floor(secondsIn / 60)
              : secondsIn;
        out += String(total).padStart(unit.length, "0");
        lastWasHour = unit[0] === "h";
        i += tok.length;
        continue;
      }
      // "mm" after an hour (or before seconds) means minutes.
      const minuteCtx = lastWasHour || /^m{1,2}:?s/i.test(rest.replace(/[^a-z:]/gi, ""));
      switch (lower) {
        case "yyyy":
          out += String(p.y).padStart(4, "0");
          break;
        case "yy":
          out += String(p.y % 100).padStart(2, "0");
          break;
        case "mmmmm":
          out += MONTHS[p.m - 1][0];
          break;
        case "mmmm":
          out += MONTHS[p.m - 1];
          break;
        case "mmm":
          out += MONTHS[p.m - 1].slice(0, 3);
          break;
        case "mm":
          out += minuteCtx ? String(p.mi).padStart(2, "0") : String(p.m).padStart(2, "0");
          break;
        case "m":
          out += minuteCtx ? String(p.mi) : String(p.m);
          break;
        case "dddd":
          out += DAYS[p.dow];
          break;
        case "ddd":
          out += DAYS[p.dow].slice(0, 3);
          break;
        case "dd":
          out += String(p.d).padStart(2, "0");
          break;
        case "d":
          out += String(p.d);
          break;
        case "hh":
        case "h": {
          let h = p.h;
          if (ampm) h = h % 12 === 0 ? 12 : h % 12;
          out += lower === "hh" ? String(h).padStart(2, "0") : String(h);
          break;
        }
        case "ss":
          out += String(p.s).padStart(2, "0");
          break;
        case "s":
          out += String(p.s);
          break;
        case "am/pm":
          out += p.h < 12 ? (tok === "am/pm" ? "am" : "AM") : tok === "am/pm" ? "pm" : "PM";
          break;
        case "a/p":
          out += p.h < 12 ? "A" : "P";
          break;
      }
      lastWasHour = lower === "hh" || lower === "h";
      i += tok.length;
      continue;
    }
    if (ch !== ":" && ch !== " ") lastWasHour = false;
    out += ch;
    i++;
  }
  return out;
}

function formatNumberSection(n: number, code: string): string {
  let s = stripBrackets(code);
  // Literal text and escapes are kept aside so digit placeholders are not
  // confused by them. The marker holds no digit, or the scan for 0/# below
  // would find one inside it.
  const lits: string[] = [];
  const mark = (t: string) => {
    lits.push(t);
    return `${String.fromCharCode(0xe100 + lits.length - 1)}`;
  };
  s = s.replace(/"([^"]*)"/g, (_m, t: string) => mark(t));
  // \x is x; _x a space as wide as x; *x a fill to the cell's width, left to
  // the cell here. FOUND IN R163: _ and * were printed, so Excel's Accounting
  // format showed "_($* 1,234.50_)" and #,##0_) "1,235_)".
  s = s.replace(/\\(.)|_(.)|\*(.)/g, (_m, esc?: string, space?: string) =>
    mark(esc !== undefined ? esc : space !== undefined ? " " : ""),
  );
  const restore = (t: string) =>
    t.replace(/([-])/g, (_m, k: string) => lits[k.charCodeAt(0) - 0xe100]);

  if (!/[0#?]/.test(s)) return restore(s); // pure literal section

  const fraction = formatFraction(n, s);
  if (fraction !== null) return restore(fraction);

  let v = n;
  const pct = (s.match(/%/g) ?? []).length;
  for (let k = 0; k < pct; k++) v *= 100;

  const sci = /[eE][+-]/.exec(s);
  const firstPh = s.search(/[0#?.,]/);
  let lastPh = -1;
  for (let k = s.length - 1; k >= 0; k--) {
    if (/[0#?]/.test(s[k])) {
      lastPh = k;
      break;
    }
  }
  if (sci) {
    const e = s.slice(sci.index);
    const expDigits = (/[+-](0+)/.exec(e)?.[1] ?? "0").length;
    lastPh = sci.index + /[+-]0+/.exec(e)![0].length;
    const mant = s.slice(firstPh, sci.index);
    const dec = mant.split(".")[1]?.replace(/[^0#?]/g, "").length ?? 0;
    const [m, ex] = Math.abs(v).toExponential(dec).split("e");
    const expNum = Number(ex);
    const expStr = String(Math.abs(expNum)).padStart(expDigits, "0");
    const body = `${m}E${expNum < 0 ? "-" : "+"}${expStr}`;
    return restore(s.slice(0, firstPh) + body + s.slice(lastPh + 1));
  }

  // Trailing commas after the last digit placeholder scale by 1000 each.
  let pattern = s.slice(firstPh, lastPh + 1);
  const after = s.slice(lastPh + 1);
  const scaleCommas = /^,+/.exec(after)?.[0].length ?? 0;
  for (let k = 0; k < scaleCommas; k++) v /= 1000;
  const suffix = after.slice(scaleCommas);
  const prefix = s.slice(0, firstPh);

  const grouping = pattern.includes(",");
  pattern = pattern.replace(/,/g, "");
  const [intPat, decPat = ""] = pattern.split(".");
  const decPlaces = decPat.replace(/[^0#?]/g, "").length;
  const minDec = decPat.replace(/[^0]/g, "").length;
  const minInt = intPat.replace(/[^0]/g, "").length;

  const fixed = excelFixed(Math.abs(v), decPlaces);
  let [ip, dp = ""] = fixed.split(".");
  // Drop optional trailing decimals (#) down to the required ones (0).
  while (dp.length > minDec && dp.endsWith("0")) dp = dp.slice(0, -1);
  if (ip === "0" && minInt === 0) ip = "";
  ip = ip.padStart(minInt, "0");
  if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // A pattern with a decimal point always shows it, as Excel does ("0.##" on 5 is "5.").
  const body = pattern.includes(".") ? `${ip}.${dp}` : ip;
  return restore(prefix + body + suffix);
}

/**
 * `toFixed`, rounding the number Excel shows rather than the one stored.
 *
 * FOUND IN R199: 2.675 is stored as 2.67499999999999982…, so `toFixed(2)`
 * gave "2.67" for TEXT(2.675, "0.00") and for a cell formatted 0.00, while
 * ROUND(2.675, 2) on the same sheet, and Excel, said 2.68. Excel rounds the
 * 15 significant digits it keeps, so this does too: the decimal text of the
 * 15-digit value is scaled by a power of ten as text, which is exact.
 */
export function excelFixed(v: number, places: number): string {
  const r = excelRound(v, places, "half");
  if (!Number.isFinite(r) || r === 0) return r.toFixed(places);
  const [mantissa, exp] = Math.abs(r).toExponential(14).split("e");
  const e = Number(exp);
  // Up to 15 digits shown, toFixed writes them as they are.
  if (e + places < 15) return r.toFixed(places);
  // FOUND IN R201: past 15 digits toFixed wrote the binary's own digits
  // (TEXT(12345678901234567, "#,##0") was …234,568 where Excel shows
  // …234,600), and from 1E+21 an exponent, which "0" then read as 1
  // (TEXT(1.5E+21, "0") was "1"). Excel shows 15 digits and then zeros.
  const digits = mantissa.replace(".", "");
  const sign = r < 0 ? "-" : "";
  if (e < 0)
    return `${sign}0.${("0".repeat(-e - 1) + digits).padEnd(places, "0").slice(0, places)}`;
  const all = digits.padEnd(e + 1 + places, "0");
  const frac = all.slice(e + 1, e + 1 + places);
  return sign + all.slice(0, e + 1) + (places > 0 ? `.${frac}` : "");
}

/**
 * x rounded at d decimal places as Excel rounds: the 15 significant digits it
 * keeps are shifted by d as decimal text, which is exact, then rounded half
 * away from zero ("half"), away from zero ("up") or toward it ("down"), and
 * shifted back. ROUND, ROUNDUP, ROUNDDOWN, TRUNC and every number format use
 * it, and a table sheet's SQL does the same steps (sql/compile.ts,
 * excelRoundSql), so a grid and a table agree.
 *
 * FOUND IN R200: ROUND guarded float noise with an absolute 1e-9 after
 * scaling. A large amount's binary error is bigger than that, so
 * ROUND(12345678901.005, 2) was ….00 where Excel says ….01, and the guard
 * rounded 2.674999999999 up to 2.68. TRUNC had no guard: TRUNC(0.29, 2) was
 * 0.28, as 0.29 × 100 is 28.999999999999996.
 */
export function excelRound(x: number, d: number, mode: "half" | "up" | "down"): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const [mantissa, exp] = Math.abs(x).toExponential(14).split("e");
  const e = Number(exp);
  // At the 15th digit or past it, there is nothing left to round.
  if (e + d >= 14) return x;
  const scaled = Number(`${mantissa}e${e + d}`);
  const r =
    mode === "half"
      ? Math.floor(scaled + 0.5)
      : mode === "up"
        ? Math.ceil(scaled)
        : Math.floor(scaled);
  return Math.sign(x) * Number(`${r}e${-d}`);
}

/**
 * Excel's fractions (R163): # ?/? is 1 1/2, ?/? is 3/2, # ?/8 is 2 5/8. The
 * denominator is the nearest fraction with as many digits as the ?s allow,
 * or the one written. Null when the section is not a fraction.
 */
function formatFraction(n: number, s: string): string | null {
  const m = /^(.*?)(?:([#0?]+)(\s+))?([#0?]+)\/([#0?]+|[1-9]\d*)(.*)$/.exec(s);
  if (!m) return null;
  const [, pre, intPat, gap, numPat, denPat, post] = m;
  const a = Math.abs(n);
  let whole = intPat ? Math.trunc(a) : 0;
  const frac = intPat ? a - whole : a;
  let num: number;
  let den: number;
  if (/^\d+$/.test(denPat)) {
    den = Number(denPat);
    num = Math.round(frac * den);
  } else {
    const maxDen = 10 ** denPat.length - 1;
    [num, den] = [Math.round(frac), 1];
    let best = Math.abs(frac - num);
    for (let d = 2; d <= maxDen && best > 1e-12; d++) {
      const k = Math.round(frac * d);
      const e = Math.abs(frac - k / d);
      if (e < best - 1e-12) [num, den, best] = [k, d, e];
    }
  }
  if (intPat && num === den) {
    whole += 1;
    num = 0;
  }
  // ? holds a space where a digit is not, 0 a zero, # nothing.
  const fill = (t: string, pat: string, left: boolean) => {
    const width = pat.length;
    if (t.length >= width) return t;
    const ch = pat.includes("0") ? "0" : pat.includes("?") ? " " : "";
    return left ? t.padStart(width, ch) : t.padEnd(width, ch);
  };
  const wholeText = intPat ? (whole === 0 && !intPat.includes("0") ? "" : String(whole)) : "";
  if (num === 0 && (intPat || a === 0)) {
    // A whole number: the fraction's place is left blank, as Excel does.
    const blank = " ".repeat(numPat.length + 1 + denPat.length);
    return pre + (wholeText || "0") + (intPat ? gap : "") + blank + post;
  }
  const numText = fill(String(num), numPat, true);
  const denText = /^\d+$/.test(denPat) ? denPat : fill(String(den), denPat, false);
  return pre + wholeText + (intPat ? gap : "") + `${numText}/${denText}` + post;
}

/**
 * A number in Excel's scientific form with k digits after the point,
 * 3.08E-04, rounded as Excel rounds: from its 15-digit decimal, so 1.5E-07
 * is 2E-07 where the double, a hair under it, would give 1E-07.
 */
function scientific(n: number, k: number): string {
  const [m, e] = Math.abs(n).toExponential(14).split("e");
  let mantissa = excelRound(Number(m), k, "half");
  let exp = Number(e);
  if (mantissa >= 10) {
    mantissa /= 10;
    exp += 1;
  }
  const body = k > 0 ? mantissa.toFixed(k).replace(/\.?0+$/, "") : String(mantissa);
  return `${n < 0 ? "-" : ""}${body}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/**
 * A General number in a column too narrow for it, as Excel shows one: with
 * fewer decimals while a digit that is not 0 is left, then in scientific
 * form with fewer digits, and null (####) only when nothing fits (R334).
 * FOUND IN R333: such a number showed #### at once, so CHISQ.TEST's
 * 0.000308192017 was ########## in a default-width column where Excel
 * shows 0.000308192. A number with a format of its own keeps ####, as in
 * Excel.
 */
export function generalToFit(n: number, fits: (text: string) => boolean): string | null {
  const full = formatGeneral(n);
  if (fits(full)) return full;
  if (!Number.isFinite(n)) return null;
  for (let d = 10; d >= 0; d--) {
    const r = excelRound(n, d, "half");
    if (r === 0) break;
    const s = formatGeneral(r);
    if (s.length < full.length && fits(s)) return s;
  }
  for (let k = 5; k >= 0; k--) {
    const s = scientific(n, k);
    if (fits(s)) return s;
  }
  return null;
}

/**
 * What a number cell too narrow for its text shows instead: a General one
 * rounded to fit, as above; one with a format of its own null, for ####.
 */
export function numberToFit(
  n: number,
  format: string | undefined,
  fits: (text: string) => boolean,
): string | null {
  return !format || format.trim().toLowerCase() === "general" ? generalToFit(n, fits) : null;
}

/** Format a value with an Excel format code. */
export function formatValue(v: Scalar, code?: string | null): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") return v.err;
  const fmt = (code ?? "").trim();
  if (typeof v === "string") {
    if (!fmt || fmt.toLowerCase() === "general") return v;
    const secs = sections(fmt);
    const textSec = secs.length >= 4 ? secs[3] : secs.find((x) => x.includes("@"));
    if (!textSec) return v;
    return textSec.replace(
      /"([^"]*)"|\\(.)|_(.)|\*(.)|@/g,
      (_m, q?: string, esc?: string, space?: string, fill?: string) =>
        q !== undefined
          ? q
          : esc !== undefined
            ? esc
            : space !== undefined
              ? " "
              : fill !== undefined
                ? ""
                : v,
    );
  }
  if (!fmt || fmt.toLowerCase() === "general") return formatGeneral(v);
  const secs = sections(fmt);
  const { i, ownSign } = sectionFor(v, secs);
  // No section for the number (every condition fails): Excel shows #s.
  if (i < 0) return "#".repeat(8);
  const sec = currencyTags(secs[i]);
  // The section that writes its own sign is given the number without it.
  const n = ownSign ? -v : v;
  if (isDateFormat(sec) || ELAPSED.test(sec)) {
    if (v < 0) return "#".repeat(8);
    return formatDate(v, sec);
  }
  const body = formatNumberSection(n, sec);
  return n < 0 && !/^-/.test(body) ? `-${body}` : body;
}

/** The formats offered in the toolbar, by name. */
export const PRESET_FORMATS: { label: string; code: string }[] = [
  { label: "General", code: "General" },
  { label: "Number", code: "#,##0.00" },
  { label: "Integer", code: "#,##0" },
  { label: "Percent", code: "0.00%" },
  { label: "Currency", code: '"$"#,##0.00' },
  { label: "Scientific", code: "0.00E+00" },
  { label: "Date", code: "yyyy-mm-dd" },
  { label: "Date and time", code: "yyyy-mm-dd hh:mm" },
  { label: "Time", code: "hh:mm:ss" },
  { label: "Text", code: "@" },
];

/** Where the characters of a code are literal (inside "…", after \, inside […]). */
function literalMask(code: string): boolean[] {
  const mask = new Array<boolean>(code.length).fill(false);
  let q = false;
  let br = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (q) {
      mask[i] = true;
      if (ch === '"') q = false;
      continue;
    }
    if (br) {
      mask[i] = true;
      if (ch === "]") br = false;
      continue;
    }
    if (ch === '"') {
      q = true;
      mask[i] = true;
    } else if (ch === "[") {
      br = true;
      mask[i] = true;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      mask[i] = true;
      if (i + 1 < code.length) mask[++i] = true;
    }
  }
  return mask;
}

function adjustSection(sec: string, dir: 1 | -1): string {
  if (isDateFormat(sec) || sec.includes("@")) return sec;
  const mask = literalMask(sec);
  let last = -1;
  let dot = -1;
  for (let i = 0; i < sec.length; i++) {
    if (mask[i]) continue;
    // The exponent's digits are not decimal places.
    if (/[eE]/.test(sec[i]) && /[+-]/.test(sec[i + 1] ?? "")) break;
    if (/[0#?]/.test(sec[i])) last = i;
    else if (sec[i] === "." && dot < 0) dot = i;
  }
  if (last < 0) return sec;
  const decimalsEnd = last + 1;
  if (dir > 0) {
    return dot >= 0 && dot < decimalsEnd
      ? sec.slice(0, decimalsEnd) + "0" + sec.slice(decimalsEnd)
      : sec.slice(0, decimalsEnd) + ".0" + sec.slice(decimalsEnd);
  }
  if (dot < 0 || dot > last) return sec; // no decimals to remove
  // Drop the last decimal place; the point goes with the last one.
  const removeFrom = last - 1 === dot ? dot : last;
  return sec.slice(0, removeFrom) + sec.slice(last + 1);
}

/**
 * The format with one decimal place more or fewer, as Excel's Increase and
 * Decrease Decimal buttons change it. A cell in General starts from the
 * places it currently shows.
 */
export function adjustDecimals(
  code: string | undefined | null,
  dir: 1 | -1,
  sample?: Scalar,
): string {
  const fmt = (code ?? "").trim();
  if (!fmt || fmt.toLowerCase() === "general") {
    const shown = typeof sample === "number" ? formatGeneral(sample) : "0";
    const places = /\.(\d+)/.exec(shown)?.[1].length ?? 0;
    const next = Math.max(0, places + dir);
    return next ? `0.${"0".repeat(next)}` : "0";
  }
  return sections(fmt)
    .map((s) => adjustSection(s, dir))
    .join(";");
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000FF",
  cyan: "#00FFFF",
  green: "#00FF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  white: "#FFFFFF",
  yellow: "#FFFF00",
};
// Excel's legacy 56-color palette, for [Color1]…[Color56].
const INDEXED = [
  "#000000",
  "#FFFFFF",
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
  "#800000",
  "#008000",
  "#000080",
  "#808000",
  "#800080",
  "#008080",
  "#C0C0C0",
  "#808080",
  "#9999FF",
  "#993366",
  "#FFFFCC",
  "#CCFFFF",
  "#660066",
  "#FF8080",
  "#0066CC",
  "#CCCCFF",
  "#000080",
  "#FF00FF",
  "#FFFF00",
  "#00FFFF",
  "#800080",
  "#800000",
  "#008080",
  "#0000FF",
  "#00CCFF",
  "#CCFFFF",
  "#CCFFCC",
  "#FFFF99",
  "#99CCFF",
  "#FF99CC",
  "#CC99FF",
  "#FFCC99",
  "#3366FF",
  "#33CCCC",
  "#99CC00",
  "#FFCC00",
  "#FF9900",
  "#FF6600",
  "#666699",
  "#969696",
  "#003366",
  "#339966",
  "#003300",
  "#333300",
  "#993300",
  "#993366",
  "#333399",
  "#333333",
];

/**
 * The color a format paints a number in: [Red] in a negative section is how
 * an Excel sheet shows losses. Undefined when the section names none.
 */
export function formatColor(v: Scalar, code: string | undefined | null): string | undefined {
  if (typeof v !== "number" || !code) return undefined;
  const secs = sections(code);
  const { i } = sectionFor(v, secs);
  if (i < 0) return undefined;
  for (const m of secs[i].matchAll(/\[([^\]]+)\]/g)) {
    const name = m[1].trim().toLowerCase();
    if (NAMED_COLORS[name]) return NAMED_COLORS[name];
    const idx = /^color\s*(\d{1,2})$/.exec(name);
    if (idx) return INDEXED[Number(idx[1]) - 1];
  }
  return undefined;
}
