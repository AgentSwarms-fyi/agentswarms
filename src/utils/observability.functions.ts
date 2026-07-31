import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MODELS = [
  { provider: "openai", model: "openai/gpt-5", inCost: 1.25e-6, outCost: 1.0e-5 },
  { provider: "openai", model: "openai/gpt-5-mini", inCost: 2.5e-7, outCost: 2.0e-6 },
  { provider: "anthropic", model: "anthropic/claude-sonnet-4", inCost: 3.0e-6, outCost: 1.5e-5 },
  { provider: "google", model: "google/gemini-2.5-pro", inCost: 1.25e-6, outCost: 5.0e-6 },
  { provider: "google", model: "google/gemini-2.5-flash", inCost: 7.5e-8, outCost: 3.0e-7 },
  { provider: "local", model: "local/llama-3.1-70b", inCost: 0, outCost: 0 },
];

const AGENTS = [
  { name: "Support Bot", avatar: "🤖" },
  { name: "Research Swarm", avatar: "🔬" },
  { name: "Code Reviewer", avatar: "💻" },
  { name: "Content Writer", avatar: "✍️" },
  { name: "Data Analyst", avatar: "📊" },
  { name: "DevOps Bot", avatar: "⚙️" },
];

const PROMPTS = [
  "Summarize the latest customer feedback from this week",
  "Review the pull request and check for security issues",
  "Generate a weekly status report for engineering",
  "Analyze yesterday's signup funnel drop-off",
  "Draft a follow-up email to enterprise lead Acme Corp",
  "Refactor the auth middleware to support OAuth refresh tokens",
  "Find regressions in latency between v2.3 and v2.4",
  "Translate the onboarding docs into Spanish and German",
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const seedTraces = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // Check if already seeded
    const { count } = await supabase
      .from("execution_traces")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) > 50) {
      return { seeded: false, message: "Traces already exist" };
    }

    const rows: any[] = [];
    const now = Date.now();

    // Generate 30 days of traces, ~10-30 per day
    for (let day = 29; day >= 0; day--) {
      const perDay = randInt(8, 28);
      for (let i = 0; i < perDay; i++) {
        const m = rand(MODELS);
        const a = rand(AGENTS);
        const tokensIn = randInt(200, 4000);
        const tokensOut = randInt(80, 1500);
        const cost = tokensIn * m.inCost + tokensOut * m.outCost;
        const isError = Math.random() < 0.06;
        const ts = now - day * 86400000 - randInt(0, 86400000);
        const prompt = rand(PROMPTS);

        rows.push({
          user_id: userId,
          agent_name: a.name,
          llm_provider: m.provider,
          llm_model: m.model,
          latency_ms: randInt(180, 4500),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: Number(cost.toFixed(6)),
          status: isError ? "error" : "success",
          prompt,
          request_payload: {
            model: m.model,
            messages: [
              { role: "system", content: `You are ${a.name}, a helpful AI agent.` },
              { role: "user", content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 4096,
          },
          response_payload: isError
            ? { error: "rate_limit_exceeded", code: 429 }
            : {
                id: `chatcmpl_${Math.random().toString(36).slice(2, 10)}`,
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Here is the analysis you requested...",
                    },
                  },
                ],
                usage: {
                  prompt_tokens: tokensIn,
                  completion_tokens: tokensOut,
                  total_tokens: tokensIn + tokensOut,
                },
              },
          tool_calls:
            Math.random() < 0.4
              ? [
                  {
                    name: rand(["web_search", "calculator", "sql_query", "send_email"]),
                    arguments: { query: prompt.slice(0, 30) },
                  },
                ]
              : [],
          error_message: isError ? "Rate limit exceeded for model" : null,
          created_at: new Date(ts).toISOString(),
        });
      }
    }

    // Insert in batches
    for (let i = 0; i < rows.length; i += 200) {
      await supabase.from("execution_traces").insert(rows.slice(i, i + 200));
    }

    return { seeded: true, count: rows.length };
  });
