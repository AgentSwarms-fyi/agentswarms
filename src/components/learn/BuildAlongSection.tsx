// Build-Along Labs — a /learn tab that walks users through building 5 standalone
// agents and 5 multi-agent swarms inside AgentSwarms, step by step, with
// data-driven diagrams. Content lives in src/lib/buildAlongs.ts.
import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Network,
  Clock,
  Lightbulb,
  Sparkles,
  CheckCircle2,
  GraduationCap,
} from "lucide-react";
import {
  BUILD_ALONGS,
  type BuildAlong,
  type AgentBlueprint,
  type SwarmGraph,
  type GraphKind,
} from "@/lib/buildAlongs";

const ease = [0.22, 1, 0.36, 1] as const;

const DIFFICULTY_TONE: Record<BuildAlong["difficulty"], string> = {
  Beginner: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  Intermediate: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  Advanced: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

const GRAPH_AVATAR: Record<GraphKind, string> = {
  input: "📨",
  agent: "🤖",
  condition: "🔀",
  loop: "🔁",
  approval: "🛡️",
  evaluate: "📊",
  function: "⚙️",
  output: "✅",
};

/* ── Agent blueprint diagram ── */
function AgentBlueprintDiagram({ bp }: { bp: AgentBlueprint }) {
  const chips: { label: string; value: string }[] = [
    { label: "Model", value: bp.model },
    { label: "Temp", value: String(bp.temperature) },
  ];
  if (bp.knowledge) chips.push({ label: "Knowledge", value: bp.knowledge });
  if (bp.memory) chips.push({ label: "Memory", value: bp.memory });
  if (bp.guardrails) chips.push({ label: "Guardrails", value: bp.guardrails });
  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border border-primary/30 bg-gradient-to-b from-primary/5 to-card/40 p-5">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease }}
        className="mb-4 flex items-center gap-3"
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl border border-primary/40 bg-card/70 text-2xl">
          🤖
        </span>
        <div>
          <div className="text-sm font-bold text-foreground">{bp.name}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Standalone agent
          </div>
        </div>
      </motion.div>
      <div className="mb-3 flex flex-wrap gap-2">
        {chips.map((c, i) => (
          <motion.span
            key={c.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + i * 0.06, duration: 0.3 }}
            className="rounded-lg border border-border/60 bg-card/50 px-2.5 py-1 text-[11px]"
          >
            <span className="text-muted-foreground">{c.label}: </span>
            <span className="font-medium text-foreground">{c.value}</span>
          </motion.span>
        ))}
      </div>
      {bp.tools && bp.tools.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="mb-3 flex flex-wrap items-center gap-2"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tools
          </span>
          {bp.tools.map((t) => (
            <span
              key={t}
              className="rounded-md border border-nexus-glow/40 bg-nexus-glow/10 px-2 py-0.5 text-[11px] text-foreground"
            >
              {t}
            </span>
          ))}
        </motion.div>
      )}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45 }}
        className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs italic leading-relaxed text-foreground/80"
      >
        “{bp.systemPromptPreview}”
      </motion.div>
    </div>
  );
}

