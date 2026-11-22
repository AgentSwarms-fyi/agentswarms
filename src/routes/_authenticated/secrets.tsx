// Secrets Manager — the page itself is a thin shell now; the real
// create/edit/delete UI lives in SecretsManagerPanel so Settings → API Keys
// can host the identical controls inline.
import { PageHeader } from "@/components/PageHeader";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretsManagerPanel } from "@/components/settings/SecretsManagerPanel";

export const Route = createFileRoute("/_authenticated/secrets")({
  head: () => ({
    meta: [{ title: "Secrets — AgentSwarms" }],
  }),
  component: SecretsPage,
});

function SecretsPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Secrets are one kind of key among many; the others are a click away
          rather than a page somebody has to know exists. */}
      <PageHeader
        title="Secrets"
        description={
          <>
            Store named values to use in connection forms. Every other key and credential you hold
            is listed in{" "}
            <Link
              to="/settings"
              search={{ tab: "api-keys" }}
              className="text-primary underline-offset-4 hover:underline"
            >
              Settings → API keys
            </Link>
            .
          </>
        }
      />

      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your secrets</CardTitle>
          <CardDescription>
            Sharing with other users or groups is managed by superadmins under Admin → IAM → Access.
            Shared secrets are usable in references but never readable, and go only to the hosts
            their owner allows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SecretsManagerPanel />
        </CardContent>
      </Card>
    </div>
  );
}
