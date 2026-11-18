// Server-side "visual BI answer" for embedded agents. Anonymous embed visitors
// have no data access, so the widget is generated with the AGENT OWNER's data:
// the owner's tables are loaded via the service-role client, strictly scoped to
// the owner (ctx.scopeUserId — the tenant guard), the owner's LLM plans one
// read-only SELECT + a chart spec, the query runs through the same worker-safe
// SQL executor the agent SQL tool uses, and the result becomes a chart widget.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { providerFetch } from "@/utils/ssrfGuard.server";
import { extractUsage, recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";
import { describeUserTables, runSqlQuery } from "@/utils/tools/sql.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";
import { suggestChart, type ChartSpec, type LlmJsonFn } from "@/lib/biAgent";
import { numericColumns, reconcileChartFields } from "@/lib/biChartFields";
import { chartTypeFromWord, plannerTypeList } from "@/lib/biChartCatalog";

export type EmbedWidget = {
  id: string;
  kind: "chart";
  title: string;
  chart: ChartSpec;
  columns: string[];
  rows: Record<string, unknown>[];
};

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function llmJsonServer(
  ownerId: string,
  provider: ProviderId,
  model: string,
  system: string,
  user: string,
  /** Which call this is, as Traces names it. */
  surface = "Embed BI: Plan",
): Promise<Record<string, unknown> | null> {
  // FOUND FROM THE SURVEY (R97). An anonymous viewer's question is answered
  // with the dashboard OWNER's model on the owner's credentials, so it is the
  // owner's model rules that decide — asked here, where this private copy of
  // the JSON call used to skip them, and closed when they cannot be read.
  const { modelAccessRefusal } = await import("@/utils/iam.server");
  const refused = await modelAccessRefusal(ownerId, provider, model).catch(
    (e) => `could not check model access: ${(e as Error).message}`,
  );
  if (refused) {
    console.warn(`[embed-bi] owner ${ownerId}: ${refused}`);
    return null;
  }
  const transport = await resolveOpenAICompatTransport({ userId: ownerId, provider });
  if (!transport || (!transport.apiKey && provider !== "ollama")) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const startedAt = Date.now();
  try {
    const res = await providerFetch(transport.endpointUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
        ...(transport.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!res.ok) {
      console.warn(`[embed-bi] owner ${ownerId}: ${surface} answered HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;

    // Bill the OWNER for the planning call.
    //
    // This ran untraced. Month-to-date spend is a SUM over execution_traces
    // (see budgetGuard.server.ts), so a call that never inserts a row can
    // never accumulate: the widget was real money that the monthly cap could
    // not see, on a surface where the question comes from an anonymous
    // visitor. The budget was checked before generating and then not charged
    // for what generating cost — so the cap was always evaluated against an
    // undercount that permanently excluded every widget ever drawn.
    const usage = extractUsage(data);
    await recordGatewayCall({
      userId: ownerId,
      surface,
      provider,
      model,
      tokensIn: usage?.tokensIn,
      tokensOut: usage?.tokensOut,
      providerCostUsd: usage?.costUsd,
      promptText: usage ? undefined : `${system}\n\n${user}`,
      responseText: usage ? undefined : (content ?? ""),
      latencyMs: Date.now() - startedAt,
      status: content ? "success" : "error",
    });

    if (!content) {
      console.warn(`[embed-bi] owner ${ownerId}: ${surface} returned no content`);
      return null;
    }
    return JSON.parse(stripFences(content)) as Record<string, unknown>;
  } catch (e) {
    console.warn(`[embed-bi] owner ${ownerId}: ${surface} failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a chart widget for `question` using the owner's data, or null when
 * there's no usable data / the plan fails. Never throws — a failed BI attempt
 * must not affect the embed's text answer.
 */
export async function generateEmbedWidget(opts: {
  ownerId: string;
  provider: ProviderId;
  model: string;
  question: string;
  /**
   * The agent's `sql_query` table allow-list, when it has one.
   *
   * THIS IS A PUBLIC SURFACE. The question comes from an anonymous visitor and
   * the SQL is written by a model that has been handed the schema, so an
   * allow-list the owner set on the agent has to apply here exactly as it does
   * in chat. It did not, for a while: this path called describeUserTables and
   * runSqlQuery with no allow-list at all, so an agent restricted to one table
   * would still describe every dataset the owner has to the model and return
   * rows from any of them.
   *
   * Absent or empty means unrestricted, matching how the same list behaves for
   * the chat tool — it is opt-in there, and one surface silently applying a
   * stricter rule than the other is how the two drift apart.
   */
  sqlTableNames?: string[] | null;
}): Promise<EmbedWidget | null> {
  // Why no chart came back, in the server log. Every exit below used to be a
  // bare `return null`, so a visitor saw a text answer and the owner had no
  // way to tell a missing table from a model that answered nothing (R507).
  // Reasons only: never the visitor's question, the SQL or a row.
  const skip = (reason: string): null => {
    console.warn(`[embed-bi] owner ${opts.ownerId}: no chart: ${reason}`);
    return null;
  };
  try {
    // Service-role client, strictly scoped to the owner (tenant guard).
    const ctx = {
      userId: opts.ownerId,
      sb: supabaseAdmin,
      scopeUserId: opts.ownerId,
    } as AgentToolContext;

    const allowed = (opts.sqlTableNames ?? []).map((s) => s.trim()).filter(Boolean);
    const allowSet = allowed.length > 0 ? new Set(allowed) : null;

    const schema = await describeUserTables(ctx, allowSet);
    if (!schema || /no data tables|no tables/i.test(schema)) {
      return skip("the agent can read no data tables");
    }

    // The SQL first, with the visual it is meant for. Until R507 the plan
    // returned the chart too, from a list of six types written into this
    // prompt, before the query had run: an embed could never draw a pareto, a
    // pivot or a US state map, and a chart naming a column the SELECT did not
    // return drew an empty frame on the owner's public page.
    const plan = await llmJsonServer(
      opts.ownerId,
      opts.provider,
      opts.model,
      "You turn a question into ONE read-only SQL SELECT over the given tables, and name the " +
        "chart that will show the result. SQL is PostgreSQL dialect; quote identifiers with " +
        "double quotes when they contain spaces. Aggregate for big tables. " +
        `Chart types: ${plannerTypeList()}. ` +
        'Output ONLY JSON: { "sql": string, "chartType": string }. When the question names a ' +
        "table or a column that is not among the given tables, answer it from nothing else: " +
        'return { "sql": null }. A chart of another table under the title of the question is ' +
        "a wrong answer.",
      `TABLES:\n${schema}\n\nQUESTION: ${opts.question}`,
    );
    const sql = typeof plan?.sql === "string" ? plan.sql : null;
    if (!sql) return skip("the model wrote no SQL");

    const raw = JSON.parse(await runSqlQuery(ctx, { sql }, allowSet)) as {
      error?: string;
      columns?: string[];
      rows?: Record<string, unknown>[];
    };
    if (raw.error) return skip(`the query failed: ${raw.error.slice(0, 200)}`);
    if (!Array.isArray(raw.rows) || raw.rows.length === 0)
      return skip("the query returned no rows");
    const columns = raw.columns ?? Object.keys(raw.rows[0] ?? {});

    // Then the chart, from the rows that came back, by the same chart step the
    // app uses: every visual it can choose, the same reading of what a model
    // returns, and the same check of the columns it names.
    const llm: LlmJsonFn = async <T>(o: { systemPrompt: string; userPrompt: string }) => {
      const out = await llmJsonServer(
        opts.ownerId,
        opts.provider,
        opts.model,
        o.systemPrompt,
        o.userPrompt,
        "Embed BI: Chart",
      );
      if (!out) throw new Error("no chart");
      return out as T;
    };
    const suggested = await suggestChart({
      question: opts.question,
      result: { columns, rows: raw.rows, row_count: raw.rows.length } as never,
      plan: { intent: opts.question, tables: [], metrics: [], breakdowns: [] } as never,
      preferChart: chartTypeFromWord(plan?.chartType),
      llm,
    });
    const fields = reconcileChartFields({ chart: suggested, columns, rows: raw.rows });
    const chart: ChartSpec = fields.verdict === "ok" ? suggested : fields.chart;
    if (chart.type === "table") {
      // Column names and kinds only: enough to tell "the model chose a
      // table" from "the measure came back as text".
      const numeric = [...numericColumns(columns, raw.rows)];
      return skip(
        `the rows suit no chart (chart step: ${suggested.type}, check: ${fields.verdict}, ` +
          `columns: ${columns.join(", ")}, numeric: ${numeric.join(", ") || "none"})`,
      );
    }

    return {
      id: crypto.randomUUID(),
      kind: "chart",
      title: opts.question.slice(0, 120),
      chart,
      columns,
      rows: raw.rows,
    };
  } catch (e) {
    return skip((e as Error).message);
  }
}
