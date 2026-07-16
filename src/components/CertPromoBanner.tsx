// CertPromoBanner — dismissible in-app announcement promoting the (free)
// Agentic AI Practitioner certification. Mounted at the top of /dashboard
// and /learn. Hidden for users who have already passed.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Award, ArrowRight, Sparkles, X } from "lucide-react";

const ANNOUNCEMENT_KEY = "cert-free-launch-2026q2";

export function CertPromoBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [dismissResult, certResult] = await Promise.all([
        supabase
          .from("user_announcements_dismissed")
          .select("announcement_key")
          .eq("user_id", user.id)
          .eq("announcement_key", ANNOUNCEMENT_KEY)
          .maybeSingle(),
        supabase
          .from("certificates")
          .select("id")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle(),
      ]);

      if (cancelled) return;
      if (dismissResult.data) return; // already dismissed
      if (certResult.data) return; // already certified
      setShow(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = async () => {
    setShow(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("user_announcements_dismissed")
      .insert({ user_id: user.id, announcement_key: ANNOUNCEMENT_KEY });
  };

  if (!show) return null;

  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-primary/40 bg-gradient-to-r from-primary/15 via-nexus-glow/10 to-chart-4/15 p-4 sm:p-5">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/25 blur-3xl" />
      <div className="relative flex flex-wrap items-center gap-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-nexus-glow text-white shadow-md ring-2 ring-primary/20">
          <Award className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
              <Sparkles className="h-3 w-3" /> Free for a limited time
            </span>
          </div>
          <h3 className="mt-1 text-base font-bold tracking-tight sm:text-lg">
            Get AgentSwarms Certified — Agentic AI Practitioner
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
            Pass our 50-question exam and walk away with a LinkedIn-pluggable
            badge and a verifiable certificate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" className="gap-1.5">
            <Link to="/certification">
              Start the exam <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
            <Link to="/learn">What's covered</Link>
          </Button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
