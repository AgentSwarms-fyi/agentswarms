// Narrative widgets computed from a widget's own rows (R498).
//
//   "The top 3 suppliers by quantity are: …"
//   "Revenue for Nov 2026 increased by 44.4% (+$34.5M) from $77.8M to $112.3M."
//   "Units is forecast to be 543.6 for Mar 2027 (likely 498.1 to 589.2)."
//
// Every dashboard demo we studied leads with sentences like these, and they
// are worth more than prose a model writes once: they are ARITHMETIC over the
// rows the widget holds, so they are recomputed whenever a filter or a
// cross-filter changes those rows, and they cannot state a number the data
// does not contain. "AI insight" stays for the paragraph a person would
// write; this is the sentence a dashboard should never get wrong.
//
// Honesty rules, the same ones insightSweep and analystSeries keep:
//   • too little history gets a reason, not a weaker sentence;
//   • a missing comparison period is said to be missing, never swapped for
//     the nearest one that has data;
//   • a forecast is called a forecast and carries its range.
//
// Pure — no React, no engine, no model.
import { forecastValues } from "@/lib/mlForecast";
import { MIN_FORECAST_POINTS, readSeries, MIN_SERIES_POINTS } from "@/lib/analystSeries";
import { nextBucketLabel, type DateGrain } from "@/lib/biChartMath";
import type { BiInsightKind, BiMeasureIs, ChartSpec } from "@/lib/biAgent";
import { isPreAggregated, isRunningTotal } from "@/lib/biColumnKinds";
import { numericColumns } from "@/lib/biChartFields";
import {
  comparePeriods,
  comparisonLabel,
  dateLikeColumns,
  grainNoun,
  inferGrain,
  parsePeriodValue,
  periodSeries,
  prettyPeriod,
} from "@/lib/biPeriods";

export type InsightSpec = {
  kind: BiInsightKind;
  valueField: string;
  categoryField?: string;
  dateField?: string;
  topN?: number;
  periods?: number;
  label?: string;
  template?: string;
  lowerIsBetter?: boolean;
  dateGrain?: "auto" | DateGrain;
  /** top / bottom: what the measure is (R512); unset reads the column's name. */
  measureIs?: BiMeasureIs;
};

/** A run of sentence text. Tones: a number to read, and good or bad news. */
export type InsightPart = { text: string; tone?: "strong" | "good" | "bad" };

export type InsightResult =
  | {
      ok: true;
      lead: InsightPart[];
      /** Ranked lines under the lead (top, bottom, movers). */
      items?: InsightPart[][];
      /** Every value the sentence used, for an author's own template. */
      tokens: Record<string, string>;
    }
  | { ok: false; reason: string };

export type InsightFormat = {
  /** Formats a value of the measure (currency, percent, compact…). */
  value: (n: number) => string;
  /** The measure is already a percentage, so a change is in points. */
  percentMeasure?: boolean;
  locale?: string;
};

export const INSIGHT_KINDS: { value: BiInsightKind; label: string; needs: string }[] = [
  { value: "top", label: "Top ranked", needs: "a category and a measure" },
  { value: "bottom", label: "Bottom ranked", needs: "a category and a measure" },
  { value: "change", label: "Period over period", needs: "a date and a measure" },
  { value: "forecast", label: "Forecast", needs: "a date and a measure, 8+ periods" },
  { value: "anomaly", label: "Anomaly", needs: "a date and a measure, 5+ periods" },
  { value: "growth", label: "Growth rate", needs: "a date and a measure" },
  { value: "movers", label: "Top movers", needs: "a category, a date and a measure" },
  { value: "figures", label: "Figures in a sentence", needs: "one or more numeric columns" },
];

/**
 * Every numeric column's total over the rows, formatted, keyed by the column
 * name lower-cased — the tokens of a "figures" sentence (R501): "About
 * {{rides}} rides, {{electric}} of them on electric bikes".
 */
