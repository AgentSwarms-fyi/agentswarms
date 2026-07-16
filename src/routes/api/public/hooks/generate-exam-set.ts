// POST /api/public/hooks/generate-exam-set
// Public hook (called by pg_cron weekly) that uses an LLM to generate a
// fresh 50-question MCQ set covering LLM internals, agentic patterns,
// guardrails, Responsible AI, memory, SQL agents, swarms, and scaling.
// Inserts the new set into exam_question_sets and (optionally) deactivates
// the oldest non-seed set so the rotating bank stays bounded.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

const MODEL = "google/gemini-2.5-pro";
const MAX_ACTIVE_SETS = 12; // ~3 months of weekly sets

const SYSTEM = `You are a senior curriculum designer for an Agentic AI certification.
Produce exactly 50 multiple-choice questions covering this distribution:
  • 10 — LLM internals (tokens, temperature, context window, sampling, embeddings)
  • 10 — Agentic patterns (ReAct, Reflection, Planner-Executor, Tool Use, Routing, Multi-Agent, HITL)
  • 8  — Guardrails (PII, prompt injection, jailbreaks, output validation, refusals)
  • 6  — Responsible AI (NIST AI RMF, EU AI Act, bias, transparency, accountability)
  • 6  — Agent memory (STM, LTM, summarization, recall strategies)
  • 4  — Text-to-SQL agents (schema grounding, query safety, validation)
  • 4  — Multi-agent swarms (orchestrator vs peer-to-peer, hand-offs, observability)
  • 2  — Scaling & cost (caching, batching, fallback, budget control)

Difficulty mix: 20 easy, 20 medium, 10 hard.
Each question must have exactly 4 options and ONE correct answer.
Make questions practical and scenario-based where possible. Avoid trivia.
Distribute the correct answer roughly evenly across positions 0/1/2/3 — do NOT default to index 1.
Do NOT repeat questions you have generated before — vary the angle.`;

const USER_TEMPLATE = (weekLabel: string) => `Generate the question set for "${weekLabel}".
Return STRICT JSON only, no prose, of shape:
{
  "questions": [
    {
      "id": "q-1",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correct_index": 0,
      "difficulty": "easy" | "medium" | "hard",
      "topic": "llm" | "patterns" | "guardrails" | "rai" | "memory" | "sql" | "swarms" | "scaling"
    }
    // ... 50 items total, ids q-1 through q-50
  ]
}`;

export const Route = createFileRoute("/api/public/hooks/generate-exam-set")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Lightweight shared-secret check so randoms can't spam the generator.
        // pg_cron sends Authorization: Bearer <SUPABASE_ANON_KEY>; we accept that.
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        const expected = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        if (!token || token !== expected) {
          return json({ error: "Unauthorized" }, 401);
        }

        const apiKey = getOpenRouterApiKey();
        if (!apiKey) return json({ error: "OPENROUTER_API_KEY missing" }, 503);

        const now = new Date();
        const year = now.getUTCFullYear();
        const week = isoWeek(now);
        const weekLabel = `${year}-W${String(week).padStart(2, "0")}`;

        // Idempotency — if a set for this week already exists, skip.
        const { data: existing } = await supabaseAdmin
          .from("exam_question_sets")
          .select("id")
          .eq("week_label", weekLabel)
          .maybeSingle();
        if (existing) {
          return json({ skipped: true, reason: "already_exists", week_label: weekLabel });
        }

        let questions: unknown;
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
                { role: "system", content: SYSTEM },
                { role: "user", content: USER_TEMPLATE(weekLabel) },
              ],
              response_format: { type: "json_object" },
              temperature: 0.8,
            }),
          });
          if (!r.ok) {
            const txt = await r.text();
            return json(
              { error: `Generator returned ${r.status}`, detail: txt.slice(0, 500) },
              502,
            );
          }
          const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const text = data.choices?.[0]?.message?.content || "{}";
          const parsed = JSON.parse(text) as { questions?: unknown };
          questions = parsed.questions;
        } catch (e) {
          return json({ error: `Generator failed: ${String(e)}` }, 500);
        }

        if (!Array.isArray(questions) || questions.length < 40) {
          return json(
            {
              error: "Generator returned too few questions",
              got: Array.isArray(questions) ? questions.length : 0,
            },
            502,
          );
        }

        // Shuffle each question's options so the correct answer position is
        // uniformly distributed across A/B/C/D. LLMs tend to bias toward "B".
        const shuffled = (questions as Array<Record<string, unknown>>).map((q) => {
          const opts = Array.isArray(q.options) ? [...(q.options as unknown[])] : [];
          const ci = typeof q.correct_index === "number" ? q.correct_index : 0;
          if (opts.length < 2 || ci < 0 || ci >= opts.length) return q;
          const correctVal = opts[ci];
          // Fisher-Yates
          for (let i = opts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [opts[i], opts[j]] = [opts[j], opts[i]];
          }
          return { ...q, options: opts, correct_index: opts.indexOf(correctVal) };
        });

        const { data: inserted, error: insErr } = await supabaseAdmin
          .from("exam_question_sets")
          .insert({
            week_label: weekLabel,
            questions: shuffled as never,
            is_active: true,
            is_seed: false,
          })
          .select("id")
          .single();
        if (insErr || !inserted) {
          return json({ error: insErr?.message || "Insert failed" }, 500);
        }

        // Bound the active pool — deactivate oldest non-seed sets beyond the cap.
        const { data: actives } = await supabaseAdmin
          .from("exam_question_sets")
          .select("id,created_at,is_seed")
          .eq("is_active", true)
          .eq("is_seed", false)
          .order("created_at", { ascending: false });
        if (actives && actives.length > MAX_ACTIVE_SETS) {
          const stale = actives.slice(MAX_ACTIVE_SETS).map((s) => s.id);
          if (stale.length) {
            await supabaseAdmin
              .from("exam_question_sets")
              .update({ is_active: false })
              .in("id", stale);
          }
        }

        return json({
          ok: true,
          week_label: weekLabel,
          set_id: inserted.id,
          question_count: (questions as unknown[]).length,
        });
      },
    },
  },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ISO 8601 week number
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
