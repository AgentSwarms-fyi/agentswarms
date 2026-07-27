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

function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

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

function sumCost(rows: { cost_usd: number | null }[] | null): number {
  return (rows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
}

/** Month-to-date spend attributed to one credential. */
async function credentialSpend(scope: CostScope): Promise<number> {
  const { data } = await supabaseAdmin
    .from("execution_traces")
    .select("cost_usd")
    .eq("cost_scope_type", scope.type)
    .eq("cost_scope_id", scope.id)
    .gte("created_at", monthStartIso());
  return sumCost(data);
}

/** Month-to-date spend across every member of a group. */
async function groupSpend(memberIds: string[]): Promise<number> {
  if (memberIds.length === 0) return 0;
  const { data } = await supabaseAdmin
    .from("execution_traces")
    .select("cost_usd")
    .in("user_id", memberIds)
    .gte("created_at", monthStartIso());
  return sumCost(data);
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
        if (spend >= cap) decision = { over: true, scope: "credential", spend, cap };
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
