// /verify/$code — public verification page for a certificate.
// No auth required. Allows recruiters / LinkedIn viewers to confirm a badge.
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Award, CheckCircle2, ShieldCheck, XCircle, Loader2 } from "lucide-react";
import certBadge from "@/assets/cert-badge-v2.png";

// Server function uses the admin client so anon RLS doesn't apply.
// Only returns the fields needed for display — never exposes user_id.
const verifyCertificate = createServerFn({ method: "POST" })
  .inputValidator((data: { code: string }) => {
    if (!data.code || typeof data.code !== "string" || data.code.length > 100) {
      throw new Error("Invalid verification code");
    }
    return { code: data.code.trim() };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cert, error } = await supabaseAdmin
      .from("certificates")
      .select("id,name_on_cert,organization,mcq_score,agent_score,swarm_score,verification_code,issued_at")
      .eq("verification_code", data.code)
      .maybeSingle();
    if (error) {
      console.error("[verifyCertificate]", error.message);
      return null;
    }
    return cert;
  });

export const Route = createFileRoute("/verify/$code")({
  component: VerifyPage,
  head: ({ params }) => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: `Verify credential ${params.code} · AgentSwarms` },
      {
        name: "description",
        content:
          "Verify an AgentSwarms — Agentic AI Practitioner certificate issued via the AgentSwarms certification program.",
      },
    ],
  }),
});

type Cert = {
  id: string;
  name_on_cert: string;
  organization: string | null;
  mcq_score: number;
  agent_score: number;
  swarm_score: number;
  verification_code: string;
  issued_at: string;
};

function VerifyPage() {
  const { code } = Route.useParams();
  const [loading, setLoading] = useState(true);
  const [cert, setCert] = useState<Cert | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const result = await verifyCertificate({ data: { code } });
        setCert((result as Cert) ?? null);
      } catch {
        setCert(null);
      }
      setLoading(false);
    })();
  }, [code]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
          <ShieldCheck className="h-3.5 w-3.5" /> Credential verification
        </div>

        {loading ? (
          <div className="rounded-2xl border border-border/50 bg-card/40 p-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            <p className="mt-3">Looking up credential…</p>
          </div>
        ) : !cert ? (
          <div className="rounded-2xl border-2 border-rose-400/40 bg-rose-500/5 p-10 text-center">
            <XCircle className="mx-auto h-10 w-10 text-rose-500" />
            <h1 className="mt-3 text-2xl font-extrabold">Credential not found</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              No certificate matches the code <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{code}</code>.
              Double-check the code or contact AgentSwarms.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border-2 border-emerald-400/40 bg-card/60 p-10 shadow-lg">
            <div className="flex flex-wrap items-start gap-6">
              <img
                src={certBadge}
                alt="AgentSwarms Agentic AI Practitioner badge"
                className="h-32 w-32 flex-shrink-0"
              />
              <div className="flex-1 min-w-[240px]">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Verified
                </div>
                <h1 className="mt-2 text-3xl font-extrabold tracking-tight">
                  {cert.name_on_cert}
                </h1>
                {cert.organization && (
                  <p className="text-sm text-muted-foreground">{cert.organization}</p>
                )}
                <p className="mt-3 text-sm">
                  Holds the <strong>AgentSwarms — Agentic AI Practitioner</strong> credential, issued on{" "}
                  <strong>
                    {new Date(cert.issued_at).toLocaleDateString("en-US", {
                      year: "numeric", month: "long", day: "numeric",
                    })}
                  </strong>
                  .
                </p>
              </div>
            </div>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                { label: "Multiple-choice", value: `${cert.mcq_score}%` },
                { label: "Agent builds", value: `${cert.agent_score}%` },
                { label: "Swarm design", value: `${cert.swarm_score}%` },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border/60 bg-background/40 p-4 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
                  <p className="mt-1 text-2xl font-extrabold text-primary">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 rounded-md border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
              <Award className="h-4 w-4 text-primary" />
              <span>Verification code: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{cert.verification_code}</code></span>
              <span className="ml-auto">Issued by AgentSwarms — Agentic AI Lab</span>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
