// The builder's options for the visuals and styles added in R500 — cards,
// start → finish ranges, radial bars, rank over time — plus the colour
// column, end labels and shaded bands lines take, the heatmap's diverging
// scale and striped tables. Held in one object so the builder pane wires them
// with one state, one prefill and one call into the spec.
import type {
  BiChartAnalytics,
  BiLegendPlacement,
  BiPictogramIcon,
  ChartSpec,
} from "@/lib/biAgent";

export type VisualBand = { from: string; to: string; label: string };
/** A note as the builder holds it: the x value as typed, and its text (R505). */
export type VisualNote = { x: string; text: string };

/** Notes a chart draws at most, and the characters a note keeps (R505). */
export const MAX_NOTES = 10;
export const NOTE_CHARS = 80;

export type VisualOpts = {
  cardsLayout: "tiles" | "rows";
  imageField: string;
  iconFields: string[];
  heading: string;
  title: string;
  body: string;
  lead: string;
  value: string;
  max: string;
  categoryField: string;
  startField: string;
  endField: string;
  labelField: string;
  higherIsBetter: boolean;
  colorField: string;
  endLabels: boolean;
  bands: VisualBand[];
  heatScale: "sequential" | "diverging";
  striped: boolean;
  // R501: point map, pins on a road, controls.
  latField: string;
  lngField: string;
  sizeField: string;
  measureField: string;
  params: string[];
  intro: string;
  // R502: Pareto, calendar, small multiples, pictogram; line/bar options.
  dateField: string;
  splitField: string;
  smX: string;
  smY: string;
  smKind: "line" | "bar";
  icon: BiPictogramIcon;
  unit: string;
  maWindow: string;
  logScale: boolean;
  zoomBar: boolean;
  // R505: 100% stacks, the legend, notes, tiles coloured by a measure.
  percentStack: boolean;
  legend: BiLegendPlacement;
  notes: VisualNote[];
  colorMeasure: string;
  lowerIsBetter: boolean;
};

export const VISUAL_OPTS_DEFAULT: VisualOpts = {
  cardsLayout: "tiles",
  imageField: "",
  iconFields: [],
  heading: "",
  title: "",
  body: "",
  lead: "",
  value: "",
  max: "",
  categoryField: "",
  startField: "",
  endField: "",
  labelField: "",
  higherIsBetter: false,
  colorField: "",
  endLabels: false,
  bands: [],
  heatScale: "sequential",
  striped: false,
  latField: "",
  lngField: "",
  sizeField: "",
  measureField: "",
  params: [],
  intro: "",
  dateField: "",
  splitField: "",
  smX: "",
  smY: "",
  smKind: "line",
  icon: "person",
  unit: "",
  maWindow: "",
  logScale: false,
  zoomBar: false,
  percentStack: false,
  legend: "bottom",
  notes: [],
  colorMeasure: "",
  lowerIsBetter: false,
};

/** Visual types whose fields live in these options rather than the pane's. */
export const OPTS_VISUALS = new Set([
  "cards",
  "range",
  "pointmap",
  "journey",
  "controls",
  "pareto",
  "calendar",
  "smallmultiples",
  "pictogram",
]);
/** Types that need no query: they draw from their own spec (R501). */
export const NO_DATA_VISUALS = new Set(["controls"]);
/** Types that take a colour column (`colorField`); a treemap's tiles since R505. */
export const COLOR_FIELD_VISUALS = new Set(["line", "bump", "radialbar", "treemap"]);
/** Types that draw a legend, so it can be moved or hidden (R505). */
export const LEGEND_VISUALS = new Set([
  "bar",
  "scolumn",
  "shbar",
  "line",
  "area",
  "pie",
  "combo",
  "radar",
]);
/** Types that take notes pinned to an x value (R505). */
export const NOTE_VISUALS = new Set(["line", "area", "bar", "scolumn"]);

/**
 * Whether a chart's parts stack, so they can be shown as shares of 100%
 * (R505): stacked columns and bars always; a column chart when it splits by
 * a series and stacks it; an area when it has more than one part.
 */
export function stacksParts(
  type: string,
  f: { seriesField?: string; stacked?: boolean; extraMeasures?: string[] },
): boolean {
  if (type === "scolumn" || type === "shbar") return true;
  if (type === "bar") return Boolean(f.seriesField && f.stacked);
  if (type === "area") return Boolean(f.seriesField || f.extraMeasures?.length);
  return false;
}

