/**
 * Why the chart builder's "Add to dashboard" cannot be pressed yet, or null
 * when it can: the first thing missing, in the order a person fills the
 * pane. The button shows it beneath itself while disabled.
 *
 * FOUND IN R203 (seen in R196): the button stayed disabled until the widget
 * had a title, and nothing said so. The empty title box showed its
 * placeholder, "Revenue by month", in grey, which reads as a title already
 * given, so a finished chart looked unaddable for no reason.
 */
export function chartBlocker(s: {
  /** An ontology map needs no query. */
  ontology: boolean;
  sql: string;
  /** The query has been run and its rows are in the preview. */
  ran: boolean;
  /** The chart's columns are chosen (a chart spec exists). */
  chart: boolean;
  title: string;
}): string | null {
  if (!s.ontology) {
    if (!s.sql.trim()) return "Write a query or pick tables, then Run it.";
    if (!s.ran) return "Run the query to see its rows.";
  }
  if (!s.chart) return s.ontology ? "Build the map to add it." : "Choose the columns to chart.";
  if (!s.title.trim()) return "Give the widget a title.";
  return null;
}

/** The same for a governed metric (the Semantic source). */
export function metricBlocker(s: {
  model: string;
  metrics: number;
  /** Preview has been pressed and its rows are in. */
  ran: boolean;
  title: string;
}): string | null {
  if (!s.model) return "Pick a metric model.";
  if (s.metrics === 0) return "Pick at least one metric.";
  if (!s.ran) return "Press Preview to see the metric's rows.";
  if (!s.title.trim()) return "Give the widget a title.";
  return null;
}
