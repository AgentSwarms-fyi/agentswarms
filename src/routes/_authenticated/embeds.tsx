// Web Embedding workspace (/embeds): create and manage iframe embeds of
// chat agents, swarm tasks and BI dashboards. All the machinery lives in
// EmbedSection — this route gives it a first-class page + sidebar home.
import { createFileRoute } from "@tanstack/react-router";
import { Code2 } from "lucide-react";

import { EmbedSection } from "@/components/embed/EmbedSection";

export const Route = createFileRoute("/_authenticated/embeds")({
  head: () => ({
    meta: [{ title: "Web Embedding — AgentSwarms" }],
  }),
  component: EmbedsPage,
});

function EmbedsPage() {
  return (
    <div className="max-w-6xl space-y-6 p-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Integrations
        </p>
        <h1 className="flex items-center gap-2 font-display text-3xl font-semibold tracking-tight">
          <Code2 className="h-7 w-7 text-primary" /> Web Embedding
        </h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Put your chat agents, multi-agent swarms and BI dashboards on any website with an iframe.
          Each embed is authorized by a generated key scoped to one resource and a domain allow-list
          you control — disable the key and every iframe stops instantly.
        </p>
      </div>
      <EmbedSection />
    </div>
  );
}
