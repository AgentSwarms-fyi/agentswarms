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
  const sec = v < 0 && secs.length >= 2 ? secs[1] : v === 0 && secs.length >= 3 ? secs[2] : secs[0];
  for (const m of sec.matchAll(/\[([^\]]+)\]/g)) {
    const name = m[1].trim().toLowerCase();
    if (NAMED_COLORS[name]) return NAMED_COLORS[name];
    const idx = /^color\s*(\d{1,2})$/.exec(name);
    if (idx) return INDEXED[Number(idx[1]) - 1];
  }
  return undefined;
}