function figureTokens(
  rows: Record<string, unknown>[],
  f: InsightFormat,
): { tokens: Record<string, string>; names: string[] } {
  const sums = new Map<string, number>();
  const order: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    for (const [k, v] of Object.entries(r)) {
      const n = toNumber(v);
      if (n === null) continue;
      const key = k.toLowerCase();
      if (!sums.has(key)) order.push(key);
      sums.set(key, (sums.get(key) ?? 0) + n);
    }
  }
  const tokens: Record<string, string> = { rows: rows.length.toLocaleString(f.locale) };
  for (const k of order) tokens[k] = f.value(sums.get(k)!);
  return { tokens, names: order };
}

function figures(rows: Record<string, unknown>[], f: InsightFormat, measure: string): Internal {
  const { tokens, names } = figureTokens(rows, f);
  if (names.length === 0) return { ok: false, reason: "The query returns no numbers to state." };
  return {
    ok: true,
    // Without the author's own sentence: each figure named, in column order.
    lead: names.flatMap((k, i) => [
      { text: `${i === 0 ? "" : ", "}${i === 0 ? measure : humanizeField(k)} ` },
      { text: tokens[k], tone: "strong" as const },
    ]),
    tokens,
  };
}

/** "total_revenue" → "Total revenue". */
export function humanizeField(field: string): string {
  const s = field
    .replace(/[_\s]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : field;
}

/** Plural of a lower-cased noun phrase, for "the top 3 regions". */
export function pluralize(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * A fraction as a percentage: "19.5%", "4.0%", "200%" — one decimal below
 * 100%, exactly as the KPI tile prints it. FOUND IN R498's UI test: the tile
 * read "▼ 19.5%" while the sentence beside it said "decreased by 19%", one
 * number shown two ways on the same dashboard.
 */
const pctText = (p: number) => {
  const a = Math.abs(p) * 100;
  return `${a.toFixed(a >= 100 ? 0 : 1)}%`;
};

/** Signed change in the measure's own format ("+$1.2M", "−4 pts"). */
function signedChange(n: number, f: InsightFormat): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  if (f.percentMeasure) {
    const pts = Math.abs(n);
    return `${sign}${Number(pts.toFixed(2)).toLocaleString(f.locale)} pts`;
  }
  return `${sign}${f.value(Math.abs(n))}`;
}

/** Good or bad news: rising is good unless the measure is a cost. */
function toneFor(change: number, lowerIsBetter?: boolean): InsightPart["tone"] {
  if (change === 0) return "strong";
  return change > 0 !== Boolean(lowerIsBetter) ? "good" : "bad";
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * What a ranked narrative's measure is (R512): the spec's word, else its
 * column's name — a running total, an average or rate, or something to add up.
 * The Grand Prix points race ranked drivers by the SUM of their running points
 * over twenty rounds; a column of averages was summed the same way.
 */
export function measureKindFor(spec: InsightSpec, f: InsightFormat): BiMeasureIs {
  if (spec.measureIs) return spec.measureIs;
  if (isRunningTotal(spec.valueField)) return "running";
  if (isPreAggregated(spec.valueField) || f.percentMeasure) return "average";
  return "sum";
}

/**
 * The measure per category, first-seen order kept for ties: added up, the
 * latest row's value of a running total (rows in their query's order), or the
 * average of an average.
 */
function totalsByCategory(
  rows: Record<string, unknown>[],
  categoryField: string,
  valueField: string,
  kind: BiMeasureIs = "sum",
): { label: string; value: number }[] {
  const acc = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    const v = toNumber(r?.[valueField]);
    if (v === null) continue;
    const raw = r?.[categoryField];
    const label = raw === null || raw === undefined || raw === "" ? "(blank)" : String(raw);
    const cur = acc.get(label) ?? { value: 0, count: 0 };
    acc.set(label, { value: kind === "running" ? v : cur.value + v, count: cur.count + 1 });
  }
  return [...acc.entries()].map(([label, a]) => ({
    label,
    value: kind === "average" ? a.value / a.count : a.value,
  }));
}

/** Fill {{tokens}} in an author's sentence; filled values read as numbers. */
export function renderTemplate(
  template: string,
  tokens: Record<string, string>,
  tones: Record<string, InsightPart["tone"]> = {},
): InsightPart[] {
  const parts: InsightPart[] = [];
  // Digits too (R501): a figures sentence names its columns, e.g. {{rides_2026}}.
  const re = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    const key = m[1].toLowerCase();
    if (key in tokens) parts.push({ text: tokens[key], tone: tones[key] ?? "strong" });
    // An unknown token stays visible as written, so the author can see it.
    else parts.push({ text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

/** The tokens each kind offers an author's template, with what they hold. */
export const INSIGHT_TOKENS: Record<BiInsightKind, { token: string; detail: string }[]> = {
  top: [
    { token: "n", detail: "How many are listed" },
    { token: "category", detail: "What is ranked, plural" },
    { token: "measure", detail: "The measure's name" },
    { token: "list", detail: "Every listed item with its value" },
    { token: "first", detail: "The first item" },
    { token: "first_value", detail: "The first item's value" },
    { token: "total", detail: "The measure across every item" },
  ],
  bottom: [],
  change: [
    { token: "measure", detail: "The measure's name" },
    { token: "period", detail: "The latest period" },
    { token: "previous_period", detail: "The period before it" },
    { token: "current", detail: "The latest value" },
    { token: "previous", detail: "The value before it" },
    { token: "change", detail: "The change, signed" },
    { token: "change_pct", detail: "The change in percent" },
    { token: "direction", detail: "increased, decreased or was unchanged" },
  ],
  forecast: [
    { token: "measure", detail: "The measure's name" },
    { token: "next_period", detail: "The period forecast" },
    { token: "forecast", detail: "The forecast value" },
    { token: "low", detail: "Low end of the likely range" },
    { token: "high", detail: "High end of the likely range" },
    { token: "method", detail: "How it was forecast" },
  ],
  anomaly: [
    { token: "measure", detail: "The measure's name" },
    { token: "period", detail: "The most recent unusual period" },
    { token: "value", detail: "Its value" },
    { token: "expected", detail: "The typical (median) value" },
    { token: "direction", detail: "higher or lower" },
    { token: "count", detail: "How many periods stand out" },
  ],
  growth: [
    { token: "measure", detail: "The measure's name" },
    { token: "periods", detail: "Periods the rate covers" },
    { token: "grain", detail: "month, quarter, year…" },
    { token: "rate", detail: "Compounded rate per period" },
    { token: "from", detail: "First value" },
    { token: "to", detail: "Last value" },
    { token: "from_period", detail: "First period" },
    { token: "to_period", detail: "Last period" },
  ],
  movers: [
    { token: "measure", detail: "The measure's name" },
    { token: "period", detail: "The latest period" },
    { token: "previous_period", detail: "The period before it" },
    { token: "list", detail: "Every mover with its change" },
    { token: "top", detail: "The biggest mover" },
    { token: "top_change_pct", detail: "Its change in percent" },
  ],
  figures: [
    { token: "<column>", detail: "Any numeric column's total, by its name" },
    { token: "rows", detail: "How many rows were added up" },
  ],
};
INSIGHT_TOKENS.bottom = INSIGHT_TOKENS.top;

/** Compute the sentence for a spec over these rows. */
export function computeInsight(
  spec: InsightSpec,
  rows: Record<string, unknown>[],
  f: InsightFormat,
): InsightResult {
  const data = Array.isArray(rows) ? rows : [];
  const measure = spec.label?.trim() || humanizeField(spec.valueField);
  const grainSel = spec.dateGrain ?? "auto";
  // A field the rows do not have is said to be missing. FOUND IN R498's UI
  // test: a narrative kept ranking by `country` after its query stopped
  // returning one, and every row fell into one "(blank)" member — "The top 1
  // country by sales is: (blank) $2.3M (100%)", stated as fact.
  if (data.length > 0) {
    const has = (f: string) => data.some((r) => r && Object.prototype.hasOwnProperty.call(r, f));
    const needed = [
      spec.valueField,
      ...(spec.kind === "top" || spec.kind === "bottom" || spec.kind === "movers"
        ? [spec.categoryField]
        : []),
      ...(spec.kind !== "top" && spec.kind !== "bottom" && spec.kind !== "figures"
        ? [spec.dateField]
        : []),
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    const missing = needed.filter((x) => !has(x));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `This query returns no ${missing.join(" or ")} column — pick one it returns.`,
      };
    }
  }
  const out = (() => {
    switch (spec.kind) {
      case "top":
      case "bottom":
        return ranked(spec, data, f, measure);
      case "movers":
        return movers(spec, data, f, measure, grainSel);
      case "figures":
        return figures(data, f, measure);
      default:
        return overTime(spec, data, f, measure, grainSel);
    }
  })();
  if (!out.ok || !spec.template?.trim()) return out;
  return {
    ...out,
    lead: renderTemplate(spec.template, out.tokens, out.tones),
    // An author who wrote their own sentence asked for that sentence; the
    // ranked list still follows it, because a template cannot loop.
    items: out.items,
  };
}

type Internal =
  | {
      ok: true;
      lead: InsightPart[];
      items?: InsightPart[][];
      tokens: Record<string, string>;
      tones?: Record<string, InsightPart["tone"]>;
    }
  | { ok: false; reason: string };

function ranked(
  spec: InsightSpec,
  rows: Record<string, unknown>[],
  f: InsightFormat,
  measure: string,
): Internal {
  if (!spec.categoryField) return { ok: false, reason: "Pick the column to rank." };
  const kind = measureKindFor(spec, f);
  const members = totalsByCategory(rows, spec.categoryField, spec.valueField, kind);
  if (members.length === 0) {
    return { ok: false, reason: `No ${spec.categoryField} has a number to rank.` };
  }
  const n = Math.max(1, Math.min(10, Math.round(spec.topN ?? 3)));
  const sorted = [...members].sort((a, b) =>
    spec.kind === "bottom" ? a.value - b.value : b.value - a.value,
  );
  const shown = sorted.slice(0, n);
  const sum = members.reduce((a, m) => a + m.value, 0);
  // Across every item: the sum, or for an average the average (R512).
  const total = kind === "average" ? sum / members.length : sum;
  // A share of a total that nets losses against profits is not a share, and
  // an average has no share of anything.
  const shares = kind !== "average" && members.every((m) => m.value >= 0) && total > 0;
  const singular = humanizeField(spec.categoryField).toLowerCase();
  const category = pluralize(singular);
  const word = spec.kind === "bottom" ? "bottom" : "top";
  const lead: InsightPart[] = [
    { text: `The ${word} ` },
    { text: String(shown.length), tone: "strong" },
    { text: ` ${shown.length === 1 ? singular : category} by ${measure.toLowerCase()}` },
    {
      text:
        members.length > shown.length
          ? ` (of ${members.length}) ${shown.length === 1 ? "is" : "are"}:`
          : ` ${shown.length === 1 ? "is" : "are"}:`,
    },
  ];
  const items = shown.map((m) => {
    const line: InsightPart[] = [
      { text: m.label, tone: "strong" },
      { text: ` ${f.value(m.value)}` },
    ];
    if (shares) line.push({ text: ` (${pctText(m.value / total)})` });
    return line;
  });
  return {
    ok: true,
    lead,
    items,
    tokens: {
      n: String(shown.length),
      category,
      measure,
      list: shown.map((m) => `${m.label} (${f.value(m.value)})`).join(", "),
      first: shown[0].label,
      first_value: f.value(shown[0].value),
      total: f.value(total),
    },
  };
}

function overTime(
  spec: InsightSpec,
  rows: Record<string, unknown>[],
  f: InsightFormat,
  measure: string,
  grainSel: "auto" | DateGrain,
): Internal {
  if (!spec.dateField) return { ok: false, reason: "Pick the date column." };
  const series = periodSeries(rows, spec.dateField, spec.valueField, grainSel);
  const pts = series.points;
  if (pts.length === 0) {
    return { ok: false, reason: `No row has both a ${spec.dateField} date and a number.` };
  }
  const p = (label: string | null | undefined) => prettyPeriod(label, f.locale);

  if (spec.kind === "change") {
    const cmp = comparePeriods(series, "previous")!;
    const period = p(cmp.current.label);
    const base: Record<string, string> = {
      measure,
      period,
      previous_period: p(cmp.previousLabel),
      current: f.value(cmp.current.value),
    };
    if (!cmp.previous || cmp.change === undefined) {
      return {
        ok: true,
        lead: [
          { text: `${measure} for ${period} was ` },
          { text: f.value(cmp.current.value), tone: "strong" },
          {
            text: cmp.previousLabel
              ? `. There is no ${p(cmp.previousLabel)} to compare it with.`
              : ".",
          },
        ],
        tokens: { ...base, previous: "—", change: "—", change_pct: "—", direction: "was" },
      };
    }
    const dir = cmp.change > 0 ? "increased" : cmp.change < 0 ? "decreased" : "was unchanged";
    const tone = toneFor(cmp.change, spec.lowerIsBetter);
    const change = signedChange(cmp.change, f);
    const pct =
      cmp.changePct === null || cmp.changePct === undefined ? null : pctText(cmp.changePct);
    const lead: InsightPart[] =
      cmp.change === 0
        ? [
            { text: `${measure} for ${period} was unchanged at ` },
            { text: f.value(cmp.current.value), tone: "strong" },
            { text: ` from ${p(cmp.previousLabel)}.` },
          ]
        : [
            { text: `${measure} for ${period} ${dir} by ` },
            { text: pct ?? change, tone },
            ...(pct ? [{ text: " (" }, { text: change, tone }, { text: ")" }] : []),
            { text: " from " },
            { text: f.value(cmp.previous.value), tone: "strong" },
            { text: " to " },
            { text: f.value(cmp.current.value), tone: "strong" },
            { text: "." },
          ];
    return {
      ok: true,
      lead,
      tokens: {
        ...base,
        previous: f.value(cmp.previous.value),
        change,
        change_pct: pct ?? "—",
        direction: dir,
      },
      tones: { change: tone, change_pct: tone },
    };
  }

  if (spec.kind === "forecast") {
    if (pts.length < MIN_FORECAST_POINTS) {
      return {
        ok: false,
        reason: `A forecast needs at least ${MIN_FORECAST_POINTS} periods; this has ${pts.length}.`,
      };
    }
    const last = pts[pts.length - 1];
    const fc = forecastValues(
      pts.map((x) => x.value),
      1,
      { labelHint: last.label },
    );
    const point = fc?.points[0];
    if (!fc || !point) return { ok: false, reason: "These values cannot be forecast." };
    const next = nextBucketLabel(last.label, 1);
    const nextText = next ? p(next) : `the next ${grainNoun(series.grain)}`;
    return {
      ok: true,
      lead: [
        { text: `${measure} is forecast to be ` },
        { text: f.value(point.value), tone: "strong" },
        { text: ` for ${nextText} (likely ` },
        { text: f.value(point.lo) },
        { text: " to " },
        { text: f.value(point.hi) },
        { text: `, by ${fc.fit.method}).` },
      ],
      tokens: {
        measure,
        next_period: nextText,
        forecast: f.value(point.value),
        low: f.value(point.lo),
        high: f.value(point.hi),
        method: fc.fit.method,
      },
    };
  }

  if (spec.kind === "anomaly") {
    const reading = readSeries(pts);
    if (!reading) {
      return {
        ok: false,
        reason: `Finding an anomaly needs at least ${MIN_SERIES_POINTS} periods; this has ${pts.length}.`,
      };
    }
    const latest = [...reading.anomalies].sort((a, b) => b.index - a.index)[0];
    if (!latest) {
      return {
        ok: true,
        lead: [
          { text: `No ${grainNoun(series.grain)} stands out: none of the ` },
          { text: String(pts.length), tone: "strong" },
          { text: ` is 3 or more deviations from the typical ${measure.toLowerCase()} of ` },
          { text: f.value(reading.median), tone: "strong" },
          { text: "." },
        ],
        tokens: {
          measure,
          period: "—",
          value: "—",
          expected: f.value(reading.median),
          direction: "—",
          count: "0",
        },
      };
    }
    const unusual = latest.direction === "high" ? "higher" : "lower";
    const tone = toneFor(latest.direction === "high" ? 1 : -1, spec.lowerIsBetter);
    return {
      ok: true,
      lead: [
        { text: `The most recent anomaly was ${p(latest.label)}: ${measure.toLowerCase()} was ` },
        { text: f.value(latest.value), tone },
        { text: `, ${unusual} than the typical ` },
        { text: f.value(reading.median), tone: "strong" },
        {
          text:
            reading.anomalies.length > 1
              ? `. ${reading.anomalies.length} periods stand out in all.`
              : ".",
        },
      ],
      tokens: {
        measure,
        period: p(latest.label),
        value: f.value(latest.value),
        expected: f.value(reading.median),
        direction: unusual,
        count: String(reading.anomalies.length),
      },
      tones: { value: tone },
    };
  }

  // growth
  if (pts.length < 2) {
    return { ok: false, reason: "A growth rate needs at least 2 periods." };
  }
  const n = Math.max(1, Math.min(pts.length - 1, Math.round(spec.periods ?? pts.length - 1)));
  const from = pts[pts.length - 1 - n];
  const to = pts[pts.length - 1];
  if (!(from.value > 0 && to.value > 0)) {
    return {
      ok: false,
      reason: "A compounded growth rate needs a positive value at both ends of the range.",
    };
  }
  const rate = Math.pow(to.value / from.value, 1 / n) - 1;
  const tone = toneFor(rate, spec.lowerIsBetter);
  const rateText = `${rate < 0 ? "−" : ""}${pctText(rate)}`;
  return {
    ok: true,
    lead: [
      {
        text: `The ${n}-${grainNoun(series.grain)} compounded growth rate for ${measure.toLowerCase()} is `,
      },
      { text: rateText, tone },
      { text: ` per ${grainNoun(series.grain)}, from ` },
      { text: f.value(from.value), tone: "strong" },
      { text: ` in ${p(from.label)} to ` },
      { text: f.value(to.value), tone: "strong" },
      { text: ` in ${p(to.label)}.` },
    ],
    tokens: {
      measure,
      periods: String(n),
      grain: grainNoun(series.grain),
      rate: rateText,
      from: f.value(from.value),
      to: f.value(to.value),
      from_period: p(from.label),
      to_period: p(to.label),
    },
    tones: { rate: tone },
  };
}

function movers(
  spec: InsightSpec,
  rows: Record<string, unknown>[],
  f: InsightFormat,
  measure: string,
  grainSel: "auto" | DateGrain,
): Internal {
  if (!spec.categoryField) return { ok: false, reason: "Pick the column whose members move." };
  if (!spec.dateField) return { ok: false, reason: "Pick the date column." };
  const dateField = spec.dateField;
  const categoryField = spec.categoryField;
  // One grain for every member, read from all the rows: per member it could
  // differ, and "this month vs last" must mean the same months for each.
  const dates = rows
    .map((r) => parsePeriodValue(r?.[dateField]))
    .filter((d): d is Date => d !== null);
  if (dates.length === 0) return { ok: false, reason: `No row has a ${dateField} date.` };
  const grain = grainSel === "auto" ? inferGrain(dates) : grainSel;
  const byMember = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const raw = r?.[categoryField];
    const key = raw === null || raw === undefined || raw === "" ? "(blank)" : String(raw);
    const list = byMember.get(key);
    if (list) list.push(r);
    else byMember.set(key, [r]);
  }
  const all = periodSeries(rows, dateField, spec.valueField, grain);
  const latest = all.points[all.points.length - 1]?.label;
  if (!latest) return { ok: false, reason: "No row has both a date and a number." };
  const prevLabel = comparisonLabel(latest, grain, "previous");
  const moves: { label: string; cur: number; prev: number; change: number; pct: number | null }[] =
    [];
  for (const [label, list] of byMember) {
    const s = periodSeries(list, dateField, spec.valueField, grain).points;
    const cur = s.find((x) => x.label === latest)?.value ?? 0;
    const prev = s.find((x) => x.label === prevLabel)?.value ?? 0;
    if (cur === 0 && prev === 0) continue;
    const change = cur - prev;
    moves.push({ label, cur, prev, change, pct: prev === 0 ? null : change / Math.abs(prev) });
  }
  if (moves.length === 0) {
    return {
      ok: false,
      reason: `Nothing has a value in ${prettyPeriod(latest, f.locale)} or the period before it.`,
    };
  }
  const n = Math.max(1, Math.min(10, Math.round(spec.topN ?? 3)));
  const shown = moves
    .filter((m) => m.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, n);
  const period = prettyPeriod(latest, f.locale);
  const previous = prettyPeriod(prevLabel, f.locale);
  if (shown.length === 0) {
    return {
      ok: true,
      lead: [
        {
          text: `No ${humanizeField(categoryField).toLowerCase()} changed between ${previous} and ${period}.`,
        },
      ],
      tokens: {
        measure,
        period,
        previous_period: previous,
        list: "—",
        top: "—",
        top_change_pct: "—",
      },
    };
  }
  const describe = (m: (typeof shown)[number]) =>
    m.pct === null
      ? `new, ${signedChange(m.change, f)}`
      : `${m.change < 0 ? "−" : "+"}${pctText(m.pct)} (${signedChange(m.change, f)})`;
  return {
    ok: true,
    lead: [
      { text: `Biggest changes in ${measure.toLowerCase()}, ` },
      { text: period, tone: "strong" },
      { text: ` against ${previous}:` },
    ],
    items: shown.map((m) => {
      const tone = toneFor(m.change, spec.lowerIsBetter);
      return [
        { text: m.label, tone: "strong" },
        { text: ` ${m.change > 0 ? "▲" : "▼"} ` },
        { text: describe(m), tone },
        { text: `, to ${f.value(m.cur)}` },
      ];
    }),
    tokens: {
      measure,
      period,
      previous_period: previous,
      list: shown.map((m) => `${m.label} ${describe(m)}`).join(", "),
      top: shown[0].label,
      top_change_pct:
        shown[0].pct === null
          ? "new"
          : `${shown[0].change < 0 ? "−" : "+"}${pctText(shown[0].pct)}`,
    },
  };
}

// ── Suggestions for the visual being built (R499) ─────────────────────────

type InsightChart = Extract<ChartSpec, { type: "insight" }>;

export type NarrativeSuggestion = { spec: InsightChart; title: string; text: string };

/**
 * Numbers that are not amounts: a rank, a round, a sequence or an id. Summed,
 * they made sentences like "the top 3 given names by position are: George 3
 * (50.0%)" — FOUND IN R500's UI test on a standings table.
 */
const NOT_A_MEASURE =
  /^(id|.+_id|pos|position|.+_position|rank|ranking|.+_rank|round|lap|grid|seq|sequence|index|idx|no|number|.+_number|year)$/i;

/** Pictures, links and colours are columns of a row, not names for it. */
const NOT_A_LABEL = /^(data:|https?:\/\/|#[0-9a-f]{3,8}$)/i;

function isLabelColumn(col: string, rows: Record<string, unknown>[]): boolean {
  const vals = rows
    .slice(0, 20)
    .map((r) => r[col])
    .filter((v): v is string => typeof v === "string" && v !== "");
  return vals.length === 0 || !vals.every((v) => NOT_A_LABEL.test(v.trim()));
}

/** The narratives these rows support, best first, at most `max`. */
export function suggestNarratives(
  columns: string[],
  rows: Record<string, unknown>[],
  value: (n: number) => string,
  format: Pick<ChartSpec, "format" | "currency" | "decimals"> = {},
  max = 3,
  /** The visual's own measure and category, used first when they qualify. */
  prefer: { measure?: string; category?: string } = {},
): NarrativeSuggestion[] {
  if (!rows.length) return [];
  const dates = dateLikeColumns(columns, rows);
  const allNums = [...numericColumns(columns, rows)].filter((c) => !dates.includes(c));
  const nums = allNums.filter((c) => !NOT_A_MEASURE.test(c));
  const cats = columns.filter(
    (c) => !dates.includes(c) && !allNums.includes(c) && isLabelColumn(c, rows),
  );
  if (prefer.category && cats.includes(prefer.category)) {
    cats.splice(cats.indexOf(prefer.category), 1);
    cats.unshift(prefer.category);
  }
  const m = prefer.measure && nums.includes(prefer.measure) ? prefer.measure : nums[0];
  if (!m) return [];
  const plan: { kind: BiInsightKind; title: string; categoryField?: string; dateField?: string }[] =
    [];
  const name = humanizeField(m);
  if (dates[0]) {
    plan.push({ kind: "change", title: `${name} against the last period`, dateField: dates[0] });
    plan.push({ kind: "forecast", title: `${name} next period`, dateField: dates[0] });
    plan.push({ kind: "anomaly", title: `Unusual ${name.toLowerCase()}`, dateField: dates[0] });
    if (cats[0]) {
      plan.push({
        kind: "movers",
        title: `Biggest movers in ${name.toLowerCase()}`,
        dateField: dates[0],
        categoryField: cats[0],
      });
    }
  }
  if (cats[0]) {
    plan.push({
      kind: "top",
      title: `Top ${pluralize(humanizeField(cats[0]).toLowerCase())}`,
      categoryField: cats[0],
    });
    plan.push({
      kind: "bottom",
      title: `Bottom ${pluralize(humanizeField(cats[0]).toLowerCase())}`,
      categoryField: cats[0],
    });
  }
  // Only the number format is taken from the visual. FOUND IN R499's UI test:
  // the builder passed its whole chart spec here, the spread copied its
  // `type: "kpi"` over "insight", and an added narrative drew as a KPI tile.
  const fmt: Pick<ChartSpec, "format" | "currency" | "decimals"> = {};
  if (format.format) fmt.format = format.format;
  if (format.currency) fmt.currency = format.currency;
  if (format.decimals !== undefined) fmt.decimals = format.decimals;
  const out: NarrativeSuggestion[] = [];
  for (const p of plan) {
    const spec: InsightChart = {
      type: "insight",
      kind: p.kind,
      valueField: m,
      categoryField: p.categoryField,
      dateField: p.dateField,
      ...fmt,
    };
    const r = computeInsight(spec, rows, { value, percentMeasure: format.format === "percent" });
    if (!r.ok) continue;
    const text = [r.lead, ...(r.items ?? [])]
      .map((parts) => parts.map((x) => x.text).join(""))
      .join(" ");
    out.push({ spec, title: p.title, text });
    if (out.length >= max) break;
  }
  return out;
}
