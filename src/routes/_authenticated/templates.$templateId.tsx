import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, Sparkles, ArrowLeft, AlertTriangle } from "lucide-react";
import { getRealTemplate } from "@/lib/realTemplates";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/templates/$templateId")({
  component: TemplateDemoPage,
  notFoundComponent: () => (
    <div className="p-8 text-center">
      <p className="text-muted-foreground">Template not found.</p>
      <Button asChild className="mt-4"><Link to="/templates">Back to Templates</Link></Button>
    </div>
  ),
});

function TemplateDemoPage() {
  const { templateId } = Route.useParams();
  const tpl = getRealTemplate(templateId);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [status, setStatus] = useState<"idle" | "provisioning" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !tpl || status !== "idle") return;
    setStatus("provisioning");
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error("Please sign in to run the demo.");
        const resp = await fetch("/api/templates/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ templateId: tpl.id }),
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json?.error || "Failed to provision the demo");
        setStatus("ready");
        // Persist the suggested prompt + tour id so the playground can pick them up.
        try {
          sessionStorage.setItem(
            `template-tour:${json.agentId}`,
            JSON.stringify({
              templateId: tpl.id,
              suggestedPrompt: tpl.suggestedPrompts[0] || "",
            }),
          );
        } catch {/* ignore */}
        navigate({ to: "/playground", search: { agentId: json.agentId } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to start the demo";
        setError(msg);
        setStatus("error");
        toast.error(msg);
      }
    })();
  }, [user, tpl, status, navigate]);

  if (!tpl) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Template not found.</p>
        <Button asChild className="mt-4"><Link to="/templates">Back to Templates</Link></Button>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12">
      <Button asChild variant="ghost" size="sm" className="mb-6">
        <Link to="/templates"><ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to gallery</Link>
      </Button>

      <Card className="p-8 text-center space-y-4">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          {status === "error" ? (
            <AlertTriangle className="h-6 w-6 text-destructive" />
          ) : status === "ready" ? (
            <Sparkles className="h-6 w-6 text-primary" />
          ) : (
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
          )}
        </div>
        <h1 className="text-xl font-semibold">{tpl.title}</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {status === "provisioning" && "Provisioning a real agent, knowledge base, and seeded approval into your workspace…"}
          {status === "ready" && "All set — taking you to the live playground."}
          {status === "error" && (error || "Something went wrong.")}
          {status === "idle" && "Preparing the demo…"}
        </p>

        {status === "error" && (
          <div className="flex justify-center gap-2 pt-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/templates">Back</Link>
            </Button>
            <Button size="sm" onClick={() => { setError(null); setStatus("idle"); }}>
              Try again
            </Button>
          </div>
        )}

        <div className="pt-4 border-t border-border text-left text-xs space-y-2 text-muted-foreground">
          <p><span className="font-medium text-foreground">Model:</span> {tpl.modelLabel}</p>
          <p><span className="font-medium text-foreground">Knowledge:</span> {tpl.seedDocuments.length} seed document{tpl.seedDocuments.length === 1 ? "" : "s"}</p>
          <p><span className="font-medium text-foreground">Tools:</span> {tpl.tools.map((t) => t.type).join(", ") || "none"}</p>
          <p><span className="font-medium text-foreground">Guardrails:</span>
            {" "}
            {[
              tpl.guardrails.piiScan && "PII scan",
              tpl.guardrails.outputSafety && "output safety",
              tpl.guardrails.enforceCitations && "citations enforced",
            ].filter(Boolean).join(" · ") || "none"}
          </p>
        </div>
      </Card>
    </div>
  );
}
