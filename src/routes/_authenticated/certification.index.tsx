// /certification — entry page for the AgentSwarms certification exam.
// Phase 2a: shows progress + exam intro + lifecycle of any in-progress
// or past attempt. The 50-Q exam UI, agent/swarm picker, AI evaluation,
// and certificate generation will be wired in the next iteration.
import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { CurriculumProgress } from "@/components/CurriculumProgress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  ArrowRight,
  Award,
  Bot,
  CheckCircle2,
  Clock,
  GraduationCap,
  Loader2,
  Network,
  Sparkles,
  Trophy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import certBadge from "@/assets/cert-badge-v2.png";
import sampleCertificateUrl from "@/assets/sample-certificate-v2.pdf?url";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

const REQUIRED_AGENTS = 5;
const REQUIRED_SWARMS = 2;
const SAMPLE_CERTIFICATE_URL = sampleCertificateUrl;
const SWARM_TEMPLATE_TITLES = new Set(SWARM_TEMPLATES.map((t) => t.title));

function isTemplateAgent(a: { name: string; description: string | null }): boolean {
  if (a.description && /\[demo:[^\]]+\]/.test(a.description)) return true;
  if (a.name && a.name.startsWith("Demo · ")) return true;
  return false;
}

function isTemplateSwarm(s: { name: string }): boolean {
  return SWARM_TEMPLATE_TITLES.has(s.name);
}

type Cert = {
  id: string;
  verification_code: string;
  issued_at: string;
  organization: string | null;
  name_on_cert: string;
};

export const Route = createFileRoute("/_authenticated/certification/")({
  component: CertificationPage,
});

type Attempt = {
  id: string;
  status: string;
  mcq_score: number;
  mcq_total: number;
  next_eligible_at: string | null;
  evaluator_feedback: string | null;
  improvement_areas: unknown;
  submitted_at: string | null;
};

