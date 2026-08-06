import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap, ArrowLeft, Building2, Check } from "lucide-react";
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
  // Which social providers the auth server will actually accept. GoTrue
  // publishes this at /auth/v1/settings; a provider left unconfigured in
  // Supabase (Authentication → Providers) rejects the OAuth redirect with a
  // raw JSON "provider is not enabled" page — so a button for it is a dead
  // end by construction. null = not known yet (or the probe failed): render
  // the buttons as before, because hiding working sign-in paths on a
  // transient fetch failure would be worse than the JSON page.
  const [socialEnabled, setSocialEnabled] = useState<{
    google: boolean;
    apple: boolean;
  } | null>(null);

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { external?: { google?: boolean; apple?: boolean } } | null) => {
        if (j?.external) {
          setSocialEnabled({
            google: j.external.google === true,
            apple: j.external.apple === true,
          });
        }
      })
      .catch(() => {
        /* fail open — see the note above */
      });
  }, []);

  // Instance SSO configuration (set by superadmins under /admin/iam → SSO).
  const [ssoConfig, setSsoConfig] = useState<{ enabled: boolean; enforced: boolean } | null>(null);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoLoading, setSsoLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/sso-config")
      .then((r) => (r.ok ? r.json() : { enabled: false, enforced: false }))
      .then((cfg) => setSsoConfig({ enabled: !!cfg.enabled, enforced: !!cfg.enforced }))
      .catch(() => setSsoConfig({ enabled: false, enforced: false }));
  }, []);

  // Escape hatch so a superadmin can always reach native login even when SSO
  // is enforced: /login?native=1
  const nativeOverride =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("native");
  const showNative = !ssoConfig?.enforced || nativeOverride;
  const showSso = ssoConfig?.enabled ?? false;

  const handleSsoSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const domain = ssoEmail.trim().split("@")[1];
    if (!domain) return toast.error("Enter your work email address");
    setSsoLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithSSO({
        domain,
        options: { redirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
      if (data?.url) window.location.href = data.url;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "SSO sign-in failed";
      toast.error(
        /No SSO provider assigned|not found/i.test(raw)
          ? `Single sign-on isn't configured for @${domain}. Contact your administrator.`
          : raw,
      );
      setSsoLoading(false);
    }
  };

  // Social sign-in uses Supabase Auth directly. Each provider must be enabled
  // (with its client id/secret) in your Supabase project under
  // Authentication → Providers, or the call returns a "provider is not
  // enabled" error. The browser is redirected to the provider and back.
  const handleOAuthSignIn = async (provider: "google" | "apple", setBusy: (v: boolean) => void) => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
      // Success: Supabase navigates the browser to the provider's consent page.
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${provider} sign-in failed`;
      toast.error(msg);
      setBusy(false);
    }
  };

  const handleGoogleSignIn = () => handleOAuthSignIn("google", setGoogleLoading);
  const handleAppleSignIn = () => handleOAuthSignIn("apple", setAppleLoading);

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
      let msg = err instanceof Error ? err.message : "Authentication failed";
      // The IAM signup trigger raises "signups_disabled" when the instance is
      // invite-only; Supabase surfaces it as a generic database error.
      if (/signups_disabled|Database error saving new user/i.test(msg)) {
        msg = "This instance is invite-only. Ask your administrator for an invitation.";
      }
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
    <div className="flex min-h-screen bg-background">
      {/* Brand panel — wrapped in `dark` so it stays the product's dark
          surface in both themes, exactly like the landing hero. Sign-in is a
          brand moment: say what this is and why it's trustworthy, instead of
          floating an anonymous card in an empty viewport. */}
      <div className="dark relative hidden w-[44%] flex-col justify-between overflow-hidden bg-background p-10 text-foreground lg:flex xl:p-14">
        <div className="bg-grid-faint pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_70%_at_40%_40%,black,transparent)]" />
        <div className="bg-hero-glow pointer-events-none absolute inset-0" />
        <Link to="/" className="relative flex items-center gap-3" title="Back to home">
          <span className="block h-10 w-10 overflow-hidden rounded-xl shadow-lg shadow-primary/25">
            <img
              src={agentSwarmsLogo}
              alt="AgentSwarms logo"
              className="h-full w-full object-cover"
            />
          </span>
          <span>
            <span className="block text-base font-bold leading-tight">AgentSwarms</span>
            <span className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Unified agentic AI &amp; business intelligence
            </span>
          </span>
        </Link>
        <div className="relative max-w-md">
          <h1 className="font-display text-3xl font-semibold leading-[1.15] tracking-tight xl:text-4xl">
            Your agents.
            <br />
            Your infrastructure.
          </h1>
          <ul className="mt-8 space-y-4 text-sm text-muted-foreground">
            <li className="flex items-start gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Self-hosted — your database, your model keys, your data
            </li>
            <li className="flex items-start gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Agents, multi-agent swarms, RAG and a full BI suite in one platform
            </li>
            <li className="flex items-start gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Every call traced, budgeted and governed by IAM
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">
          Source-available · Elastic License 2.0
        </p>
      </div>

      {/* Form panel */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-10">
        <div className="bg-grid-faint pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_60%_at_50%_40%,black,transparent)] lg:hidden" />
        <div className="bg-hero-glow pointer-events-none absolute inset-0 lg:hidden" />
        <div className="absolute right-4 top-4">
          <ThemeToggle variant="outline" />
        </div>
        <div className="w-full max-w-md">
          <Card className="w-full border-border/50 bg-card/80 backdrop-blur lg:border-0 lg:bg-transparent lg:shadow-none lg:backdrop-blur-0">
            <CardHeader className="text-center lg:text-left">
              <Link
                to="/"
                className="mx-auto mb-4 block h-12 w-12 overflow-hidden rounded-xl shadow-lg shadow-primary/25 lg:hidden"
                title="Back to home"
              >
                <img
                  src={agentSwarmsLogo}
                  alt="AgentSwarms AI School logo"
                  className="h-full w-full object-cover"
                />
              </Link>
              <CardTitle className="text-2xl font-bold lg:hidden">AgentSwarms</CardTitle>
              <CardTitle className="hidden font-display text-[1.6rem] font-semibold tracking-tight lg:block">
                {headerCopy}
              </CardTitle>
              <CardDescription className="lg:hidden">{headerCopy}</CardDescription>
              <CardDescription className="hidden lg:block">
                {mode === "signup"
                  ? "Free to start — agents and sample data are seeded on first sign-in."
                  : mode === "forgot"
                    ? "We'll email you a link to choose a new password."
                    : "Welcome back."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {showSso && (
                <div className="mb-2">
                  {ssoOpen ? (
                    <form onSubmit={handleSsoSignIn} className="space-y-2">
                      <Label htmlFor="sso-email">Work email</Label>
                      <Input
                        id="sso-email"
                        type="email"
                        placeholder="you@company.com"
                        value={ssoEmail}
                        onChange={(e) => setSsoEmail(e.target.value)}
                        autoComplete="email"
                        autoFocus
                        required
                      />
                      <Button type="submit" className="w-full gap-2" disabled={ssoLoading}>
                        <Building2 className="h-4 w-4" />
                        {ssoLoading ? "Redirecting…" : "Continue with SSO"}
                      </Button>
                      <button
                        type="button"
                        onClick={() => setSsoOpen(false)}
                        className="mx-auto block text-xs text-muted-foreground underline-offset-4 hover:underline"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <Button
                      type="button"
                      variant={showNative ? "outline" : "default"}
                      className="w-full gap-2"
                      onClick={() => setSsoOpen(true)}
                    >
                      <Building2 className="h-4 w-4" /> Continue with single sign-on (SSO)
                    </Button>
                  )}
                  {showNative && (
                    <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      <span>or</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                </div>
              )}

              {!showNative && !showSso && ssoConfig !== null && (
                <p className="text-center text-sm text-muted-foreground">
                  Sign-in is managed by your administrator.
                </p>
              )}

              {showNative &&
                mode !== "forgot" &&
                (socialEnabled === null || socialEnabled.google || socialEnabled.apple) && (
                  <>
                    {(socialEnabled === null || socialEnabled.google) && (
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
                    )}
                    {(socialEnabled === null || socialEnabled.apple) && (
                      <Button
                        type="button"
                        variant="outline"
                        className="mt-2 w-full gap-2"
                        onClick={handleAppleSignIn}
                        disabled={appleLoading || googleLoading || loading}
                      >
                        <svg
                          className="h-4 w-4"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          fill="currentColor"
                        >
                          <path d="M16.365 1.43c0 1.14-.49 2.27-1.27 3.08-.84.86-2.2 1.52-3.32 1.43-.14-1.1.42-2.27 1.18-3.05.86-.87 2.32-1.5 3.41-1.46zM20.5 17.07c-.55 1.28-.82 1.85-1.53 2.99-.99 1.6-2.39 3.58-4.12 3.6-1.54.02-1.94-.99-4.03-.98-2.09.01-2.53 1-4.07.98-1.73-.02-3.06-1.81-4.05-3.4C-.07 16.79-.32 11.6 1.6 8.93c1.37-1.9 3.52-3.02 5.55-3.02 2.06 0 3.36 1.12 5.07 1.12 1.66 0 2.67-1.12 5.05-1.12 1.8 0 3.7.98 5.06 2.67-4.45 2.44-3.73 8.81-1.83 8.49z" />
                        </svg>
                        {appleLoading ? "Redirecting…" : "Continue with Apple"}
                      </Button>
                    )}
                    <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      <span>or</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  </>
                )}

              {showNative && (
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
              )}

              {showNative && (
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
              )}
            </CardContent>
          </Card>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            By continuing you agree to the{" "}
            <Link to="/terms" className="underline-offset-4 hover:text-foreground hover:underline">
              Terms of Use
            </Link>{" "}
            and{" "}
            <Link
              to="/privacy"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
