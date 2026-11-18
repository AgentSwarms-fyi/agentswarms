// Dashboard parameters (R501): a value the viewer picks — a rider group,
// whether a map counts where rides started or ended, the first and last day of
// a period — that widget SQL reads as {{name}}.
//
// Why not a dashboard filter: a filter narrows a widget's rows AFTER its
// query, by a column the result still has. A station map grouped by station
// has no date column left to narrow, and its 480 rows are already the
// aggregate — the date has to go INTO the query, before it groups. A
// parameter does that: the widget's SQL says
//
//   WHERE ride_date BETWEEN {{date_from}} AND {{date_to}}
//
// and the query re-runs when the value changes.
//
// Safety: a value is never pasted into SQL as typed. It must be one of the
// owner's own options, or a real calendar date, and it goes in as a quoted
// literal ('member', DATE '2026-03-01'). A request carrying anything else gets
// the parameter's default instead. Definitions live with the dashboard's
// filters (the same saved list, as kind "param"), so they travel with every
// copy, version and promotion of the dashboard.

export type BiParamControl = "radio" | "dropdown" | "date" | "number" | "slider" | "text";
/** Controls that pick a number between a lowest and a highest value (R503). */
export const NUMBER_CONTROLS: readonly BiParamControl[] = ["number", "slider"];
export type BiParamOption = { value: string; label: string };

export type BiParamConfig = {
  id: string;
  kind: "param";
  /** What widget SQL writes as {{name}}. */
  name: string;
  label: string;
  control: BiParamControl;
  /** radio / dropdown: the values that may be picked. */
  options?: BiParamOption[];
  /**
   * number / slider (R503): the lowest and highest values and the step between
   * them. A number goes into SQL bare, so `LIMIT {{top_n}}` reads it.
   */
  min?: number;
  max?: number;
  step?: number;
  /** The value used until a viewer picks one, and by every refresh. */
  default: string;
  /** "bar" (default): in the filter bar. "canvas": only in a Controls visual. */
  placement?: "bar" | "canvas";
};

/** Picked values, by parameter name. */
export type BiParamValues = Record<string, string>;

export const PARAM_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OPTIONS = 50;
const MAX_VALUE = 200;
/** A plain decimal: digits, an optional minus and fraction. No exponent, no spaces. */
const PLAIN_NUMBER = /^-?\d{1,15}(\.\d{1,10})?$/;

function isNumberControl(c: BiParamControl): boolean {
  return NUMBER_CONTROLS.includes(c);
}

