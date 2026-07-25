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
 * The outcome of a Visual BI attempt for a chat turn:
 * - `narrative`: a data-grounded natural-language answer written by the analyst
 *   from the REAL query result. When present the chat should use it as the
 *   answer, so the text agrees with the data (and doesn't say "upload a CSV"
 *   when the data is already attached).
 * - `widget`: a chart to render inline, only when the result is actually
 *   chartable (a table-only result adds little next to the text).
 * Both null ⇒ the question wasn't answerable from data (keep the agent's reply).
 */
export type ChatBiResult = { narrative: string | null; widget: BiWidget | null };

const EMPTY_BI: ChatBiResult = { narrative: null, widget: null };

/**
 * Run the user's question through the BI analyst over their own datasets and
 * return a data-grounded narrative + optional chart. Never throws — a failed BI
 * attempt must not break the chat turn. `scope` controls the widget row snapshot.
 */
export async function generateChatWidget(
  question: string,
  opts: { model?: string; scope?: DocScope } = {},
): Promise<ChatBiResult> {
  try {
    const datasets = await hydrateFromSupabase();
    if (!datasets || datasets.length === 0) return EMPTY_BI;
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
    // No usable result ⇒ probably not a data question; let the agent's reply stand.
    if (turn.status !== "done" || !turn.result || turn.result.row_count === 0) return EMPTY_BI;
    const narrative = turn.narrative?.trim() || null;
    // A table-only "chart" adds little next to the text answer — skip the visual
    // but still return the narrative so the answer is data-grounded.
    const chartable = turn.chart && turn.chart.type !== "table";
    const cap = SCOPE_ROW_CAP[opts.scope ?? "sample"] ?? WIDGET_ROW_CAP;
    const widget = chartable ? widgetFromBiTurn(turn, { kind: "local" }, cap) : null;
    return { narrative, widget };
  } catch {
    return EMPTY_BI;
  }
}
