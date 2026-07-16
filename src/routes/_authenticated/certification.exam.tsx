// /certification/exam — the live 50-question certification exam.
// Flow:
//  1. Calls /api/exam/start to get a fresh attempt + 50 questions.
//  2. User answers MCQs and selects 5 agents + 2 swarms from their gallery.
//  3. Submits → /api/exam/submit-mcq scores MCQs server-side.
//  4. Calls /api/exam/evaluate which uses Gemini 2.5 Pro to score
//     agent + swarm configs, finalises pass/fail, issues a certificate.
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Award,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  GraduationCap,
  Loader2,
  Lock,
  Sparkles,
  Trophy,
  X,
  XCircle,
} from "lucide-react";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/certification/exam")({
  validateSearch: (search: Record<string, unknown>) => ({
    autostart: search.autostart === true || search.autostart === "true" || search.autostart === "1",
  }),
  component: ExamPage,
});

type Question = {
  id: string;
  question: string;
  options: string[];
  difficulty: string;
};

type AgentRow = { id: string; name: string; description: string | null; llm_model: string };
type SwarmRow = { id: string; name: string; description: string | null };

type MCQDetail = {
  id: string;
  question: string;
  options: string[];
  chosen_index: number;
  correct_index: number;
  chosen_text: string | null;
  correct_text: string | null;
  is_correct: boolean;
  explanation: string | null;
  difficulty: string;
};

type EvalItem = {
  id: string;
  name: string;
  score_pct: number;
  strengths: string[];
  weaknesses: string[];
};

type EvalScore = {
  score_pct: number;
  per_item: EvalItem[];
  feedback: string;
};

const REQUIRED_TRACKS_PASSED = 4;
const TOTAL_TRACKS = 6;
const EXAM_DURATION_SECONDS = 90 * 60; // 90 minutes
const MAX_AGENTS = 5;
const MAX_SWARMS = 2;

// Names of every built-in swarm template (used to exclude template-derived
// swarms from the certification picker — only candidate-built swarms count).
const SWARM_TEMPLATE_TITLES = new Set(SWARM_TEMPLATES.map((t) => t.title));

// Agents provisioned from a template carry "[demo:<id>]" in their description
// and are named "Demo · <Title>". Either signal disqualifies them.
function isTemplateAgent(a: AgentRow): boolean {
  if (a.description && /\[demo:[^\]]+\]/.test(a.description)) return true;
  if (a.name && a.name.startsWith("Demo · ")) return true;
  return false;
}

function isTemplateSwarm(s: SwarmRow): boolean {
  return SWARM_TEMPLATE_TITLES.has(s.name);
}

