import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { toast } from "sonner";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — AgentSwarms" },
      {
        name: "description",
        content:
          "Sign in or create your free AgentSwarms account to start learning Agentic AI hands-on with live demos, RAG, tools, guardrails, and multi-agent swarms.",
      },
      { name: "robots", content: "noindex, follow" },
      { property: "og:title", content: "Sign in — AgentSwarms" },
      {
        property: "og:description",
        content: "Access the AgentSwarms lab to build, run, and learn Agentic AI.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/login" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/login" }],
  }),
  component: LoginPage,
});

type Mode = "signin" | "signup" | "forgot";

// Welcome email is dispatched centrally from src/hooks/use-auth.tsx on the
// first session we see for a given user (idempotent via user_metadata).

function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) throw result.error;
      if (result.redirected) return;
      window.location.href = "/dashboard";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Google sign-in failed";
      toast.error(msg);
      setGoogleLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    setAppleLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("apple", {
        redirect_uri: window.location.origin,
      });
      if (result.error) throw result.error;
      if (result.redirected) return;
      window.location.href = "/dashboard";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Apple sign-in failed";
      toast.error(msg);
      setAppleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/dashboard` },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account!", {
          description: "Click the link in the email and you'll be signed in automatically.",
        });
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = "/dashboard";
      } else {
        // Forgot password
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("Reset link sent", {
          description: "Check your email for a link to choose a new password.",
        });
        setMode("signin");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const headerCopy =
    mode === "signup"
      ? "Create your account"
      : mode === "forgot"
        ? "Reset your password"
        : "Sign in to your account";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="bg-grid-faint pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_60%_at_50%_40%,black,transparent)]" />
      <div className="bg-hero-glow pointer-events-none absolute inset-0" />
      <div className="absolute right-4 top-4">
        <ThemeToggle variant="outline" />
      </div>
      <Card className="w-full max-w-md border-border/50 bg-card/80 backdrop-blur">
        <CardHeader className="text-center">
          <Link
            to="/"
            className="mx-auto mb-4 block h-12 w-12 overflow-hidden rounded-xl shadow-lg shadow-primary/25"
            title="Back to home"
          >
            <img
              src={agentSwarmsLogo}
              alt="AgentSwarms AI School logo"
              className="h-full w-full object-cover"
            />
          </Link>
          <CardTitle className="text-2xl font-bold">AgentSwarms</CardTitle>
          <CardDescription>{headerCopy}</CardDescription>
        </CardHeader>
        <CardContent>
          {mode !== "forgot" && (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={handleGoogleSignIn}
                disabled={googleLoading || loading}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12 11v3.2h5.5c-.24 1.4-1.7 4.1-5.5 4.1A6.3 6.3 0 1 1 12 5.7a5.7 5.7 0 0 1 4 1.55l2.18-2.1A9 9 0 1 0 12 21c5.2 0 8.7-3.65 8.7-8.8 0-.6-.06-1.06-.14-1.5H12z"
                  />
                </svg>
                {googleLoading ? "Redirecting…" : "Continue with Google"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full gap-2"
                onClick={handleAppleSignIn}
                disabled={appleLoading || googleLoading || loading}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M16.365 1.43c0 1.14-.49 2.27-1.27 3.08-.84.86-2.2 1.52-3.32 1.43-.14-1.1.42-2.27 1.18-3.05.86-.87 2.32-1.5 3.41-1.46zM20.5 17.07c-.55 1.28-.82 1.85-1.53 2.99-.99 1.6-2.39 3.58-4.12 3.6-1.54.02-1.94-.99-4.03-.98-2.09.01-2.53 1-4.07.98-1.73-.02-3.06-1.81-4.05-3.4C-.07 16.79-.32 11.6 1.6 8.93c1.37-1.9 3.52-3.02 5.55-3.02 2.06 0 3.36 1.12 5.07 1.12 1.66 0 2.67-1.12 5.05-1.12 1.8 0 3.7.98 5.06 2.67-4.45 2.44-3.73 8.81-1.83 8.49z" />
                </svg>
                {appleLoading ? "Redirecting…" : "Continue with Apple"}
              </Button>
              <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            {mode !== "forgot" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => setMode("forgot")}
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "Loading..."
                : mode === "signup"
                  ? "Create Account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Sign In"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            {mode === "forgot" ? (
              <button
                onClick={() => setMode("signin")}
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
              </button>
            ) : mode === "signup" ? (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => setMode("signin")}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don't have an account?{" "}
                <button
                  onClick={() => setMode("signup")}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Sign up
                </button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
