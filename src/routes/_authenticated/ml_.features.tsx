// Feature views (R538): its own page in Data science, where it had been a tab
// of ML Models. Named feature sets over lakehouse tables, the training sets
// built from them point in time, and their online copies.
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/PageHeader";
import { FeatureViewsPanel } from "@/components/ml/FeatureViewsPanel";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/ml_/features")({
  component: FeatureViewsPage,
  head: () => ({
    meta: [
      { title: "Feature views — AgentSwarms" },
      {
        name: "description",
        content:
          "Named feature sets over lakehouse tables, training sets built from them, and their online copies.",
      },
    ],
  }),
});

function FeatureViewsPage() {
  const { session } = useAuth();
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Feature views"
        description="Named sets of features over lakehouse tables: build a training set from one as of each row's time, and serve it online for fast lookups."
      />
      <FeatureViewsPanel token={session?.access_token ?? ""} />
    </div>
  );
}