/** The options a saved chart was built with. */
export function visualOptsFrom(c: ChartSpec): VisualOpts {
  const o: VisualOpts = { ...VISUAL_OPTS_DEFAULT, bands: [], params: [], notes: [] };
  if (c.type === "cards") {
    o.cardsLayout = c.layout ?? "tiles";
    o.imageField = c.imageField ?? "";
    o.iconFields = c.iconFields ?? [];
    o.heading = c.heading ?? "";
    o.title = c.title;
    o.body = c.body ?? "";
    o.lead = c.lead ?? "";
    o.value = c.value ?? "";
    o.max = c.max !== undefined ? String(c.max) : "";
  }
  if (c.type === "range") {
    o.categoryField = c.categoryField;
    o.startField = c.startField;
    o.endField = c.endField;
    o.labelField = c.labelField ?? "";
    o.higherIsBetter = c.higherIsBetter === true;
  }
  if (c.type === "pointmap") {
    o.latField = c.latField;
    o.lngField = c.lngField;
    o.sizeField = c.sizeField ?? "";
    o.labelField = c.labelField ?? "";
  }
  if (c.type === "journey") {
    o.categoryField = c.categoryField;
    o.measureField = c.valueField;
  }
  if (c.type === "controls") {
    o.params = [...c.params];
    o.intro = c.intro ?? "";
  }
  if (c.type === "pareto") {
    o.categoryField = c.categoryField;
    o.measureField = c.valueField;
  }
  if (c.type === "calendar") {
    o.dateField = c.dateField;
    o.measureField = c.valueField;
  }
  if (c.type === "smallmultiples") {
    o.smX = c.xField;
    o.smY = c.yField;
    o.splitField = c.splitField;
    o.smKind = c.kind === "bar" ? "bar" : "line";
  }
  if (c.type === "pictogram") {
    o.categoryField = c.categoryField;
    o.measureField = c.valueField;
    o.icon = c.icon ?? "person";
    o.unit = c.unit !== undefined ? String(c.unit) : "";
  }
  o.maWindow = c.movingAverage !== undefined ? String(c.movingAverage) : "";
  o.logScale = c.logScale === true;
  o.zoomBar = c.zoomBar === true;
  if (c.type === "heatmap") o.heatScale = c.scale ?? "sequential";
  if (c.type === "treemap") {
    o.colorMeasure = c.colorMeasure ?? "";
    o.heatScale = c.scale ?? "sequential";
    o.lowerIsBetter = c.lowerIsBetter === true;
  }
  o.percentStack = c.percentStack === true;
  o.legend = c.legend ?? "bottom";
  o.notes = (c.annotations ?? []).map((n) => ({ x: String(n.x), text: n.text }));
  if (c.type === "table") o.striped = c.striped === true;
  o.colorField = c.colorField ?? "";
  o.endLabels = c.endLabels === true;
  o.bands = (c.xBands ?? []).map((b) => ({
    from: String(b.from),
    to: String(b.to),
    label: b.label ?? "",
  }));
  return o;
}

/** A band's end as the rows have it: a number where it reads as one. */
function bandEnd(v: string): string | number {
  const t = v.trim();
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : t;
}

/**
 * The spec for a visual whose fields live in the options (cards, range), or
 * that takes the pane's own fields (radial bars, rank over time). Null while
 * something it needs is missing.
 */
