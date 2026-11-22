// Web Embedding workspace (/embeds): create and manage iframe embeds of
// chat agents, swarm tasks and BI dashboards. All the machinery lives in
// EmbedSection — this route gives it a first-class page + sidebar home.
import { PageHeader } from "@/components/PageHeader";
import { createFileRoute } from "@tanstack/react-router";

import { EmbedSection } from "@/components/embed/EmbedSection";
import { readPageIntent } from "@/lib/pageIntent";

export const Route = createFileRoute("/_authenticated/embeds")({
  head: () => ({
    meta: [{ title: "Web Embedding — AgentSwarms" }],
  }),
  component: EmbedsPage,
  // `?new=1` starts a new embed and `?open=<id>` shows one — how search
  // results and the "New" menu link here (src/lib/pageIntent.ts).
  validateSearch: (s: Record<string, unknown>) => readPageIntent(s),
});

function EmbedsPage() {
  // Read here and handed down, because the same section is also shown inside
  // Settings, where the address belongs to another page.
  const search = Route.useSearch();
  return (
    <div className="max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Web Embedding"
        description="Put a chat agent, swarm or dashboard on another website with an iframe or the React SDK, each behind its own key and list of allowed sites."
      />
      <EmbedSection intent={search} />
    </div>
  );
}
