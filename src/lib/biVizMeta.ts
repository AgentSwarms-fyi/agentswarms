// What each visual needs to be built, for hover help on the widget picker
// (QuickSight-style "Requires one dimension in group by") and to steer the AI.
//
// `requires` is the short field requirement; `how` is a one-line "how to build
// / when to use". Keyed by the ChartSpec `type` plus the non-chart widget kinds
// ("text", "image").

export type VizReq = { requires: string; how: string };

export const VIZ_REQUIREMENTS: Record<string, VizReq> = {
  bar: {
    requires: "1 dimension (X axis) + 1 measure (Y axis). Optional: a field to split into series.",
    how: "Compare a measure across categories.",
  },
  hbar: {
    requires: "1 dimension (Y axis) + 1 measure (X axis).",
    how: "Compare across categories with long labels.",
  },
  scolumn: {
    requires: "1 dimension (X axis) + 1 measure (Y axis) + 1 field to stack by.",
    how: "Show part-to-whole composition across categories, vertically.",
  },
  shbar: {
    requires: "1 dimension (Y axis) + 1 measure (X axis) + 1 field to stack by.",
    how: "Show part-to-whole composition across categories, horizontally.",
  },
  barrace: {
    requires: "1 dimension (racing bars) + 1 measure + 1 time field (frames).",
    how: "Animate a ranking changing over time.",
  },
  line: {
    requires: "1 dimension (X axis, usually a date) + 1 measure (Y axis). Optional: series.",
    how: "Show a trend over time or an ordered axis.",
  },
  area: {
    requires: "1 dimension (X axis) + 1 measure (Y axis). Optional: series.",
    how: "Show a trend with volume/magnitude emphasis.",
  },
  combo: {
    requires: "1 dimension (X axis) + 2 measures (one bars, one line).",
    how: "Compare two measures on different scales over one dimension.",
  },
  scatter: {
    requires: "2 measures (X and Y). Optional: a measure for bubble size.",
    how: "Show correlation between two numeric fields.",
  },
  pie: {
    requires: "1 dimension (slices) + 1 measure (value).",
    how: "Show part-to-whole for a few categories.",
  },
  nightingale: {
    requires: "1 dimension (segments) + 1 measure (value).",
    how: "A polar/rose alternative to a pie for many categories.",
  },
  radar: {
    requires: "1 dimension (axes) + 1 measure (value). Optional: series to overlay.",
    how: "Compare several measures/entities across common axes.",
  },
  funnel: {
    requires: "1 dimension (stages) + 1 measure (value).",
    how: "Show drop-off through sequential stages.",
  },
  sankey: {
    requires: "2 dimensions (source, target) + 1 measure (flow value).",
    how: "Show flows between nodes.",
  },
  treemap: {
    requires: "1 dimension (group by / labels) + 1 measure (rectangle size).",
    how: "Part-to-whole with many categories, sized by a measure.",
  },
  heatmap: {
    requires: "2 dimensions (X and Y) + 1 measure (colour intensity).",
    how: "Show intensity across two categorical dimensions.",
  },
  wordcloud: {
    requires: "1 text dimension (words). Optional: 1 measure to weight by.",
    how: "Size words by how often they appear (or by a measure).",
  },
  boxplot: {
    requires: "1 dimension (X axis) + 1 measure (Y axis).",
    how: "Show distribution/spread of a measure per category.",
  },
  waterfall: {
    requires: "1 dimension (X axis) + 1 measure (Y axis).",
    how: "Show how sequential positives/negatives build to a total.",
  },
  kpi: {
    requires: "1 measure (value). Optional: a target field.",
    how: "Highlight a single headline number.",
  },
  gauge: {
    requires: "1 measure (value). Optional: a target and a max.",
    how: "Show a value against a target/range.",
  },
  matrix: {
    requires: "1 row dimension + 1 column dimension + 1 measure (cell value).",
    how: "A pivot table with row/column groups and subtotals.",
  },
  map: {
    requires: "1 location field (country/region) + 1 measure (value).",
    how: "Shade a map by a measure per location.",
  },
  bubblemap: {
    requires: "1 location field + 1 measure (bubble size).",
    how: "Plot sized bubbles by a measure per location.",
  },
  table: {
    requires: "No fields required — shows every column returned.",
    how: "List the raw rows behind the question.",
  },
  ontology: {
    requires:
      "No fields — the AI derives typed subject–predicate–object relations across the datasets, warehouses and knowledge bases you pick (KB knowledge graphs contribute concept nodes and their triples).",
    how: "Knowledge graph of your data estate — click nodes and edges to inspect each triple.",
  },
  text: {
    requires: "No data — just a title and Markdown content.",
    how: "Add headings, notes or an executive summary.",
  },
  image: {
    requires: "No data — an uploaded image or an image URL (e.g. a public S3 object).",
    how: "Place a logo, diagram or picture on the dashboard.",
  },
};

export function vizRequirement(type: string): VizReq | undefined {
  return VIZ_REQUIREMENTS[type];
}
