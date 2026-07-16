// CurriculumProgress — small dashboard widget showing the user's
// per-track best quiz score + overall completion %, plus a CTA to
// the certification exam once enough tracks are passed.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Award, GraduationCap, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

const TRACKS = [
  { id: "track-foundations", label: "Foundations" },
  { id: "track-patterns", label: "Patterns + Guardrails" },
  { id: "track-memory", label: "Agent Memory" },
  { id: "track-sql", label: "Text-to-SQL Agents" },
  { id: "track-swarms", label: "Multi-Agent Swarms" },
  { id: "track-scaling", label: "Scaling + Responsible AI" },
];

type BestPerTrack = Record<string, { pct: number; passed: boolean }>;

export function CurriculumProgress({ compact = false }: { compact?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [best, setBest] = useState<BestPerTrack>({});

  const load = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("quiz_attempts")
      .select("track_id,score,total,passed")
      .eq("user_id", user.id);
    const map: BestPerTrack = {};
    (data ?? []).forEach((row) => {
      const pct = Math.round((row.score / row.total) * 100);
      const cur = map[row.track_id];
      if (!cur || pct > cur.pct) {
        map[row.track_id] = { pct, passed: row.passed };
      }
    });
    setBest(map);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // Refresh when a quiz is submitted elsewhere on the page, when the tab
    // regains focus, or when the user navigates back via bfcache. This keeps
    // the Welcome page progress accurate without a hard refresh.
    const onUpdate = () => { load(); };
    const onFocus = () => { load(); };
    window.addEventListener("quiz-progress-updated", onUpdate);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("quiz-progress-updated", onUpdate);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const passedCount = TRACKS.filter((t) => best[t.id]?.passed).length;
  const overallPct = Math.round((passedCount / TRACKS.length) * 100);
  const examReady = passedCount >= 4; // pragmatic: at least 4/6 passed

  if (loading) {
    return (
      <div className="rounded-xl border border-border/50 bg-card/40 p-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" /> Loading your progress…
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-primary/30 bg-card/60 p-6", compact && "p-4")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
            <GraduationCap className="h-3 w-3" /> Your progress
          </div>
          <h3 className="mt-2 text-lg font-bold">
            {passedCount} / {TRACKS.length} tracks passed
          </h3>
          <p className="text-xs text-muted-foreground">
            Pass each track quiz at 80%+ to unlock certification.
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-extrabold leading-none">{overallPct}%</p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">curriculum</p>
        </div>
      </div>

      <Progress value={overallPct} className="mt-4 h-2" />

      <ul className="mt-5 grid gap-2 sm:grid-cols-2">
        {TRACKS.map((t) => {
          const b = best[t.id];
          return (
            <li key={t.id}>
              <a
                href={`/learn#quiz-${t.id}`}
                title={`Jump to ${t.label} quiz`}
                className={cn(
                  "group flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs transition-all hover:border-primary hover:bg-primary/5 hover:shadow-sm",
                  b?.passed
                    ? "border-emerald-400/40 bg-emerald-500/5"
                    : "border-border/60 bg-background/40",
                )}
              >
                <span className="font-medium group-hover:text-primary">{t.label}</span>
                <span className="flex items-center gap-1.5">
                  {b ? (
                    <>
                      <span className="font-mono">{b.pct}%</span>
                      {b.passed ? (
                        <Trophy className="h-3.5 w-3.5 text-amber-500" />
                      ) : (
                        <Badge variant="outline" className="text-[9px]">retake</Badge>
                      )}
                    </>
                  ) : (
                    <Badge variant="outline" className="text-[9px]">take quiz →</Badge>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {examReady ? (
          <Button size="sm" className="gap-1.5" asChild>
            <Link to="/certification/exam" search={{ autostart: true }}>
              <Award className="h-3.5 w-3.5" />
              Go to certification exam
            </Link>
          </Button>
        ) : (
          <Button size="sm" disabled className="gap-1.5">
            <Award className="h-3.5 w-3.5" />
            {`Pass ${4 - passedCount} more track${4 - passedCount === 1 ? "" : "s"} to unlock`}
          </Button>
        )}
      </div>
    </div>
  );
}
