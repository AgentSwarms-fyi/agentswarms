// Generate BI widgets from a chat question, reusing the Data & SQL AI analyst
// (plan → SQL → execute → chart) over the user's own datasets. Used by the chat
// playground to show visuals alongside an agent's natural-language answer.
import { runBiTurn, loadSemantics, loadSavedMetrics, llmJson } from "@/lib/biAgent";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { widgetFromBiTurn, WIDGET_ROW_CAP, type BiWidget } from "@/lib/biDashboards";
import type { DocScope } from "@/lib/docGen/types";
import {
  MAX_CHAT_VISUALS,
  normalizeSubQuestions,
  requestedVisualCount,
  wantsMultipleVisuals,
} from "@/lib/chatBiSplit";

// The chat widget's row snapshot. `full` lets the visual cover the whole result
// (up to a safety cap); `sample` keeps it light for a quick answer-side visual.
const SCOPE_ROW_CAP: Record<DocScope, number> = { sample: WIDGET_ROW_CAP, full: 50_000 };

/**
 * The outcome of a Visual BI attempt for a chat turn:
 * - `narrative`: a data-grounded natural-language answer written by the analyst
 *   from the REAL query result. When present the chat should use it as the
 *   answer, so the text agrees with the data (and doesn't say "upload a CSV"
 *   when the data is already attached).
 * - `widgets`: charts to render inline, only for results that are actually
 *   chartable (a table-only result adds little next to the text). Usually one;
 *   several when the question asked for several.
 * Empty on both ⇒ the question wasn't answerable from data (keep the agent's reply).
 */
export type ChatBiResult = { narrative: string | null; widgets: BiWidget[] };

const EMPTY_BI: ChatBiResult = { narrative: null, widgets: [] };

/**
 * Break a multi-visual request into one analytical question per visual.
 *
 * Only called when {@link wantsMultipleVisuals} matched, so the ordinary
 * single-chart path never pays for it. Falls back to the original question on
 * any failure — a broken split must degrade to today's behaviour, not to
 * nothing.
 */
async function splitQuestion(question: string, model?: string): Promise<string[]> {
  const asked = requestedVisualCount(question);
  const limit = asked ?? MAX_CHAT_VISUALS;
  try {
    const out = await llmJson<{ questions?: unknown }>({
      systemPrompt:
        `You split a request for several data visuals into one self-contained analytical question per visual.\n` +
        `SCHEMA: { "questions": string[] }\n` +
        `- Produce ${asked ? `EXACTLY ${asked}` : `at most ${limit}`} question(s).\n` +
        `- Each must stand alone (repeat the subject; never write "and the same by month").\n` +
        `- Each must yield ONE small grouped result: a category or time dimension plus one or more measures.\n` +
        `- Cover genuinely different angles — a different dimension, measure or time frame each time. Never restate one question twice.\n` +
        `- Keep the user's own wording and subject matter. Do not invent tables or columns.`,
      userPrompt: question,
      model,
      temperature: 0.2,
      maxTokens: 500,
    });
    const qs = normalizeSubQuestions(out.questions, limit);
    return qs.length > 0 ? qs : [question];
  } catch {
    return [question];
  }
}

/**
 * Run the user's question through the BI analyst over their own datasets and
 * return a data-grounded narrative + charts. Never throws — a failed BI attempt
 * must not break the chat turn. `scope` controls the widget row snapshot.
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

    const questions = wantsMultipleVisuals(question)
      ? await splitQuestion(question, opts.model)
      : [question];

    const cap = SCOPE_ROW_CAP[opts.scope ?? "sample"] ?? WIDGET_ROW_CAP;
    const widgets: BiWidget[] = [];
    const narratives: string[] = [];

    // Sequential: each run is a plan → SQL → execute round trip, and firing
    // four at once at one provider is the reliable way to get rate-limited.
    for (const q of questions) {
      const turn = await runBiTurn({
        question: q,
        datasets,
        semantics,
        metrics,
        model: opts.model,
        onUpdate: () => {},
      });
      // Skip this angle rather than the whole answer — one unanswerable
      // sub-question should not lose the visuals that did work.
      if (turn.status !== "done" || !turn.result || turn.result.row_count === 0) continue;
      const text = turn.narrative?.trim();
      if (text) narratives.push(text);
      // A table-only "chart" adds little next to the text answer — skip the
      // visual but still keep the narrative so the answer is data-grounded.
      if (turn.chart && turn.chart.type !== "table") {
        // widgetFromBiTurn can still decline (e.g. a spec it can't render).
        const w = widgetFromBiTurn(turn, { kind: "local" }, cap);
        if (w) widgets.push(w);
      }
    }

    if (narratives.length === 0 && widgets.length === 0) return EMPTY_BI;
    return { narrative: narratives.join("\n\n") || null, widgets };
  } catch {
    return EMPTY_BI;
  }
}