/** Whether n sits on the parameter's steps, counting from its lowest value. */
function onStep(n: number, min: number, step: number): boolean {
  const k = (n - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

function isIsoDay(v: string): boolean {
  if (!ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Free text (R508), for a report's own parameters only: an order number, a
 * customer's name. A report is run by its owner alone, so a typed value is no
 * wider than what the owner can already query; dashboards, which viewers
 * drive, never accept it (parseParams drops it unless asked). The value
 * reaches SQL only as a quoted literal, quotes doubled, like an option.
 */
function isPlainText(v: string): boolean {
  if (v.length > MAX_VALUE) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

/** Whether a value may be used for this parameter. */
export function isValidParamValue(p: BiParamConfig, v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (p.control === "text") return isPlainText(v);
  if (p.control === "date") return isIsoDay(v);
  if (isNumberControl(p.control)) {
    if (!PLAIN_NUMBER.test(v)) return false;
    const n = Number(v);
    const min = p.min ?? 0;
    const max = p.max ?? 100;
    return n >= min && n <= max && onStep(n, min, p.step ?? 1);
  }
  return (p.options ?? []).some((o) => o.value === v);
}

/**
 * The parameters in a dashboard's saved filter list; anything malformed is
 * left out. `allowText` admits the free-text control, which only a report's
 * parameters may use (R508).
 */
export function parseParams(v: unknown, opts: { allowText?: boolean } = {}): BiParamConfig[] {
  if (!Array.isArray(v)) return [];
  const out: BiParamConfig[] = [];
  const names = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.kind !== "param" || typeof r.id !== "string") continue;
    const name = typeof r.name === "string" ? r.name : "";
    if (!PARAM_NAME.test(name) || names.has(name)) continue;
    const control: BiParamControl =
      r.control === "radio" ||
      r.control === "date" ||
      r.control === "number" ||
      r.control === "slider"
        ? r.control
        : r.control === "text" && opts.allowText
          ? "text"
          : "dropdown";
    const choice = control === "radio" || control === "dropdown";
    const options = !choice
      ? undefined
      : (Array.isArray(r.options) ? r.options : [])
          .filter(
            (o): o is { value: string; label?: unknown } =>
              !!o &&
              typeof o === "object" &&
              typeof (o as { value?: unknown }).value === "string" &&
              (o as { value: string }).value.length <= MAX_VALUE,
          )
          .slice(0, MAX_OPTIONS)
          .map((o) => ({
            value: o.value,
            label: typeof o.label === "string" && o.label.trim() ? o.label : o.value,
          }));
    if (choice && (!options || options.length === 0)) continue;
    const p: BiParamConfig = {
      id: r.id,
      kind: "param",
      name,
      label: typeof r.label === "string" && r.label.trim() ? r.label : name,
      control,
      options,
      default: "",
      placement: r.placement === "canvas" ? "canvas" : "bar",
    };
    if (isNumberControl(control)) {
      const range = numberRange(r.min, r.max, r.step);
      if (!range) continue;
      Object.assign(p, range);
    }
    p.default = isValidParamValue(p, r.default)
      ? (r.default as string)
      : control === "text"
        ? ""
        : control === "date"
          ? new Date().toISOString().slice(0, 10)
          : isNumberControl(control)
            ? String(p.min)
            : options![0].value;
    names.add(name);
    out.push(p);
  }
  return out;
}

/**
 * A number parameter's lowest and highest values and step, or null when they
 * do not make a range: the lowest must be below the highest, the step above
 * zero and no wider than the range, and every one a plain finite number.
 */
export function numberRange(
  min: unknown,
  max: unknown,
  step: unknown,
): { min: number; max: number; step: number } | null {
  const num = (v: unknown, dflt: number) =>
    v === undefined || v === null || v === "" ? dflt : typeof v === "number" ? v : Number(v);
  const lo = num(min, 0);
  const hi = num(max, 100);
  const st = num(step, 1);
  if (![lo, hi, st].every((n) => Number.isFinite(n) && PLAIN_NUMBER.test(String(n)))) return null;
  if (!(lo < hi) || !(st > 0) || st > hi - lo) return null;
  return { min: lo, max: hi, step: st };
}

/** Every parameter at its default. */
export function defaultParamValues(params: BiParamConfig[]): BiParamValues {
  return Object.fromEntries(params.map((p) => [p.name, p.default]));
}

/**
 * The values to run with: each picked value that is valid for its parameter,
 * otherwise the default. Untrusted input (a request body) goes through here.
 */
export function resolveParamValues(params: BiParamConfig[], picked: unknown): BiParamValues {
  const src = picked && typeof picked === "object" ? (picked as Record<string, unknown>) : {};
  const out: BiParamValues = {};
  for (const p of params) {
    const v = Object.prototype.hasOwnProperty.call(src, p.name) ? src[p.name] : undefined;
    out[p.name] = isValidParamValue(p, v) ? v : p.default;
  }
  return out;
}

/**
 * A value as a SQL literal: DATE '2026-03-01', a bare number (10, 2.5), or a
 * quoted string. A number is written from the parsed value, never the text as
 * typed, so only digits, a minus and a point can reach the query.
 */
export function paramLiteral(p: BiParamConfig, v: string): string {
  const safe = isValidParamValue(p, v) ? v : p.default;
  if (p.control === "date") return `DATE '${safe}'`;
  if (isNumberControl(p.control)) {
    const n = Number(safe);
    // In brackets when negative: written after a minus (`x -{{n}}`), a bare
    // -5 would make `x --5`, and `--` comments out the rest of the line.
    return n < 0 ? `(${n})` : String(n);
  }
  return `'${safe.replace(/'/g, "''")}'`;
}

const PLACEHOLDER = /'?\{\{\s*([a-z][a-z0-9_]*)\s*\}\}'?/gi;

/** The parameter names a query mentions. */
export function paramNamesIn(sql: string | undefined): string[] {
  if (!sql) return [];
  const out = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER)) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * The query with each {{name}} of a known parameter replaced by its value as
 * a literal. A placeholder written inside quotes ('{{name}}') is replaced
 * whole, quotes included, so it cannot become a doubly quoted string.
 * Unknown names are left as written: the engine then reports them.
 */
export function substituteParams(
  sql: string,
  params: BiParamConfig[],
  values: BiParamValues,
): string {
  if (!params.length || !sql.includes("{{")) return sql;
  const byName = new Map(params.map((p) => [p.name, p]));
  return sql.replace(PLACEHOLDER, (whole, name: string) => {
    const p = byName.get(name.toLowerCase());
    if (!p) return whole;
    const lit = paramLiteral(p, values[p.name] ?? p.default);
    // A quote on only one side belongs to the surrounding SQL: keep it.
    const lead = whole.startsWith("'") && !whole.endsWith("'") ? "'" : "";
    const trail = whole.endsWith("'") && !whole.startsWith("'") ? "'" : "";
    return `${lead}${lit}${trail}`;
  });
}

/** Whether a query reads any of these parameters. */
export function usesParams(sql: string | undefined, params: BiParamConfig[]): boolean {
  if (!params.length) return false;
  const names = new Set(params.map((p) => p.name));
  return paramNamesIn(sql).some((n) => names.has(n));
}

/** True when every parameter the query reads is at its default. */
export function atDefaults(
  sql: string | undefined,
  params: BiParamConfig[],
  values: BiParamValues,
): boolean {
  const byName = new Map(params.map((p) => [p.name, p]));
  return paramNamesIn(sql).every((n) => {
    const p = byName.get(n);
    return !p || (values[n] ?? p.default) === p.default;
  });
}

/** The saved filter list: the dashboard's filters, then its parameters. */
export function joinFiltersColumn(filters: unknown[], params: BiParamConfig[]): unknown[] {
  return [...filters, ...params];
}

/** "member | Member" per line → options; a line without "|" is its own label. */
export function parseOptionLines(text: string): BiParamOption[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      const value = (i >= 0 ? l.slice(0, i) : l).trim();
      const label = (i >= 0 ? l.slice(i + 1) : "").trim() || value;
      return { value, label };
    })
    .filter((o) => o.value);
}

/** A value as a viewer reads it: the option's label, or the date or number. */
export function paramValueLabel(p: BiParamConfig, v: string): string {
  if (p.control === "date" || isNumberControl(p.control)) return v;
  return p.options?.find((o) => o.value === v)?.label ?? v;
}
