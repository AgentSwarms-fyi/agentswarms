// /admin/runtime — dedicated superadmin page for the Developer-workspace server
// runtime (enable, tune limits/egress, grant access). Separate from IAM.
import { createFileRoute, Link } from "@tanstack/react-router";
import { Server, ShieldAlert } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";
import { RuntimeTab } from "@/components/admin/RuntimeTab";

export const Route = createFileRoute("/_authenticated/admin/runtime")({
  head: () => ({
    meta: [
      { title: "Developer runtime — AgentSwarms" },
      {
        name: "description",
        content: "Enable and configure the server-side Python runtime for the Developer workspace.",
      },
    ],
  }),
  component: AdminRuntimePage,
});

function AdminRuntimePage() {
  const { user, session } = useAuth();
  const isSuperadmin = useIsSuperadmin();
  const token = session?.access_token;

  if (!user) return null;

  if (!isSuperadmin) {
    return (
      <div className="p-6">
        <Card className="mx-auto mt-12 max-w-lg border-destructive/40">
          <CardContent className="p-8 text-center">
            <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <h2 className="mb-1 text-lg font-semibold">Restricted area</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Developer runtime settings are only available to superadmins.
            </p>
            <Link to="/dashboard" className="text-sm text-primary hover:underline">
              Go back to dashboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Admin
        </p>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
          <Server className="h-6 w-6 text-primary" /> Developer runtime
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Enable and configure the server-side Python runtime for the{" "}
          <Link to="/notebooks" className="text-primary hover:underline">
            Developer workspace
          </Link>{" "}
          — real CPython kernels with <code>pip install</code> and the full frameworks, sandboxed
          and governed. Off by default: until you enable it, notebooks show a short &ldquo;runtime
          required&rdquo; prompt instead of running.
        </p>
      </div>
      <div className="max-w-3xl">
        <RuntimeTab token={token!} />
      </div>
    </div>
  );
}
