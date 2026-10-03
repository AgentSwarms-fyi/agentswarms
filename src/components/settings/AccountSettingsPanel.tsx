import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { monthStartIso, mySpendSince } from "@/lib/budgetSpendClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Mail, ShieldCheck, DollarSign, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { ProfileSettingsPanel } from "@/components/settings/ProfileSettingsPanel";

// Supabase's own field for how this session authenticated — "email",
// "google", "apple", etc. Not in the generated Database type (it's on the
// auth user, not a table), hence the loose read.
function authProviderLabel(user: User | null): string {
  const provider = user?.app_metadata?.provider;
  if (!provider || provider === "email") return "Email & password";
  return provider[0].toUpperCase() + provider.slice(1);
}

/**
 * A note on "subscription/usage tier status": this is the self-hosted,
 * source-available build (see README's "This repo vs agentswarms.fyi") —
 * there is no billing plan to show here, your own Supabase project and
 * model keys are the only limits. What DOES exist and is genuinely
 * equivalent — "how much have I used, against what cap" — is the budget
 * system, so that's what this card shows, reusing the same
 * budget_spend_since RPC the full Budgets page uses rather than
 * re-summing execution_traces in the browser (see budgetSpendClient.ts for
 * why that naive version silently under-reports past ~1000 rows).
 */
function UsageSummaryCard() {
  const { user } = useAuth();
  const [capUsd, setCapUsd] = useState<number | null>(null);
  const [spendUsd, setSpendUsd] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const [budgetRes, spendRes] = await Promise.all([
        supabase.from("budget_settings").select("monthly_cap_usd").maybeSingle(),
        mySpendSince(user.id, monthStartIso()),
      ]);
      if (cancelled) return;
      if (budgetRes.error) setError(budgetRes.error.message);
      else
        setCapUsd((budgetRes.data as { monthly_cap_usd: number } | null)?.monthly_cap_usd ?? null);
      if (!spendRes.ok) setError((e) => e ?? spendRes.error);
      else setSpendUsd(spendRes.spend);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <DollarSign className="h-4 w-4 text-primary" /> Usage this month
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Couldn't load usage: {error}</p>
      ) : spendUsd === null ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">${spendUsd.toFixed(2)}</span> spent
          {capUsd ? (
            <>
              {" "}
              of a <span className="font-medium text-foreground">${capUsd.toFixed(0)}</span> monthly
              cap
            </>
          ) : (
            " — no monthly cap set"
          )}
        </p>
      )}
      <Link
        to="/budgets"
        className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        Manage budgets &amp; per-agent limits <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

/**
 * Account tab: profile (delegated to ProfileSettingsPanel), password,
 * sign-in method, and a usage snapshot. Email change and full account
 * deletion stay on /account — rarer, higher-stakes actions that deserve
 * their own page rather than living in this quick-access panel.
 */
export function AccountSettingsPanel() {
  const { user } = useAuth();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  const providerLabel = authProviderLabel(user);
  const isEmailAuth = providerLabel === "Email & password";

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setPwLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success("Password updated successfully");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <ProfileSettingsPanel />

      <Separator />

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" /> Sign-in
        </h3>
        <div className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Mail className="h-3.5 w-3.5" /> {user?.email ?? "—"}
          </div>
          <Badge variant="outline">{providerLabel}</Badge>
        </div>
      </div>

      {isEmailAuth && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-primary" /> Change password
          </h3>
          <form onSubmit={handlePasswordChange} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settings-new-password" className="text-xs">
                  New password
                </Label>
                <Input
                  id="settings-new-password"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-confirm-password" className="text-xs">
                  Confirm new password
                </Label>
                <Input
                  id="settings-confirm-password"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
            </div>
            <Button type="submit" size="sm" disabled={pwLoading}>
              {pwLoading ? "Updating…" : "Update password"}
            </Button>
          </form>
        </div>
      )}

      <Separator />

      <UsageSummaryCard />

      <Link
        to="/account"
        className="flex items-center gap-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Change email or delete your account <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
