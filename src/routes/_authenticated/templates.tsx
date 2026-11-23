// Templates: every ready-made starting point in the app, in one place (R530).
//
// The list is read from the registries beside each page
// (src/lib/templateGallery.ts). Use opens the template on its own page, where
// it is made only once the person confirms there: a draft to save, a dialog to
// press Create in, or a question before something is made for them.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowRight,
  Bot,
  Check,
  FilePen,
  FileSpreadsheet,
  Network,
  NotebookPen,
  PackagePlus,
  Plug,
  Search,
  Shapes,
  Wand2,
  Waypoints,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  KIND_INFO,
  NEED_LABEL,
  TEMPLATE_AREAS,
  TEMPLATE_GALLERY,
  TEMPLATE_KINDS,
  kindCounts,
  searchTemplates,
  type GalleryTemplate,
  type TemplateKind,
  type TemplateNeed,
} from "@/lib/templateGallery";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";
import { templateReadiness, type TemplateReadiness } from "@/utils/templates.functions";

type Search = { q?: string; kind?: TemplateKind };

export const Route = createFileRoute("/_authenticated/templates")({
  component: TemplatesPage,
  head: () => ({ meta: [{ title: "Templates — AgentSwarms" }] }),
  // The filter is in the address, so a filtered gallery can be linked to and
  // Back returns to it.
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s.q === "string" && s.q.trim()) out.q = s.q.slice(0, 100);
    if (typeof s.kind === "string" && (TEMPLATE_KINDS as readonly string[]).includes(s.kind)) {
      out.kind = s.kind as TemplateKind;
    }
    return out;
  },
});

const KIND_ICON: Record<TemplateKind, LucideIcon> = {
  swarm: Network,
  agent: Bot,
  mcp_server: Wrench,
  skill: Wand2,
  pipeline: Waypoints,
  connector: Plug,
  workbook: FileSpreadsheet,
  ontology: Shapes,
  notebook: NotebookPen,
};

function TemplatesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/templates" });
  const { user } = useAuth();
  const readinessFn = useServerFn(templateReadiness);
  const [ready, setReady] = useState<TemplateReadiness | null>(null);
  const [query, setQuery] = useState(search.q ?? "");

  useEffect(() => {
    if (!user?.id) return;
    let live = true;
    readinessFn({ data: {} })
      .then((r) => live && setReady(r))
      .catch((e) => reportFailure("check what the templates need", e));
    return () => {
      live = false;
    };
  }, [user?.id, readinessFn]);

  // Typing updates the address once it settles, not on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim() || undefined;
      if (q !== search.q) {
        void navigate({ search: (prev: Search) => ({ ...prev, q }), replace: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, search.q, navigate]);

  const kind = search.kind ?? null;
  const setKind = (k: TemplateKind | null) =>
    void navigate({ search: (prev: Search) => ({ ...prev, kind: k ?? undefined }), replace: true });

  const shown = useMemo(() => searchTemplates(TEMPLATE_GALLERY, query, kind), [query, kind]);
  // The chips count what the search leaves, so "Swarms 13" never sits beside
  // one swarm found.
  const matching = useMemo(() => searchTemplates(TEMPLATE_GALLERY, query), [query]);
  const counts = useMemo(() => kindCounts(matching), [matching]);
  const filtered = Boolean(kind || query.trim());

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
      <PageHeader
        title="Templates"
        description="Ready-made starting points for every kind of work here. Each opens on its own page, ready to change, and nothing is made until you say so there."
      />

      <div className="space-y-3">
        <div className="relative max-w-md">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            className="pl-9"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear the search"
              title="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of template">
          <KindChip active={!kind} onClick={() => setKind(null)}>
            All <span className="tabular-nums text-muted-foreground">{matching.length}</span>
          </KindChip>
          {counts.map(([k, n]) => {
            const Icon = KIND_ICON[k];
            return (
              <KindChip
                key={k}
                active={kind === k}
                muted={n === 0 && kind !== k}
                onClick={() => setKind(kind === k ? null : k)}
              >
                <Icon aria-hidden className="h-3.5 w-3.5" />
                {KIND_INFO[k].plural}{" "}
                <span className="tabular-nums text-muted-foreground">{n}</span>
              </KindChip>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No template matches{query.trim() ? ` “${query.trim()}”` : ""}
            {kind ? ` among ${KIND_INFO[kind].plural.toLowerCase()}` : ""}.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setQuery("");
              setKind(null);
            }}
          >
            Show every template
          </Button>
        </div>
      ) : filtered ? (
        <section aria-label="Templates found" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {shown.length} {shown.length === 1 ? "template" : "templates"}
          </p>
          <Grid items={shown} ready={ready} />
        </section>
      ) : (
        TEMPLATE_AREAS.map((area) => {
          const items = shown.filter((t) => KIND_INFO[t.kind].area === area);
          if (!items.length) return null;
          const id = `area-${area.toLowerCase().replace(/\s+/g, "-")}`;
          return (
            <section key={area} aria-labelledby={id} className="space-y-3">
              <h2 id={id} className="text-sm font-semibold text-foreground">
                {area}
              </h2>
              <Grid items={items} ready={ready} />
            </section>
          );
        })
      )}
    </div>
  );
}

