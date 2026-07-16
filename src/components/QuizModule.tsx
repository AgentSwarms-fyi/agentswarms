// QuizModule — drop-in 5-question MCQ for a curriculum track.
// - Loads questions for the given track_id from quiz_questions
// - Lets the user answer, then scores + shows explanations
// - Persists the attempt to quiz_attempts (passed when score >= 80%)
// - Shows the user's best previous score
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, XCircle, Loader2, Trophy, RefreshCw, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { maybeSendCertReadyEmail } from "@/lib/email/certReadyTrigger";

type QuizQuestion = {
  id: string;
  track_id: string;
  position: number;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  difficulty: string;
};

type Props = {
  trackId: string;
  trackTitle: string;
};

export function QuizModule({ trackId, trackTitle }: Props) {
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const [qRes, aRes] = await Promise.all([
        supabase
          .from("quiz_questions")
          .select("*")
          .eq("track_id", trackId)
          .order("position", { ascending: true })
          .limit(5),
        supabase
          .from("quiz_attempts")
          .select("score,total")
          .eq("track_id", trackId)
          .order("score", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (!mounted) return;
      if (qRes.error) {
        toast.error("Could not load quiz questions");
      } else {
        setQuestions((qRes.data as QuizQuestion[]) ?? []);
      }
      if (aRes.data) {
        setBestScore(Math.round((aRes.data.score / aRes.data.total) * 100));
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [trackId]);

  const total = questions.length;
  const allAnswered = total > 0 && questions.every((q) => typeof answers[q.id] === "number");

  const handleSubmit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    let s = 0;
    questions.forEach((q) => {
      if (answers[q.id] === q.correct_index) s++;
    });
    setScore(s);
    setSubmitted(true);
    const pct = total ? Math.round((s / total) * 100) : 0;
    const passed = pct >= 80;

    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { error } = await supabase.from("quiz_attempts").insert({
        user_id: user.id,
        track_id: trackId,
        answers: questions.map((q) => ({
          question_id: q.id,
          chosen: answers[q.id],
          correct: q.correct_index,
        })),
        score: s,
        total,
        passed,
      });
      if (error) {
        toast.error("Could not save your attempt");
      } else {
        if (passed) toast.success(`Passed ${trackTitle} quiz — ${pct}%`);
        // Notify other widgets (e.g. CurriculumProgress on the Welcome page)
        // that quiz progress changed so they refetch without a hard reload.
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("quiz-progress-updated", {
              detail: { trackId, pct, passed },
            }),
          );
        }
        // After a passed quiz, the user might have just crossed the
        // certification readiness bar — fire the (idempotent) nudge email.
        if (passed) {
          void maybeSendCertReadyEmail();
        }
      }
    }
    if (bestScore === null || pct > bestScore) setBestScore(pct);
    setSubmitting(false);
  };

  const handleRetry = () => {
    setAnswers({});
    setSubmitted(false);
    setScore(0);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border/50 bg-card/40 p-6 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto h-4 w-4 animate-spin" /> Loading quiz…
      </div>
    );
  }

  if (questions.length === 0) {
    return null;
  }

  const pct = total ? Math.round((score / total) * 100) : 0;
  const passed = pct >= 80;

  return (
    <div className="rounded-xl border-2 border-primary/30 bg-card/60 p-6 shadow-md">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
            <GraduationCap className="h-3 w-3" /> Track quiz
          </div>
          <h3 className="mt-2 text-lg font-bold tracking-tight">
            Check your understanding · {trackTitle}
          </h3>
          <p className="text-xs text-muted-foreground">
            5 multiple-choice questions. Pass at 80% to mark this track complete.
          </p>
        </div>
        {bestScore !== null && (
          <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Best</p>
            <p className="text-sm font-bold">
              {bestScore}%{" "}
              {bestScore >= 80 && <Trophy className="-mt-0.5 inline h-3.5 w-3.5 text-amber-500" />}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-5">
        {questions.map((q, idx) => {
          const chosen = answers[q.id];
          const isCorrect = submitted && chosen === q.correct_index;
          const isWrong = submitted && typeof chosen === "number" && chosen !== q.correct_index;
          return (
            <div
              key={q.id}
              className={cn(
                "rounded-lg border p-4 transition-colors",
                submitted && isCorrect && "border-emerald-400/50 bg-emerald-500/5",
                submitted && isWrong && "border-rose-400/50 bg-rose-500/5",
                !submitted && "border-border/60 bg-background/40",
              )}
            >
              <div className="flex items-start gap-3">
                <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
                  Q{idx + 1}
                </Badge>
                <p className="text-sm font-semibold leading-snug">{q.question}</p>
                <Badge variant="outline" className="ml-auto shrink-0 text-[10px] capitalize">
                  {q.difficulty}
                </Badge>
              </div>
              <div className="mt-3 grid gap-2">
                {q.options.map((opt, i) => {
                  const selected = chosen === i;
                  const showCorrect = submitted && i === q.correct_index;
                  const showWrongChoice = submitted && selected && i !== q.correct_index;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={submitted}
                      onClick={() => setAnswers((p) => ({ ...p, [q.id]: i }))}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-all",
                        !submitted && selected && "border-primary bg-primary/10",
                        !submitted && !selected && "border-border/60 hover:border-primary/50 hover:bg-muted/30",
                        showCorrect && "border-emerald-400 bg-emerald-500/10",
                        showWrongChoice && "border-rose-400 bg-rose-500/10",
                        submitted && !showCorrect && !showWrongChoice && "border-border/40 opacity-70",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] font-bold",
                          selected && !submitted && "border-primary bg-primary text-primary-foreground",
                          showCorrect && "border-emerald-500 bg-emerald-500 text-white",
                          showWrongChoice && "border-rose-500 bg-rose-500 text-white",
                        )}
                      >
                        {String.fromCharCode(65 + i)}
                      </span>
                      <span className="flex-1">{opt}</span>
                      {showCorrect && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      {showWrongChoice && <XCircle className="h-4 w-4 text-rose-500" />}
                    </button>
                  );
                })}
              </div>
              {submitted && q.explanation && (
                <p className="mt-3 rounded-md border border-border/40 bg-background/60 p-2 text-xs leading-relaxed text-muted-foreground">
                  <strong className="text-foreground">Why:</strong> {q.explanation}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!submitted ? (
        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {Object.keys(answers).length} / {total} answered
          </p>
          <Button onClick={handleSubmit} disabled={!allAnswered || submitting}>
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Submit answers
          </Button>
        </div>
      ) : (
        <div className="mt-5 rounded-lg border-2 p-4 text-sm"
          style={{ borderColor: passed ? "rgb(16 185 129 / 0.5)" : "rgb(244 63 94 / 0.5)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Result</p>
              <p className="text-2xl font-extrabold">
                {score} / {total} <span className="text-base font-medium text-muted-foreground">({pct}%)</span>
              </p>
            </div>
            <Badge className={cn("text-xs", passed ? "bg-emerald-500" : "bg-rose-500")}>
              {passed ? "Passed (≥80%)" : "Try again — need 80%"}
            </Badge>
          </div>
          <Progress value={pct} className="mt-3 h-2" />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRetry} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Retake quiz
            </Button>
            {passed && (
              <p className="text-xs text-muted-foreground">
                Nice work! Keep going through the curriculum, or jump to the certification exam when you've finished all tracks.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
