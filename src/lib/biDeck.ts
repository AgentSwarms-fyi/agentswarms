// Turning a BI dashboard into a PowerPoint deck.
//
// THE NUMBERS IN THE DECK ARE THE NUMBERS ON THE DASHBOARD. Every figure comes
// from the widget's own snapshot — the same `rows` the card renders — and is
// never re-queried and never authored by a model. A deck whose totals disagree
// with the dashboard it was exported from is worse than no deck at all: it is
// two sources of truth, and the one in the meeting room is the one people act
// on. The AI layer above this file writes prose (titles, takeaways) and is
// given the computed values as text it may quote; it never produces a figure.
//
// The other rule here is that a visual we cannot draw is SAID, not skipped.
// PowerPoint has no sankey, no geo map, no bar race. Silently dropping those
// widgets would hand someone a deck they believe is their dashboard while three
// charts are missing. Each one is either degraded to a table of the same data
// or withheld with the reason attached, and the dialog shows both.
//
// Pure module: no imports beyond types, so the mapping is testable without a
// browser, a database or pptxgenjs.
import type { ChartSpec } from "./biAgent";
import type { BiWidget } from "./biDashboards";
import type { DocChart, DocTable, PptxKpi, PptxPlan, PptxSlide } from "./docGen/types";

/**
 * Deck accent, as pptxgenjs wants it: hex, no leading "#".
 *
 * DERIVED, not picked: this is the app's own `--primary` token,
 * `oklch(0.52 0.12 205)`, converted once to sRGB. Choosing a colour by eye that
 * merely looked close would drift from the product the deck is exported from,
 * and the drift would only ever be visible side by side.
 */
export const AGENTSWARMS_ACCENT = "007B89";

/** How many data points a slide-sized chart can show before it turns to mush. */
export const MAX_CATEGORIES = 14;

/** Rows of a table slide. Beyond this the type is unreadable at 1080p. */
export const MAX_TABLE_ROWS = 12;

/** A widget that will become a slide, or one that cannot and why. */
export type DeckCandidate =
  | { widget: BiWidget; ok: true; slide: PptxSlide; note?: string }
  | { widget: BiWidget; ok: false; reason: string };

/**
 * Chart types this deck can draw, mapped from the dashboard's own vocabulary.
 *
 * `null` means "no direct equivalent" — the caller degrades to a table rather
 * than picking a lookalike. Rendering a sankey as a bar chart would be a
 * different claim about the data wearing the original's title.
 */
export function deckChartType(type: string): DocChart["type"] | null {
  switch (type) {
    // BI's "bar" is vertical; pptx calls that a column. Getting this backwards
    // transposes every category axis in the deck.
    case "bar":
    case "scolumn":
    case "waterfall":
    case "combo":
      return "column";
    case "hbar":
    case "shbar":
      return "bar";
    case "line":
      return "line";
    case "area":
      return "area";
    case "pie":
    case "nightingale":
      return "pie";
    case "treemap":
      return "doughnut";
    default:
      return null;
  }
}

/** Which field of a spec holds the category labels, if any. */
function categoryField(spec: ChartSpec): string | null {
  const s = spec as unknown as Record<string, string | undefined>;
  return s.xField ?? s.nameField ?? s.locationField ?? s.textField ?? null;
}

/** Which field holds the measure, if any. */
function valueField(spec: ChartSpec): string | null {
  const s = spec as unknown as Record<string, string | undefined>;
  return s.yField ?? s.valueField ?? s.barField ?? null;
}

/** A number from an arbitrary cell, or null when the cell is not numeric. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  }
  return null;
}

function label(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return String(v);
}

/**
 * Categories and series for a chart slide, straight off the widget's snapshot.
 *
 * Returns null when the snapshot cannot support the chart the widget declares —
 * a missing field, no rows, or no numeric column. The caller turns that into a
 * stated reason. It must NOT invent a zero: a bar of height zero is a claim
 * that the value is zero.
 */