function KindChip({
  active,
  muted = false,
  onClick,
  children,
}: {
  active: boolean;
  /** Nothing of this kind matches the search. */
  muted?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
        muted && "opacity-50",
      )}
    >
      {children}
    </button>
  );
}

function Grid({ items, ready }: { items: GalleryTemplate[]; ready: TemplateReadiness | null }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((t) => (
        <TemplateCard key={t.key} template={t} ready={ready} />
      ))}
    </div>
  );
}

/** Whether a need is met for the person looking: true, false, or not something we check. */
function met(need: TemplateNeed, ready: TemplateReadiness | null): boolean | null {
  if (!ready) return null;
  if (need === "model") return ready.model;
  if (need === "lakehouse") return ready.lakehouse;
  return null;
}

function TemplateCard({
  template: t,
  ready,
}: {
  template: GalleryTemplate;
  ready: TemplateReadiness | null;
}) {
  const info = KIND_INFO[t.kind];
  const Icon = KIND_ICON[t.kind];
  const EffectIcon = info.effect === "makes" ? PackagePlus : FilePen;
  const blocked = t.needs.includes("lakehouse") && ready?.lakehouse === false;

  return (
    <article id={`template-${t.key}`} className="flex flex-col rounded-xl border bg-card p-5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon aria-hidden className="h-3.5 w-3.5" />
        {info.label}
        {t.tags[0] && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate normal-case tracking-normal">{t.tags[0]}</span>
          </>
        )}
      </p>
      <h3 className="mt-2 text-base font-semibold leading-snug text-foreground">{t.title}</h3>
      <p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">{t.summary}</p>

      {t.needs.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {t.needs.map((n) => {
            const ok = met(n, ready);
            return (
              <li key={n} className="flex items-center gap-1.5">
                {ok ? (
                  <Check aria-hidden className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <span aria-hidden className="h-3.5 w-3.5" />
                )}
                {ok === false && n === "model" ? (
                  <span>
                    Uses a model, and no key was found for you.{" "}
                    <Link to="/integrations" className="text-primary hover:underline">
                      Connect one
                    </Link>{" "}
                    first.
                  </span>
                ) : ok === false && n === "lakehouse" ? (
                  <span>Needs the lakehouse, which is not switched on for this server.</span>
                ) : (
                  <span>{NEED_LABEL[n]}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-auto pt-4">
        <p className="mb-3 flex gap-1.5 text-xs leading-5 text-muted-foreground">
          <EffectIcon aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {info.use}
        </p>
        {blocked ? (
          <Button size="sm" disabled>
            Use template
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link to={t.link.to as never} search={(t.link.search ?? {}) as never}>
              Use template
              <ArrowRight aria-hidden className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        )}
      </div>
    </article>
  );
}
