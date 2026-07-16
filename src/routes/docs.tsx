import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { DocsSidebar, DocsToc } from "@/components/docs/DocsShell";

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
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_180px]">
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <DocsSidebar current={current} />
          </aside>
          <article className="max-w-none">
            <Outlet />
          </article>
          <aside className="hidden xl:sticky xl:top-20 xl:block xl:self-start">
            <DocsToc pathname={current} />
          </aside>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