function CertificationPage() {
  const [loading, setLoading] = useState(true);
  const [latest, setLatest] = useState<Attempt | null>(null);
  const [cert, setCert] = useState<Cert | null>(null);
  const [eligibleAgents, setEligibleAgents] = useState(0);
  const [eligibleSwarms, setEligibleSwarms] = useState(0);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      const [{ data }, { data: agentsData }, { data: swarmsData }] = await Promise.all([
        supabase
          .from("exam_attempts")
          .select("*")
          .eq("user_id", user.id)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from("agents").select("id,name,description").eq("user_id", user.id),
        supabase.from("swarms").select("id,name").eq("user_id", user.id),
      ]);

      const attempt = (data as unknown as Attempt) ?? null;
      setLatest(attempt);

      const aCount = (agentsData ?? []).filter(
        (a) => !isTemplateAgent(a as { name: string; description: string | null }),
      ).length;
      const sCount = (swarmsData ?? []).filter(
        (s) => !isTemplateSwarm(s as { name: string }),
      ).length;
      setEligibleAgents(aCount);
      setEligibleSwarms(sCount);

      // If the latest attempt is passed, surface the certificate so we can
      // show download + LinkedIn buttons right on the hub.
      if (attempt && attempt.status === "passed") {
        const { data: c } = await supabase
          .from("certificates")
          .select("id,verification_code,issued_at,organization,name_on_cert")
          .eq("attempt_id", attempt.id)
          .maybeSingle();
        setCert((c as Cert) ?? null);
      }

      setLoading(false);
    })();
  }, []);

  const cooldownUntil = latest?.next_eligible_at ? new Date(latest.next_eligible_at) : null;
  const inCooldown = cooldownUntil ? cooldownUntil.getTime() > Date.now() : false;
  const isPassed = latest?.status === "passed";
  const hasEnoughAgents = eligibleAgents >= REQUIRED_AGENTS;
  const hasEnoughSwarms = eligibleSwarms >= REQUIRED_SWARMS;
  const readyToStart = hasEnoughAgents && hasEnoughSwarms;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
        <Award className="h-3.5 w-3.5" /> Certification
      </div>
      <h1 className="text-3xl font-extrabold tracking-tight">
        AgentSwarms — Agentic AI Practitioner
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        50 multiple-choice questions across LLMs, agentic patterns, guardrails, Responsible AI,
        memory, swarms, SQL agents, and scaling — plus a hands-on review of{" "}
        <strong>5 agents</strong> and <strong>2 swarms</strong> you've built yourself (template
        demos don't count). Pass thresholds: <strong>MCQ ≥ 80%</strong>,{" "}
        <strong>Agents ≥ 60%</strong>, <strong>Swarms ≥ 40%</strong>. Failed attempts have a 15-day
        cooldown before retrying.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <div className="rounded-xl border border-border/50 bg-card/40 p-6">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Sparkles className="h-4 w-4 text-primary" /> What's covered
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Click any topic to jump straight to its track quiz on the curriculum page.
            </p>
            <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              {[
                {
                  text: "LLM internals (tokens, temperature, sampling, hallucination)",
                  track: "track-foundations",
                },
                {
                  text: "All 7 agentic patterns (ReAct, planner-executor, reflection, routing, parallel, HITL, RAG)",
                  track: "track-patterns",
                },
                {
                  text: "Guardrails: PII, prompt injection, schema validation, topic restriction",
                  track: "track-patterns",
                },
                {
                  text: "Responsible AI: NIST AI RMF, EU AI Act, fairness, transparency",
                  track: "track-scaling",
                },
                {
                  text: "Memory: STM windowing, LTM typed items, recall scoring",
                  track: "track-memory",
                },
                {
                  text: "Multi-agent swarms: orchestrator, peer-to-peer, A2A handoffs",
                  track: "track-swarms",
                },
                {
                  text: "Text-to-SQL: AST validation, allow-listing, row caps",
                  track: "track-sql",
                },
                {
                  text: "Production: traces, evals, cost guardrails, model versioning",
                  track: "track-scaling",
                },
              ].map((t) => (
                <li key={t.text}>
                  <a
                    href={`/learn#quiz-${t.track}`}
                    className="group flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                    <span className="flex-1">{t.text}</span>
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 text-primary" />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-border/50 bg-card/40 p-6">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <GraduationCap className="h-4 w-4 text-primary" /> Your latest attempt
            </h2>
            {loading ? (
              <p className="mt-3 text-sm text-muted-foreground">
                <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> Loading…
              </p>
            ) : !latest ? (
              <p className="mt-3 text-sm text-muted-foreground">
                You haven't started the exam yet. Make sure you've passed the track quizzes first —
                review your progress on the right.
              </p>
            ) : (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {latest.status.replace(/_/g, " ")}
                  </Badge>
                  {latest.submitted_at && (
                    <span className="text-xs text-muted-foreground">
                      Submitted {new Date(latest.submitted_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground">
                  MCQ score:{" "}
                  <strong className="text-foreground">
                    {latest.mcq_score} / {latest.mcq_total}
                  </strong>
                </p>
                {inCooldown && cooldownUntil && (
                  <p className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2 text-xs text-amber-300">
                    <Clock className="mr-1 inline h-3 w-3" /> Next attempt available{" "}
                    {cooldownUntil.toLocaleDateString()}
                  </p>
                )}
                {latest.evaluator_feedback && (
                  <p className="rounded-md border border-border/40 bg-background/60 p-3 text-xs text-muted-foreground">
                    <strong className="text-foreground">Evaluator feedback:</strong>{" "}
                    {latest.evaluator_feedback}
                  </p>
                )}
              </div>
            )}
          </div>

          {isPassed && cert && <PassedCertificateCard cert={cert} />}

          {!loading && !isPassed && (
            <div
              className={cn(
                "rounded-xl border-2 p-5",
                readyToStart
                  ? "border-emerald-400/40 bg-emerald-500/5"
                  : "border-amber-400/50 bg-amber-500/5",
              )}
            >
              <h2 className="flex items-center gap-2 text-base font-bold">
                {readyToStart ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> You're exam-ready
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 text-amber-500" /> Build your portfolio first
                  </>
                )}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Before starting, you must have <strong>{REQUIRED_AGENTS} self-built agents</strong>{" "}
                and <strong>{REQUIRED_SWARMS} self-built swarms</strong> ready for evaluation.
                Agents and swarms provisioned from templates or demos do <strong>not</strong> count.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ReadinessRow
                  icon={<Bot className="h-3.5 w-3.5" />}
                  label="Self-built agents"
                  current={eligibleAgents}
                  required={REQUIRED_AGENTS}
                  to="/agents"
                  ctaLabel="Build agent"
                />
                <ReadinessRow
                  icon={<Network className="h-3.5 w-3.5" />}
                  label="Self-built swarms"
                  current={eligibleSwarms}
                  required={REQUIRED_SWARMS}
                  to="/swarms"
                  ctaLabel="Build swarm"
                />
              </div>
            </div>
          )}

          <div className="rounded-xl border-2 border-primary/30 bg-card/60 p-6">
            <div className="flex flex-wrap items-start gap-5">
              <img
                src={certBadge}
                alt="AgentSwarms Agentic AI Practitioner badge — pluggable on LinkedIn"
                className="h-28 w-28 flex-shrink-0"
              />
              <div className="flex-1 min-w-[220px]">
                <h2 className="text-lg font-bold">Ready to begin?</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Pass and you'll receive this LinkedIn-pluggable badge plus a downloadable PDF
                  certificate with a public verification URL.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {inCooldown || !readyToStart ? (
                    <Button
                      size="sm"
                      disabled
                      className="gap-1.5"
                      title={
                        inCooldown
                          ? "Cooldown active"
                          : `You need ${REQUIRED_AGENTS} agents (have ${eligibleAgents}) and ${REQUIRED_SWARMS} swarms (have ${eligibleSwarms})`
                      }
                    >
                      <Award className="h-3.5 w-3.5" /> Start exam
                    </Button>
                  ) : (
                    <Button size="sm" className="gap-1.5" asChild>
                      <Link to="/certification/exam" search={{ autostart: true }}>
                        <Award className="h-3.5 w-3.5" /> Start exam
                      </Link>
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="gap-1.5" asChild>
                    <Link to="/learn">
                      <GraduationCap className="h-3.5 w-3.5" /> Continue learning
                    </Link>
                  </Button>
                  <a href={SAMPLE_CERTIFICATE_URL} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="ghost" className="gap-1.5">
                      Preview sample certificate
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <CurriculumProgress />
        </div>
      </div>
    </div>
  );
}

function ReadinessRow({
  icon,
  label,
  current,
  required,
  to,
  ctaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  current: number;
  required: number;
  to: "/agents" | "/swarms";
  ctaLabel: string;
}) {
  const ok = current >= required;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border p-2.5 text-xs",
        ok ? "border-emerald-400/30 bg-emerald-500/5" : "border-amber-400/30 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn(ok ? "text-emerald-500" : "text-amber-500")}>{icon}</span>
        <div>
          <div className="font-semibold text-foreground">{label}</div>
          <div className="text-muted-foreground">
            {current} / {required} {ok ? "✓" : "ready"}
          </div>
        </div>
      </div>
      {!ok && (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" asChild>
          <Link to={to}>
            {ctaLabel} <ArrowRight className="h-3 w-3" />
          </Link>
        </Button>
      )}
    </div>
  );
}

function PassedCertificateCard({ cert }: { cert: Cert }) {
  const issued = new Date(cert.issued_at);
  const certUrl = `https://agentswarms.fyi/verify/${cert.verification_code}`;
  const linkedInHref = `https://www.linkedin.com/profile/add?${new URLSearchParams({
    startTask: "CERTIFICATION_NAME",
    name: "Agentic AI Practitioner",
    organizationName: "AgentSwarms — Agentic AI Lab",
    issueYear: String(issued.getUTCFullYear()),
    issueMonth: String(issued.getUTCMonth() + 1),
    certUrl,
    certId: cert.verification_code,
  }).toString()}`;

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const r = await fetch(`/api/certificate/${cert.id}?v=2026-06-02`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AgentSwarms-Certificate.pdf";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border-2 border-emerald-400/40 bg-emerald-500/5 p-6">
      <div className="flex flex-wrap items-start gap-5">
        <img
          src={certBadge}
          alt="AgentSwarms Agentic AI Practitioner badge"
          className="h-28 w-28 flex-shrink-0"
        />
        <div className="flex-1 min-w-[220px]">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-emerald-400">
            <Trophy className="h-3 w-3" /> Certified
          </div>
          <h2 className="mt-2 text-xl font-extrabold tracking-tight">
            You're an Agentic AI Practitioner
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Issued to <strong className="text-foreground">{cert.name_on_cert}</strong> on{" "}
            {issued.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
            . Verification code{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {cert.verification_code}
            </code>
            .
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" className="gap-1.5" onClick={handleDownload}>
              <Award className="h-3.5 w-3.5" /> Download certificate (PDF)
            </Button>
            <Button
              size="sm"
              asChild
              variant="outline"
              className="gap-1.5 border-[#0a66c2]/40 text-[#0a66c2] hover:bg-[#0a66c2]/10 hover:text-[#0a66c2]"
            >
              <a href={linkedInHref} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                  <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
                </svg>
                Add to LinkedIn
              </a>
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <a href={`/verify/${cert.verification_code}`} target="_blank" rel="noreferrer">
                View public verification page
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
