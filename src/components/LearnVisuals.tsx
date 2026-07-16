// Visual learning aids for the curriculum on /learn.
// All diagrams are pure CSS + inline SVG using semantic design tokens
// (--primary, --chart-2..5, --muted, --border) so they auto-adapt to
// the active light/dark theme without any per-component overrides.
//
// Each block is a self-contained section with:
//   - a colored chip + title
//   - the visual itself
//   - a one-paragraph "what you're looking at" caption
//
// Drop a <VisualBlock> straight into a curriculum section.

import {
  Sparkles,
  Repeat,
  Network,
  GitBranch,
  Workflow,
  Brain,
  Image as ImageIcon,
  Search,
  ScanEye,
  Layers,
  Database,
  ShieldCheck,
  Compass,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ─────────────────────────── shell ─────────────────────────── */

function VisualShell({
  icon: Icon,
  chip,
  title,
  caption,
  children,
}: {
  icon: LucideIcon;
  chip: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="my-10 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-card/40 to-card/0 p-5 sm:p-7">
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <Icon className="h-3 w-3" /> {chip}
      </div>
      <h4 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h4>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {caption}
      </p>
      <div className="mt-5 overflow-x-auto rounded-xl border border-border/50 bg-background/40 p-4 sm:p-6">
        {children}
      </div>
    </section>
  );
}

/* ─────────────── 1. Vector embeddings — 3D-ish scatter ─────────────── */

export function EmbeddingsVisual() {
  // Two clusters of related words + 1 outlier, projected onto a 2D plane
  // with a faux 3D grid behind them. SVG only — no libs.
  const cluster = [
    { x: 90, y: 110, label: "Dog", c: "var(--chart-1)" },
    { x: 120, y: 95, label: "Puppy", c: "var(--chart-1)" },
    { x: 70, y: 135, label: "Wolf", c: "var(--chart-1)" },
    { x: 105, y: 145, label: "Cat", c: "var(--chart-1)" },
    { x: 245, y: 105, label: "Apple", c: "var(--chart-2)" },
    { x: 270, y: 130, label: "Banana", c: "var(--chart-2)" },
    { x: 230, y: 145, label: "Mango", c: "var(--chart-2)" },
    { x: 425, y: 60, label: "Car", c: "var(--chart-4)" },
    { x: 460, y: 75, label: "Truck", c: "var(--chart-4)" },
  ];
  return (
    <VisualShell
      icon={Search}
      chip="Vector embeddings"
      title="Meaning lives as coordinates in space"
      caption="Each word becomes an array of numbers. Plot those numbers and similar concepts cluster together — 'Dog' and 'Puppy' sit close, 'Banana' lives in fruit-land, 'Car' is in another neighborhood entirely. Semantic search is just nearest-neighbor lookup in this space."
    >
      <svg viewBox="0 0 540 220" className="w-full">
        {/* faux 3D grid */}
        <defs>
          <linearGradient id="gridFade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--border)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--border)" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <line
            key={`h${i}`}
            x1={0}
            y1={40 + i * 32}
            x2={540}
            y2={40 + i * 32}
            stroke="url(#gridFade)"
            strokeWidth={1}
          />
        ))}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <line
            key={`v${i}`}
            x1={i * 60}
            y1={40}
            x2={i * 60 + 30}
            y2={210}
            stroke="var(--border)"
            strokeOpacity={0.25}
            strokeWidth={1}
          />
        ))}

        {/* cluster halos */}
        <ellipse cx={100} cy={125} rx={60} ry={38} fill="var(--chart-1)" fillOpacity={0.12} />
        <ellipse cx={250} cy={125} rx={50} ry={32} fill="var(--chart-2)" fillOpacity={0.12} />
        <ellipse cx={445} cy={70} rx={42} ry={26} fill="var(--chart-4)" fillOpacity={0.14} />

        {/* labels above clusters */}
        <text x={100} y={75} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-1)">ANIMALS</text>
        <text x={250} y={75} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-2)">FRUITS</text>
        <text x={445} y={30} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-4)">VEHICLES</text>

        {/* points */}
        {cluster.map((p) => (
          <g key={p.label}>
            <circle cx={p.x} cy={p.y} r={5} fill={p.c} />
            <circle cx={p.x} cy={p.y} r={9} fill={p.c} fillOpacity={0.25} />
            <text
              x={p.x + 9}
              y={p.y + 3}
              fontSize="11"
              fontWeight="600"
              fill="var(--foreground)"
            >
              {p.label}
            </text>
          </g>
        ))}

        {/* axis hints */}
        <text x={10} y={20} fontSize="9" fill="var(--muted-foreground)">dim 1</text>
        <text x={510} y={210} fontSize="9" fill="var(--muted-foreground)">dim 2</text>
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 2. Attention — heatmap over a sentence ─────────────── */

