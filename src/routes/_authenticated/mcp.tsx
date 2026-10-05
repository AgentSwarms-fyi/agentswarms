import { createFileRoute, Link } from "@tanstack/react-router";
import { McpServersPanel } from "@/components/settings/McpServersPanel";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpPage,
});

function McpPage() {
  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Integrations
          </p>
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
        <McpServersPanel showBuilderLink={false} />
      </div>
    </div>
  );
}
