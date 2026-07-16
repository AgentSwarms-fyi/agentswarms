// Renders a BlogPost's typed blocks into a styled long-read, plus a gradient
// cover used as the gallery thumbnail and the post hero.
import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  Info,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  RefreshCw,
  FileStack,
  Scale,
  Plug,
  Bug,
  Network,
  ClipboardList,
  Workflow,
  Cloud,
  Cpu,
  Brain,
  ArrowRight,
  Compass,
} from "lucide-react";
import type { BlogBlock, BlogPost } from "@/lib/blog";
import { BLOG_VISUALS } from "./blogVisuals";
import { getBlogPost } from "@/lib/blog";
import { RELATED_POSTS, EXPLORE_LINKS } from "@/lib/blogRelated";

const ease = [0.22, 1, 0.36, 1] as const;

// Minimal inline formatter: **bold**, *italic*, `code`, [label](href).
// Links beginning with "/" route via TanStack <Link>; others open externally.
function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    if (tok.startsWith("`") && tok.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] text-primary"
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      if (href.startsWith("/")) {
        return (
          <Link
            key={i}
            to={href}
            className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
          >
            {label}
          </Link>
        );
      }
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
        >
          {label}
        </a>
      );
    }
    if (tok.startsWith("*") && tok.endsWith("*")) {
      return (
        <em key={i} className="italic">
          {tok.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={i}>{tok}</Fragment>;
  });
}

const CALLOUT_STYLE = {
  info: { wrap: "border-sky-500/40 bg-sky-500/5", icon: Info, color: "text-sky-400" },
  warn: {
    wrap: "border-amber-500/40 bg-amber-500/5",
    icon: AlertTriangle,
    color: "text-amber-400",
  },
  success: {
    wrap: "border-emerald-500/40 bg-emerald-500/5",
    icon: CheckCircle2,
    color: "text-emerald-400",
  },
  tip: { wrap: "border-primary/40 bg-primary/5", icon: Lightbulb, color: "text-primary" },
} as const;

