import { createFileRoute, Link } from "@tanstack/react-router";
import { QuestionDiagram } from "@/components/interview/QuestionDiagrams";
import { SiteHeader, SiteFooter } from "@/components/SiteChrome";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Award,
  BadgeCheck,
  BookOpen,
  Briefcase,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
  GraduationCap,
  Lightbulb,
  MessageCircle,
  Search,
  Star,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  interviewQuestions,
  groupQuestionsByTopic,
  INTERVIEW_TOPICS,
  INTERVIEW_LEVELS,
  type InterviewQuestion,
  type InterviewTopic,
  type InterviewLevel,
} from "@/lib/interviewQuestions";

export const Route = createFileRoute("/interview-questions")({
  head: () => ({
    meta: [
      { title: "GenAI & Agentic AI Interview Questions (2026)" },
      {
        name: "description",
        content:
          "40+ real GenAI, RAG, agents, MCP & LLM system-design interview questions with standout answers and primary-source citations. Free.",
      },
      {
        name: "keywords",
        content:
          "generative ai interview questions, agentic ai interview questions, RAG interview questions, LLM system design interview, MCP interview, multi-agent systems interview, AI engineer interview 2026",
      },
      {
        property: "og:title",
        content: "GenAI & Agentic AI Interview Questions (2026) — AgentSwarms",
      },
      {
        property: "og:description",
        content:
          "40+ real interview questions with standout answers and primary-source citations. Free.",
      },
      { property: "og:type", content: "article" },
      { property: "og:url", content: "https://agentswarms.fyi/interview-questions" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/interview-questions" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: interviewQuestions.map((q) => ({
            "@type": "Question",
            name: q.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: q.interviewAnswer ?? q.standout,
            },
          })),
        }),
      },
    ],
  }),
  component: InterviewQuestionsPage,
});

