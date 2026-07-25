// Generate a BI widget from a chat question, reusing the Data & SQL AI analyst
// (plan → SQL → execute → chart) over the user's own datasets. Used by the chat
// playground to show a visual alongside an agent's natural-language answer.
import { runBiTurn, loadSemantics, loadSavedMetrics } from "@/lib/biAgent";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { widgetFromBiTurn, WIDGET_ROW_CAP, type BiWidget } from "@/lib/biDashboards";
import type { DocScope } from "@/lib/docGen/types";

// The chat widget's row snapshot. `full` lets the visual cover the whole result
// (up to a safety cap); `sample` keeps it light for a quick answer-side visual.
const SCOPE_ROW_CAP: Record<DocScope, number> = { sample: WIDGET_ROW_CAP, full: 50_000 };

/**
 * Produce a widget for `question`, or null when there's no usable data / the
 * analyst couldn't chart it. Never throws — a failed BI attempt must not break
 * the chat turn. `scope` controls how many result rows the widget snapshots.
 */
export async function generateChatWidget(
  question: string,
  opts: { model?: string; scope?: DocScope } = {},
): Promise<BiWidget | null> {
  try {
    const datasets = await hydrateFromSupabase();
    if (!datasets || datasets.length === 0) return null;
    const [semantics, metrics] = await Promise.all([
      loadSemantics(datasets.map((d) => d.id)),
      loadSavedMetrics(),
    ]);
    const turn = await runBiTurn({
      question,
      datasets,
      semantics,
      metrics,
      model: opts.model,
      onUpdate: () => {},
    });
    if (turn.status !== "done" || !turn.result || !turn.chart) return null;
    // A table-only "chart" adds little next to the text answer — skip it.
    if (turn.chart.type === "table") return null;
    const cap = SCOPE_ROW_CAP[opts.scope ?? "sample"] ?? WIDGET_ROW_CAP;
    return widgetFromBiTurn(turn, { kind: "local" }, cap);
  } catch {
    return null;
  }
}
