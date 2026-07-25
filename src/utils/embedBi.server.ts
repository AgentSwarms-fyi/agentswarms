// Server-side "visual BI answer" for embedded agents. Anonymous embed visitors
// have no data access, so the widget is generated with the AGENT OWNER's data:
// the owner's tables are loaded via the service-role client, strictly scoped to
// the owner (ctx.scopeUserId — the tenant guard), the owner's LLM plans one
// read-only SELECT + a chart spec, the query runs through the same worker-safe
// SQL executor the agent SQL tool uses, and the result becomes a chart widget.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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
}): Promise<EmbedWidget | null> {
  try {
    // Service-role client, strictly scoped to the owner (tenant guard).
    const ctx = {
      userId: opts.ownerId,
      sb: supabaseAdmin,
      scopeUserId: opts.ownerId,
    } as AgentToolContext;

    const schema = await describeUserTables(ctx);
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

    const raw = JSON.parse(await runSqlQuery(ctx, { sql })) as {
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
