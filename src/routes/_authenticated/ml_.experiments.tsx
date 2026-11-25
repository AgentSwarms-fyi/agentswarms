// Experiments (R538): its own page in Data science, where it had been a tab
// of ML Models. Every training run and every notebook run logged with the
// helper, side by side; the panel is the one ML Models showed (R527).
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/PageHeader";
import { ExperimentsPanel } from "@/components/ml/ExperimentsPanel";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/ml_/experiments")({
  component: ExperimentsPage,
  head: () => ({
    meta: [
      { title: "Experiments — AgentSwarms" },
      {
        name: "description",
        content:
          "Every training run and notebook run, compared on the same metrics, and the one to register.",
      },
    ],
  }),
});

function ExperimentsPage() {
  const { session } = useAuth();
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Experiments"
        description="Every training run and every notebook run logged here, compared on the same metrics. Register the one worth keeping as a model version."
      />
      <ExperimentsPanel token={session?.access_token ?? ""} />
    </div>
  );
}
