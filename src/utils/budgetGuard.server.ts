// Hard budget enforcement for model calls.
//
// budget_settings.monthly_cap_usd already existed, but nothing ever enforced it:
// checkAndNotifyBudget only sends threshold emails, so spend could run past the
// cap indefinitely. This adds an actual gate.
//
// OPT-IN BY DESIGN (ENFORCE_BUDGET_CAP). monthly_cap_usd defaults to a very
// small value, so switching enforcement on by default would immediately start
// refusing model calls on existing instances whose cap was never meant to bite.
// Operators turn it on deliberately once their caps reflect reality.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export function budgetEnforcementEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ENFORCE_BUDGET_CAP ?? "");
}

// Month-to-date spend is a sum over execution_traces, so cache it briefly —
// otherwise every chat turn pays for the aggregate. A short TTL keeps the cap
// meaningful while bounding the query rate. Per-process, like the rate limiter.
type Entry = { at: number; over: boolean; spend: number; cap: number };
const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

export type BudgetStatus = { over: boolean; spend: number; cap: number };

/**
 * Whether `userId` has exhausted their monthly cap. Returns not-over when
 * enforcement is disabled, no cap is set, or anything fails — this gate must
 * never be the reason a legitimate call breaks.
 */
export async function getBudgetStatus(userId: string): Promise<BudgetStatus> {
  const miss: BudgetStatus = { over: false, spend: 0, cap: 0 };
  if (!budgetEnforcementEnabled()) return miss;

  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { over: hit.over, spend: hit.spend, cap: hit.cap };
  }
  try {
    const { data: budget } = await supabaseAdmin
      .from("budget_settings")
      .select("monthly_cap_usd")
      .eq("user_id", userId)
      .maybeSingle();
    const cap = Number(budget?.monthly_cap_usd ?? 0);
    if (!Number.isFinite(cap) || cap <= 0) return miss;

    const now = new Date();
    const monthStartIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const { data: traces } = await supabaseAdmin
      .from("execution_traces")
      .select("cost_usd")
      .eq("user_id", userId)
      .gte("created_at", monthStartIso);
    const spend = (traces ?? []).reduce(
      (s: number, r: { cost_usd: number | null }) => s + Number(r.cost_usd ?? 0),
      0,
    );
    const status: BudgetStatus = { over: spend >= cap, spend, cap };
    cache.set(userId, { at: Date.now(), ...status });
    if (cache.size > 5000) {
      for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
    }
    return status;
  } catch {
    // Never fail a call because the budget lookup broke.
    return miss;
  }
}