function ExamPage() {
  const navigate = useNavigate();
  const { autostart } = Route.useSearch();
  const [phase, setPhase] = useState<
    "loading" | "locked" | "intro" | "mcq" | "picker" | "evaluating" | "result"
  >("loading");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [weekLabel, setWeekLabel] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState(0);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [swarms, setSwarms] = useState<SwarmRow[]>([]);
  const [pickedAgents, setPickedAgents] = useState<Set<string>>(new Set());
  const [pickedSwarms, setPickedSwarms] = useState<Set<string>>(new Set());
  const [tracksPassed, setTracksPassed] = useState(0);
  const [result, setResult] = useState<{
    status: string;
    mcq_pct: number;
    mcq_score?: number;
    mcq_total?: number;
    agent_pct: number;
    swarm_pct: number;
    improvement_areas: string[];
    certificate_id: string | null;
    next_eligible_at: string | null;
    mcq_details?: MCQDetail[];
    agent_eval?: EvalScore;
    swarm_eval?: EvalScore;
    thresholds?: { mcq: number; agent: number; swarm: number };
  } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(EXAM_DURATION_SECONDS);
  const submitRef = useRef<(auto?: boolean) => void>(() => {});
  const timedOutRef = useRef(false);

  // Initial: load gallery + bring up intro
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        navigate({ to: "/login" });
        return;
      }
      const [aRes, sRes, qRes] = await Promise.all([
        supabase.from("agents").select("id,name,description,llm_model").eq("user_id", user.id),
        supabase.from("swarms").select("id,name,description").eq("user_id", user.id),
        supabase.from("quiz_attempts").select("track_id,score,total,passed").eq("user_id", user.id),
      ]);
      // Templates copied into the user's gallery don't reflect their own
      // skill — only count agents/swarms they personally built.
      const userAgents = ((aRes.data as AgentRow[]) ?? []).filter((a) => !isTemplateAgent(a));
      const userSwarms = ((sRes.data as SwarmRow[]) ?? []).filter((s) => !isTemplateSwarm(s));
      setAgents(userAgents);
      setSwarms(userSwarms);

      // Compute best-pass-per-track from quiz attempts
      const passedTracks = new Set<string>();
      (qRes.data ?? []).forEach((r) => {
        if (r.passed) passedTracks.add(r.track_id);
      });
      const passedCount = passedTracks.size;
      setTracksPassed(passedCount);

      if (passedCount < REQUIRED_TRACKS_PASSED) {
        setPhase("locked");
        return;
      }
      setPhase("intro");
    })();
  }, [navigate]);

  const startExam = async () => {
    setPhase("loading");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("You're signed out — please log in again.");
        navigate({ to: "/login" });
        return;
      }
      const r = await fetch("/api/exam/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        credentials: "include",
      });
      // Detect the preview auth-bridge redirect (different origin → opaque)
      if (r.type === "opaqueredirect" || r.redirected) {
        toast.error("Exam API is not reachable from this preview. Try the published site.");
        setPhase("intro");
        return;
      }
      let data: any = {};
      try {
        data = await r.json();
      } catch {
        /* non-JSON body */
      }
      if (!r.ok) {
        if (r.status === 429) {
          toast.error(
            `Cooldown active. Next attempt: ${new Date(data.next_eligible_at).toLocaleDateString()}.`,
          );
          navigate({ to: "/certification" });
          return;
        }
        toast.error(data.error || `Could not start exam (HTTP ${r.status})`);
        setPhase("intro");
        return;
      }
      if (!data.attempt_id || !Array.isArray(data.questions)) {
        toast.error("Exam server returned an invalid response");
        setPhase("intro");
        return;
      }
      setAttemptId(data.attempt_id);
      setWeekLabel(data.week_label);
      setQuestions(data.questions);
      setSecondsLeft(EXAM_DURATION_SECONDS);
      timedOutRef.current = false;
      setPhase("mcq");
    } catch (err) {
      console.error("[startExam] failed", err);
      toast.error(err instanceof Error ? err.message : "Could not reach exam server");
      setPhase("intro");
    }
  };

  useEffect(() => {
    if (phase !== "intro" || !autostart) return;
    void startExam();
  }, [autostart, phase]);

  const allAnswered =
    questions.length > 0 && questions.every((q) => typeof answers[q.id] === "number");
  const answeredCount = Object.keys(answers).length;
  const current = questions[cursor];

  const submit = async (auto = false) => {
    if (!auto) {
      if (pickedAgents.size !== MAX_AGENTS) {
        toast.error(`Select exactly ${MAX_AGENTS} agents`);
        return;
      }
      if (pickedSwarms.size !== MAX_SWARMS) {
        toast.error(`Select exactly ${MAX_SWARMS} swarms`);
        return;
      }
    }
    setPhase("evaluating");
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const submitRes = await fetch("/api/exam/submit-mcq", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        answers,
        selected_agent_ids: Array.from(pickedAgents),
        selected_swarm_ids: Array.from(pickedSwarms),
      }),
    });
    if (!submitRes.ok) {
      toast.error("Could not submit MCQ answers");
      setPhase(auto ? "result" : "picker");
      return;
    }

    const evalRes = await fetch("/api/exam/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ attempt_id: attemptId }),
    });
    const evalData = await evalRes.json();
    if (!evalRes.ok) {
      toast.error(evalData.error || "Evaluator failed");
      setPhase(auto ? "result" : "picker");
      return;
    }
    setResult(evalData);
    setPhase("result");
  };

  // Keep latest submit callable from the timer effect without re-binding
  submitRef.current = submit;

  // Abort the in-progress attempt — marks it abandoned with NO cooldown so
  // the user can immediately start a fresh attempt. Cooldowns are reserved
  // for actual exam failures.
  const abortExam = async () => {
    if (!attemptId) {
      navigate({ to: "/certification" });
      return;
    }
    try {
      const { error } = await supabase
        .from("exam_attempts")
        .update({
          status: "abandoned",
          submitted_at: new Date().toISOString(),
          next_eligible_at: null,
        })
        .eq("id", attemptId);
      if (error) throw error;
      toast.success("Exam aborted. You can retry anytime.");
    } catch (err) {
      console.error("[abortExam] failed", err);
      toast.error("Could not abort cleanly — returning to hub.");
    } finally {
      navigate({ to: "/certification" });
    }
  };

  // 90-minute countdown — runs only during MCQ + picker phases
  useEffect(() => {
    if (phase !== "mcq" && phase !== "picker") return;
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          if (!timedOutRef.current) {
            timedOutRef.current = true;
            toast.error("Time's up — submitting your exam now");
            submitRef.current?.(true);
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // ---------- RENDER ----------
  if (phase === "loading") {
    return (
      <div className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground">
        <div>
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Preparing your exam…
        </div>
      </div>
    );
  }

  if (phase === "locked") {
    const remaining = REQUIRED_TRACKS_PASSED - tracksPassed;
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-2xl border-2 border-amber-400/40 bg-amber-500/5 p-8">
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-400">
            <Lock className="h-3.5 w-3.5" /> Exam locked
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Pass the track quizzes first to unlock the exam
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            You've passed{" "}
            <strong className="text-foreground">
              {tracksPassed} / {TOTAL_TRACKS}
            </strong>{" "}
            track quizzes. You need at least{" "}
            <strong className="text-foreground">{REQUIRED_TRACKS_PASSED}</strong> passed (≥80% on
            each) before starting the certification exam.
            {remaining > 0 && (
              <>
                {" "}
                Just <strong className="text-foreground">{remaining}</strong> more{" "}
                {remaining === 1 ? "quiz" : "quizzes"} to go.
              </>
            )}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link to="/learn">
              <Button className="gap-1.5">
                <GraduationCap className="h-3.5 w-3.5" /> Go to curriculum & quizzes
              </Button>
            </Link>
            <Link to="/certification">
              <Button variant="outline" className="gap-1.5">
                <ArrowRight className="h-3.5 w-3.5" /> See your progress
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "intro") {
    return <IntroCard agents={agents.length} swarms={swarms.length} onStart={startExam} />;
  }

  if (phase === "mcq") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Question set: {weekLabel}</Badge>
          <div className="flex items-center gap-3">
            <CountdownPill seconds={secondsLeft} />
            <span>
              {answeredCount} / {questions.length} answered
            </span>
            <AbortExamButton onAbort={abortExam} />
          </div>
        </div>
        <Progress value={(answeredCount / questions.length) * 100} className="mb-6 h-1.5" />

        {current && (
          <div className="rounded-2xl border-2 border-primary/30 bg-card/60 p-6 shadow-md">
            <div className="mb-4 flex items-center gap-2">
              <Badge>
                Q{cursor + 1} / {questions.length}
              </Badge>
              <Badge variant="outline" className="capitalize">
                {current.difficulty}
              </Badge>
            </div>
            <h2 className="text-lg font-bold leading-snug">{current.question}</h2>
            <div className="mt-5 grid gap-2">
              {current.options.map((opt, i) => {
                const selected = answers[current.id] === i;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAnswers((p) => ({ ...p, [current.id]: i }))}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left text-sm transition-all",
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border/60 hover:border-primary/50 hover:bg-muted/30",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="flex-1">{opt}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={cursor === 0}
            onClick={() => setCursor((c) => c - 1)}
            className="gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          {cursor < questions.length - 1 ? (
            <Button size="sm" onClick={() => setCursor((c) => c + 1)} className="gap-1">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!allAnswered}
              onClick={() => setPhase("picker")}
              className="gap-1"
            >
              Continue to agent + swarm picker <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (phase === "picker") {
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">Submit your build portfolio</h1>
          <div className="flex items-center gap-3">
            <CountdownPill seconds={secondsLeft} />
            <AbortExamButton onAbort={abortExam} />
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Select <strong>exactly {MAX_AGENTS} agents</strong> and{" "}
          <strong>exactly {MAX_SWARMS} swarms</strong> from your own builds for AI evaluation. Demo
          agents and template swarms are intentionally hidden — only things you built yourself
          count. The evaluator (Gemini 2.5 Pro) scores prompt clarity, tool selection, guardrails,
          swarm topology, and production-readiness.
        </p>

        <Section
          title={`Pick ${MAX_AGENTS} agents (${pickedAgents.size} / ${MAX_AGENTS})`}
          empty={
            agents.length === 0
              ? "You haven't built any agents of your own yet — head to /agents and create one."
              : null
          }
        >
          {agents.map((a) => {
            const checked = pickedAgents.has(a.id);
            const atCap = pickedAgents.size >= MAX_AGENTS;
            const disabled = !checked && atCap;
            return (
              <PickerCard
                key={a.id}
                checked={checked}
                disabled={disabled}
                onChange={(c) => {
                  if (c && pickedAgents.size >= MAX_AGENTS) {
                    toast.error(`You can only select ${MAX_AGENTS} agents`);
                    return;
                  }
                  setPickedAgents((s) => {
                    const next = new Set(s);
                    if (c) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  });
                }}
                title={a.name}
                subtitle={a.llm_model}
                desc={a.description}
              />
            );
          })}
        </Section>

        <Section
          title={`Pick ${MAX_SWARMS} swarms (${pickedSwarms.size} / ${MAX_SWARMS})`}
          empty={
            swarms.length === 0
              ? "You haven't built any swarms of your own yet — head to /swarms and create one."
              : null
          }
        >
          {swarms.map((s) => {
            const checked = pickedSwarms.has(s.id);
            const atCap = pickedSwarms.size >= MAX_SWARMS;
            const disabled = !checked && atCap;
            return (
              <PickerCard
                key={s.id}
                checked={checked}
                disabled={disabled}
                onChange={(c) => {
                  if (c && pickedSwarms.size >= MAX_SWARMS) {
                    toast.error(`You can only select ${MAX_SWARMS} swarms`);
                    return;
                  }
                  setPickedSwarms((p) => {
                    const next = new Set(p);
                    if (c) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  });
                }}
                title={s.name}
                desc={s.description}
              />
            );
          })}
        </Section>

        <div className="mt-6 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => setPhase("mcq")}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Back to MCQs
          </Button>
          <Button
            onClick={() => submit(false)}
            disabled={pickedAgents.size !== MAX_AGENTS || pickedSwarms.size !== MAX_SWARMS}
            className="gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" /> Submit for evaluation
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "evaluating") {
    return (
      <div className="grid min-h-[60vh] place-items-center text-center text-sm">
        <div>
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
          <h2 className="text-lg font-bold">Evaluating your submission</h2>
          <p className="mt-1 text-muted-foreground">
            Gemini 2.5 Pro is scoring your agents + swarms. This usually takes 20–40 seconds.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "result" && result) {
    const passed = result.status === "passed";
    const thresholds = result.thresholds ?? { mcq: 80, agent: 60, swarm: 40 };
    const mcqDetails = result.mcq_details ?? [];
    const correctCount = mcqDetails.filter((d) => d.is_correct).length;
    const wrongDetails = mcqDetails.filter((d) => !d.is_correct);
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 space-y-6">
        <div
          className={cn(
            "rounded-2xl border-2 p-8 shadow-lg",
            passed ? "border-emerald-400/40 bg-emerald-500/5" : "border-rose-400/40 bg-rose-500/5",
          )}
        >
          {passed ? (
            <Trophy className="h-10 w-10 text-amber-500" />
          ) : (
            <XCircle className="h-10 w-10 text-rose-500" />
          )}
          <h1 className="mt-3 text-3xl font-extrabold">
            {passed ? "Congratulations — you passed!" : "Not quite there yet"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {passed
              ? "Your AgentSwarms — Agentic AI Practitioner certificate has been issued."
              : `You can retry after ${result.next_eligible_at ? new Date(result.next_eligible_at).toLocaleDateString() : "the cooldown"}. The next exam will use a different question set.`}
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Score
              label={`Multiple-choice (need ≥${thresholds.mcq}%)`}
              value={`${result.mcq_pct}%`}
              ok={result.mcq_pct >= thresholds.mcq}
            />
            <Score
              label={`Agent builds (need ≥${thresholds.agent}%)`}
              value={`${result.agent_pct}%`}
              ok={result.agent_pct >= thresholds.agent}
            />
            <Score
              label={`Swarm design (need ≥${thresholds.swarm}%)`}
              value={`${result.swarm_pct}%`}
              ok={result.swarm_pct >= thresholds.swarm}
            />
          </div>

          {!passed && result.improvement_areas.length > 0 && (
            <div className="mt-6 rounded-md border border-border/60 bg-background/60 p-4 text-sm">
              <p className="font-bold">Where to focus next:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {result.improvement_areas.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            {passed && result.certificate_id && (
              <>
                <Button asChild className="gap-1.5">
                  <a
                    href={`/api/certificate/${result.certificate_id}?v=2026-06-02`}
                    onClick={async (e) => {
                      e.preventDefault();
                      const {
                        data: { session },
                      } = await supabase.auth.getSession();
                      const r = await fetch(
                        `/api/certificate/${result.certificate_id}?v=2026-06-02`,
                        {
                          cache: "no-store",
                          headers: { Authorization: `Bearer ${session?.access_token}` },
                        },
                      );
                      const blob = await r.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "AgentSwarms-Certificate.pdf";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Award className="h-3.5 w-3.5" /> Download certificate (PDF)
                  </a>
                </Button>
                <AddToLinkedInButton certificateId={result.certificate_id} />
              </>
            )}
            <Link to="/certification">
              <Button variant="outline">Back to certification hub</Button>
            </Link>
          </div>
        </div>

        {/* MCQ breakdown */}
        {mcqDetails.length > 0 && (
          <div className="rounded-2xl border border-border/50 bg-card/40 p-6">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-extrabold">Multiple-choice breakdown</h2>
              <Badge variant="outline" className="text-xs">
                {correctCount} correct · {wrongDetails.length} incorrect
              </Badge>
            </div>
            {wrongDetails.length > 0 && (
              <>
                <p className="text-xs uppercase tracking-wider text-rose-400/90 font-bold">
                  Questions you got wrong
                </p>
                <div className="mt-3 space-y-3">
                  {wrongDetails.map((d, i) => (
                    <McqRow key={d.id} index={i} detail={d} />
                  ))}
                </div>
              </>
            )}
            <details className="mt-5 group">
              <summary className="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground">
                Show all {mcqDetails.length} questions (including the {correctCount} you got right)
              </summary>
              <div className="mt-3 space-y-3">
                {mcqDetails.map((d, i) => (
                  <McqRow key={d.id} index={i} detail={d} />
                ))}
              </div>
            </details>
          </div>
        )}

        {/* Agent + swarm evaluator notes */}
        {result.agent_eval && result.agent_eval.per_item.length > 0 && (
          <EvalSection
            title="Agent evaluator notes"
            feedback={result.agent_eval.feedback}
            items={result.agent_eval.per_item}
          />
        )}
        {result.swarm_eval && result.swarm_eval.per_item.length > 0 && (
          <EvalSection
            title="Swarm evaluator notes"
            feedback={result.swarm_eval.feedback}
            items={result.swarm_eval.per_item}
          />
        )}
      </div>
    );
  }

  return null;
}

function IntroCard({
  agents,
  swarms,
  onStart,
}: {
  agents: number;
  swarms: number;
  onStart: () => void;
}) {
  const ready = agents >= MAX_AGENTS && swarms >= MAX_SWARMS;
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-2xl border-2 border-primary/30 bg-card/60 p-8">
        <h1 className="text-3xl font-extrabold tracking-tight">Ready to take the exam?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You'll answer 50 multiple-choice questions, then submit{" "}
          <strong className="text-foreground">{MAX_AGENTS} agents</strong> and{" "}
          <strong className="text-foreground">{MAX_SWARMS} swarms</strong> you built yourself for AI
          evaluation. Demo agents and template swarms don't count. You have{" "}
          <strong className="text-foreground">90 minutes</strong> to finish — a countdown will
          appear once you start, and the exam will auto-submit when time runs out. Pass thresholds:{" "}
          <strong>MCQ ≥ 80%</strong>, <strong>Agents ≥ 60%</strong>, <strong>Swarms ≥ 40%</strong>.
          Failed attempts have a 15-day cooldown.
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <ReadyRow label="Your own agents in gallery" current={agents} need={MAX_AGENTS} />
          <ReadyRow label="Your own swarms in gallery" current={swarms} need={MAX_SWARMS} />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onStart();
            }}
            disabled={!ready}
            className="gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" /> Begin exam
          </Button>
          <Button asChild type="button" variant="outline">
            <Link to="/certification">Cancel</Link>
          </Button>
        </div>
        {!ready && (
          <p className="mt-3 text-xs text-amber-400">
            Build at least {MAX_AGENTS} agents and {MAX_SWARMS} swarms of your own (template demos
            don't count) before starting the exam.
          </p>
        )}
      </div>
    </div>
  );
}

function ReadyRow({ label, current, need }: { label: string; current: number; need: number }) {
  const ok = current >= need;
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        ok ? "border-emerald-400/40 bg-emerald-500/5" : "border-amber-400/40 bg-amber-500/5",
      )}
    >
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-bold">
        {current} / {need}
      </p>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6">
      <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {empty ? (
        <p className="mt-2 rounded-md border border-amber-400/40 bg-amber-500/5 p-3 text-sm text-amber-400">
          {empty}
        </p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{children}</div>
      )}
    </div>
  );
}

function PickerCard({
  checked,
  onChange,
  title,
  subtitle,
  desc,
  disabled = false,
}: {
  checked: boolean;
  onChange: (c: boolean) => void;
  title: string;
  subtitle?: string;
  desc?: string | null;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-sm transition-colors",
        disabled
          ? "cursor-not-allowed opacity-50 border-border/60"
          : checked
            ? "cursor-pointer border-primary bg-primary/10"
            : "cursor-pointer border-border/60 hover:border-primary/50",
      )}
      title={
        disabled ? "Selection limit reached — uncheck another to change your picks" : undefined
      }
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(!!v)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <p className="font-semibold">{title}</p>
        {subtitle && (
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{subtitle}</p>
        )}
        {desc && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{desc}</p>}
      </div>
    </label>
  );
}

function Score({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border p-4 text-center",
        ok ? "border-emerald-400/40 bg-emerald-500/10" : "border-rose-400/40 bg-rose-500/10",
      )}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
    </div>
  );
}

function CountdownPill({ seconds }: { seconds: number }) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const danger = seconds <= 5 * 60;
  const warning = !danger && seconds <= 15 * 60;
  return (
    <div
      role="timer"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold tabular-nums tracking-wider",
        danger
          ? "border-rose-400/50 bg-rose-500/10 text-rose-400 animate-pulse"
          : warning
            ? "border-amber-400/50 bg-amber-500/10 text-amber-400"
            : "border-primary/40 bg-primary/10 text-primary",
      )}
    >
      <Clock className="h-3.5 w-3.5" />
      {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </div>
  );
}