export function seriesFromWidget(widget: BiWidget): {
  categories: string[];
  series: { name: string; values: number[] }[];
  truncated: boolean;
} | null {
  const spec = widget.chart;
  const rows = widget.rows;
  if (!spec || !Array.isArray(rows) || rows.length === 0) return null;

  const cat = categoryField(spec);
  const val = valueField(spec);
  if (!cat || !val) return null;
  if (!(cat in rows[0]) || !(val in rows[0])) return null;

  const splitField = (spec as unknown as { seriesField?: string }).seriesField;

  // Category order is the snapshot's order — the dashboard already sorted it,
  // and re-sorting here would silently disagree with the card beside it.
  const categories: string[] = [];
  for (const r of rows) {
    const c = label(r[cat]);
    if (!categories.includes(c)) categories.push(c);
  }
  const truncated = categories.length > MAX_CATEGORIES;
  const kept = truncated ? categories.slice(0, MAX_CATEGORIES) : categories;

  const seriesNames =
    splitField && splitField in rows[0]
      ? [...new Set(rows.map((r) => label(r[splitField])))]
      : [val];

  const series = seriesNames.map((name) => ({
    name,
    values: kept.map((c) => {
      const match = rows.find(
        (r) =>
          label(r[cat]) === c &&
          (!splitField || !(splitField in r) || label(r[splitField]) === name),
      );
      return match ? (num(match[val]) ?? 0) : 0;
    }),
  }));

  // Every series flat zero means nothing matched the way we read the snapshot.
  // Better to report the widget as un-chartable than to draw a flat line.
  if (series.every((s) => s.values.every((v) => v === 0))) return null;

  return { categories: kept, series, truncated };
}

/** A table slide's contents from the snapshot, capped for legibility. */
export function tableFromWidget(widget: BiWidget): DocTable | null {
  const rows = widget.rows;
  const cols = widget.columns?.length
    ? widget.columns
    : Array.isArray(rows) && rows.length
      ? Object.keys(rows[0])
      : [];
  if (!Array.isArray(rows) || rows.length === 0 || cols.length === 0) return null;
  return {
    columns: cols,
    rows: rows.slice(0, MAX_TABLE_ROWS).map((r) => cols.map((c) => label(r[c]))),
  };
}

/** The single headline figure of a KPI widget, formatted as the card shows it. */
export function kpiFromWidget(widget: BiWidget): PptxKpi | null {
  const spec = widget.chart;
  const rows = widget.rows;
  if (!spec || spec.type !== "kpi" || !Array.isArray(rows) || rows.length === 0) return null;
  const field = (spec as unknown as { valueField?: string }).valueField;
  if (!field) return null;
  const raw = rows[0][field];
  const n = num(raw);
  if (n === null) return null;
  return {
    label: (spec as unknown as { label?: string }).label || widget.title,
    value: formatCompact(n),
  };
}

/**
 * Compact number formatting, matching how a KPI card reads on screen.
 *
 * Deliberately plain: the widget's own currency/decimal formatting lives in the
 * renderer, and reaching into it from here would either duplicate that logic or
 * drift from it. A figure that reads 1.2M on the dashboard must not read
 * 1,203,481 in the deck and invite the question of which is right.
 */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/**
 * One widget → one slide, or a stated reason why not.
 *
 * The order of these branches is the order of preference: draw the chart the
 * widget declares; failing that show the same data as a table; failing that say
 * what is missing.
 */
export function widgetToSlide(widget: BiWidget): DeckCandidate {
  if (widget.kind === "text") {
    return { widget, ok: false, reason: "Text tiles carry no data to chart" };
  }
  if (widget.kind === "image") {
    return { widget, ok: false, reason: "Image tiles are not re-rendered into slides" };
  }
  const spec = widget.chart;
  if (!spec) return { widget, ok: false, reason: "This widget has no chart definition" };

  const hasRows = Array.isArray(widget.rows) && widget.rows.length > 0;
  if (!hasRows) {
    return {
      widget,
      ok: false,
      reason: "No saved data — refresh the dashboard, then export",
    };
  }

  if (spec.type === "kpi" || spec.type === "gauge") {
    const kpi = kpiFromWidget({ ...widget, chart: { ...spec, type: "kpi" } as ChartSpec });
    if (kpi)
      return { widget, ok: true, slide: { title: widget.title, layout: "kpi", kpis: [kpi] } };
    // fall through to a table rather than dropping it
  }

  const mapped = spec.type === "table" ? null : deckChartType(spec.type);
  if (mapped) {
    const data = seriesFromWidget(widget);
    if (data) {
      return {
        widget,
        ok: true,
        slide: {
          title: widget.title,
          layout: "chart",
          chart: { type: mapped, categories: data.categories, series: data.series },
        },
        note: data.truncated
          ? `Showing the first ${MAX_CATEGORIES} of ${widget.rows!.length} categories`
          : undefined,
      };
    }
  }

  const table = tableFromWidget(widget);
  if (table) {
    const total = widget.rows!.length;
    return {
      widget,
      ok: true,
      slide: { title: widget.title, layout: "table", table },
      note:
        mapped === null && spec.type !== "table"
          ? `PowerPoint has no ${spec.type} chart — shown as a table of the same data`
          : total > MAX_TABLE_ROWS
            ? `First ${MAX_TABLE_ROWS} of ${total} rows`
            : undefined,
    };
  }

  return { widget, ok: false, reason: "The saved data has no columns to show" };
}

