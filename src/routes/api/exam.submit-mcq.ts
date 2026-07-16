// POST /api/exam/submit-mcq
// Server-side scores the MCQ answers (client never sees correct indices)
// and saves them to the attempt. Does NOT finalise pass/fail — that
// happens after agent/swarm submission via /api/exam/evaluate.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const Route = createFileRoute("/api/exam/submit-mcq")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json().catch(() => ({}))) as {
          attempt_id?: string;
          answers?: Record<string, number>;
          selected_agent_ids?: string[];
          selected_swarm_ids?: string[];
        };
        if (!body.attempt_id || !body.answers) return json({ error: "Bad request" }, 400);

        const supabase = createClient(
          import.meta.env.VITE_SUPABASE_URL!,
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
          { global: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const {
          data: { user },
        } = await supabase.auth.getUser();
        const TEST_OVERRIDE_EMAILS = new Set([import.meta.env.ADMIN_EMAIL.toLowerCase()]);
        const isTestOverride = !!user?.email && TEST_OVERRIDE_EMAILS.has(user.email.toLowerCase());

        const { data: attempt } = await supabase
          .from("exam_attempts")
          .select("set_id,user_id,status")
          .eq("id", body.attempt_id)
          .maybeSingle();
        if (!attempt) return json({ error: "Attempt not found" }, 404);
        if (attempt.status !== "in_progress")
          return json({ error: "Attempt already submitted" }, 409);

        const { data: set } = await supabase
          .from("exam_question_sets")
          .select("questions")
          .eq("id", attempt.set_id)
          .maybeSingle();
        if (!set) return json({ error: "Question set missing" }, 500);

        let score = 0;
        const total = (set.questions as any[]).length;
        const detailed: Array<{ id: string; chosen: number; correct: number }> = [];
        (set.questions as any[]).forEach((q: any, i: number) => {
          const id = q.id ?? `q-${i + 1}`;
          const chosen = body.answers![id];
          const correct = q.correct_index ?? q.correct ?? q.answer ?? -1;
          detailed.push({ id, chosen: chosen ?? -1, correct });
          if (chosen === correct) score++;
        });

        // Test override: QA accounts always score full marks so we can
        // verify the certificate + LinkedIn flow end-to-end.
        if (isTestOverride) {
          score = total;
        }

        await supabase
          .from("exam_attempts")
          .update({
            mcq_answers: detailed as any,
            mcq_score: score,
            mcq_total: total,
            selected_agent_ids: body.selected_agent_ids ?? [],
            selected_swarm_ids: body.selected_swarm_ids ?? [],
            status: "evaluating",
          })
          .eq("id", body.attempt_id);

        return json({ score, total, pct: total ? Math.round((score / total) * 100) : 0 });
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
