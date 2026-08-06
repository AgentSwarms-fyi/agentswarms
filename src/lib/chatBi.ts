// Generate BI widgets from a chat question, reusing the Data & SQL AI analyst
// (plan → SQL → execute → chart) over the user's own datasets. Used by the chat
// playground to show visuals alongside an agent's natural-language answer.
import { runBiTurn, loadSemantics, loadSavedMetrics, llmJson } from "@/lib/biAgent";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { widgetFromBiTurn, widgetRowCap, type BiWidget } from "@/lib/biDashboards";
import type { DocScope } from "@/lib/docGen/types";
import { buildSources, sqlTableSources, type RawSource, type Source } from "@/utils/tools/sources";
import {
  MAX_CHAT_VISUALS,
  needsConversationContext,
  normalizeSubQuestions,
  requestedVisualCount,
  wantsMultipleVisuals,
} from "@/lib/chatBiSplit";

// The chat widget's row snapshot. `full` lets the visual cover the whole result
// (up to a safety cap); `sample` keeps it light for a quick answer-side visual.
// Resolved per call, not at module load, so the configured cap applies.
const scopeRowCap = (scope: DocScope): number => (scope === "full" ? 50_000 : widgetRowCap());

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
export type ChatBiResult = {
  narrative: string | null;
  widgets: BiWidget[];
  /**
   * The table(s) read and the SELECT that produced the answer.
   *
   * A BI answer used to arrive with no provenance: a chart and a confident
   * sentence, and nothing saying which dataset it came from or what was run.
   * The agent's own sql_query tool had cited both all along, so the same
   * question answered two ways showed the user two different things.
   */
  sources: Source[];
};

const EMPTY_BI: ChatBiResult = { narrative: null, widgets: [], sources: [] };

/**
 * Say why Visual BI gave up.
 *
 * Every exit from {@link generateChatWidget} used to be silent: a bare catch,
 * a `continue`, and two bare `return EMPTY_BI`s. The only symptom of any of
 * them was an agent answer appearing where a chart should have been, which is
 * also what a genuinely non-data question looks like. Debugging it meant
 * guessing, so a real failure and correct behaviour were the same event.
 *
 * console.warn rather than a thrown error or a toast: falling through IS the
 * designed behaviour and must stay silent for the user, while still leaving a
 * trail for whoever is asked why the chart did not appear.
 */
function biTrace(reason: string, detail?: unknown): void {
  if (detail === undefined) console.warn(`[VisualBI] ${reason}`);
  else console.warn(`[VisualBI] ${reason}`, detail);
}

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

/** A prior turn, oldest first, as the chat already stores it. */
export type ChatBiHistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * Appended to the agent's system prompt when Visual BI ran for this turn and
 * came back empty, so the fall-through answer knows what just happened.
 *
 * Without it the agent has no idea Visual BI exists, let alone that it just
 * failed, and answers the only way it can: by explaining how to build the
 * chart by hand somewhere else. The user is looking at a lit "Visual BI"
 * toggle while being told to go and draw it themselves on another page.
 *
 * Appended LAST, after the agent's own prompt, so everything before it keeps a
 * stable token prefix for provider-side prompt caching — the same ordering
 * rule TOOL_SAFETY_RULE follows in loop.server.ts.
 */
export const BI_FELL_THROUGH_NOTE =
  "[system] Visual BI is enabled for this conversation and has ALREADY run against the user's " +
  "connected datasets for this question. It could not produce a chart. Charts are rendered by the " +
  "application, not written by you, and the user does not build them by hand.\n" +
  "- Do NOT tell them to open another page, click a chart icon, or use a different tool.\n" +
  "- Do NOT draw a chart yourself out of text: no bars made of block characters, hashes, asterisks " +
  "or equals signs, and no ASCII art. A picture made of characters is not a chart, and calling it " +
  "one is worse than saying no chart was produced.\n" +
  "- DO answer the question with the real figures, as prose and a markdown table when that helps.\n" +
  "- DO say, in one short sentence, that a chart could not be generated for this one.";

/** How much of the conversation the condenser is allowed to read. */
const CONDENSE_TURNS = 6;
const CONDENSE_CHARS = 1500;

/**
 * Rewrite a follow-up into a question that stands on its own.
 *
 * The analyst never sees the conversation, so "show me this as a bar chart"
 * reaches it with no subject and produces nothing — and a Visual BI turn that
 * produces nothing is indistinguishable, to the code below, from a question
 * that was never about data. The user gets the plain agent instead, which
 * cheerfully explains how to build the chart by hand.
 *
 * Gated on {@link needsConversationContext} so self-contained questions never
 * pay for it, and falls back to the original question on ANY failure — a
 * broken condense must degrade to today's behaviour, not to nothing.
 */