function Block({ block }: { block: BlogBlock }) {
  switch (block.type) {
    case "lead":
      return (
        <p className="text-xl leading-relaxed text-foreground/90 sm:text-2xl">
          {renderInline(block.text)}
        </p>
      );
    case "heading":
      return (
        <h2
          id={block.id}
          className="scroll-mt-24 pt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
        >
          {block.text}
        </h2>
      );
    case "subheading":
      return <h3 className="text-lg font-semibold text-foreground">{block.text}</h3>;
    case "paragraph":
      return (
        <p className="text-base leading-relaxed text-foreground/80 sm:text-lg">
          {renderInline(block.text)}
        </p>
      );
    case "list":
      return block.ordered ? (
        <ol className="space-y-2.5">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-3 text-base leading-relaxed text-foreground/80">
              <span className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                {i + 1}
              </span>
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="space-y-2.5">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-3 text-base leading-relaxed text-foreground/80">
              <span className="mt-2.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gradient-to-br from-primary to-nexus-glow" />
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ul>
      );
    case "callout": {
      const s = CALLOUT_STYLE[block.tone];
      const Icon = s.icon;
      return (
        <div className={`rounded-xl border p-4 ${s.wrap}`}>
          <div className="flex items-start gap-3">
            <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${s.color}`} />
            <div>
              {block.title && (
                <div className={`text-sm font-semibold ${s.color}`}>{block.title}</div>
              )}
              <p className="mt-0.5 text-sm leading-relaxed text-foreground/85">
                {renderInline(block.text)}
              </p>
            </div>
          </div>
        </div>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 border-primary/60 pl-5 text-lg italic leading-relaxed text-foreground/85">
          {renderInline(block.text)}
          {block.cite && (
            <cite className="mt-2 block text-sm not-italic text-muted-foreground">
              — {block.cite}
            </cite>
          )}
        </blockquote>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-xl border border-border/60 bg-zinc-950 p-4 text-[13px] leading-relaxed">
          <code className="font-mono text-zinc-100">{block.code}</code>
        </pre>
      );
    case "diagram": {
      const Visual = BLOG_VISUALS[block.visual];
      return (
        <motion.figure
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, ease }}
          className="rounded-2xl border border-border/60 bg-card/30 p-5 sm:p-7"
        >
          {Visual ? (
            <Visual />
          ) : (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              Missing diagram: {block.visual}
            </div>
          )}
          {block.caption && (
            <figcaption className="mt-4 text-center text-sm text-muted-foreground">
              {renderInline(block.caption)}
            </figcaption>
          )}
        </motion.figure>
      );
    }
    case "divider":
      return <hr className="border-border/50" />;
    default:
      return null;
  }
}

export function BlogContent({ post }: { post: BlogPost }) {
  const related = RELATED_POSTS[post.slug] ?? [];
  const explore = EXPLORE_LINKS[post.slug] ?? [];
  return (
    <div className="space-y-6">
      {post.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}

      {(related.length > 0 || explore.length > 0) && (
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {related.length > 0 && (
            <aside className="rounded-2xl border border-border/60 bg-card/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Compass className="h-4 w-4 text-primary" /> Related on the blog
              </div>
              <ul className="mt-3 space-y-3">
                {related.map((r) => {
                  const target = getBlogPost(r.slug);
                  if (!target) return null;
                  return (
                    <li key={r.slug}>
                      <Link
                        to="/blog/$slug"
                        params={{ slug: r.slug }}
                        className="group block rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-primary/5"
                      >
                        <div className="flex items-start gap-2 text-sm font-semibold text-foreground group-hover:text-primary">
                          <ArrowRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                          <span>{target.title}</span>
                        </div>
                        <p className="ml-5 mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {r.note}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </aside>
          )}

          {explore.length > 0 && (
            <aside className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/40 to-nexus-glow/10 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-primary">
                <Compass className="h-4 w-4" /> Explore on AgentSwarms
              </div>
              <ul className="mt-3 space-y-3">
                {explore.map((e) => (
                  <li key={e.href}>
                    <Link
                      to={e.href as "/"}
                      className="group block rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-primary/10"
                    >

                      <div className="flex items-start gap-2 text-sm font-semibold text-foreground group-hover:text-primary">
                        <ArrowRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
                        <span>{e.label}</span>
                      </div>
                      <p className="ml-5 mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {e.note}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

const COVER_ICONS: Record<string, typeof RefreshCw> = {
  refresh: RefreshCw,
  docs: FileStack,
  scale: Scale,
  plug: Plug,
  bug: Bug,
  network: Network,
  clipboard: ClipboardList,
  workflow: Workflow,
  cloud: Cloud,
  cpu: Cpu,
  brain: Brain,
};

export function BlogCover({ post, size = "card" }: { post: BlogPost; size?: "card" | "hero" }) {
  const Icon = COVER_ICONS[post.cover.icon] ?? FileStack;
  const hero = size === "hero";
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${post.cover.gradient} ${
        hero ? "h-56 rounded-2xl sm:h-72" : "h-24 sm:h-28"
      }`}
    >
      {/* faint grid motif */}
      <div
        className="absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage:
            "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
          backgroundSize: hero ? "32px 32px" : "18px 18px",
          color: "white",
        }}
      />
      <Icon
        className={`absolute text-white/25 ${hero ? "right-6 top-6 h-28 w-28" : "right-2.5 top-2.5 h-10 w-10"}`}
        strokeWidth={1.25}
      />
      <div className={`absolute inset-0 flex flex-col justify-end gap-2 ${hero ? "p-6" : "p-3"}`}>
        <div className="flex flex-wrap gap-1.5">
          {post.tags.slice(0, hero ? 4 : 2).map((t) => (
            <span
              key={t}
              className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90 backdrop-blur-sm"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
