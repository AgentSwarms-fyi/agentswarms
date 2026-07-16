// Triggered nudge: invite a learner to the (free) Agentic AI Practitioner exam
// once they've crossed a clear readiness milestone. Each send is 1:1 and
// triggered by THIS user's own action (a quiz pass / agent build), which is
// what keeps it on the transactional side rather than a marketing blast.
//
// Predicate (ALL must hold):
//   - >= 4 of 6 track quizzes passed
//   - >= 3 self-built agents (templates/demos don't count)
//   - no exam attempt yet
//   - no prior cert-ready send (idempotency)
import { supabase } from "@/integrations/supabase/client";
import { sendTransactionalEmail } from "@/lib/email/send";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

const REQUIRED_TRACKS_PASSED = 4;
const REQUIRED_AGENTS = 3;
const TEMPLATE_NAME = "cert-ready";

const SWARM_TEMPLATE_TITLES = new Set(SWARM_TEMPLATES.map((t) => t.title));

function isTemplateAgent(a: { name: string; description: string | null }): boolean {
  if (a.description && /\[demo:[^\]]+\]/.test(a.description)) return true;
  if (a.name && a.name.startsWith("Demo · ")) return true;
  return false;
}

function isTemplateSwarm(s: { name: string }): boolean {
  return SWARM_TEMPLATE_TITLES.has(s.name);
}

/**
 * Best-effort: if the current user just crossed the readiness bar, fire the
 * one-time cert-ready transactional nudge. Safe to call from any client-side
 * "user did something useful" hook — quiet on every failure path.
 */
export async function maybeSendCertReadyEmail(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return;

    // 1. Has the user already attempted the exam? If so, skip.
    const { data: examAttempt } = await supabase
      .from("exam_attempts")
      .select("id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (examAttempt) return;

    // 2. Count distinct passed tracks.
    const { data: attempts } = await supabase
      .from("quiz_attempts")
      .select("track_id,passed")
      .eq("user_id", user.id);
    const passedTracks = new Set(
      (attempts ?? []).filter((a) => a.passed).map((a) => a.track_id),
    );
    if (passedTracks.size < REQUIRED_TRACKS_PASSED) return;

    // 3. Count self-built agents.
    const { data: agents } = await supabase
      .from("agents")
      .select("id,name,description")
      .eq("user_id", user.id);
    const selfBuiltAgents = (agents ?? []).filter(
      (a) => !isTemplateAgent(a as { name: string; description: string | null }),
    );
    if (selfBuiltAgents.length < REQUIRED_AGENTS) return;

    // 4. Server-side idempotency: the send route stamps every send into
    //    email_send_log with template_name = "cert-ready". The route is
    //    service-role, so we can't read the log directly from the browser —
    //    instead we let the server route's own idempotencyKey deduplicate.
    //    Attempts after the first will be no-ops on the server side.
    await sendTransactionalEmail({
      templateName: TEMPLATE_NAME,
      recipientEmail: user.email,
      idempotencyKey: `cert-ready-${user.id}`,
      templateData: {
        recipient:
          (user.user_metadata?.full_name as string | undefined)?.split(" ")[0] ||
          user.email.split("@")[0],
        passedTracks: passedTracks.size,
        agentCount: selfBuiltAgents.length,
      },
    });
  } catch (err) {
    // Never let a failed nudge break the action that triggered it.
    console.warn("cert-ready nudge skipped:", err);
  }
}