const LEVEL_COLORS: Record<InterviewLevel, string> = {
  Screening: "bg-muted text-muted-foreground border-border/60",
  Mid: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  Senior: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
  "Staff+": "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

function InterviewQuestionsPage() {
  const [search, setSearch] = useState("");
  const [activeTopics, setActiveTopics] = useState<Set<InterviewTopic>>(new Set());
  const [activeLevels, setActiveLevels] = useState<Set<InterviewLevel>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return interviewQuestions.filter((it) => {
      if (activeTopics.size > 0 && !activeTopics.has(it.topic)) return false;
      if (activeLevels.size > 0 && !activeLevels.has(it.level)) return false;
      if (!q) return true;
      const blob =
        `${it.question} ${it.average} ${it.standout} ${it.example ?? ""} ${it.askedAt?.join(" ") ?? ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [search, activeTopics, activeLevels]);

  const grouped = useMemo(() => groupQuestionsByTopic(filtered), [filtered]);
  const totalCount = interviewQuestions.length;
  const visibleCount = filtered.length;

  const toggleTopic = (t: InterviewTopic) => {
    setActiveTopics((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const toggleLevel = (l: InterviewLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  };
  const clearAll = () => {
    setActiveTopics(new Set());
    setActiveLevels(new Set());
    setSearch("");
  };

  const isExpanded = (id: string) => expandAll || expanded.has(id);
  const toggleOne = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader />
      <div className="flex flex-1 min-h-0 flex-col">
        {/* Header */}
        <div className="border-b border-border/50 bg-gradient-to-br from-background via-background to-primary/5 px-6 py-6 lg:px-10">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 flex items-center gap-2 text-xs">
              <Link
                to="/learn"
                className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                Learn
              </Link>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-foreground">Interview Questions</span>
            </div>

            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Briefcase className="h-3 w-3" />
                  Interview Prep · 2026
                </div>
                <h1 className="text-3xl font-bold tracking-tight lg:text-4xl">
                  GenAI &amp; Agentic AI Interview Questions
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground lg:text-base">
                  {totalCount}+ real questions sourced from public Glassdoor / Blind / LinkedIn
                  reports and 2026 practitioner guides. Each one includes the <em>average</em>{" "}
                  answer that gets you a polite no, the <em>standout</em> answer that gets you the
                  offer, plus citations from Anthropic, OpenAI, and real case studies — nothing
                  invented.
                </p>
              </div>

              <div className="flex flex-shrink-0 flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExpandAll((v) => !v)}
                  className="gap-1.5"
                >
                  {expandAll ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {expandAll ? "Collapse all" : "Expand all"}
                </Button>
                <Link to="/certification">
                  <Button size="sm" className="gap-1.5">
                    <Award className="h-3.5 w-3.5" />
                    Take the certification
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="sticky top-0 z-10 border-b border-border/50 bg-background/95 px-6 py-4 backdrop-blur lg:px-10">
          <div className="mx-auto max-w-6xl space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search questions, companies, keywords (e.g. 'prompt injection', 'RAG eval', 'multi-agent')…"
                  className="pl-9"
                  aria-label="Search interview questions"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Filter className="h-3.5 w-3.5" />
                <span>
                  Showing <strong className="text-foreground">{visibleCount}</strong> of{" "}
                  {totalCount}
                </span>
                {(activeTopics.size > 0 || activeLevels.size > 0 || search) && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="ml-1 text-primary underline-offset-2 hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>

            {/* Topic chips */}
            <div className="flex flex-wrap gap-1.5">
              <span className="mr-1 self-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Topic:
              </span>
              {INTERVIEW_TOPICS.map((t) => {
                const active = activeTopics.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTopic(t)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/60 bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>

            {/* Level chips */}
            <div className="flex flex-wrap gap-1.5">
              <span className="mr-1 self-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Level:
              </span>
              {INTERVIEW_LEVELS.map((l) => {
                const active = activeLevels.has(l);
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => toggleLevel(l)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/60 bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-8 lg:px-10">
          <div className="mx-auto max-w-6xl space-y-10">
            {visibleCount === 0 && (
              <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-12 text-center">
                <p className="text-sm text-muted-foreground">
                  No questions match your filters.{" "}
                  <button onClick={clearAll} className="text-primary underline">
                    Reset
                  </button>
                  .
                </p>
              </div>
            )}

            {grouped.map((section) => (
              <section
                key={section.topic}
                id={`topic-${section.topic.replace(/\s+/g, "-").toLowerCase()}`}
                className="space-y-3"
              >
                <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2">
                  <div>
                    <h2 className="text-xl font-bold tracking-tight">{section.topic}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {section.questions.length} question{section.questions.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="space-y-3">
                  {section.questions.map((q) => (
                    <QuestionCard
                      key={q.id}
                      q={q}
                      expanded={isExpanded(q.id)}
                      onToggle={() => toggleOne(q.id)}
                    />
                  ))}
                </div>
              </section>
            ))}

            {/* Footer */}
            <div className="rounded-xl border border-border/50 bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <GraduationCap className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
                <div className="space-y-2 text-sm">
                  <p className="font-semibold">Ready to prove you know this stuff?</p>
                  <p className="text-muted-foreground">
                    Pair this guide with the AgentSwarms certification — a proctored exam covering
                    agents, RAG, MCP, evals, and system design. Many of the questions here are also
                    in the practice quizzes inside the curriculum.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link to="/certification">
                      <Button size="sm" variant="outline" className="gap-1.5">
                        <Award className="h-3.5 w-3.5" />
                        Certification
                      </Button>
                    </Link>
                    <Link to="/learn">
                      <Button size="sm" variant="outline" className="gap-1.5">
                        <BookOpen className="h-3.5 w-3.5" />
                        Curriculum
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

function QuestionCard({
  q,
  expanded,
  onToggle,
}: {
  q: InterviewQuestion;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      className={cn(
        "rounded-xl border bg-card transition-all",
        expanded ? "border-primary/40 shadow-sm" : "border-border/60 hover:border-border",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn("h-5 px-1.5 text-[10px] font-semibold", LEVEL_COLORS[q.level])}
            >
              {q.level}
            </Badge>
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
              {q.topic}
            </Badge>
            {q.askedAt && q.askedAt.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                Asked at: <span className="text-foreground/80">{q.askedAt.join(" · ")}</span>
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold leading-snug">{q.question}</h3>
        </div>
        <ChevronDown
          className={cn(
            "mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border/50 px-4 py-4">
          {q.interviewAnswer && (
            <div className="rounded-lg border border-primary/30 bg-gradient-to-br from-primary/5 to-primary/[0.02] p-4">
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                <MessageCircle className="h-3.5 w-3.5" />
                Say this in the interview
              </div>
              <div className="mb-2 text-[10px] italic text-muted-foreground">
                A natural, spoken answer — paced for the room
              </div>
              <p className="text-sm leading-relaxed text-foreground/95">{q.interviewAnswer}</p>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <AnswerBlock
              tone="muted"
              icon={<Lightbulb className="h-3.5 w-3.5" />}
              label="Average answer"
              sub="Correct, but you sound like every other candidate"
              text={q.average}
            />
            <AnswerBlock
              tone="primary"
              icon={<BadgeCheck className="h-3.5 w-3.5" />}
              label="Standout answer"
              sub="The depth, trade-offs and references that earn the offer"
              text={q.standout}
            />
          </div>

          <QuestionDiagram questionId={q.id} />

          {q.example && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                <Star className="h-3 w-3" />
                Real-world example / case study
              </div>
              <p className="text-foreground/90">{q.example}</p>
            </div>
          )}

          {q.sources && q.sources.length > 0 && (
            <div className="rounded-lg border border-border/50 bg-background/60 p-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sources to cite in the interview
              </div>
              <ul className="space-y-1">
                {q.sources.map((s) => (
                  <li key={s.url} className="text-xs">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                    >
                      {s.label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function AnswerBlock({
  tone,
  icon,
  label,
  sub,
  text,
}: {
  tone: "muted" | "primary";
  icon: React.ReactNode;
  label: string;
  sub: string;
  text: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs leading-relaxed",
        tone === "primary" && "border-primary/40 bg-primary/5",
        tone === "muted" && "border-border/60 bg-muted/30",
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider",
          tone === "primary" ? "text-primary" : "text-muted-foreground",
        )}
      >
        {icon}
        {label}
      </div>
      <div className="mb-2 text-[10px] italic text-muted-foreground">{sub}</div>
      <p className="text-foreground/90">{text}</p>
    </div>
  );
}
