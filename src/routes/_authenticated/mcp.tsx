import { PageEyebrow } from "@/components/PageEyebrow";
import { createFileRoute, Link } from "@tanstack/react-router";
import { McpServersPanel } from "@/components/settings/McpServersPanel";
import { readPageIntent } from "@/lib/pageIntent";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpPage,
  // `?new=1` starts a new connection and `?open=<id>` shows one server — how
  // search results and the "New" menu link here (src/lib/pageIntent.ts).
  validateSearch: (s: Record<string, unknown>) => readPageIntent(s),
});

function McpPage() {
  // Read here and handed down, because the same panel is also shown inside
  // Settings, where the address belongs to another page.
  const search = Route.useSearch();
  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div>
          <PageEyebrow />
          <h1 className="font-display text-3xl font-semibold tracking-tight">MCP Integrations</h1>
          <p className="text-muted-foreground mt-1">
            Model Context Protocol servers expose tools and resources to your agents. To write your
            own instead of connecting to someone else's, use{" "}
            <Link to="/mcp-builder" className="text-primary hover:underline">
              MCP Builder
            </Link>{" "}
            — servers you register there appear in this list automatically.
          </p>
        </div>
        <McpServersPanel showBuilderLink={false} intent={search} />
      </div>
    </div>
  );
}