/* ── Swarm graph diagram (16:9, uniform-scale SVG so arrows aren't distorted) ── */
function SwarmGraphDiagram({ graph }: { graph: SwarmGraph }) {
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!;
  return (
    <div className="relative mx-auto aspect-[16/9] w-full max-w-3xl overflow-visible rounded-2xl border border-border/50 bg-card/20 p-2">
      <svg
        viewBox="0 0 160 90"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
      >
        <g className="text-primary/70">
          {graph.edges.map((e, i) => {
            const a = node(e.from);
            const b = node(e.to);
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const pad = 7;
            const sx = a.x + ux * pad;
            const sy = a.y + uy * pad;
            const ex = b.x - ux * pad;
            const ey = b.y - uy * pad;
            const ah = 3.4;
            const aw = 2.1;
            const px = -uy;
            const py = ux;
            const points = `${ex},${ey} ${ex - ux * ah + px * aw},${ey - uy * ah + py * aw} ${ex - ux * ah - px * aw},${ey - uy * ah - py * aw}`;
            return (
              <motion.g
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.25 + i * 0.1, duration: 0.4 }}
              >
                <line
                  x1={sx}
                  y1={sy}
                  x2={ex}
                  y2={ey}
                  stroke="currentColor"
                  strokeWidth={0.7}
                  vectorEffect="non-scaling-stroke"
                />
                <polygon points={points} fill="currentColor" />
              </motion.g>
            );
          })}
        </g>
        <g className="text-muted-foreground">
          {graph.edges
            .filter((e) => e.label)
            .map((e, i) => {
              const a = node(e.from);
              const b = node(e.to);
              return (
                <motion.text
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 + i * 0.1 }}
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 1.5}
                  textAnchor="middle"
                  fontSize={3.6}
                  fontWeight={700}
                  fill="currentColor"
                >
                  {e.label}
                </motion.text>
              );
            })}
        </g>
      </svg>
      {graph.nodes.map((n, i) => (
        <motion.div
          key={n.id}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.08, duration: 0.35, ease }}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
          style={{ left: `${(n.x / 160) * 100}%`, top: `${(n.y / 90) * 100}%` }}
        >
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-primary/40 bg-card/90 text-lg shadow-md">
            {GRAPH_AVATAR[n.kind]}
          </span>
          <span className="mt-1 max-w-[88px] text-center text-[10px] font-medium leading-tight text-foreground">
            {n.label}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

/* ── Gallery card ── */
function BuildCard({ build, onOpen }: { build: BuildAlong; onOpen: () => void }) {
  return (
    <motion.button
      onClick={onOpen}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, ease }}
      whileHover={{ y: -3 }}
      className="group flex h-full flex-col rounded-2xl border border-border/60 bg-card/40 p-5 text-left transition-colors hover:border-primary/50"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-border/60 bg-background/50">
          {build.kind === "agent" ? (
            <Bot className="h-4 w-4 text-primary" />
          ) : (
            <Network className="h-4 w-4 text-nexus-glow" />
          )}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${DIFFICULTY_TONE[build.difficulty]}`}
        >
          {build.difficulty}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          {build.duration}
        </span>
      </div>
      <h3 className="text-base font-bold tracking-tight text-foreground">{build.title}</h3>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-muted-foreground">{build.tagline}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
        Start building
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </motion.button>
  );
}

/* ── Detail view ── */
function BuildDetail({ build, onBack }: { build: BuildAlong; onBack: () => void }) {
  const builderHref = build.kind === "agent" ? "/agents" : "/swarms";
  return (
    <div className="mx-auto max-w-4xl">
      <button
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All labs
      </button>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${DIFFICULTY_TONE[build.difficulty]}`}
        >
          {build.difficulty}
        </span>
        <span className="flex items-center gap-1 rounded-full border border-border/60 bg-card/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          {build.kind === "agent" ? (
            <>
              <Bot className="h-3 w-3" /> Standalone agent
            </>
          ) : (
            <>
              <Network className="h-3 w-3" /> Multi-agent swarm
            </>
          )}
        </span>
        <span className="flex items-center gap-1 rounded-full border border-border/60 bg-card/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" /> {build.duration}
        </span>
      </div>
      <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
        {build.title}
      </h1>
      <p className="mt-3 text-lg leading-relaxed text-muted-foreground">{build.summary}</p>

      {/* Meta grid */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-card/40 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            Use case
          </div>
          <p className="mt-1 text-sm text-foreground/85">{build.useCase}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-card/40 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            What you'll build
          </div>
          <p className="mt-1 text-sm text-foreground/85">{build.youWillBuild}</p>
        </div>
      </div>

      {/* Concepts */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <GraduationCap className="h-3.5 w-3.5" /> You'll learn
        </span>
        {build.concepts.map((c) => (
          <span
            key={c}
            className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] text-primary"
          >
            {c}
          </span>
        ))}
      </div>

      {/* Prerequisites */}
      {build.prerequisites && build.prerequisites.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
            Before you start
          </div>
          <ul className="mt-1 space-y-1">
            {build.prerequisites.map((p) => (
              <li key={p} className="flex items-start gap-2 text-sm text-foreground/85">
                <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-amber-400" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Diagram */}
      <div className="mt-8">
        <div className="mb-3 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {build.kind === "agent" ? "The agent you're building" : "The swarm you're building"}
        </div>
        {build.diagram.type === "agent" ? (
          <AgentBlueprintDiagram bp={build.diagram} />
        ) : (
          <SwarmGraphDiagram graph={build.diagram} />
        )}
      </div>

      {/* Steps */}
      <div className="mt-10">
        <h2 className="text-xl font-bold tracking-tight text-foreground">Step by step</h2>
        <ol className="mt-5 space-y-4">
          {build.steps.map((s, i) => (
            <motion.li
              key={i}
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, ease }}
              className="relative rounded-2xl border border-border/60 bg-card/40 p-5 pl-14"
            >
              <span className="absolute left-4 top-5 grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-nexus-glow text-sm font-bold text-primary-foreground">
                {i + 1}
              </span>
              <h3 className="text-base font-semibold text-foreground">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{s.body}</p>
              {s.detail && s.detail.length > 0 && (
                <ul className="mt-3 space-y-1.5 rounded-lg border border-border/50 bg-background/40 p-3">
                  {s.detail.map((d, j) => (
                    <li key={j} className="flex items-start gap-2 text-[13px] text-foreground/80">
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                      <span className="font-mono">{d}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.concept && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-nexus-glow/30 bg-nexus-glow/5 p-3 text-[13px] text-foreground/85">
                  <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-nexus-glow" />
                  <span>
                    <span className="font-semibold text-nexus-glow">Why it matters: </span>
                    {s.concept}
                  </span>
                </div>
              )}
              {s.tip && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[13px] text-foreground/85">
                  <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
                  <span>
                    <span className="font-semibold text-amber-300">Tip: </span>
                    {s.tip}
                  </span>
                </div>
              )}
            </motion.li>
          ))}
        </ol>
      </div>

      {/* Done + CTA */}
      <div className="mt-8 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" />
          <div>
            <div className="font-semibold text-emerald-300">Done!</div>
            <p className="mt-1 text-sm text-foreground/85">{build.done}</p>
          </div>
        </div>
        <Link
          to={builderHref}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open the {build.kind === "agent" ? "Agent Builder" : "Swarm Canvas"}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

export function BuildAlongSection() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? BUILD_ALONGS.find((b) => b.id === activeId) : null;

  if (active) {
    return <BuildDetail build={active} onBack={() => setActiveId(null)} />;
  }

  const agents = BUILD_ALONGS.filter((b) => b.kind === "agent");
  const swarms = BUILD_ALONGS.filter((b) => b.kind === "swarm");

  return (
    <div>
      <div className="mb-8">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
          <Sparkles className="h-3 w-3" /> Build-Along Labs
        </div>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
          Build it with us, step by step
        </h1>
        <p className="mt-3 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Ten guided labs that walk you through building real agents and swarms in the AgentSwarms
          agent builder and canvas — from your first web-search agent to a production RAG pipeline
          with evaluation and human approval.
        </p>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-bold tracking-tight text-foreground">Standalone Agents</h2>
        <span className="text-sm text-muted-foreground">· 5 labs</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((b) => (
          <BuildCard key={b.id} build={b} onOpen={() => setActiveId(b.id)} />
        ))}
      </div>

      <div className="mb-3 mt-12 flex items-center gap-2">
        <Network className="h-5 w-5 text-nexus-glow" />
        <h2 className="text-xl font-bold tracking-tight text-foreground">Multi-Agent Swarms</h2>
        <span className="text-sm text-muted-foreground">· 5 labs</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {swarms.map((b) => (
          <BuildCard key={b.id} build={b} onOpen={() => setActiveId(b.id)} />
        ))}
      </div>
    </div>
  );
}
