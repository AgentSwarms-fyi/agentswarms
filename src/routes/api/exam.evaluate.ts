// POST /api/exam/evaluate
// Authenticated endpoint. Given an exam_attempts row id, the server pulls the
// referenced agents + swarms from the user's gallery, formats them into a
// scorecard prompt, calls an LLM evaluator, and writes
// agent_eval / swarm_eval / evaluator_feedback / improvement_areas back to
// the attempt. The MCQ portion is scored client-side and persisted before
// this is called; this endpoint computes the agent + swarm scores and
// finalises status (passed / failed) plus the 15-day cooldown.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

const MODEL = "google/gemini-2.5-pro";

type EvalScore = {
  score_pct: number;
  per_item: Array<{
    id: string;
    name: string;
    score_pct: number;
    strengths: string[];
    weaknesses: string[];
  }>;
  feedback: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const Route = createFileRoute("/api/exam/evaluate")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);

        const userClient = createClient(
          import.meta.env.VITE_SUPABASE_URL!,
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
          { global: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const {
          data: { user },
        } = await userClient.auth.getUser();
        if (!user) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json().catch(() => ({}))) as { attempt_id?: string };
        if (!body.attempt_id) return json({ error: "attempt_id required" }, 400);

        const apiKey = getOpenRouterApiKey();
        if (!apiKey) return json({ error: "Evaluator unavailable" }, 503);

        // Load the attempt (RLS via user client guarantees ownership)
        const { data: attempt, error: attemptErr } = await userClient
          .from("exam_attempts")
          .select("*")
          .eq("id", body.attempt_id)
          .maybeSingle();
        if (attemptErr || !attempt) return json({ error: "Attempt not found" }, 404);

        // Pull the question set so we can build the per-question breakdown
        // (question text, correct option, user's pick, explanation) that the
        // result screen renders for the candidate's review.
        const { data: setRow } = await userClient
          .from("exam_question_sets")
          .select("questions")
          .eq("id", attempt.set_id)
          .maybeSingle();
        const questionMap = new Map<string, any>();
        ((setRow?.questions as any[]) ?? []).forEach((q: any, i: number) => {
          const id = q.id ?? `q-${i + 1}`;
          questionMap.set(id, q);
        });

        // Pull selected agents + swarms
        const [agentsRes, swarmsRes] = await Promise.all([
          userClient
            .from("agents")
            .select("id,name,description,system_prompt,llm_model,llm_provider,temperature,tools")
            .in("id", attempt.selected_agent_ids ?? []),
          userClient
            .from("swarms")
            .select("id,name,description,nodes,edges")
            .in("id", attempt.selected_swarm_ids ?? []),
        ]);
        const agents = agentsRes.data ?? [];
        const swarms = swarmsRes.data ?? [];

        // Test override: a small allowlist of internal QA accounts always
        // passes with full marks so we can verify the cert + LinkedIn flow
        // end-to-end without needing perfect agent/swarm builds.
        const TEST_OVERRIDE_EMAILS = new Set([import.meta.env.ADMIN_EMAIL.toLowerCase()]);
        const isTestOverride = !!user.email && TEST_OVERRIDE_EMAILS.has(user.email.toLowerCase());

        let agentEval: EvalScore;
        let swarmEval: EvalScore;
        if (isTestOverride) {
          agentEval = {
            score_pct: 100,
            per_item: agents.map((a: any) => ({
              id: a.id,
              name: a.name,
              score_pct: 100,
              strengths: ["Test override — full marks granted for QA flow"],
              weaknesses: [],
            })),
            feedback: "Test-account override: agent evaluation skipped.",
          };
          swarmEval = {
            score_pct: 100,
            per_item: swarms.map((s: any) => ({
              id: s.id,
              name: s.name,
              score_pct: 100,
              strengths: ["Test override — full marks granted for QA flow"],
              weaknesses: [],
            })),
            feedback: "Test-account override: swarm evaluation skipped.",
          };
        } else {
          // Run two evaluator calls in parallel
          [agentEval, swarmEval] = await Promise.all([
            evaluate(apiKey, "agents", agents),
            evaluate(apiKey, "swarms", swarms),
          ]);
        }

        const mcqPct = isTestOverride
          ? 100
          : attempt.mcq_total > 0
            ? Math.round((attempt.mcq_score / attempt.mcq_total) * 100)
            : 0;
        // Pass thresholds — lowered for agents (80→60) and swarms (50→40)
        // to better reflect the difficulty of building production-grade
        // builds while still requiring a strong MCQ score.
        const PASS_MCQ = 80;
        const PASS_AGENT = 60;
        const PASS_SWARM = 40;
        const passed = isTestOverride
          ? true
          : mcqPct >= PASS_MCQ &&
            agentEval.score_pct >= PASS_AGENT &&
            swarmEval.score_pct >= PASS_SWARM;

        const improvementAreas: string[] = [];
        if (mcqPct < PASS_MCQ)
          improvementAreas.push(`MCQ score ${mcqPct}% — review weak topics in the curriculum`);
        if (agentEval.score_pct < PASS_AGENT)
          improvementAreas.push(
            `Agent quality ${agentEval.score_pct}% — strengthen system prompts, tool selection, and guardrails`,
          );
        if (swarmEval.score_pct < PASS_SWARM)
          improvementAreas.push(
            `Swarm design ${swarmEval.score_pct}% — improve orchestration and handoffs`,
          );

        const status = passed ? "passed" : "failed";
        const next_eligible_at = passed
          ? null
          : new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

        const overallFeedback =
          `Overall: ${passed ? "PASSED" : "Did not pass"}.\n\n` +
          `MCQ: ${mcqPct}% (need ≥${PASS_MCQ}%).\n` +
          `Agents: ${agentEval.score_pct}% (need ≥${PASS_AGENT}%).\n` +
          `Swarms: ${swarmEval.score_pct}% (need ≥${PASS_SWARM}%).\n\n` +
          `Agent evaluator: ${agentEval.feedback}\n\n` +
          `Swarm evaluator: ${swarmEval.feedback}`;

        // Build a question-by-question breakdown for the result screen.
        // mcq_answers was persisted by /api/exam/submit-mcq as
        // [{id, chosen, correct}] — we enrich each entry with the question
        // text, option labels, and explanation from the source set.
        const mcqDetails = ((attempt.mcq_answers as any[]) ?? []).map((a: any) => {
          const q = questionMap.get(a.id);
          const options: string[] = q?.options ?? [];
          const correctIndex = typeof a.correct === "number" ? a.correct : -1;
          const chosenIndex = typeof a.chosen === "number" ? a.chosen : -1;
          return {
            id: a.id,
            question: q?.question ?? q?.q ?? "",
            options,
            chosen_index: chosenIndex,
            correct_index: correctIndex,
            chosen_text: chosenIndex >= 0 ? (options[chosenIndex] ?? null) : null,
            correct_text: correctIndex >= 0 ? (options[correctIndex] ?? null) : null,
            is_correct: chosenIndex === correctIndex,
            explanation: q?.explanation ?? null,
            difficulty: q?.difficulty ?? "medium",
          };
        });

        // Persist via service role (RLS-safe — we already verified ownership)
        await supabaseAdmin
          .from("exam_attempts")
          .update({
            status,
            agent_eval: agentEval as any,
            swarm_eval: swarmEval as any,
            evaluator_feedback: overallFeedback,
            improvement_areas: improvementAreas as any,
            submitted_at: new Date().toISOString(),
            next_eligible_at,
          })
          .eq("id", attempt.id);

        // Issue certificate if passed
        let certificate_id: string | null = null;
        if (passed) {
          const { data: profile } = await userClient
            .from("profiles")
            .select("display_name,first_name,last_name,organization,designation")
            .eq("user_id", user.id)
            .maybeSingle();
          // Resolve a real human name for the certificate. Priority:
          //   1. profiles.first_name + profiles.last_name (preferred — collected at signup)
          //   2. profiles.display_name (user-edited)
          //   3. auth user_metadata full_name / name (set by OAuth or signup)
          //   4. email local-part with separators replaced + title-cased
          //   5. "Certified Practitioner" as last-resort fallback
          const firstName = (profile?.first_name ?? "").trim();
          const lastName = (profile?.last_name ?? "").trim();
          const fullFromProfile = firstName && lastName ? `${firstName} ${lastName}` : "";
          const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
          const metaName =
            (typeof meta.full_name === "string" && meta.full_name.trim()) ||
            (typeof meta.name === "string" && meta.name.trim()) ||
            "";
          const emailLocal = user.email?.split("@")[0] ?? "";
          const titleCasedFromEmail = emailLocal
            ? emailLocal
                .replace(/[._-]+/g, " ")
                .split(" ")
                .filter(Boolean)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(" ")
            : "";
          const nameOnCert =
            fullFromProfile ||
            (profile?.display_name && profile.display_name.trim()) ||
            metaName ||
            titleCasedFromEmail ||
            "Certified Practitioner";
          const code = `ASW-${new Date().getFullYear()}-${rand(6)}`;
          const { data: cert } = await supabaseAdmin
            .from("certificates")
            .insert({
              user_id: user.id,
              attempt_id: attempt.id,
              mcq_score: mcqPct,
              agent_score: agentEval.score_pct,
              swarm_score: swarmEval.score_pct,
              name_on_cert: nameOnCert,
              organization: profile?.organization ?? null,
              verification_code: code,
            })
            .select("id")
            .single();
          certificate_id = cert?.id ?? null;
        }

        return json({
          status,
          mcq_pct: mcqPct,
          mcq_score: attempt.mcq_score,
          mcq_total: attempt.mcq_total,
          agent_pct: agentEval.score_pct,
          swarm_pct: swarmEval.score_pct,
          improvement_areas: improvementAreas,
          certificate_id,
          next_eligible_at,
          mcq_details: mcqDetails,
          agent_eval: agentEval,
          swarm_eval: swarmEval,
          thresholds: { mcq: PASS_MCQ, agent: PASS_AGENT, swarm: PASS_SWARM },
        });
      },
    },
  },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function rand(n: number) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function evaluate(
  apiKey: string,
  kind: "agents" | "swarms",
  items: Array<Record<string, unknown>>,
): Promise<EvalScore> {
  if (!items || items.length === 0) {
    return { score_pct: 0, per_item: [], feedback: `No ${kind} submitted.` };
  }

  const rubric =
    kind === "agents"
      ? `You are an expert reviewer of AI agent configurations. For EACH agent, score 0-100.

CRITICAL — weight these two dimensions heavily (≥50% of the score combined):
  1. PROMPT QUALITY (25%): Is the system prompt specific, role-grounded, scoped, and unambiguous? Does it define tone, output format, refusal behavior, and edge-case handling? Vague or generic prompts ("You are a helpful assistant") MUST be penalised heavily.
  2. GUARDRAILS (25%): Does the prompt explicitly address PII handling, prompt-injection resistance, jailbreak refusals, output validation, scope boundaries, and what the agent must NOT do? Missing guardrails MUST be called out as a weakness.

Remaining dimensions (50% combined):
  - Appropriateness of model + temperature for the stated job
  - Tool selection (only the tools needed; no missing critical tools)
  - Production-readiness (error handling, structured output, observability)

For EVERY agent, the "strengths" and "weaknesses" arrays MUST contain at least one explicit item about prompt quality and one about guardrails (even if the comment is positive).`
      : `You are an expert reviewer of multi-agent swarm designs. For EACH swarm, score 0-100.

Weight these dimensions:
  - Topology fit (orchestrator vs peer-to-peer matches the use case) — 20%
  - Clear hand-off contracts between nodes — 20%
  - Per-node PROMPT QUALITY across the swarm (specific roles, scoped instructions, structured hand-off format) — 20%
  - GUARDRAILS at swarm level (input validation at entry node, refusal/escalation paths, HITL gates, scope limits between nodes) — 20%
  - Avoidance of loops/dead ends, non-overlapping responsibilities, observability (planner/critic/HITL) — 20%

For EVERY swarm, the "strengths" and "weaknesses" arrays MUST include at least one explicit item about node prompt quality and one about swarm-level guardrails.`;

  const prompt = `${rubric}

Return STRICT JSON of shape:
{
  "per_item": [{"id": "<id>", "name": "<name>", "score_pct": <0-100>, "strengths": ["..."], "weaknesses": ["..."]}],
  "feedback": "<3-4 sentence overall coaching summary that EXPLICITLY comments on prompt quality and guardrails across the submitted ${kind}>"
}

Items to review:
${JSON.stringify(items, null, 2)}`;

  try {
    const r = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: "You are a strict but fair certification evaluator. Always return valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (!r.ok) {
      return { score_pct: 0, per_item: [], feedback: `Evaluator error (${r.status}).` };
    }
    const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text) as { per_item?: EvalScore["per_item"]; feedback?: string };
    const per_item = parsed.per_item ?? [];
    const score_pct = per_item.length
      ? Math.round(per_item.reduce((a, b) => a + (b.score_pct || 0), 0) / per_item.length)
      : 0;
    return { score_pct, per_item, feedback: parsed.feedback || "" };
  } catch (e) {
    return { score_pct: 0, per_item: [], feedback: `Evaluator failed: ${String(e)}` };
  }
}
