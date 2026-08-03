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
import { monthStartIso, spendSince } from "@/utils/budgetSpend.server";

export function budgetEnforcementEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ENFORCE_BUDGET_CAP ?? "");
}

/**
 * What to do when the spend LOOKUP fails, as opposed to coming back under cap.
 *
 * Default is to allow: a governance feature should not be the reason a
 * legitimate call breaks. But that default used to be indistinguishable from
 * "spent nothing" — every call site read the query as `data ?? []`, so a
 * timeout summed to $0 and passed every cap, and the gate stopped enforcing
 * exactly when there was most to enforce against.
 *
 * The difference is now expressible, so an operator who needs the cap to HOLD
 * can set BUDGET_FAIL_CLOSED=true and have an unknown figure refuse the call
 * instead of waving it through. Either way the failure is logged.
 */
export function budgetFailsClosed(): boolean {
  return /^(1|true|yes)$/i.test(process.env.BUDGET_FAIL_CLOSED ?? "");
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

    const result = await spendSince({ userId, since: monthStartIso() });
    if (!result.ok) {
      // Unknown, not zero. Not cached either — a transient failure must not be
      // remembered as "under cap" for the next minute.
      console.warn(`[budget] spend lookup failed for ${userId}: ${result.error}`);
      return budgetFailsClosed() ? { over: true, spend: 0, cap } : miss;
    }
    const spend = result.spend;
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

// ── Group + credential budgets ──────────────────────────────────────────────
// The per-user cap above answers "has this person spent too much?". Two other
// questions matter for an operator:
//   • has this TEAM spent too much?         → budget_limits scope_type 'group'
//   • has this KEY spent too much?          → scope_type 'embed_key' /
//     'swarm_api_key'. This is the one that bounds anonymous embed traffic:
//     without it a public key that leaks can drain the owner's whole allowance.
// Any exceeded scope blocks the call — the most restrictive limit wins.

export type CostScope = { type: "embed_key" | "swarm_api_key"; id: string };

export type BudgetDecision = {
  over: boolean;
  /** Which ceiling was hit — used for the message shown to the caller. */
  scope: "user" | "group" | "credential" | null;
  spend: number;
  cap: number;
};

const scopeCache = new Map<string, { at: number; d: BudgetDecision }>();

async function capFor(scopeType: string, scopeId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("budget_limits")
    .select("monthly_cap_usd, is_active")
    .eq("scope_type", scopeType)
    .eq("scope_id", scopeId)
    .maybeSingle();
  if (!data?.is_active) return 0;
  const cap = Number(data.monthly_cap_usd ?? 0);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

/**
 * Month-to-date spend attributed to one credential.
 *
 * Returns null when the figure could not be established — the caller must not
 * read that as zero, which is the bug this whole path existed to have.
 */
async function credentialSpend(scope: CostScope): Promise<number | null> {
  const r = await spendSince({
    userId: "",
    since: monthStartIso(),
    scope: { type: scope.type, id: scope.id },
  });
  if (!r.ok) {
    console.warn(`[budget] credential spend lookup failed for ${scope.type}: ${r.error}`);
    return null;
  }
  return r.spend;
}

/**
 * Month-to-date spend across every member of a group.
 *
 * null means the figure could not be established — not that the team spent
 * nothing, which is how the previous `data ?? []` read a failed query.
 */
async function groupSpend(memberIds: string[]): Promise<number | null> {
  if (memberIds.length === 0) return 0;
  const r = await spendSince({ userId: "", since: monthStartIso(), userIds: memberIds });
  if (!r.ok) {
    console.warn(`[budget] group spend lookup failed: ${r.error}`);
    return null;
  }
  return r.spend;
}

/**
 * Full budget decision for a call: the owner's personal cap, every group they
 * belong to, and the credential the call came through (when there is one).
 *
 * Same fail-open contract as getBudgetStatus: enforcement off, no caps set, or
 * any error ⇒ allowed. A governance feature must never be the reason a
 * legitimate call breaks.
 */
export async function getBudgetDecision(
  userId: string,
  scope?: CostScope | null,
): Promise<BudgetDecision> {
  const allow: BudgetDecision = { over: false, scope: null, spend: 0, cap: 0 };
  if (!budgetEnforcementEnabled()) return allow;

  const cacheKey = scope ? `${userId}:${scope.type}:${scope.id}` : userId;
  const hit = scopeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.d;

  let decision = allow;
  try {
    // 1. Personal cap (reuses the cached per-user path).
    const user = await getBudgetStatus(userId);
    if (user.over) {
      decision = { over: true, scope: "user", spend: user.spend, cap: user.cap };
    }

    // 2. Credential cap.
    if (!decision.over && scope) {
      const cap = await capFor(scope.type, scope.id);
      if (cap > 0) {
        const spend = await credentialSpend(scope);
        if (spend === null) {
          if (budgetFailsClosed()) decision = { over: true, scope: "credential", spend: 0, cap };
        } else if (spend >= cap) {
          decision = { over: true, scope: "credential", spend, cap };
        }
      }
    }

    // 3. Group caps — every group the owner belongs to.
    if (!decision.over) {
      const { data: memberships } = await supabaseAdmin
        .from("iam_group_members")
        .select("group_id")
        .eq("user_id", userId);
      for (const m of memberships ?? []) {
        const cap = await capFor("group", m.group_id);
        if (cap <= 0) continue;
        const { data: members } = await supabaseAdmin
          .from("iam_group_members")
          .select("user_id")
          .eq("group_id", m.group_id);
        const spend = await groupSpend((members ?? []).map((x) => x.user_id));
        if (spend === null) {
          // Unknown, not zero. Same rule as the other two scopes.
          if (budgetFailsClosed()) {
            decision = { over: true, scope: "group", spend: 0, cap };
            break;
          }
          continue;
        }
        if (spend >= cap) {
          decision = { over: true, scope: "group", spend, cap };
          break;
        }
      }
    }
  } catch {
    return allow;
  }

  scopeCache.set(cacheKey, { at: Date.now(), d: decision });
  if (scopeCache.size > 5000) {
    for (const [k, v] of scopeCache) if (Date.now() - v.at > TTL_MS) scopeCache.delete(k);
  }
  return decision;
}

/** Human-readable refusal for a blocked call. */
export function budgetMessage(d: BudgetDecision): string {
  const cap = `$${d.cap.toFixed(2)}`;
  if (d.scope === "credential") {
    return `This integration has reached its monthly AI budget (${cap}). Its owner can raise the limit.`;
  }
  if (d.scope === "group") {
    return `Your team has reached its monthly AI budget (${cap}). An administrator can raise the limit.`;
  }
  return `You have reached your monthly AI budget (${cap}).`;
}
