// Slide layout components for the Presentation Viewer.
// Three layouts, each driven entirely by props from src/lib/presentations.ts:
//   - TitleSlide       large centered H1 + sub-headline + AgentSwarms watermark
//   - BulletSlide      H2 + staggered bullet list with generous line height
//   - CodeDiagramSlide H2 + prose on the left, code/Mermaid on the right
//
// Dark-mode, premium-SaaS aesthetic. Bullet stagger uses framer-motion.
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { PRESENTATION_VISUALS } from "./visuals";
import type {
  TitleSlide as TitleSlideData,
  BulletSlide as BulletSlideData,
  CodeSlide as CodeSlideData,
  StatementSlide as StatementSlideData,
  CompareSlide as CompareSlideData,
  VisualSlide as VisualSlideData,
} from "@/lib/presentations";

function Eyebrow({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
      <Sparkles className="h-3 w-3" />
      {children}
    </span>
  );
}

export function TitleSlide({ slide }: { slide: TitleSlideData }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-8 text-center">
      {slide.eyebrow && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4 }}
        >
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </motion.div>
      )}
      <motion.h1
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, duration: 0.5 }}
        className="mt-6 max-w-4xl bg-gradient-to-br from-foreground via-foreground to-foreground/60 bg-clip-text text-5xl font-extrabold leading-tight tracking-tight text-transparent sm:text-6xl lg:text-7xl"
      >
        {slide.title}
      </motion.h1>
      {slide.subtitle && (
        <motion.p
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22, duration: 0.5 }}
          className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl"
        >
          {slide.subtitle}
        </motion.p>
      )}
      {/* AgentSwarms watermark */}
      <div className="pointer-events-none absolute bottom-6 right-8 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground/60">
        <img src={agentSwarmsLogo} alt="" className="h-4 w-4 rounded object-cover" />
        AgentSwarms
      </div>
    </div>
  );
}

export function BulletSlide({ slide }: { slide: BulletSlideData }) {
  return (
    <div className="flex h-full flex-col justify-center px-10 sm:px-16">
      {slide.eyebrow && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mb-4"
        >
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </motion.div>
      )}
      <motion.h2
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, duration: 0.45 }}
        className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl"
      >
        {slide.title}
      </motion.h2>
      <motion.ul
        className="mt-10 max-w-3xl space-y-5"
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.12, delayChildren: 0.2 } },
        }}
      >
        {slide.bullets.map((b, i) => (
          <motion.li
            key={i}
            variants={{
              hidden: { opacity: 0, x: -16 },
              show: { opacity: 1, x: 0, transition: { duration: 0.4 } },
            }}
            className="flex items-start gap-4 text-lg leading-relaxed text-foreground/90 sm:text-xl"
          >
            <span className="mt-2.5 h-2 w-2 flex-shrink-0 rounded-full bg-gradient-to-br from-primary to-nexus-glow" />
            <span>{b}</span>
          </motion.li>
        ))}
      </motion.ul>
    </div>
  );
}

function CodePanel({ slide }: { slide: CodeSlideData }) {
  if (slide.mermaid) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-[#0d1117]">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
          <span className="ml-2">Mermaid diagram</span>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-[13px] leading-relaxed text-emerald-300/90">
          <code>{slide.mermaid}</code>
        </pre>
      </div>
    );
  }
  if (slide.code) {
    return (
      <div className="h-full overflow-auto rounded-xl border border-border/60 bg-[#0d1117] p-1 text-sm">
        <MarkdownMessage content={`\`\`\`${slide.language ?? ""}\n${slide.code}\n\`\`\``} />
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center rounded-xl border border-dashed border-border/60 bg-card/40 text-sm text-muted-foreground">
      Diagram / code goes here
    </div>
  );
}

