import { PageHeader } from "@/components/PageHeader";
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
      <div className="min-w-0 flex-1 space-y-6 p-6">
        <PageHeader
          title="MCP Servers"
          description={
            <>
              Connect MCP servers so your agents can use their tools and resources. To write your
              own, use{" "}
              <Link to="/mcp-builder" className="text-primary hover:underline">
                MCP Builder
              </Link>
              ; servers you make there appear here.
            </>
          }
        />
        <McpServersPanel showBuilderLink={false} intent={search} />
      </div>
    </div>
  );
}
