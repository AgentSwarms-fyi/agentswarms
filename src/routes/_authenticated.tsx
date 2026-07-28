import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { AppLayout } from "@/components/AppLayout";
import { usePrefetchProviderModels } from "@/hooks/use-provider-models";

export const Route = createFileRoute("/_authenticated")({
  head: () => ({
    meta: [
      { title: "AgentSwarms — Lab" },
      {
        name: "description",
        content:
          "Your AgentSwarms workspace: build agents, run swarms, inspect traces, and manage knowledge bases.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isAuthenticated, loading } = useAuth();
  // Refresh each connected provider's model catalogue on app open — OpenRouter's
  // free tier in particular changes continuously, so a list baked into the
  // bundle goes stale between releases.
  usePrefetchProviderModels();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    return null;
  }

  return <AppLayout />;
}