export function visualSpec(
  type: string,
  o: VisualOpts,
  f: { xField: string; yField: string; seriesField: string; nameField: string; valueField: string },
): ChartSpec | null {
  switch (type) {
    case "cards": {
      if (!o.title.trim()) return null;
      const max = Number(o.max);
      return {
        type: "cards",
        layout: o.cardsLayout === "rows" ? "rows" : undefined,
        imageField: o.imageField || undefined,
        iconFields: o.iconFields.length ? o.iconFields : undefined,
        heading: o.heading.trim() || undefined,
        title: o.title,
        body: o.body.trim() || undefined,
        lead: o.lead.trim() || undefined,
        value: o.value.trim() || undefined,
        max: Number.isInteger(max) && max > 0 ? max : undefined,
      };
    }
    case "range":
      return o.categoryField && o.startField && o.endField
        ? {
            type: "range",
            categoryField: o.categoryField,
            startField: o.startField,
            endField: o.endField,
            labelField: o.labelField || undefined,
            higherIsBetter: o.higherIsBetter || undefined,
          }
        : null;
    case "radialbar":
      return f.nameField && f.valueField
        ? { type: "radialbar", nameField: f.nameField, valueField: f.valueField }
        : null;
    case "bump":
      return f.xField && f.yField && f.seriesField
        ? { type: "bump", xField: f.xField, yField: f.yField, seriesField: f.seriesField }
        : null;
    case "pointmap":
      return o.latField && o.lngField
        ? {
            type: "pointmap",
            latField: o.latField,
            lngField: o.lngField,
            colorField: o.colorField || undefined,
            sizeField: o.sizeField || undefined,
            labelField: o.labelField || undefined,
          }
        : null;
    case "journey":
      return o.categoryField && o.measureField
        ? {
            type: "journey",
            categoryField: o.categoryField,
            valueField: o.measureField,
            colorField: o.colorField || undefined,
          }
        : null;
    case "pareto":
      return o.categoryField && o.measureField
        ? { type: "pareto", categoryField: o.categoryField, valueField: o.measureField }
        : null;
    case "calendar":
      return o.dateField && o.measureField
        ? { type: "calendar", dateField: o.dateField, valueField: o.measureField }
        : null;
    case "smallmultiples":
      return o.smX && o.smY && o.splitField
        ? {
            type: "smallmultiples",
            xField: o.smX,
            yField: o.smY,
            splitField: o.splitField,
            kind: o.smKind === "bar" ? "bar" : undefined,
          }
        : null;
    case "pictogram": {
      if (!o.categoryField || !o.measureField) return null;
      const unit = Number(o.unit);
      return {
        type: "pictogram",
        categoryField: o.categoryField,
        valueField: o.measureField,
        icon: o.icon === "person" ? undefined : o.icon,
        unit: o.unit.trim() && Number.isFinite(unit) && unit > 0 ? unit : undefined,
      };
    }
    case "controls":
      return o.params.length
        ? { type: "controls", params: o.params, intro: o.intro.trim() || undefined }
        : null;
    default:
      return null;
  }
}

/** A treemap's colour measure and its scale (R505); nothing without a measure. */
export function treemapColor(o: VisualOpts): {
  colorMeasure?: string;
  scale?: "diverging";
  lowerIsBetter?: boolean;
} {
  if (!o.colorMeasure) return {};
  return {
    colorMeasure: o.colorMeasure,
    scale: o.heatScale === "diverging" ? "diverging" : undefined,
    lowerIsBetter: o.heatScale === "diverging" && o.lowerIsBetter ? true : undefined,
  };
}

/**
 * The colour column, end labels, bands, 100% stacks, legend and notes for the
 * types that take them. `stacks` says whether this chart's parts stack (see
 * stacksParts); a 100% stack is kept only where they do.
 */
export function visualAnalytics(
  type: string,
  o: VisualOpts,
  stacks = true,
): Partial<BiChartAnalytics> {
  const out: Partial<BiChartAnalytics> = {};
  // R505: shares of 100%, where the legend sits, and notes at x values.
  if (stacks && o.percentStack && ["scolumn", "shbar", "bar", "area"].includes(type)) {
    out.percentStack = true;
  }
  if (LEGEND_VISUALS.has(type) && o.legend !== "bottom") out.legend = o.legend;
  if (NOTE_VISUALS.has(type)) {
    const notes = o.notes
      .filter((n) => n.x.trim() !== "" && n.text.trim() !== "")
      .slice(0, MAX_NOTES)
      .map((n) => ({ x: bandEnd(n.x), text: n.text.trim().slice(0, NOTE_CHARS) }));
    if (notes.length) out.annotations = notes;
  }
  if (COLOR_FIELD_VISUALS.has(type) && o.colorField) out.colorField = o.colorField;
  if (type === "line" && o.endLabels) out.endLabels = true;
  // R502: a moving average (lines), a log axis and a zoom bar (lines, bars).
  if (type === "line") {
    const n = Number(o.maWindow);
    if (o.maWindow.trim() && Number.isInteger(n) && n >= 2 && n <= 365) out.movingAverage = n;
  }
  if (type === "line" || type === "bar") {
    if (o.logScale) out.logScale = true;
    if (o.zoomBar) out.zoomBar = true;
  }
  if (type === "line" || type === "bump") {
    const bands = o.bands
      .filter((b) => b.from.trim() !== "" && b.to.trim() !== "")
      .map((b) => ({
        from: bandEnd(b.from),
        to: bandEnd(b.to),
        label: b.label.trim() || undefined,
      }));
    if (bands.length) out.xBands = bands;
  }
  return out;
}
