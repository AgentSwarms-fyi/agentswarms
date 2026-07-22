// Audit Log — its own page under the Observability sidebar group.
// Who did what, when: model calls, dataset & warehouse queries,
// dashboard views and catalog crawls, with configurable retention.
import { createFileRoute } from "@tanstack/react-router";

import { AuditLog } from "@/components/observability/AuditLog";

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit Log — AgentSwarms" },
      {
        name: "description",
        content: "Track user activity across models, datasets, dashboards and data sources.",
      },
    ],
  }),
  component: AuditPage,
});

function AuditPage() {
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who did what, when — model calls, dataset and warehouse queries, dashboard views and
          catalog crawls. Administrators see the whole instance; everyone else sees their own
          activity.
        </p>
      </div>
      <AuditLog />
    </div>
  );
}
