import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Bot,
  Network,
  Notebook,
  Wrench,
  MessageSquare,
  Activity,
  Plug,
  LayoutDashboard,
  Settings,
  Library,
  Compass,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  Rocket,
  GraduationCap,
  Database,
  Workflow,
  BookOpen,
  Layers,
  PieChart,
  Boxes,
  Share2,
  Code2,
  Webhook,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Wallet,
  Server,
  Info,
  AlertTriangle,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type DocItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

export type DocGroup = {
  label: string;
  items: DocItem[];
};

export const DOCS_GROUPS: DocGroup[] = [
  {
    label: "Getting started",
    items: [
      { to: "/docs", label: "Introduction", icon: Compass },
      { to: "/docs/quickstart", label: "Quickstart", icon: Rocket },
      { to: "/docs/concepts", label: "Core concepts", icon: GraduationCap },
      { to: "/docs/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/docs/account", label: "Account", icon: Settings },
    ],
  },
  {
    label: "Build",
    items: [
      { to: "/docs/agents", label: "Agent Builder", icon: Bot },
      { to: "/docs/playground", label: "Agent Chat", icon: MessageSquare },
      { to: "/docs/swarms", label: "Swarm Canvas", icon: Network },
      { to: "/docs/skills", label: "Skills & Prompt Library", icon: Library },
      { to: "/docs/notebooks", label: "Developer workspace", icon: Notebook },
    ],
  },
  {
    label: "Data & analytics",
    items: [
      { to: "/docs/data", label: "Data Catalog & SQL", icon: Database },
      { to: "/docs/data-prep", label: "Data preparation", icon: Workflow },
      { to: "/docs/knowledge", label: "Knowledge Base", icon: BookOpen },
      { to: "/docs/semantics", label: "Semantic Layer", icon: Layers },
      { to: "/docs/bi", label: "BI Workspace", icon: PieChart },
    ],
  },
  {
    label: "Integrate & ship",
    items: [
      { to: "/docs/integrations", label: "Integrations", icon: Plug },
      { to: "/docs/models", label: "Models & providers", icon: Boxes },
      { to: "/docs/mcp", label: "MCP servers", icon: Share2 },
      { to: "/docs/embedding", label: "Web embedding", icon: Code2 },
      { to: "/docs/api", label: "API & webhooks", icon: Webhook },
      { to: "/docs/secrets", label: "Secrets", icon: KeyRound },
    ],
  },
  {
    label: "Govern & operate",
    items: [
      { to: "/docs/iam", label: "Access control", icon: ShieldCheck },
      { to: "/docs/guardrails", label: "Guardrails & PII", icon: ShieldAlert },
      { to: "/docs/budgets", label: "Budgets & cost", icon: Wallet },
      { to: "/docs/debugging", label: "Logs & traces", icon: Wrench },
      { to: "/docs/analytics", label: "Analytics & audit", icon: Activity },
    ],
  },
  {
    label: "Self-hosting",
    items: [{ to: "/docs/self-hosting", label: "Install & deploy", icon: Server }],
  },
];

// Flat, ordered list used for prev/next navigation.
export const DOCS_NAV: DocItem[] = DOCS_GROUPS.flatMap((g) => g.items);

function SidebarLinks({ current }: { current: string }) {
  return (
    <div className="space-y-4">
      {DOCS_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.to === current;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition " +
                      (active
                        ? "bg-primary/15 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-primary/10 hover:text-foreground")
                    }
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DocsSidebar({ current }: { current: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentItem = DOCS_NAV.find((d) => d.to === current);
  return (
    <nav aria-label="Documentation">
      {/* Mobile: collapsible disclosure so content stays above the fold */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          className="flex w-full items-center justify-between rounded-xl border border-border/50 bg-card/40 px-3 py-2.5 text-sm font-medium"
        >
          <span className="flex items-center gap-2 text-foreground">
            {currentItem ? <currentItem.icon className="h-4 w-4 text-primary" /> : null}
            {currentItem?.label ?? "Documentation"}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              mobileOpen && "rotate-180",
            )}
          />
        </button>
        {mobileOpen && (
          <div className="mt-2 rounded-xl border border-border/50 bg-card/40 p-3">
            <SidebarLinks current={current} />
          </div>
        )}
      </div>
      {/* Desktop: always-visible grouped rail. Scrolls inside itself — the
          rail is ~1100px tall and sticky, so without this the last groups sit
          below the fold for the whole read on long pages (measured: on
          /docs/agents at mid-scroll the last item was 480px past the
          viewport, unreachable until the article ended). */}
      <div className="hidden rounded-xl border border-border/50 bg-card/40 p-3 lg:block lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        <SidebarLinks current={current} />
      </div>
    </nav>
  );
}

/**
 * "On this page" rail. Scans the rendered article for h2[id] headings after
 * mount and tracks the one currently in view — no per-page wiring needed.
 */
export function DocsToc({ pathname }: { pathname: string }) {
  const [headings, setHeadings] = useState<{ id: string; text: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLHeadingElement>("article h2[id]"));
    setHeadings(els.map((el) => ({ id: el.id, text: el.textContent ?? "" })));
    if (els.length === 0) {
      setActiveId(null);
      return;
    }

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.intersectionRatio);
          else visible.delete(entry.target.id);
        });
        for (const el of els) {
          if (visible.has(el.id)) {
            setActiveId(el.id);
            return;
          }
        }
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: [0, 0.5, 1] },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pathname]);

  if (headings.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1 border-l border-border/60">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                "-ml-px block border-l py-0.5 pl-3 text-[13px] leading-snug transition",
                activeId === h.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocsHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-8">
      {eyebrow && (
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
          {eyebrow}
        </p>
      )}
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
      {description && (
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">{description}</p>
      )}
    </header>
  );
}

