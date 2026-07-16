import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Bot,
  Network,
  Notebook,
  Wrench,
  MessageSquare,
  Activity,
  Award,
  Plug,
  LayoutDashboard,
  Settings,
  Library,
  Compass,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  LayoutTemplate,
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
      { to: "/docs/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/docs/account", label: "Account", icon: Settings },
    ],
  },
  {
    label: "Build",
    items: [
      { to: "/docs/templates", label: "Templates", icon: LayoutTemplate },
      { to: "/docs/agents", label: "Agent Builder", icon: Bot },
      { to: "/docs/swarms", label: "Swarm Canvas", icon: Network },
      { to: "/docs/skills", label: "Skills & Prompt Library", icon: Library },
      { to: "/docs/notebooks", label: "Notebooks", icon: Notebook },
    ],
  },
  {
    label: "Run & observe",
    items: [
      { to: "/docs/playground", label: "Chat Playground", icon: MessageSquare },
      { to: "/docs/debugging", label: "Logs & traces", icon: Wrench },
      { to: "/docs/analytics", label: "Analytics", icon: Activity },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/docs/certification", label: "Certification", icon: Award },
      { to: "/docs/integrations", label: "Integrations", icon: Plug },
    ],
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
      {/* Desktop: always-visible grouped rail */}
      <div className="hidden rounded-xl border border-border/50 bg-card/40 p-3 lg:block">
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