export function AttentionVisual() {
  const sentence = ["She", "deposited", "money", "at", "the", "bank"];
  // Attention weights from the focus word "bank" to every other token,
  // shown for two contexts: financial vs river.
  const ctxFinancial = [0.05, 0.18, 0.55, 0.06, 0.05, 1.0];
  const sentence2 = ["The", "fisherman", "walked", "along", "the", "bank"];
  const ctxRiver = [0.05, 0.45, 0.1, 0.2, 0.05, 1.0];

  const renderRow = (tokens: string[], weights: number[], focusIdx: number) => (
    <div className="flex flex-wrap items-end justify-center gap-2">
      {tokens.map((t, i) => {
        const w = weights[i];
        const bg = `color-mix(in oklab, var(--primary) ${Math.round(w * 70)}%, transparent)`;
        const isFocus = i === focusIdx;
        return (
          <div key={`${t}-${i}`} className="flex flex-col items-center gap-1">
            <div
              className="rounded-md border border-border/40 px-2 py-1 text-[11px] font-mono"
              style={{
                background: bg,
                color: w > 0.4 ? "var(--primary-foreground)" : "var(--foreground)",
                borderColor: isFocus ? "var(--primary)" : undefined,
                borderWidth: isFocus ? 2 : 1,
              }}
            >
              {t}
            </div>
            <div className="text-[9px] tabular-nums text-muted-foreground">
              {w.toFixed(2)}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <VisualShell
      icon={ScanEye}
      chip="Attention mechanism"
      title="The same word — two completely different meanings"
      caption="At every step, the transformer asks: which earlier tokens matter for predicting the next one? The same word ‘bank’ pulls attention from ‘money’ in one sentence and from ‘fisherman’ in the other. That context-sensitive routing is what makes LLMs feel like they understand."
    >
      <div className="space-y-6">
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Context A — finance
          </div>
          {renderRow(sentence, ctxFinancial, 5)}
        </div>
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Context B — river
          </div>
          {renderRow(sentence2, ctxRiver, 5)}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>attention weight</span>
          <div
            className="h-2 w-32 rounded"
            style={{
              background:
                "linear-gradient(to right, color-mix(in oklab, var(--primary) 5%, transparent), var(--primary))",
            }}
          />
          <span>0.0 → 1.0</span>
        </div>
      </div>
    </VisualShell>
  );
}

/* ─────────────── 3. RAG pipeline ─────────────── */

export function RAGVisual() {
  const steps = [
    { label: "User prompt", sub: "What's our refund policy?" },
    { label: "Embedding model", sub: "→ vector [0.12, …]" },
    { label: "Vector DB search", sub: "top-k similar chunks" },
    { label: "Context injection", sub: "stuffed into prompt" },
    { label: "LLM generation", sub: "answer + citations" },
  ];
  return (
    <VisualShell
      icon={Workflow}
      chip="Retrieval-Augmented Generation"
      title="The 5-step pipeline that kills hallucinations"
      caption="The model never invents an answer from thin air. Your question is embedded, used to retrieve the most relevant chunks of your documents, those chunks are added to the prompt, and only then does the LLM write — grounded in your knowledge base, with citations."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:gap-1">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            <div className="flex-1 rounded-lg border border-primary/30 bg-primary/5 p-3 text-center">
              <div className="mx-auto mb-1.5 grid h-7 w-7 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                {i + 1}
              </div>
              <div className="text-[11px] font-semibold">{s.label}</div>
              <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
                {s.sub}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden sm:block">
                <svg width="14" height="20" viewBox="0 0 14 20" className="text-primary/60">
                  <path d="M2 10h9M7 5l5 5-5 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

/* ─────────────── 4. Diffusion — noise → image ─────────────── */

export function DiffusionVisual() {
  // 5 frames showing increasing structure. Pure SVG noise → faux cat shape.
  const frames = [0, 1, 2, 3, 4];
  const renderFrame = (i: number) => {
    const seed = i * 7 + 3;
    // density of "noise" pixels decreases as the structure forms
    const noisePts = Array.from({ length: 60 - i * 12 }).map((_, k) => {
      const x = ((seed * (k + 1) * 17) % 100);
      const y = ((seed * (k + 3) * 13) % 100);
      return { x, y };
    });
    const opacity = 0.15 + i * 0.18;
    return (
      <div className="flex flex-col items-center gap-1">
        <svg viewBox="0 0 100 100" className="h-20 w-20 rounded-md border border-border/50 bg-muted/30">
          {/* noise */}
          {noisePts.map((p, k) => (
            <rect key={k} x={p.x} y={p.y} width={2} height={2} fill="var(--muted-foreground)" fillOpacity={0.7} />
          ))}
          {/* faux cat silhouette emerges in later frames */}
          {i >= 2 && (
            <g fill="var(--primary)" fillOpacity={opacity}>
              {/* head */}
              <circle cx={50} cy={55} r={22} />
              {/* ears */}
              <polygon points="32,40 38,18 46,38" />
              <polygon points="68,40 62,18 54,38" />
            </g>
          )}
          {i >= 3 && (
            <g fill="var(--background)" fillOpacity={0.9}>
              <circle cx={42} cy={52} r={2.5} />
              <circle cx={58} cy={52} r={2.5} />
            </g>
          )}
          {i >= 4 && (
            <g stroke="var(--background)" strokeWidth={1.2} fill="none" strokeLinecap="round">
              <path d="M30 56 L20 54" />
              <path d="M30 60 L20 62" />
              <path d="M70 56 L80 54" />
              <path d="M70 60 L80 62" />
              <path d="M46 64 Q50 68 54 64" />
            </g>
          )}
        </svg>
        <div className="text-[10px] font-mono text-muted-foreground">step {i + 1}</div>
      </div>
    );
  };

  return (
    <VisualShell
      icon={ImageIcon}
      chip="Diffusion models"
      title="From pure noise to a clear image, one denoise at a time"
      caption="A diffusion model is trained to reverse a noising process. Starting from random static, it predicts ‘what noise should I subtract?’ over and over. After 20–50 steps, a coherent image emerges — the same trick powers Stable Diffusion, Midjourney, and Flux."
    >
      <div className="flex flex-wrap items-center justify-center gap-3">
        {frames.map((i) => (
          <div key={i} className="flex items-center gap-2">
            {renderFrame(i)}
            {i < frames.length - 1 && (
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-primary/60">
                <path d="M2 7h9M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 text-center text-[10px] text-muted-foreground">
        noise → structure → detail → polish
      </div>
    </VisualShell>
  );
}

/* ─────────────── 5. ReAct loop ─────────────── */

export function ReActVisual() {
  return (
    <VisualShell
      icon={Repeat}
      chip="ReAct pattern"
      title="The loop every tool-using agent runs"
      caption="ReAct = Reason + Act. The model thinks (‘what do I need?’), picks a tool (‘call get_weather’), reads the result (‘12°C’), and decides whether to loop again or answer. Almost every modern agent — LangChain, CrewAI, OpenAI Assistants — runs a flavor of this."
    >
      <svg viewBox="0 0 420 260" className="mx-auto block w-full max-w-md">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* Thought */}
        <g>
          <rect x={155} y={15} width={110} height={50} rx={10} fill="var(--chart-1)" fillOpacity={0.15} stroke="var(--chart-1)" strokeWidth="1.5" />
          <text x={210} y={36} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--chart-1)">THOUGHT</text>
          <text x={210} y={52} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">what should I do?</text>
        </g>

        {/* Action */}
        <g>
          <rect x={295} y={105} width={110} height={50} rx={10} fill="var(--chart-2)" fillOpacity={0.15} stroke="var(--chart-2)" strokeWidth="1.5" />
          <text x={350} y={126} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--chart-2)">ACTION</text>
          <text x={350} y={142} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">call a tool</text>
        </g>

        {/* Observation */}
        <g>
          <rect x={155} y={195} width={110} height={50} rx={10} fill="var(--chart-4)" fillOpacity={0.15} stroke="var(--chart-4)" strokeWidth="1.5" />
          <text x={210} y={216} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--chart-4)">OBSERVATION</text>
          <text x={210} y={232} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">tool result</text>
        </g>

        {/* (Reflect) back to Thought */}
        <g>
          <rect x={15} y={105} width={110} height={50} rx={10} fill="var(--chart-3)" fillOpacity={0.15} stroke="var(--chart-3)" strokeWidth="1.5" />
          <text x={70} y={126} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--chart-3)">REFLECT</text>
          <text x={70} y={142} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">did it work?</text>
        </g>

        {/* arrows: thought → action → observation → reflect → thought */}
        <path d="M 265,50 Q 320,70 320,105" fill="none" stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arrow)" />
        <path d="M 320,155 Q 320,190 265,210" fill="none" stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arrow)" />
        <path d="M 155,210 Q 100,190 100,155" fill="none" stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arrow)" />
        <path d="M 100,105 Q 100,70 155,50" fill="none" stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arrow)" />
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 6. Plan & Execute tree ─────────────── */

export function PlanExecuteVisual() {
  const subtasks = [
    "Search competitors",
    "Extract pricing",
    "Compare features",
    "Draft summary",
    "Send report",
  ];
  return (
    <VisualShell
      icon={GitBranch}
      chip="Plan & Execute"
      title="Separate the thinking from the doing"
      caption="A Planner agent breaks a fuzzy goal into concrete subtasks once. Worker agents then execute them in parallel or sequence — no expensive replanning per step. This is how long-running agents stay coherent over hours."
    >
      <svg viewBox="0 0 560 240" className="mx-auto block w-full">
        <defs>
          <marker id="arrow2" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* Goal */}
        <g>
          <rect x={210} y={10} width={140} height={36} rx={18} fill="var(--chart-3)" fillOpacity={0.15} stroke="var(--chart-3)" strokeWidth="1.5" />
          <text x={280} y={32} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--chart-3)">GOAL</text>
        </g>

        {/* Planner */}
        <g>
          <rect x={205} y={70} width={150} height={42} rx={10} fill="var(--primary)" fillOpacity={0.15} stroke="var(--primary)" strokeWidth="1.5" />
          <text x={280} y={88} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--primary)">PLANNER</text>
          <text x={280} y={102} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">decomposes into subtasks</text>
        </g>

        {/* arrow goal → planner */}
        <path d="M 280,46 L 280,68" stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arrow2)" fill="none" />

        {/* subtasks */}
        {subtasks.map((s, i) => {
          const x = 20 + i * 110;
          return (
            <g key={s}>
              <path
                d={`M 280,112 Q ${x + 50},140 ${x + 50},170`}
                fill="none"
                stroke="var(--primary)"
                strokeOpacity={0.5}
                strokeWidth="1.2"
                markerEnd="url(#arrow2)"
              />
              <rect x={x} y={170} width={100} height={50} rx={8} fill="var(--chart-2)" fillOpacity={0.12} stroke="var(--chart-2)" strokeWidth="1.2" />
              <text x={x + 50} y={188} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--chart-2)">
                WORKER {i + 1}
              </text>
              <text x={x + 50} y={204} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">
                {s.length > 16 ? s.slice(0, 14) + "…" : s}
              </text>
            </g>
          );
        })}
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 7. Hierarchical vs networked swarms ─────────────── */

export function SwarmVisual() {
  return (
    <VisualShell
      icon={Network}
      chip="Multi-agent swarms"
      title="Two ways agents collaborate"
      caption="A hierarchical swarm has a Manager that delegates down to specialists — clean control, easy to debug. A networked swarm lets peers hand the task back and forth — more flexible, harder to bound. Most production swarms start hierarchical and add peer edges only where they earn their keep."
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Hierarchical */}
        <div>
          <div className="mb-2 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Hierarchical
          </div>
          <svg viewBox="0 0 240 200" className="mx-auto block w-full max-w-xs">
            <defs>
              <marker id="ah" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0 0 L6 3 L0 6 z" fill="var(--primary)" />
              </marker>
            </defs>
            {/* Manager */}
            <circle cx={120} cy={30} r={22} fill="var(--primary)" fillOpacity={0.18} stroke="var(--primary)" strokeWidth="1.5" />
            <text x={120} y={34} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--primary)">MGR</text>

            {/* arrows down */}
            <line x1={120} y1={52} x2={50} y2={130} stroke="var(--primary)" strokeOpacity={0.55} markerEnd="url(#ah)" />
            <line x1={120} y1={52} x2={120} y2={130} stroke="var(--primary)" strokeOpacity={0.55} markerEnd="url(#ah)" />
            <line x1={120} y1={52} x2={190} y2={130} stroke="var(--primary)" strokeOpacity={0.55} markerEnd="url(#ah)" />

            {/* workers */}
            {[
              { x: 40, label: "Research" },
              { x: 110, label: "Analyse" },
              { x: 180, label: "Draft" },
            ].map((w) => (
              <g key={w.label}>
                <circle cx={w.x + 10} cy={150} r={20} fill="var(--chart-2)" fillOpacity={0.15} stroke="var(--chart-2)" strokeWidth="1.3" />
                <text x={w.x + 10} y={154} textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--chart-2)">
                  {w.label.slice(0, 4).toUpperCase()}
                </text>
                <text x={w.x + 10} y={188} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">
                  {w.label}
                </text>
              </g>
            ))}
          </svg>
        </div>

        {/* Networked */}
        <div>
          <div className="mb-2 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Networked (peer-to-peer)
          </div>
          <svg viewBox="0 0 240 200" className="mx-auto block w-full max-w-xs">
            {/* 4 peers in a ring */}
            {(() => {
              const peers = [
                { x: 120, y: 30, label: "Critic" },
                { x: 200, y: 100, label: "Coder" },
                { x: 120, y: 170, label: "Tester" },
                { x: 40, y: 100, label: "Planner" },
              ];
              return (
                <>
                  {/* edges */}
                  {peers.map((p, i) => {
                    const next = peers[(i + 1) % peers.length];
                    return (
                      <line
                        key={`e${i}`}
                        x1={p.x}
                        y1={p.y}
                        x2={next.x}
                        y2={next.y}
                        stroke="var(--chart-3)"
                        strokeOpacity={0.55}
                        strokeWidth="1.4"
                        strokeDasharray="3 3"
                      />
                    );
                  })}
                  {/* diagonal handoffs */}
                  <line x1={120} y1={30} x2={120} y2={170} stroke="var(--chart-4)" strokeOpacity={0.4} strokeDasharray="2 4" />
                  <line x1={200} y1={100} x2={40} y2={100} stroke="var(--chart-4)" strokeOpacity={0.4} strokeDasharray="2 4" />
                  {/* nodes */}
                  {peers.map((p) => (
                    <g key={p.label}>
                      <circle cx={p.x} cy={p.y} r={20} fill="var(--chart-3)" fillOpacity={0.18} stroke="var(--chart-3)" strokeWidth="1.4" />
                      <text x={p.x} y={p.y + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--chart-3)">
                        {p.label.slice(0, 4).toUpperCase()}
                      </text>
                    </g>
                  ))}
                </>
              );
            })()}
          </svg>
        </div>
      </div>
    </VisualShell>
  );
}

