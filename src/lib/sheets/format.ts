// Excel number formats: what a cell shows, and what TEXT() returns.
//
// Supported: General; digits with 0 # , . and grouping; percent; scientific;
// currency and literal text ("..." and \x); @ for text; up to four sections
// (positive;negative;zero;text); dates and times (yyyy yy mmmm mmm mm m dddd
// ddd dd d hh h mm ss AM/PM). Colours and conditions ([Red], [>100]) are
// accepted and ignored, which is how a formula copied from Excel keeps working.

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

export function isDateFormat(code: string): boolean {
  const s = stripBrackets(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(s) && !/[0#]/.test(s);
}

function formatDate(serial: number, code: string): string {
  const p = serialParts(serial);
  const s = stripBrackets(code);
  const ampm = /AM\/PM|A\/P/i.test(s);
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
    if (ch === "\\") {
      out += s[i + 1] ?? "";
      i += 2;
      continue;
    }
    const m = /^(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|A\/P|a\/p)/.exec(
      rest,
    );
    if (m) {
      const tok = m[1];
      const lower = tok.toLowerCase();
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
  s = s.replace(/\\(.)/g, (_m, t: string) => mark(t));
  const restore = (t: string) =>
    t.replace(/([-])/g, (_m, k: string) => lits[k.charCodeAt(0) - 0xe100]);

  if (!/[0#?]/.test(s)) return restore(s); // pure literal section

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

  const fixed = Math.abs(v).toFixed(decPlaces);
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
    return textSec.replace(/"([^"]*)"/g, "$1").replace(/@/g, v);
  }
  if (!fmt || fmt.toLowerCase() === "general") return formatGeneral(v);
  const secs = sections(fmt);
  let sec = secs[0];
  let n = v;
  if (v < 0 && secs.length >= 2) {
    sec = secs[1];
    n = -v; // the negative section supplies its own sign
  } else if (v === 0 && secs.length >= 3) {
    sec = secs[2];
  }
  if (isDateFormat(sec)) {
    if (v < 0) return "#".repeat(8);
    return formatDate(v, sec);
  }
  const body = formatNumberSection(n, sec);
  return v < 0 && secs.length < 2 && !/^-/.test(body) ? `-${body}` : body;
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
