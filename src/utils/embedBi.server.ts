// Server-side "visual BI answer" for embedded agents. Anonymous embed visitors
// have no data access, so the widget is generated with the AGENT OWNER's data:
// the owner's tables are loaded via the service-role client, strictly scoped to
// the owner (ctx.scopeUserId — the tenant guard), the owner's LLM plans one
// read-only SELECT + a chart spec, the query runs through the same worker-safe
// SQL executor the agent SQL tool uses, and the result becomes a chart widget.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { extractUsage, recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";
import { describeUserTables, runSqlQuery } from "@/utils/tools/sql.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";
import type { ChartSpec } from "@/lib/biAgent";

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
): Promise<Record<string, unknown> | null> {
  const transport = await resolveOpenAICompatTransport({ userId: ownerId, provider });
  if (!transport || (!transport.apiKey && provider !== "ollama")) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const startedAt = Date.now();
  try {
    const res = await fetch(transport.endpointUrl, {
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
    if (!res.ok) return null;
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
      surface: "Embed BI: Plan",
      provider,
      model,
      tokensIn: usage?.tokensIn,
      tokensOut: usage?.tokensOut,
      promptText: usage ? undefined : `${system}\n\n${user}`,
      responseText: usage ? undefined : (content ?? ""),
      latencyMs: Date.now() - startedAt,
      status: content ? "success" : "error",
    });

    if (!content) return null;
    return JSON.parse(stripFences(content)) as Record<string, unknown>;
  } catch {
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
    if (!schema || /no data tables|no tables/i.test(schema)) return null;

    const plan = await llmJsonServer(
      opts.ownerId,
      opts.provider,
      opts.model,
      "You turn a question into ONE read-only SQL SELECT over the given tables plus a chart spec to visualize the result. " +
        "SQL is PostgreSQL dialect; quote identifiers with double quotes when they contain spaces. Aggregate for big tables. " +
        'Output ONLY JSON: { "sql": string, "chart": { "type": "bar"|"line"|"area"|"pie"|"scatter"|"kpi", "xField"?: string, "yField"?: string, "nameField"?: string, "valueField"?: string, "seriesField"?: string } }. ' +
        "Choose fields that exactly match the SELECT output column names.",
      `TABLES:\n${schema}\n\nQUESTION: ${opts.question}`,
    );
    const sql = typeof plan?.sql === "string" ? plan.sql : null;
    const chart = plan?.chart as ChartSpec | undefined;
    if (!sql || !chart || !chart.type || chart.type === "table") return null;

    const raw = JSON.parse(await runSqlQuery(ctx, { sql }, allowSet)) as {
      error?: string;
      columns?: string[];
      rows?: Record<string, unknown>[];
    };
    if (raw.error || !Array.isArray(raw.rows) || raw.rows.length === 0) return null;

    return {
      id: crypto.randomUUID(),
      kind: "chart",
      title: opts.question.slice(0, 120),
      chart,
      columns: raw.columns ?? Object.keys(raw.rows[0] ?? {}),
      rows: raw.rows,
    };
  } catch {
    return null;
  }
}