/* ─────────────── 8. Tool calling sequence ─────────────── */

export function ToolCallVisual() {
  const lifelines = [
    { name: "User", x: 60, color: "var(--chart-3)" },
    { name: "LLM", x: 200, color: "var(--primary)" },
    { name: "Runtime", x: 340, color: "var(--chart-2)" },
    { name: "API / DB", x: 480, color: "var(--chart-4)" },
  ];
  const arrows = [
    { from: 60, to: 200, y: 70, label: "ask question", direction: "right" },
    { from: 200, to: 340, y: 110, label: "JSON tool_call", direction: "right" },
    { from: 340, to: 480, y: 150, label: "execute", direction: "right" },
    { from: 480, to: 340, y: 190, label: "raw result", direction: "left" },
    { from: 340, to: 200, y: 230, label: "tool_result", direction: "left" },
    { from: 200, to: 60, y: 270, label: "final answer", direction: "left" },
  ];
  return (
    <VisualShell
      icon={Workflow}
      chip="Tool calling"
      title="The handshake between an LLM and the real world"
      caption="LLMs can't run code, query databases, or hit APIs by themselves. They emit a structured tool_call as JSON; the runtime validates it, executes the actual function, and feeds the result back. The model never touches your systems directly — that's how you keep things safe."
    >
      <svg viewBox="0 0 540 320" className="w-full">
        <defs>
          <marker id="ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* lifelines */}
        {lifelines.map((l) => (
          <g key={l.name}>
            <rect x={l.x - 35} y={20} width={70} height={26} rx={6} fill={l.color} fillOpacity={0.15} stroke={l.color} strokeWidth="1.2" />
            <text x={l.x} y={37} textAnchor="middle" fontSize="10" fontWeight="700" fill={l.color}>{l.name}</text>
            <line x1={l.x} y1={48} x2={l.x} y2={300} stroke={l.color} strokeOpacity={0.35} strokeDasharray="2 4" />
          </g>
        ))}

        {/* arrows */}
        {arrows.map((a, i) => {
          const x1 = a.direction === "right" ? a.from + 5 : a.from - 5;
          const x2 = a.direction === "right" ? a.to - 5 : a.to + 5;
          return (
            <g key={i}>
              <line x1={x1} y1={a.y} x2={x2} y2={a.y} stroke="var(--primary)" strokeWidth="1.4" markerEnd="url(#ar)" />
              <text
                x={(a.from + a.to) / 2}
                y={a.y - 5}
                textAnchor="middle"
                fontSize="9"
                fontStyle="italic"
                fill="var(--muted-foreground)"
              >
                {a.label}
              </text>
            </g>
          );
        })}
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 9. Memory funnel ─────────────── */

export function MemoryVisual() {
  return (
    <VisualShell
      icon={Brain}
      chip="Memory management"
      title="How agents remember without overflowing context"
      caption="Raw chat history is huge and expensive. STM keeps a sliding window of recent turns plus a rolling summary of older ones. LTM extracts durable facts (preferences, decisions) into a small store that gets recalled on demand. Together they let an agent feel persistent without paying for a 1M-token prompt every turn."
    >
      <svg viewBox="0 0 560 240" className="w-full">
        <defs>
          <linearGradient id="funnel" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--chart-3)" stopOpacity="0.5" />
            <stop offset="50%" stopColor="var(--primary)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity="0.5" />
          </linearGradient>
          <marker id="ar3" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* Raw chat */}
        <g>
          <rect x={10} y={40} width={140} height={150} rx={8} fill="var(--chart-3)" fillOpacity={0.12} stroke="var(--chart-3)" strokeWidth="1.3" />
          <text x={80} y={60} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-3)">RAW CHAT</text>
          <text x={80} y={75} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">100s of turns</text>
          {Array.from({ length: 9 }).map((_, i) => (
            <rect key={i} x={20} y={85 + i * 11} width={120} height={6} rx={2} fill="var(--chart-3)" fillOpacity={0.4} />
          ))}
        </g>

        {/* funnel polygon */}
        <polygon points="150,55 280,90 280,150 150,180" fill="url(#funnel)" fillOpacity={0.25} stroke="var(--primary)" strokeOpacity={0.4} strokeWidth="1" />
        <text x={215} y={125} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--primary)">SUMMARIZE</text>
        <text x={215} y={138} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">+ extract</text>

        {/* STM */}
        <g>
          <rect x={290} y={40} width={120} height={80} rx={8} fill="var(--primary)" fillOpacity={0.15} stroke="var(--primary)" strokeWidth="1.3" />
          <text x={350} y={62} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--primary)">STM</text>
          <text x={350} y={78} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">window + summary</text>
          <text x={350} y={102} textAnchor="middle" fontSize="9" fontStyle="italic" fill="var(--foreground)">~last 20 turns</text>
        </g>

        {/* LTM */}
        <g>
          <rect x={290} y={130} width={120} height={80} rx={8} fill="var(--chart-2)" fillOpacity={0.15} stroke="var(--chart-2)" strokeWidth="1.3" />
          <text x={350} y={152} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-2)">LTM</text>
          <text x={350} y={168} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">facts · prefs · episodes</text>
          <text x={350} y={192} textAnchor="middle" fontSize="9" fontStyle="italic" fill="var(--foreground)">queryable</text>
        </g>

        {/* Recall arrows back into next prompt */}
        <path d="M 410,80 Q 470,80 480,120" fill="none" stroke="var(--primary)" strokeWidth="1.4" markerEnd="url(#ar3)" />
        <path d="M 410,170 Q 470,170 480,130" fill="none" stroke="var(--chart-2)" strokeWidth="1.4" markerEnd="url(#ar3)" />

        {/* Next prompt */}
        <g>
          <rect x={460} y={95} width={90} height={60} rx={8} fill="var(--chart-4)" fillOpacity={0.15} stroke="var(--chart-4)" strokeWidth="1.3" />
          <text x={505} y={120} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-4)">NEXT PROMPT</text>
          <text x={505} y={138} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">tight + grounded</text>
        </g>
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 10. Agentic RAG — controlled loop with critic ─────────────── */