export function StatementSlide({ slide }: { slide: StatementSlideData }) {
  const Visual = slide.visual ? PRESENTATION_VISUALS[slide.visual] : null;
  return (
    <div
      className={`relative flex h-full flex-col items-center px-8 pb-24 text-center ${
        Visual ? "justify-start pt-10" : "justify-center"
      }`}
    >
      {slide.eyebrow && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-5"
        >
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </motion.div>
      )}
      <motion.p
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ delay: 0.1, duration: 0.6 }}
        className={
          Visual
            ? "max-w-4xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl lg:text-5xl"
            : "max-w-4xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl"
        }
      >
        {slide.text}
      </motion.p>
      {Visual && (
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.5 }}
          className="mt-6 min-h-0 w-full flex-1"
        >
          <Visual />
        </motion.div>
      )}
      {slide.footnote && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className={`max-w-xl text-base text-muted-foreground sm:text-lg ${Visual ? "mt-4" : "mt-8"}`}
        >
          {slide.footnote}
        </motion.p>
      )}
    </div>
  );
}

function compareTone(tone?: "neutral" | "warn" | "good") {
  if (tone === "good") return "border-emerald-500/40 bg-emerald-500/5";
  if (tone === "warn") return "border-amber-500/40 bg-amber-500/5";
  return "border-border/60 bg-card/40";
}

export function CompareSlide({ slide }: { slide: CompareSlideData }) {
  const cols = [slide.left, slide.right] as const;
  return (
    <div className="flex h-full flex-col justify-center px-10 py-12 sm:px-16">
      {slide.eyebrow && (
        <div className="mb-3">
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </div>
      )}
      <motion.h2
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-3xl font-bold tracking-tight sm:text-4xl"
      >
        {slide.title}
      </motion.h2>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {cols.map((col, ci) => (
          <motion.div
            key={ci}
            initial={{ opacity: 0, x: ci === 0 ? -20 : 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + ci * 0.1, duration: 0.45 }}
            className={`rounded-2xl border p-6 ${compareTone(col.tone)}`}
          >
            <h3 className="text-lg font-semibold text-foreground sm:text-xl">{col.heading}</h3>
            <ul className="mt-4 space-y-3">
              {col.points.map((p, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 text-sm leading-relaxed text-foreground/85 sm:text-base"
                >
                  <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export function VisualSlide({ slide }: { slide: VisualSlideData }) {
  const Visual = PRESENTATION_VISUALS[slide.visual];
  return (
    <div className="flex h-full flex-col px-10 pb-20 pt-10 sm:px-16">
      {slide.eyebrow && (
        <div className="mb-3">
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </div>
      )}
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-3xl font-bold tracking-tight sm:text-4xl"
      >
        {slide.title}
      </motion.h2>
      <div className="min-h-0 flex-1 py-6">
        {Visual ? (
          <Visual />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Missing visual: {slide.visual}
          </div>
        )}
      </div>
      {slide.caption && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="mx-auto max-w-3xl text-center text-sm text-muted-foreground sm:text-base"
        >
          {slide.caption}
        </motion.p>
      )}
    </div>
  );
}

export function CodeDiagramSlide({ slide }: { slide: CodeSlideData }) {
  return (
    <div className="flex h-full flex-col px-10 py-12 sm:px-16">
      {slide.eyebrow && (
        <div className="mb-3">
          <Eyebrow>{slide.eyebrow}</Eyebrow>
        </div>
      )}
      <motion.h2
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-3xl font-bold tracking-tight sm:text-4xl"
      >
        {slide.title}
      </motion.h2>
      <div className="mt-8 grid min-h-0 flex-1 gap-8 lg:grid-cols-2">
        {/* Left — prose + bullets */}
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.12, duration: 0.45 }}
          className="flex flex-col justify-center"
        >
          {slide.body && (
            <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
              {slide.body}
            </p>
          )}
          {slide.bullets && slide.bullets.length > 0 && (
            <ul className="mt-5 space-y-3">
              {slide.bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 text-sm leading-relaxed text-foreground/90 sm:text-base"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
        {/* Right — code / diagram */}
        <motion.div
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.18, duration: 0.45 }}
          className="min-h-0"
        >
          <CodePanel slide={slide} />
        </motion.div>
      </div>
    </div>
  );
}
