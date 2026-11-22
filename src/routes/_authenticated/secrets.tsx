// Secrets Manager — the page itself is a thin shell now; the real
// create/edit/delete UI lives in SecretsManagerPanel so Settings → API Keys
// can host the identical controls inline.
import { PageEyebrow } from "@/components/PageEyebrow";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
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
      <div>
        <PageEyebrow />
        <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
          <KeyRound className="h-7 w-7 text-primary" /> Secrets
        </h1>
        {/* Secrets are one kind of key among many; the others are a click away
            rather than a page somebody has to know exists. */}
        <p className="mt-1 text-sm text-muted-foreground">
          Named values you reference in connection forms. Every other key and credential you hold is
          listed in{" "}
          <Link
            to="/settings"
            search={{ tab: "api-keys" }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Settings → API Keys
          </Link>
          .
        </p>
      </div>

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