export function AgenticRagVisual() {
  return (
    <VisualShell
      icon={Compass}
      chip="Agentic RAG"
      title="The orchestrator decides what to retrieve — and whether to retrieve again"
      caption="Naive RAG runs one retrieval and answers. Agentic RAG plans, routes the query across multiple sources (vector KB, graph KB, SQL warehouse), critiques the evidence, and only answers when the critic says the gap is closed. The loop is the whole point."
    >
      <svg viewBox="0 0 620 300" className="w-full">
        <defs>
          <marker id="arRag" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* Question */}
        <rect x={10} y={130} width={90} height={40} rx={8} fill="var(--chart-3)" fillOpacity={0.15} stroke="var(--chart-3)" strokeWidth="1.4" />
        <text x={55} y={148} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-3)">QUESTION</text>
        <text x={55} y={162} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">user goal</text>

        {/* Planner */}
        <rect x={130} y={130} width={100} height={40} rx={8} fill="var(--primary)" fillOpacity={0.18} stroke="var(--primary)" strokeWidth="1.5" />
        <text x={180} y={148} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--primary)">PLANNER</text>
        <text x={180} y={162} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">decompose · route</text>

        {/* Sources */}
        <rect x={270} y={30} width={120} height={48} rx={8} fill="var(--chart-1)" fillOpacity={0.15} stroke="var(--chart-1)" strokeWidth="1.3" />
        <text x={330} y={50} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-1)">VECTOR KB</text>
        <text x={330} y={66} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">semantic chunks</text>

        <rect x={270} y={130} width={120} height={48} rx={8} fill="var(--chart-2)" fillOpacity={0.15} stroke="var(--chart-2)" strokeWidth="1.3" />
        <text x={330} y={150} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-2)">GRAPH KB</text>
        <text x={330} y={166} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">entities · relations</text>

        <rect x={270} y={230} width={120} height={48} rx={8} fill="var(--chart-4)" fillOpacity={0.15} stroke="var(--chart-4)" strokeWidth="1.3" />
        <text x={330} y={250} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-4)">SQL WAREHOUSE</text>
        <text x={330} y={266} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">numbers · facts</text>

        {/* Critic */}
        <rect x={430} y={130} width={100} height={40} rx={8} fill="var(--chart-5, var(--chart-3))" fillOpacity={0.18} stroke="var(--chart-3)" strokeWidth="1.5" />
        <text x={480} y={148} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--chart-3)">CRITIC</text>
        <text x={480} y={162} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">enough evidence?</text>

        {/* Answer */}
        <rect x={555} y={130} width={55} height={40} rx={8} fill="var(--primary)" fillOpacity={0.2} stroke="var(--primary)" strokeWidth="1.5" />
        <text x={582} y={148} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--primary)">ANSWER</text>
        <text x={582} y={162} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">+ cites</text>

        {/* arrows: question → planner */}
        <line x1={100} y1={150} x2={128} y2={150} stroke="var(--primary)" strokeWidth="1.6" markerEnd="url(#arRag)" />

        {/* planner → sources */}
        <path d="M 230,140 Q 250,100 268,55" fill="none" stroke="var(--primary)" strokeWidth="1.4" markerEnd="url(#arRag)" />
        <line x1={230} y1={150} x2={268} y2={150} stroke="var(--primary)" strokeWidth="1.4" markerEnd="url(#arRag)" />
        <path d="M 230,160 Q 250,200 268,250" fill="none" stroke="var(--primary)" strokeWidth="1.4" markerEnd="url(#arRag)" />

        {/* sources → critic */}
        <path d="M 390,55 Q 410,100 428,140" fill="none" stroke="var(--chart-1)" strokeWidth="1.3" markerEnd="url(#arRag)" />
        <line x1={390} y1={150} x2={428} y2={150} stroke="var(--chart-2)" strokeWidth="1.3" markerEnd="url(#arRag)" />
        <path d="M 390,250 Q 410,200 428,160" fill="none" stroke="var(--chart-4)" strokeWidth="1.3" markerEnd="url(#arRag)" />

        {/* critic → answer (DONE) */}
        <line x1={530} y1={150} x2={553} y2={150} stroke="var(--primary)" strokeWidth="1.8" markerEnd="url(#arRag)" />
        <text x={542} y={142} textAnchor="middle" fontSize="8" fontStyle="italic" fill="var(--primary)">done</text>

        {/* critic → planner (LOOP / GAP) */}
        <path d="M 480,170 Q 480,290 180,290 Q 180,260 180,172" fill="none" stroke="var(--chart-3)" strokeWidth="1.5" strokeDasharray="5 3" markerEnd="url(#arRag)" />
        <text x={330} y={285} textAnchor="middle" fontSize="9" fontStyle="italic" fontWeight="700" fill="var(--chart-3)">
          gap → re-plan & retrieve more
        </text>
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 11. Graph RAG — entities & relations ─────────────── */

