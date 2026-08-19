import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { DocsSidebar, DocsToc, DocsTocCompact } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Documentation — AgentSwarms" },
      {
        name: "description",
        content:
          "The AgentSwarms handbook: dashboard, templates, notebooks, agent builder, swarm canvas, playground, analytics and integrations.",
      },
      { property: "og:title", content: "AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Everything about AgentSwarms — how to learn, build, debug and ship agentic AI on the platform.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs" }],
  }),
  component: DocsLayout,
});

function DocsLayout() {
  const { pathname } = useLocation();
  // Normalize trailing slashes for matching
  const current = pathname.replace(/\/$/, "") || "/docs";
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* First tabbable element on the page. From lg up the sidebar rail
          renders all twenty-seven doc links, so without this a keyboard reader
          tabs past roughly thirty-three controls to reach the article — on
          every page, every time.

          Parked off-screen and moved in on focus, rather than sr-only: this
          project is on Tailwind v4, where sr-only hides with
          clip-path: inset(50%) that focus:not-sr-only does not undo, so the
          link took focus while staying a 1px sliver.

          fixed, not absolute — with no positioned ancestor, absolute resolves
          against the document, so once the reader had scrolled the link
          appeared far above the viewport. And z-[60], because the sticky site
          header is z-50 and comes later in the DOM: at equal z-index it
          painted straight over the link, which then measured as visible while
          being completely hidden behind the bar. */}
      <a
        href="#docs-content"
        className="fixed left-4 top-[-100px] z-[60] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-[top] focus:top-4 motion-reduce:transition-none print:hidden"
      >
        Skip to content
      </a>
      {/* Printing a doc page should produce the article, not the app chrome
          around it. The header, both rails, the search box and the footer all
          carry print:hidden (the shared components are wrapped here rather
          than edited, since only the docs make this call), and the grid
          collapses to one column so the article uses the page. */}
      <div className="print:hidden">
        <SiteHeader />
      </div>
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 print:block lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_180px]">
          <aside className="print:hidden lg:sticky lg:top-20 lg:self-start">
            <DocsSidebar current={current} />
          </aside>
          {/* min-w-0 is load-bearing. A grid item defaults to min-width:auto,
              so this column cannot shrink below its widest child — and the
              reference tables carry min-w-[32rem] so they stay readable. The
              desktop template already says minmax(0,1fr) for exactly this
              reason, but that only applies from lg up; below it the single
              column took the tables' width and every docs page scrolled
              sideways on a phone, with the tables' own overflow-x never
              engaging because their container was never constrained. */}
          {/* tabIndex -1 so the skip link can move focus here, not merely
              scroll — otherwise the next Tab continues from the header and the
              link has saved nothing. */}
          <article
            id="docs-content"
            tabIndex={-1}
            className="min-w-0 max-w-none focus:outline-none"
          >
            <DocsTocCompact pathname={current} />
            <Outlet />
          </article>
          <aside className="hidden print:hidden xl:sticky xl:top-20 xl:block xl:self-start">
            <DocsToc pathname={current} />
          </aside>
        </div>
      </div>
      <div className="print:hidden">
        <SiteFooter />
      </div>
    </div>
  );
}