export function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 mt-12 text-2xl font-bold tracking-tight text-foreground">
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-24 mt-8 text-lg font-semibold text-foreground">
      {children}
    </h3>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 leading-relaxed text-muted-foreground">{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-4 ml-5 list-disc space-y-3 text-muted-foreground marker:text-primary/60">
      {children}
    </ul>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-lg border-l-4 border-primary/60 bg-primary/5 px-4 py-3 text-sm text-foreground/90">
      {children}
    </div>
  );
}

/**
 * Callout with an explicit intent. `why` is the one we reach for most: these
 * docs are meant to teach, and the reason a thing works the way it does is
 * usually the part worth remembering.
 */
const CALLOUT_STYLES = {
  info: {
    icon: Info,
    ring: "border-sky-500/50 bg-sky-500/5",
    tint: "text-sky-600 dark:text-sky-400",
    label: "Note",
  },
  warn: {
    icon: AlertTriangle,
    ring: "border-amber-500/50 bg-amber-500/5",
    tint: "text-amber-600 dark:text-amber-400",
    label: "Careful",
  },
  why: {
    icon: Lightbulb,
    ring: "border-primary/50 bg-primary/5",
    tint: "text-primary",
    label: "Why it works this way",
  },
} as const;

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUT_STYLES;
  title?: string;
  children: React.ReactNode;
}) {
  const s = CALLOUT_STYLES[kind];
  const Icon = s.icon;
  return (
    <div className={cn("mt-5 rounded-xl border px-4 py-3.5", s.ring)}>
      <p
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider",
          s.tint,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {title ?? s.label}
      </p>
      <div className="mt-1.5 text-sm leading-relaxed text-foreground/90">{children}</div>
    </div>
  );
}

/** Numbered walkthrough — for "do this, then this" instructions. */
export function Steps({ items }: { items: { title: string; body?: React.ReactNode }[] }) {
  return (
    <ol className="mt-5 space-y-4">
      {items.map((step, i) => (
        <li key={step.title} className="flex gap-3.5">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[12px] font-semibold text-primary">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{step.title}</p>
            {step.body && (
              <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Reference table. Scrolls inside itself so the page never scrolls sideways. */
export function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="mt-5 overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-border/60 bg-card/40 text-left">
            {headers.map((h) => (
              <th key={h} className="px-4 py-2.5 font-semibold text-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 align-top text-muted-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline literal — a field name, a path, an env var. */
export function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

/** Fenced block for commands and snippets. */
export function Code({ children, lang }: { children: string; lang?: string }) {
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-card/40">
      {lang && (
        <div className="border-b border-border/50 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 text-[12.5px] leading-relaxed">
        <code className="font-mono text-foreground/90">{children}</code>
      </pre>
    </div>
  );
}

/** Link grid used on hub pages. */
export function CardGrid({ items }: { items: { to: string; title: string; body: string }[] }) {
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {items.map((it) => (
        <Link
          key={it.to}
          to={it.to}
          className="group rounded-xl border border-border/60 bg-card/40 p-4 transition hover:border-primary/50"
        >
          <p className="font-medium text-foreground group-hover:text-primary">{it.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{it.body}</p>
        </Link>
      ))}
    </div>
  );
}

/**
 * Definition-list style reference for configuration fields:
 * <FieldList items={[{ name: "Temperature", body: <>…</> }, …]} />
 */
export function FieldList({ items }: { items: { name: string; body: React.ReactNode }[] }) {
  return (
    <dl className="mt-5 divide-y divide-border/50 rounded-xl border border-border/60 bg-card/30">
      {items.map((item) => (
        <div key={item.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
          <dt className="text-sm font-medium text-foreground">{item.name}</dt>
          <dd className="text-sm leading-relaxed text-muted-foreground">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Diagram({ children, caption }: { children: string; caption?: string }) {
  return (
    <figure className="mt-6 overflow-x-auto rounded-xl border border-border/60 bg-card/40 p-4">
      <pre className="text-[12px] leading-snug text-foreground/90 whitespace-pre font-mono">
        {children}
      </pre>
      {caption && <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

export function DocLink({
  to,
  children,
  hash,
}: {
  to: string;
  children: React.ReactNode;
  hash?: string;
}) {
  return (
    <Link to={to} hash={hash} className="text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

export function NextPrev({ current }: { current: string }) {
  const idx = DOCS_NAV.findIndex((d) => d.to === current);
  const prev = idx > 0 ? DOCS_NAV[idx - 1] : null;
  const next = idx >= 0 && idx < DOCS_NAV.length - 1 ? DOCS_NAV[idx + 1] : null;
  return (
    <div className="mt-16 grid gap-4 border-t border-border/40 pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          to={prev.to}
          className="group flex flex-col rounded-xl border border-border/60 bg-card/40 p-4 hover:border-primary/50"
        >
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="h-3 w-3" /> Previous
          </span>
          <span className="mt-1 font-medium text-foreground group-hover:text-primary">
            {prev.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          to={next.to}
          className="group flex flex-col items-end rounded-xl border border-border/60 bg-card/40 p-4 hover:border-primary/50 sm:text-right"
        >
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            Next <ArrowRight className="h-3 w-3" />
          </span>
          <span className="mt-1 font-medium text-foreground group-hover:text-primary">
            {next.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