export function GraphRagVisual() {
  // Knowledge graph: companies, people, products, with relationships
  const nodes = [
    { id: "acme", x: 90, y: 60, label: "Acme Corp", kind: "company" },
    { id: "alice", x: 230, y: 30, label: "Alice", kind: "person" },
    { id: "bob", x: 230, y: 110, label: "Bob", kind: "person" },
    { id: "widgetx", x: 380, y: 30, label: "WidgetX", kind: "product" },
    { id: "widgety", x: 380, y: 110, label: "WidgetY", kind: "product" },
    { id: "globex", x: 90, y: 180, label: "Globex", kind: "company" },
    { id: "carol", x: 230, y: 200, label: "Carol", kind: "person" },
    { id: "widgetx2", x: 380, y: 200, label: "WidgetX", kind: "product" },
  ];
  const edges = [
    { from: "acme", to: "alice", label: "employs" },
    { from: "acme", to: "bob", label: "employs" },
    { from: "alice", to: "widgetx", label: "owns" },
    { from: "bob", to: "widgety", label: "owns" },
    { from: "globex", to: "carol", label: "employs" },
    { from: "carol", to: "widgetx2", label: "uses" },
    { from: "alice", to: "carol", label: "knows" },
  ];
  const colorOf = (kind: string) =>
    kind === "company" ? "var(--chart-1)" : kind === "person" ? "var(--chart-2)" : "var(--chart-4)";
  const byId = (id: string) => nodes.find((n) => n.id === id)!;

  return (
    <VisualShell
      icon={Network}
      chip="Graph RAG"
      title="Answers that follow relationships, not just similarity"
      caption="Plain RAG returns chunks similar to the question. Graph RAG follows typed edges between entities — 'who at Acme owns the same product Globex's customer is using?' is one hop in a graph and a near-impossible chunk match. Use it when your domain has structure: org charts, supply chains, drug interactions, codebases."
    >
      <svg viewBox="0 0 480 250" className="w-full">
        <defs>
          <marker id="grAr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>

        {/* edges */}
        {edges.map((e, i) => {
          const a = byId(e.from);
          const b = byId(e.to);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeWidth="1.2" markerEnd="url(#grAr)" />
              <text x={mx} y={my - 3} textAnchor="middle" fontSize="8" fontStyle="italic" fill="var(--muted-foreground)">
                {e.label}
              </text>
            </g>
          );
        })}

        {/* nodes */}
        {nodes.map((n) => {
          const c = colorOf(n.kind);
          return (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r={20} fill={c} fillOpacity={0.18} stroke={c} strokeWidth="1.4" />
              <text x={n.x} y={n.y + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill={c}>
                {n.label.length > 8 ? n.label.slice(0, 7) + "…" : n.label}
              </text>
            </g>
          );
        })}

        {/* legend */}
        <g transform="translate(10, 230)">
          <circle cx={6} cy={0} r={5} fill="var(--chart-1)" fillOpacity={0.4} stroke="var(--chart-1)" />
          <text x={16} y={3} fontSize="9" fill="var(--muted-foreground)">company</text>
          <circle cx={86} cy={0} r={5} fill="var(--chart-2)" fillOpacity={0.4} stroke="var(--chart-2)" />
          <text x={96} y={3} fontSize="9" fill="var(--muted-foreground)">person</text>
          <circle cx={156} cy={0} r={5} fill="var(--chart-4)" fillOpacity={0.4} stroke="var(--chart-4)" />
          <text x={166} y={3} fontSize="9" fill="var(--muted-foreground)">product</text>
        </g>
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 12. Evaluation pyramid ─────────────── */

export function EvalPyramidVisual() {
  const layers = [
    { label: "Production telemetry", sub: "thumbs · escalations · cost", color: "var(--chart-4)", w: 460 },
    { label: "End-to-end agent evals", sub: "task success · LLM-as-judge", color: "var(--primary)", w: 380 },
    { label: "Component evals", sub: "retrieval@k · tool-call accuracy", color: "var(--chart-2)", w: 280 },
    { label: "Unit tests", sub: "pure functions · prompts · schemas", color: "var(--chart-1)", w: 180 },
  ];
  return (
    <VisualShell
      icon={Layers}
      chip="Evaluation"
      title="The four-layer eval pyramid"
      caption="Most teams ship one eval suite and call it done — then wonder why production breaks. Mature teams stack four layers: cheap unit tests catch syntax bugs, component evals catch retrieval & tool errors, end-to-end evals catch reasoning regressions, and live telemetry catches everything you didn't think to test."
    >
      <svg viewBox="0 0 520 240" className="w-full">
        {layers.map((l, i) => {
          const y = 20 + i * 50;
          const x = (520 - l.w) / 2;
          return (
            <g key={l.label}>
              <rect x={x} y={y} width={l.w} height={42} rx={6} fill={l.color} fillOpacity={0.18} stroke={l.color} strokeWidth="1.4" />
              <text x={260} y={y + 18} textAnchor="middle" fontSize="11" fontWeight="700" fill={l.color}>
                {l.label}
              </text>
              <text x={260} y={y + 33} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">
                {l.sub}
              </text>
            </g>
          );
        })}
        <text x={10} y={30} fontSize="9" fontStyle="italic" fill="var(--muted-foreground)">slow · expensive</text>
        <text x={10} y={228} fontSize="9" fontStyle="italic" fill="var(--muted-foreground)">fast · cheap</text>
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 13. SQL Agent pipeline ─────────────── */

export function SqlAgentVisual() {
  const steps = [
    { label: "Question", sub: "natural language" },
    { label: "Schema Retrieval", sub: "tables + semantics" },
    { label: "SQL Draft", sub: "LLM emits query" },
    { label: "Validate & Repair", sub: "EXPLAIN / sandbox" },
    { label: "Execute", sub: "read-only role" },
    { label: "Narrate", sub: "answer + chart" },
  ];
  return (
    <VisualShell
      icon={Database}
      chip="SQL Agent"
      title="From plain-English question to safe, executed SQL"
      caption="A production SQL agent never just asks an LLM to 'write the query'. It retrieves relevant schema, drafts SQL, validates against the planner, executes inside a read-only role with row limits, and finally narrates the result. Skip a step, lose your data warehouse."
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-2">
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center min-w-[110px]">
              <div className="mx-auto mb-1 grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                {i + 1}
              </div>
              <div className="text-[11px] font-semibold leading-tight">{s.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{s.sub}</div>
            </div>
            {i < steps.length - 1 && (
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-primary/60">
                <path d="M2 7h9M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

/* ─────────────── 14. Security threat surface ─────────────── */

export function SecurityThreatVisual() {
  const threats = [
    { label: "Prompt injection", color: "var(--chart-1)", angle: 0 },
    { label: "Tool abuse", color: "var(--chart-2)", angle: 60 },
    { label: "Data exfil", color: "var(--chart-4)", angle: 120 },
    { label: "Model spoofing", color: "var(--chart-3)", angle: 180 },
    { label: "Cost / DoS", color: "var(--primary)", angle: 240 },
    { label: "PII leakage", color: "var(--chart-2)", angle: 300 },
  ];
  const cx = 230;
  const cy = 130;
  const r = 95;

  return (
    <VisualShell
      icon={ShieldCheck}
      chip="Security"
      title="Six threats every agent team should rehearse"
      caption="An agent has more attack surface than a chatbot — every tool, every retrieved document, every memory write is a potential injection point. These six threat classes cover ~90% of what red teams find in the wild. Map your defences against each."
    >
      <svg viewBox="0 0 460 270" className="w-full">
        {/* core */}
        <circle cx={cx} cy={cy} r={42} fill="var(--primary)" fillOpacity={0.18} stroke="var(--primary)" strokeWidth="1.6" />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--primary)">AGENT</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">core</text>

        {threats.map((t) => {
          const rad = (t.angle * Math.PI) / 180;
          const tx = cx + r * Math.cos(rad);
          const ty = cy + r * Math.sin(rad);
          return (
            <g key={t.label}>
              <line x1={cx + 42 * Math.cos(rad)} y1={cy + 42 * Math.sin(rad)} x2={tx - 28 * Math.cos(rad)} y2={ty - 28 * Math.sin(rad)} stroke={t.color} strokeOpacity={0.5} strokeWidth="1.4" strokeDasharray="3 3" />
              <circle cx={tx} cy={ty} r={26} fill={t.color} fillOpacity={0.18} stroke={t.color} strokeWidth="1.4" />
              <text x={tx} y={ty + 3} textAnchor="middle" fontSize="8" fontWeight="700" fill={t.color}>
                {t.label.split(" ")[0].toUpperCase()}
              </text>
              <text x={tx} y={ty + 42} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">{t.label}</text>
            </g>
          );
        })}
      </svg>
    </VisualShell>
  );
}

/* ─────────────── 15. Real-world framework stack (layered) ─────────────── */

export function FrameworkStackVisual() {
  const layers = [
    {
      label: "Experience",
      sub: "chat UI · ticket form · Slack bot",
      examples: ["React", "Slack", "Teams"],
      color: "var(--chart-4)",
    },
    {
      label: "Agent orchestration",
      sub: "the loop, handoffs, HITL, checkpoints",
      examples: ["LangGraph", "CrewAI", "AutoGen", "OpenAI Agents", "AgentSwarms"],
      color: "var(--primary)",
    },
    {
      label: "Reasoning + validation",
      sub: "typed I/O · structured outputs · planners",
      examples: ["Pydantic AI", "Semantic Kernel", "Instructor"],
      color: "var(--chart-3)",
    },
    {
      label: "Retrieval + memory",
      sub: "vector · graph · hybrid · long-term",
      examples: ["LlamaIndex", "LangChain retrievers", "pgvector", "Letta"],
      color: "var(--chart-2)",
    },
    {
      label: "Tools + integrations",
      sub: "MCP servers · APIs · code sandbox",
      examples: ["MCP", "Composio", "Custom APIs"],
      color: "var(--chart-1)",
    },
    {
      label: "Models + infra",
      sub: "LLM providers · gateways · runtimes",
      examples: ["OpenAI", "Anthropic", "Bedrock", "Vertex", "Azure", "vLLM"],
      color: "var(--muted-foreground)",
    },
  ];

  return (
    <VisualShell
      icon={Layers}
      chip="Real-world stack"
      title="What an actual production agent stack looks like"
      caption="Nobody picks 'one framework' — they pick one per layer. A typical 2025 stack is: a UI on top, an orchestrator in the middle (this is what people argue about on Twitter), a typed validation layer, a retrieval library, a tool gateway (often MCP), and the model providers underneath. AgentSwarms collapses several of these layers into a single visual canvas."
    >
      <div className="space-y-2">
        {layers.map((l) => (
          <div
            key={l.label}
            className="flex flex-col gap-2 rounded-lg border border-border/40 bg-background/60 p-3 sm:flex-row sm:items-center sm:gap-4"
            style={{ borderLeft: `4px solid ${l.color}` }}
          >
            <div className="sm:w-48 sm:shrink-0">
              <div className="text-[12px] font-semibold" style={{ color: l.color }}>
                {l.label}
              </div>
              <div className="text-[10px] leading-snug text-muted-foreground">{l.sub}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {l.examples.map((e) => (
                <span
                  key={e}
                  className="rounded-md border border-border/60 bg-card/60 px-2 py-0.5 text-[10px] font-medium text-foreground"
                >
                  {e}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

/* ─────────────── 16. Framework decision tree ─────────────── */

export function FrameworkDecisionVisual() {
  const branches = [
    { q: "Just one agent, one workflow?", yes: "Pydantic AI · OpenAI Agents", no: "→ next" },
    { q: "Multi-agent collaboration?", yes: "CrewAI · AutoGen · LangGraph supervisor", no: "→ next" },
    { q: "Long-running / resumable?", yes: "LangGraph + checkpointer", no: "→ next" },
    { q: "RAG-heavy domain?", yes: "LlamaIndex (retrieval) + any orchestrator", no: "→ next" },
    { q: ".NET or Java codebase?", yes: "Semantic Kernel", no: "→ next" },
    { q: "Want a visual canvas?", yes: "AgentSwarms · Langflow · Flowise", no: "Hand-roll it." },
  ];
  return (
    <VisualShell
      icon={GitBranch}
      chip="Pick a framework"
      title="A 30-second decision tree"
      caption="Walk top to bottom. The first 'yes' is your answer — don't keep going. Most teams over-shop frameworks; this is the question order that matches what we see in real production stacks."
    >
      <div className="space-y-2">
        {branches.map((b, i) => (
          <div
            key={b.q}
            className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[28px_1fr_auto_auto]"
          >
            <div className="hidden h-7 w-7 place-items-center rounded-full bg-primary/15 text-[10px] font-bold text-primary sm:grid">
              {i + 1}
            </div>
            <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm font-medium">
              {b.q}
            </div>
            <div className="rounded-md border border-chart-2/40 bg-chart-2/10 px-3 py-2 text-xs font-semibold text-chart-2">
              YES → {b.yes}
            </div>
            <div className="rounded-md border border-border/40 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
              NO {b.no}
            </div>
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

/* ─────────────── default re-exports for grouping ─────────────── */

export const LearnVisuals = {
  Embeddings: EmbeddingsVisual,
  Attention: AttentionVisual,
  RAG: RAGVisual,
  Diffusion: DiffusionVisual,
  ReAct: ReActVisual,
  PlanExecute: PlanExecuteVisual,
  Swarm: SwarmVisual,
  ToolCall: ToolCallVisual,
  Memory: MemoryVisual,
  AgenticRag: AgenticRagVisual,
  GraphRag: GraphRagVisual,
  EvalPyramid: EvalPyramidVisual,
  SqlAgent: SqlAgentVisual,
  SecurityThreat: SecurityThreatVisual,
  FrameworkStack: FrameworkStackVisual,
  FrameworkDecision: FrameworkDecisionVisual,
};

// Marker so the default export of this module is non-null.
export default LearnVisuals;

// Suppress "unused" warning for the Sparkles import — kept for future use.
void Sparkles;
