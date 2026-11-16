// The builder's options for the visuals and styles added in R500 — cards,
// start → finish ranges, radial bars, rank over time — plus the colour
// column, end labels and shaded bands lines take, the heatmap's diverging
// scale and striped tables. Held in one object so the builder pane wires them
// with one state, one prefill and one call into the spec.
import type { BiChartAnalytics, ChartSpec } from "@/lib/biAgent";

export type VisualBand = { from: string; to: string; label: string };

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
};

/** Visual types whose fields live in these options rather than the pane's. */
export const OPTS_VISUALS = new Set(["cards", "range"]);
/** Types that take a colour column (`colorField`). */
export const COLOR_FIELD_VISUALS = new Set(["line", "bump", "radialbar"]);

/** The options a saved chart was built with. */
export function visualOptsFrom(c: ChartSpec): VisualOpts {
  const o: VisualOpts = { ...VISUAL_OPTS_DEFAULT, bands: [] };
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
  if (c.type === "heatmap") o.heatScale = c.scale ?? "sequential";
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
    default:
      return null;
  }
}

/** The colour column, end labels and bands for the types that take them. */
export function visualAnalytics(type: string, o: VisualOpts): Partial<BiChartAnalytics> {
  const out: Partial<BiChartAnalytics> = {};
  if (COLOR_FIELD_VISUALS.has(type) && o.colorField) out.colorField = o.colorField;
  if (type === "line" && o.endLabels) out.endLabels = true;
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
