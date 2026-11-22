// Audit Log — its own page under the Observability sidebar group.
// Who did what, when: model calls, dataset & warehouse queries,
// dashboard views and catalog crawls, with configurable retention.
import { PageHeader } from "@/components/PageHeader";
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
      <PageHeader
        title="Audit Log"
        description="See who did what and when; administrators see everyone's activity, everyone else sees their own."
      />
      <AuditLog />
    </div>
  );
}
