// Animated mock visuals used on the home page. Each component is purely
// presentational — no business logic. Animations respect prefers-reduced-motion
// and fall back to a static frame.
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ChevronRight, ChevronDown } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared: marching dashed connector with a travelling packet dot.            */
/* `orientation` switches between horizontal and vertical, so the same        */
/* component handles both mobile (vertical stack) and desktop (row) layouts.  */
function FlowConnector({
  orientation,
  tone = "primary",
  active = true,
  delay = 0,
}: {
  orientation: "horizontal" | "vertical";
  tone?: "primary" | "destructive";
  active?: boolean;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const isH = orientation === "horizontal";
  const strokeClass = tone === "destructive" ? "border-destructive/60" : "border-primary/40";
  const dotClass = tone === "destructive" ? "bg-destructive" : "bg-primary";

  return (
    <div
      className={
        isH ? "relative hidden h-px flex-1 sm:block" : "relative my-1 mx-auto h-6 w-px sm:hidden"
      }
    >
      <div
        className={
          (isH
            ? "absolute inset-0 border-t border-dashed "
            : "absolute inset-0 border-l border-dashed ") + strokeClass
        }
      />
      {active && !reduce && (
        <motion.span
          aria-hidden
          className={`absolute h-1.5 w-1.5 rounded-full ${dotClass} shadow-[0_0_6px_currentColor]`}
          style={
            isH
              ? { top: "50%", left: 0, translateY: "-50%" }
              : { left: "50%", top: 0, translateX: "-50%" }
          }
          animate={isH ? { left: ["0%", "100%"] } : { top: ["0%", "100%"] }}
          transition={{
            duration: 1.4,
            repeat: Infinity,
            ease: "linear",
            delay,
          }}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. "A real builder, not a toy" — Router → Agent → Evaluate → Output       */
export function RealBuilderMock() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const nodes = [
    { label: "Router", tone: "text-indigo-500 bg-indigo-500/10", ring: "ring-indigo-500/40" },
    { label: "Agent", tone: "text-primary bg-primary/10", ring: "ring-primary/40" },
    { label: "Evaluate", tone: "text-teal-500 bg-teal-500/10", ring: "ring-teal-500/40" },
  ];

  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % 4), 1400);
    return () => window.clearInterval(id);
  }, [reduce]);

  return (
    <div className="mt-8 flex flex-1 items-center rounded-lg border border-border/60 bg-muted/20 px-4 py-6 sm:px-5 sm:py-8">
      <div className="flex w-full flex-col items-stretch sm:flex-row sm:items-center">
        {nodes.map((n, i) => {
          const active = step === i;
          return (
            <div key={n.label} className="contents">
              {i > 0 && (
                <>
                  <FlowConnector orientation="horizontal" active delay={i * 0.15} />
                  <FlowConnector orientation="vertical" active delay={i * 0.15} />
                </>
              )}
              <motion.div
                animate={active && !reduce ? { scale: [1, 1.04, 1] } : { scale: 1 }}
                transition={{ duration: 0.5 }}
                className={`mx-auto flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm transition-all sm:mx-0 ${
                  active ? `border-transparent ring-2 ${n.ring}` : "border-border"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${n.tone}`}
                >
                  <motion.span
                    animate={active && !reduce ? { scale: [1, 1.6, 1] } : { scale: 1 }}
                    transition={{ duration: 0.5 }}
                    className="h-1.5 w-1.5 rounded-full bg-current"
                  />
                </span>
                <span className="truncate text-[11px] font-semibold tracking-tight">{n.label}</span>
              </motion.div>
            </div>
          );
        })}

        <FlowConnector orientation="horizontal" active delay={0.45} />
        <FlowConnector orientation="vertical" active delay={0.45} />

        <motion.div
          animate={step === 3 && !reduce ? { scale: [1, 1.05, 1] } : { scale: 1 }}
          transition={{ duration: 0.5 }}
          className={`mx-auto flex min-w-0 items-center gap-1.5 rounded-lg border bg-emerald-500/10 px-3 py-2 sm:mx-0 ${
            step === 3
              ? "border-emerald-500/60 ring-2 ring-emerald-500/30"
              : "border-emerald-500/30"
          }`}
        >
          <span className="block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          <span className="truncate text-[11px] font-semibold tracking-tight text-emerald-600 dark:text-emerald-400">
            Output
          </span>
        </motion.div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. Presentations deck mock                                                */
export function DeckMock() {
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 5), 1100);
    return () => window.clearInterval(id);
  }, [reduce]);

  const rows = [
    { label: "Thought", base: 75, tone: "bg-primary/30" },
    { label: "Action", base: 50, tone: "bg-primary/50" },
    { label: "Observation", base: 66, tone: "bg-primary/20" },
  ];
  const slideNum = 12 + tick;

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
          Deck 04 · Agentic patterns
        </p>
        <p className="mt-2 text-lg font-semibold tracking-tight">
          ReAct: reason, act, observe, repeat
        </p>
        <div className="mt-5 space-y-2.5">
          {rows.map((r, i) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
                {r.label}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <motion.div
                  key={`${r.label}-${tick}`}
                  className={`h-2 rounded-full ${r.tone}`}
                  initial={reduce ? { width: `${r.base}%` } : { width: 0 }}
                  animate={{ width: `${r.base}%` }}
                  transition={{
                    duration: reduce ? 0 : 0.7,
                    delay: reduce ? 0 : i * 0.18,
                    ease: "easeOut",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((d) => (
              <span
                key={d}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  d === tick ? "bg-primary" : "bg-border"
                }`}
              />
            ))}
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">{slideNum} / 31</span>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. Failure-mode broken-swarm mock                                         */
export function BrokenSwarmMock() {
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 3), 1200);
    return () => window.clearInterval(id);
  }, [reduce]);
  const counts = [3, 7, 12];
  const count = counts[tick];

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
      <div className="rounded-lg border border-border/60 bg-muted/20 px-5 py-8">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            <span className="text-[11px] font-semibold tracking-tight">Researcher</span>
          </div>
          <div className="relative h-px flex-1">
            <div className="absolute inset-0 border-t border-dashed border-destructive/60" />
            {!reduce && (
              <motion.span
                aria-hidden
                className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-destructive shadow-[0_0_6px_currentColor]"
                animate={{ left: ["0%", "100%"] }}
                transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
              />
            )}
          </div>
          <motion.div
            animate={reduce ? {} : { x: [0, -1.5, 1.5, -1.5, 0] }}
            transition={{ duration: 0.4, repeat: Infinity, repeatDelay: 0.8 }}
            className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2 shadow-sm"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded bg-destructive/10 text-destructive">
              <AlertTriangle className="h-3 w-3" />
            </span>
            <span className="text-[11px] font-semibold tracking-tight">Tool Loop</span>
          </motion.div>
        </div>
        <div className="mt-5 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="font-mono text-[10px] text-destructive">
            max_iterations exceeded — agent re-called the same tool{" "}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={count}
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                transition={{ duration: 0.2 }}
                className="inline-block font-bold tabular-nums"
              >
                {count}
              </motion.span>
            </AnimatePresence>{" "}
            times
          </p>
        </div>
        <p className="mt-3 font-mono text-[10px] text-muted-foreground">
          Your job: find the missing stop condition and repair the loop.
        </p>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. Interactive notebooks mock                                             */
export function NotebookMock() {
  const reduce = useReducedMotion();
  const cats = [
    {
      l: "Foundations",
      n: 2,
      file: "fnd-prompt-engineering.ipynb",
      title: "Anatomy of a chat request",
      model: "gemini-3-flash",
    },
    {
      l: "Agentic Evals",
      n: 8,
      file: "eval-faithfulness.ipynb",
      title: "Scoring grounded answers",
      model: "gpt-5.1",
    },
    {
      l: "LangChain",
      n: 5,
      file: "lc-rag-router.ipynb",
      title: "Route by intent, then retrieve",
      model: "claude-4.5-sonnet",
    },
    {
      l: "LlamaIndex.ts",
      n: 7,
      file: "li-query-engine.ipynb",
      title: "Composable query engines",
      model: "gemini-3-flash",
    },
    {
      l: "OpenAI Agents",
      n: 6,
      file: "oa-handoff.ipynb",
      title: "Handoff between agents",
      model: "gpt-5.1",
    },
    {
      l: "Vercel AI SDK",
      n: 6,
      file: "vai-stream-ui.ipynb",
      title: "Streaming tool calls to the UI",
      model: "claude-4.5-sonnet",
    },
    {
      l: "Failure Modes",
      n: 10,
      warn: true,
      file: "fm-tool-loop.ipynb",
      title: "Reproducing a runaway loop",
      model: "gpt-5.1",
    },
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % cats.length), 1600);
    return () => window.clearInterval(id);
  }, [reduce, cats.length]);
  const active = cats[idx];

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-lg lg:order-1">
      <div className="grid grid-cols-[140px_1fr] overflow-hidden rounded-lg border border-border/60 bg-muted/20 text-[10px]">
        <div className="border-r border-border/60 bg-background/40 p-3 space-y-1.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-foreground">Notebooks</span>
            <span className="rounded-sm bg-muted px-1 text-muted-foreground">67</span>
          </div>
          {cats.map((t, i) => (
            <motion.div
              key={t.l}
              animate={{
                backgroundColor:
                  i === idx ? "rgb(var(--primary-rgb,99 102 241) / 0.10)" : "rgba(0,0,0,0)",
              }}
              className={`flex items-center justify-between rounded px-1.5 py-1 transition-colors ${
                i === idx ? "bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
            >
              <span className="truncate">{t.l}</span>
              <span className={t.warn ? "text-destructive" : ""}>{t.n}</span>
            </motion.div>
          ))}
        </div>
        <div className="p-4 font-mono leading-relaxed">
          <AnimatePresence mode="wait">
            <motion.div
              key={active.file}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
            >
              <p className="mb-2 truncate text-muted-foreground">{active.file}</p>
              <p className="truncate text-foreground">1 · {active.title}</p>
              <div className="mt-3 rounded border border-border/60 bg-background/60 p-2 text-[9px] text-primary/80">
                <div>{"{"}</div>
                <div className="pl-3">"model": "{active.model}",</div>
                <div className="pl-3">"messages": [...]</div>
                <div>{"}"}</div>
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="mt-2 flex items-center gap-2 text-[9px] text-muted-foreground">
            <motion.span
              animate={reduce ? {} : { opacity: [1, 0.6, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              className="rounded bg-primary/15 px-1.5 py-0.5 text-primary"
            >
              ▶ Run
            </motion.span>
            <span>Shift + Enter</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 5. Interactive blog VRAM estimator mock                                   */
export function VramMock() {
  const reduce = useReducedMotion();
  const sizes = [
    { l: "3B", ctx: 18, vram: 6.4, ok: [true, true, true, true] },
    { l: "8B", ctx: 28, vram: 16.2, ok: [true, true, true, true] },
    { l: "14B", ctx: 42, vram: 28.6, ok: [false, true, true, true] },
    { l: "32B", ctx: 60, vram: 44.1, ok: [false, true, true, true] },
    { l: "70B", ctx: 85, vram: 71.6, ok: [false, false, true, true] },
    { l: "405B", ctx: 95, vram: 410.0, ok: [false, false, false, false] },
  ];
  const gpus = ["24GB", "48GB", "80GB", "141GB"];
  const [idx, setIdx] = useState(4); // start at 70B for parity with original
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % sizes.length), 1600);
    return () => window.clearInterval(id);
  }, [reduce, sizes.length]);
  const active = sizes[idx];
  const modelPct = ((idx + 1) / sizes.length) * 100;

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-lg">
      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {sizes.map((s, i) => (
            <motion.span
              key={s.l}
              animate={{ scale: i === idx ? 1.05 : 1 }}
              transition={{ duration: 0.25 }}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                i === idx
                  ? "bg-primary/20 text-primary"
                  : "border border-border/60 text-muted-foreground"
              }`}
            >
              {s.l}
            </motion.span>
          ))}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>model size</span>
            <span className="font-mono text-foreground">{active.l} params</span>
          </div>
          <div className="relative h-1.5 rounded-full bg-muted">
            <motion.div
              className="h-1.5 rounded-full bg-primary"
              animate={{ width: `${modelPct}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
            <motion.div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
              animate={{ left: `${modelPct}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          </div>
          <div className="flex items-center justify-between pt-1 text-[10px] text-muted-foreground">
            <span>context length</span>
            <span className="font-mono text-foreground">
              {Math.round((active.ctx / 100) * 128)}K tokens
            </span>
          </div>
          <div className="relative h-1.5 rounded-full bg-muted">
            <motion.div
              className="h-1.5 rounded-full bg-primary"
              animate={{ width: `${active.ctx}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
            <motion.div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
              animate={{ left: `${active.ctx}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-md border border-border/60 bg-background/60 px-3 py-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            VRAM needed
          </span>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={active.l}
              initial={reduce ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              transition={{ duration: 0.25 }}
              className="font-mono text-lg font-semibold tabular-nums text-primary"
            >
              {active.vram.toFixed(1)} <span className="text-xs">GB</span>
            </motion.span>
          </AnimatePresence>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {gpus.map((g, i) => {
            const ok = active.ok[i];
            return (
              <motion.div
                key={g}
                animate={{ scale: 1 }}
                className={`rounded border px-2 py-1.5 text-center font-mono text-[10px] transition-colors ${
                  ok
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
                }`}
              >
                {g} {ok ? "✓" : "✗"}
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* Unused helper exports kept to silence tree-shake warnings on icons. */
export const _icons = { ChevronRight, ChevronDown };
