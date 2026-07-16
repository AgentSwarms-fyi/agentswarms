// POST /api/exam/start
// Picks a random active question set the user hasn't recently used and
// creates a fresh exam_attempts row in status="in_progress".
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const Route = createFileRoute("/api/exam/start")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);

        const supabase = createClient(
          import.meta.env.VITE_SUPABASE_URL!,
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
          { global: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return json({ error: "Unauthorized" }, 401);

        // Cooldown check — block if any prior failed attempt has next_eligible_at in the future.
        const { data: blocking } = await supabase
          .from("exam_attempts")
          .select("next_eligible_at,status,submitted_at")
          .eq("user_id", user.id)
          .gt("next_eligible_at", new Date().toISOString())
          .order("next_eligible_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (blocking?.next_eligible_at) {
          return json({ error: "cooldown", next_eligible_at: blocking.next_eligible_at }, 429);
        }

        // Avoid the most recent set the student used
        const { data: lastAttempt } = await supabase
          .from("exam_attempts")
          .select("set_id")
          .eq("user_id", user.id)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastSetId = lastAttempt?.set_id ?? null;

        const { data: sets } = await supabase
          .from("exam_question_sets")
          .select("id,questions,week_label")
          .eq("is_active", true);
        const eligible = (sets ?? []).filter((s) => s.id !== lastSetId);
        const pool = eligible.length > 0 ? eligible : (sets ?? []);
        if (!pool.length) return json({ error: "No exam sets available" }, 503);
        const chosen = pool[Math.floor(Math.random() * pool.length)];

        const { data: attempt, error } = await supabase
          .from("exam_attempts")
          .insert({
            user_id: user.id,
            set_id: chosen.id,
            status: "in_progress",
            mcq_total: Array.isArray(chosen.questions) ? chosen.questions.length : 0,
          })
          .select("id")
          .single();
        if (error || !attempt) return json({ error: error?.message ?? "Could not start" }, 500);

        // Strip correct answers before returning to client
        const safeQuestions = (chosen.questions as any[]).map((q: any, i: number) => ({
          id: q.id ?? `q-${i + 1}`,
          question: q.question ?? q.q,
          options: q.options,
          difficulty: q.difficulty ?? "medium",
        }));

        return json({
          attempt_id: attempt.id,
          set_id: chosen.id,
          week_label: chosen.week_label,
          questions: safeQuestions,
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