function AbortExamButton({ onAbort }: { onAbort: () => void | Promise<void> }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 border-rose-400/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-400"
        >
          <XCircle className="h-3.5 w-3.5" /> Abort exam
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Abort this exam attempt?</AlertDialogTitle>
          <AlertDialogDescription>
            Your answers and selections will be discarded. No cooldown applies — you can start a
            fresh attempt right away.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel type="button">Keep going</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            onClick={() => {
              void onAbort();
            }}
            className="bg-rose-500 text-white hover:bg-rose-500/90"
          >
            Abort and exit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function McqRow({ index, detail }: { index: number; detail: MCQDetail }) {
  const ok = detail.is_correct;
  return (
    <div
      className={cn(
        "rounded-lg border p-4 text-sm",
        ok ? "border-emerald-400/30 bg-emerald-500/5" : "border-rose-400/30 bg-rose-500/5",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={cn(
            "mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
            ok ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400",
          )}
        >
          {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
              Q{index + 1}
            </span>
            <Badge variant="outline" className="text-[10px] capitalize">
              {detail.difficulty}
            </Badge>
          </div>
          <p className="mt-1 font-semibold text-foreground">{detail.question}</p>
          <div className="mt-3 space-y-1.5 text-xs">
            <p>
              <span className="text-muted-foreground">Your answer:</span>{" "}
              {detail.chosen_text ? (
                <span className={ok ? "text-emerald-400 font-medium" : "text-rose-400 font-medium"}>
                  {detail.chosen_text}
                </span>
              ) : (
                <span className="italic text-muted-foreground">Not answered</span>
              )}
            </p>
            {!ok && (
              <p>
                <span className="text-muted-foreground">Correct answer:</span>{" "}
                <span className="text-emerald-400 font-medium">{detail.correct_text}</span>
              </p>
            )}
          </div>
          {detail.explanation && (
            <p className="mt-3 rounded-md border border-border/50 bg-background/60 p-2.5 text-xs text-muted-foreground">
              <strong className="text-foreground">Why:</strong> {detail.explanation}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function EvalSection({
  title,
  feedback,
  items,
}: {
  title: string;
  feedback: string;
  items: EvalItem[];
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card/40 p-6">
      <h2 className="text-lg font-extrabold">{title}</h2>
      {feedback && (
        <p className="mt-2 rounded-md border border-border/50 bg-background/60 p-3 text-sm text-muted-foreground">
          {feedback}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {items.map((it) => {
          const tone =
            it.score_pct >= 70
              ? "border-emerald-400/30 bg-emerald-500/5"
              : it.score_pct >= 50
                ? "border-amber-400/30 bg-amber-500/5"
                : "border-rose-400/30 bg-rose-500/5";
          return (
            <div key={it.id} className={cn("rounded-lg border p-4", tone)}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{it.name}</p>
                <Badge variant="outline" className="text-xs font-bold tabular-nums">
                  {it.score_pct}%
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs">
                {it.strengths.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider font-bold text-emerald-400/90">
                      Strengths
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {it.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {it.weaknesses.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider font-bold text-rose-400/90">
                      To improve
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {it.weaknesses.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// LinkedIn "Add to profile" deep-link. Fetches the cert row to populate
// the credential name/issuer/issue-date/verification URL into LinkedIn's
// add-to-profile form. Falls back to a plain link if the lookup fails.
function AddToLinkedInButton({ certificateId }: { certificateId: string }) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("certificates")
        .select("verification_code,issued_at,organization")
        .eq("id", certificateId)
        .maybeSingle();
      if (!data) return;
      const issued = new Date(data.issued_at);
      const certUrl = `https://agentswarms.fyi/verify/${data.verification_code}`;
      const params = new URLSearchParams({
        startTask: "CERTIFICATION_NAME",
        name: "Agentic AI Practitioner",
        organizationName: "AgentSwarms — Agentic AI Lab",
        issueYear: String(issued.getUTCFullYear()),
        issueMonth: String(issued.getUTCMonth() + 1),
        certUrl,
        certId: data.verification_code,
      });
      setHref(`https://www.linkedin.com/profile/add?${params.toString()}`);
    })();
  }, [certificateId]);

  return (
    <Button
      asChild
      variant="outline"
      className="gap-1.5 border-[#0a66c2]/40 text-[#0a66c2] hover:bg-[#0a66c2]/10 hover:text-[#0a66c2]"
      disabled={!href}
    >
      <a
        href={href ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!href) e.preventDefault();
        }}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
          <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
        </svg>
        Add to LinkedIn
      </a>
    </Button>
  );
}