/** Every widget assessed, in dashboard order, exportable or not. */
export function deckCandidates(widgets: BiWidget[]): DeckCandidate[] {
  return widgets.map(widgetToSlide);
}

/**
 * Assemble the deck.
 *
 * `narrative` is the model's contribution and is entirely optional — a failed
 * or skipped model call produces a clean, un-narrated deck rather than no deck.
 * Its takeaways are matched to slides BY WIDGET ID, not by position, so a
 * model that returns them out of order or omits one cannot caption a chart with
 * another chart's conclusion.
 */
export function buildDeckPlan(args: {
  dashboardName: string;
  dashboardDescription?: string | null;
  candidates: DeckCandidate[];
  narrative?: DeckNarrative | null;
}): PptxPlan {
  const included = args.candidates.filter((c): c is Extract<DeckCandidate, { ok: true }> => c.ok);

  const slides: PptxSlide[] = [];
  slides.push({
    title: args.narrative?.title?.trim() || args.dashboardName,
    layout: "cover",
    subtitle:
      args.narrative?.subtitle?.trim() ||
      args.dashboardDescription?.trim() ||
      "Exported from AgentSwarms BI",
  });

  if (args.narrative?.summary?.length) {
    slides.push({
      title: "Executive summary",
      layout: "bullets",
      bullets: args.narrative.summary.slice(0, 6),
    });
  }

  for (const c of included) {
    const written = args.narrative?.takeaways?.find((t) => t.widgetId === c.widget.id);
    slides.push({
      ...c.slide,
      // Supporting bullets sit BESIDE the visual — the builder switches to its
      // two-column layout the moment `bullets` is present. Without them a data
      // slide is a chart on a wall that leaves the audience to work out why it
      // is there. Only attached to slides that actually carry a visual; on a
      // KPI card the figure is already the whole point and a column of prose
      // beside it just crowds the number.
      bullets:
        written?.bullets?.length && (c.slide.chart || c.slide.table)
          ? written.bullets
          : c.slide.bullets,
      // The note is a fact about what the slide shows (a cap, a substitution)
      // and outranks the model's prose, which is why it wins the takeaway line
      // when both exist. A caption that omits "first 14 of 240" is a slide
      // presenting a sample as the whole.
      takeaway: c.note ?? written?.text,
    });
  }

  return {
    title: args.narrative?.title?.trim() || args.dashboardName,
    subtitle: args.dashboardDescription ?? undefined,
    accent: AGENTSWARMS_ACCENT,
    slides,
  };
}

/** What the model is allowed to contribute. Prose only — no figures. */
export type DeckNarrative = {
  title?: string;
  subtitle?: string;
  summary?: string[];
  /**
   * Per slide: one headline takeaway for the accent bar, and a few supporting
   * bullets that sit beside the visual.
   *
   * The bullets are what make a data slide a slide rather than a screenshot.
   * A chart alone asks the audience to work out why it is on the wall; the
   * bullets say what to look at. The builder switches to its two-column layout
   * (visual left, narrative right) the moment they are present.
   */
  takeaways?: { widgetId: string; text: string; bullets?: string[] }[];
};

/**
 * A compact, factual description of each slide for the model to write about.
 *
 * It receives the COMPUTED values, so its prose can be specific without it ever
 * doing arithmetic — the difference between "revenue peaked in March" (reading)
 * and "revenue grew 12%" (calculating, and frequently wrong).
 */
export function describeForNarrative(candidates: DeckCandidate[]): string {
  const lines: string[] = [];
  for (const c of candidates) {
    if (!c.ok) continue;
    const s = c.slide;
    if (s.chart?.categories && s.chart.series) {
      const pairs = s.chart.series
        .map(
          (ser) =>
            `${ser.name}: ${s.chart!.categories!.map((cat, i) => `${cat}=${ser.values[i]}`).join(", ")}`,
        )
        .join(" | ");
      lines.push(`[${c.widget.id}] "${s.title}" (${s.chart.type} chart) — ${pairs}`);
    } else if (s.kpis?.length) {
      lines.push(`[${c.widget.id}] "${s.title}" (metric) — ${s.kpis[0].label}: ${s.kpis[0].value}`);
    } else if (s.table) {
      lines.push(
        `[${c.widget.id}] "${s.title}" (table) — columns: ${s.table.columns.join(", ")}; ` +
          `${s.table.rows.length} row(s) shown`,
      );
    }
  }
  return lines.join("\n");
}
