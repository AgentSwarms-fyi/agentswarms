// Generate a BI widget from a chat question, reusing the Data & SQL AI analyst
// (plan → SQL → execute → chart) over the user's own datasets. Used by the chat
// playground to show a visual alongside an agent's natural-language answer.
import { runBiTurn, loadSemantics, loadSavedMetrics } from "@/lib/biAgent";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";

/**
 * Produce a widget for `question`, or null when there's no usable data / the
 * analyst couldn't chart it. Never throws — a failed BI attempt must not break
 * the chat turn.
 */
export async function generateChatWidget(
  question: string,
  model?: string,
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
      model,
      onUpdate: () => {},
    });
    if (turn.status !== "done" || !turn.result || !turn.chart) return null;
    // A table-only "chart" adds little next to the text answer — skip it.
    if (turn.chart.type === "table") return null;
    return widgetFromBiTurn(turn, { kind: "local" });
  } catch {
    return null;
  }
}