async function condenseQuestion(
  question: string,
  history: ChatBiHistoryTurn[],
  model?: string,
): Promise<string> {
  if (history.length === 0) return question;
  try {
    // Oldest-first, most recent turns only, and truncated: the condenser needs
    // the subject of the last data question, not the whole session.
    const transcript = history
      .slice(-CONDENSE_TURNS)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n")
      .slice(-CONDENSE_CHARS);
    const out = await llmJson<{ question?: unknown }>({
      systemPrompt:
        `You rewrite a follow-up question into ONE self-contained analytical question, using the conversation for context.\n` +
        `SCHEMA: { "question": string }\n` +
        `- Resolve every reference ("this", "that result", "the query above") into the actual subject, measures and dimensions.\n` +
        `- KEEP any chart type the user asked for ("as a bar chart" stays in the rewritten question).\n` +
        `- Keep the user's wording and subject matter. Never invent tables, columns or filters that the conversation does not mention.\n` +
        `- If the follow-up is already self-contained, return it unchanged.`,
      userPrompt: `CONVERSATION:\n${transcript}\n\nFOLLOW-UP: ${question}`,
      model,
      temperature: 0.1,
      maxTokens: 300,
    });
    const rewritten = typeof out.question === "string" ? out.question.trim() : "";
    // An empty or absurd rewrite is worse than the original — the original at
    // least still contains the user's own words.
    return rewritten.length > 0 && rewritten.length <= 500 ? rewritten : question;
  } catch {
    return question;
  }
}

/**
 * Whether a finished turn can actually be drawn.
 *
 * Asked for two visuals in one turn, the analyst answers with two SQL
 * statements, an ARRAY of chart specs and nested row arrays. The narrative is
 * still right — it summarises both — but the widget builder expects one spec
 * and flat rows, so it produced a single empty frame. The split path is meant
 * to prevent this; this check makes the failure mode "narrative only" rather
 * than "an empty chart" whenever a phrasing still gets through.
 */
function isRenderableTurn(turn: { chart?: unknown; result?: { rows?: unknown } }): boolean {
  const chart = turn.chart;
  if (!chart || Array.isArray(chart) || typeof chart !== "object") return false;
  if ((chart as { type?: string }).type === "table") return false;
  const rows = turn.result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  // Nested arrays mean multiple result sets came back from one turn.
  return !Array.isArray(rows[0]);
}

/**
 * Run the user's question through the BI analyst over their own datasets and
 * return a data-grounded narrative + charts. Never throws — a failed BI attempt
 * must not break the chat turn. `scope` controls the widget row snapshot.
 */
export async function generateChatWidget(
  question: string,
  opts: { model?: string; scope?: DocScope; history?: ChatBiHistoryTurn[] } = {},
): Promise<ChatBiResult> {
  try {
    const datasets = await hydrateFromSupabase();
    if (!datasets || datasets.length === 0) {
      biTrace("no datasets hydrated — nothing to query");
      return EMPTY_BI;
    }
    const [semantics, metrics] = await Promise.all([
      loadSemantics(datasets.map((d) => d.id)),
      loadSavedMetrics(),
    ]);

    // Resolve references BEFORE splitting. A follow-up asking for two charts
    // ("now show me both of those as bar charts") has to know what "those"
    // were before it can be broken into one question per visual — splitting
    // first would just produce two subject-less questions instead of one.
    const resolved = needsConversationContext(question)
      ? await condenseQuestion(question, opts.history ?? [], opts.model)
      : question;
    // The single most useful line when a chart does not appear: it separates
    // "the referent was never resolved" from "it resolved fine and the
    // planner still could not chart it". Those need different fixes.
    if (resolved !== question) biTrace(`condensed to ${JSON.stringify(resolved)}`);

    const questions = wantsMultipleVisuals(resolved)
      ? await splitQuestion(resolved, opts.model)
      : [resolved];

    const cap = scopeRowCap(opts.scope ?? "sample");
    const widgets: BiWidget[] = [];
    const narratives: string[] = [];
    const rawSources: RawSource[] = [];

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
      if (turn.status !== "done" || !turn.result || turn.result.row_count === 0) {
        biTrace(`turn produced no rows for ${JSON.stringify(q)}`, {
          status: turn.status,
          error: turn.error,
          rowCount: turn.result?.row_count ?? null,
          sql: turn.sql ?? null,
        });
        continue;
      }
      const text = turn.narrative?.trim();
      if (text) narratives.push(text);
      // Same builder the sql_query tool uses, so the caption reads identically
      // however the answer was reached.
      rawSources.push(...sqlTableSources(turn.sql, turn.result.row_count ?? null, "Visual BI"));
      // A table-only "chart" adds little next to the text answer — skip the
      // visual but still keep the narrative so the answer is data-grounded.
      if (isRenderableTurn(turn)) {
        // widgetFromBiTurn can still decline (e.g. a spec it can't render).
        const w = widgetFromBiTurn(turn, { kind: "local" }, cap);
        if (w) widgets.push(w);
        else biTrace("widgetFromBiTurn declined the spec", { chart: turn.chart });
      } else {
        biTrace("result is not renderable as a chart", {
          chart: turn.chart,
          chartIsArray: Array.isArray(turn.chart),
          rowCount: turn.result.row_count,
        });
      }
    }

    if (narratives.length === 0 && widgets.length === 0) {
      biTrace("every turn was skipped — falling through to the agent");
      return EMPTY_BI;
    }
    const narrative = narratives.join("\n\n") || null;
    return {
      narrative,
      widgets,
      // buildSources already dedupes and numbers — a multi-visual answer hits
      // the same table several times and must not cite it three times over.
      // No KB sources here: the analyst answers from the user's data only.
      sources: buildSources([], rawSources, narrative ?? ""),
    };
  } catch (e) {
    // This catch used to be bare. A Visual BI turn that produced nothing was
    // indistinguishable from one that threw, so the only symptom either way
    // was an agent answer where a chart should have been — with nothing
    // anywhere to say which had happened, or why.
    biTrace("threw", e);
    return EMPTY_BI;
  }
}
