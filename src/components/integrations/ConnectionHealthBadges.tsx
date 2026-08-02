// The two health signals a data connection carries, rendered the same way for
// warehouses and app sources.
//
// One component rather than two copies because the thresholds are a POLICY —
// what counts as a stale credential, what a failed probe looks like — and two
// copies drift until the Apps tab and the Data Sources tab disagree about the
// same connection.
import { AlertTriangle, KeyRound, ShieldCheck, ShieldX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Whole days since the credential was entered, or null when unknown.
 *
 * Mirrors credentialAgeDays in connectionHealth.server. It is duplicated here
 * for one specific reason: that module imports the Supabase admin client and
 * pulls the whole server graph into the browser bundle. The logic is a single
 * subtraction, and the test asserts the two agree.
 */
export function credentialAgeDays(rotatedAt: string | null | undefined): number | null {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Kept in step with CREDENTIAL_MAX_AGE_DAYS, whose default is the same. */
export const CREDENTIAL_STALE_DAYS = 90;

export function HealthBadge({
  status,
  error,
  checkedAt,
}: {
  status?: string | null;
  error?: string | null;
  checkedAt?: string | null;
}) {
  // No probe has run yet. Deliberately renders NOTHING rather than a neutral
  // "unknown" chip: a new connection would otherwise wear a warning-shaped
  // badge for up to twelve hours for no reason.
  if (!status) return null;

  const ok = status === "ok";
  const when = checkedAt ? new Date(checkedAt).toLocaleString() : "unknown time";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={ok ? "outline" : "destructive"}
          className="gap-1 whitespace-nowrap font-normal"
        >
          {ok ? <ShieldCheck className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}
          {ok ? "Healthy" : "Failing"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        {ok ? `Last checked ${when}.` : `Failed at ${when}: ${error ?? "no detail"}`}
      </TooltipContent>
    </Tooltip>
  );
}

export function CredentialAgeBadge({ rotatedAt }: { rotatedAt?: string | null }) {
  const age = credentialAgeDays(rotatedAt);
  // Only shown once it matters. A badge on every row saying "3 days old" is
  // noise that trains people to ignore the one that says 400.
  if (age === null || age < CREDENTIAL_STALE_DAYS) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 whitespace-nowrap font-normal text-amber-600">
          {age >= CREDENTIAL_STALE_DAYS * 4 ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <KeyRound className="h-3 w-3" />
          )}
          {age}d old
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        This credential was entered {age} days ago. Nothing expires automatically — this is a
        reminder to rotate it if your policy calls for it. Save the connection again with a new
        secret to reset the clock.
      </TooltipContent>
    </Tooltip>
  );
}
