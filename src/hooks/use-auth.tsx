import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User, Session } from "@supabase/supabase-js";

async function sendWelcomeEmailOnce(session: Session) {
  // Send the branded welcome email exactly once per user, the first time we
  // see them with an active session. Idempotency is enforced by stamping
  // `welcome_email_sent` into auth user_metadata.
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  if (meta.welcome_email_sent) return;
  const email = session.user.email;
  if (!email) return;

  try {
    // Mark first so we don't double-send on a race; if the call fails, the
    // user simply doesn't get the email (the auth confirmation email still
    // sends through Supabase's regular flow).
    await supabase.auth.updateUser({
      data: { ...meta, welcome_email_sent: true },
    });

    await fetch("/api/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        templateName: "welcome",
        recipientEmail: email,
        templateData: {
          siteName: "AgentSwarms",
          siteUrl: window.location.origin,
          recipient: (meta.full_name as string | undefined)?.split(" ")[0] || email.split("@")[0],
        },
      }),
    });
  } catch (err) {
    console.warn("Welcome email dispatch failed", err);
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      // Send welcome email on first sign-in (covers both email confirmation
      // flow and immediate auto-confirm). Idempotent via user_metadata flag.
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        // Defer so we don't block the auth listener (Supabase guidance).
        setTimeout(() => {
          void sendWelcomeEmailOnce(session);
        }, 0);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return { user, session, loading, signOut, isAuthenticated: !!user };
}
