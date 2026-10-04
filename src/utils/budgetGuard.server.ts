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
 * What to do when a figure the cap depends on cannot be read - the spend, a
 * cap, or the caller's teams (R250; it used to cover the spend alone) - as
 * opposed to coming back under cap.
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

export type BudgetStatus = {
  over: boolean;
  spend: number;
  cap: number;
  /** True when `spend` is a floor: some calls had no known price, or the
   *  count of those could not be read. */
  partial?: boolean;
  /** True when a figure this verdict needed could not be read at all. `over`
   *  is then BUDGET_FAIL_CLOSED's answer, not a measurement (R250). */
  unknown?: boolean;
};

/**
 * The verdict for a budget that could not be established.
 *
 * FOUND IN R250. The default is fail-open, on purpose and documented: a
 * governance feature must not be why a legitimate call breaks. BUDGET_FAIL_CLOSED
 * is the operator's way to say the cap must hold. It was honoured on exactly
 * one read - month-to-date spend - while the cap read, the credential and group
 * cap reads, both membership reads and both catch-alls answered "allowed"
 * whatever it said. Every unknown goes through here now.
 */
function unknownStatus(cap: number): BudgetStatus {
  return budgetFailsClosed()
    ? { over: true, spend: 0, cap, unknown: true }
    : { over: false, spend: 0, cap: 0, unknown: true };
}

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
    const { data: budget, error: capErr } = await supabaseAdmin
      .from("budget_settings")
      .select("monthly_cap_usd")
      .eq("user_id", userId)
      .maybeSingle();
    if (capErr) {
      // Unknown, not "no cap": the same rule as the spend below.
      console.warn(`[budget] cap lookup failed for ${userId}: ${capErr.message}`);
      return unknownStatus(0);
    }
    const cap = Number(budget?.monthly_cap_usd ?? 0);
    if (!Number.isFinite(cap) || cap <= 0) return miss;

    const result = await spendSince({ userId, since: monthStartIso() });
    if (!result.ok) {
      // Unknown, not zero. Not cached either — a transient failure must not be
      // remembered as "under cap" for the next minute.
      console.warn(`[budget] spend lookup failed for ${userId}: ${result.error}`);
      return unknownStatus(cap);
    }
    const spend = result.spend;
    // A total that counted unpriced calls at $0 is a FLOOR, and the two
    // verdicts are not symmetric on a floor:
    //
    //   over  — sound. If the floor already exceeds the cap, the true spend
    //           does too, whatever the unpriced calls turn out to have cost.
    //   under — not sound. The calls with no known price could carry any
    //           amount, and the one that would tip it over is exactly the one
    //           that was counted as free.
    //
    // So an operator who set BUDGET_FAIL_CLOSED — meaning the cap must hold —
    // gets the same answer here as for a lookup that failed outright. The
    // default stays fail-open, so nothing changes for anyone who has not asked
    // for a cap that holds.
    const partial = result.unpriced === null || result.unpriced > 0;
    const over = spend >= cap || (partial && budgetFailsClosed());
    const status: BudgetStatus = { over, spend, cap, partial };
    cache.set(userId, { at: Date.now(), ...status });
    if (partial && !status.over) {
      console.warn(
        `[budget] spend for ${userId} is a floor (${
          result.unpriced === null
            ? "unpriced count unavailable"
            : `${result.unpriced} unpriced calls`
        }); under-cap is not established`,
      );
    }
    if (cache.size > 5000) {
      for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
    }
    return status;
  } catch (e) {
    // The default still never fails a call because the lookup broke; an
    // operator who set BUDGET_FAIL_CLOSED asked for exactly that, and gets it.
    console.warn(
      `[budget] lookup failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return unknownStatus(0);
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

export type CostScope = { type: "embed_key" | "swarm_api_key" | "gateway_key"; id: string };

export type BudgetDecision = {
  over: boolean;
  /** Which ceiling was hit — used for the message shown to the caller. */
  scope: "user" | "group" | "credential" | null;
  spend: number;
  cap: number;
  /** A figure could not be read; `over` is BUDGET_FAIL_CLOSED's answer. */
  unknown?: boolean;
};

const scopeCache = new Map<string, { at: number; d: BudgetDecision }>();

/** The cap on one scope; 0 for none, null when it could not be read (R250). */
async function capFor(scopeType: string, scopeId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("budget_limits")
    .select("monthly_cap_usd, is_active")
    .eq("scope_type", scopeType)
    .eq("scope_id", scopeId)
    .maybeSingle();
  if (error) {
    console.warn(`[budget] cap lookup failed for ${scopeType}: ${error.message}`);
    return null;
  }
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
  // R250: any figure that could not be read. With BUDGET_FAIL_CLOSED it
  // blocks; without it the call goes ahead, as documented. Either way the
  // verdict is not cached: a blip must not be remembered for a minute.
  let sawUnknown = false;
  const unknownAt = (s: BudgetDecision["scope"], cap: number): boolean => {
    sawUnknown = true;
    if (!budgetFailsClosed()) return false;
    decision = { over: true, scope: s, spend: 0, cap, unknown: true };
    return true;
  };
  try {
    // 1. Personal cap (reuses the cached per-user path).
    const user = await getBudgetStatus(userId);
    if (user.unknown) sawUnknown = true;
    if (user.over) {
      decision = {
        over: true,
        scope: "user",
        spend: user.spend,
        cap: user.cap,
        ...(user.unknown ? { unknown: true } : {}),
      };
    }

    // 2. Credential cap.
    if (!decision.over && scope) {
      const cap = await capFor(scope.type, scope.id);
      if (cap === null) {
        unknownAt("credential", 0);
      } else if (cap > 0) {
        const spend = await credentialSpend(scope);
        if (spend === null) {
          unknownAt("credential", cap);
        } else if (spend >= cap) {
          decision = { over: true, scope: "credential", spend, cap };
        }
      }
    }

    // 3. Group caps — every group the owner belongs to.
    if (!decision.over) {
      const { data: memberships, error: mErr } = await supabaseAdmin
        .from("iam_group_members")
        .select("group_id")
        .eq("user_id", userId);
      if (mErr) {
        // Which groups, and so which caps, is unknown — not "none".
        console.warn(`[budget] group memberships lookup failed: ${mErr.message}`);
        unknownAt("group", 0);
      }
      for (const m of mErr ? [] : (memberships ?? [])) {
        const cap = await capFor("group", m.group_id);
        if (cap === null) {
          if (unknownAt("group", 0)) break;
          continue;
        }
        if (cap <= 0) continue;
        const { data: members, error: membersErr } = await supabaseAdmin
          .from("iam_group_members")
          .select("user_id")
          .eq("group_id", m.group_id);
        // A failed members read used to reach groupSpend as [], and
        // groupSpend([]) is 0: the team "spent nothing". Unknown, not zero.
        const spend = membersErr ? null : await groupSpend((members ?? []).map((x) => x.user_id));
        if (spend === null) {
          if (unknownAt("group", cap)) break;
          continue;
        }
        if (spend >= cap) {
          decision = { over: true, scope: "group", spend, cap };
          break;
        }
      }
    }
  } catch (e) {
    console.warn(
      `[budget] decision failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return budgetFailsClosed()
      ? { over: true, scope: null, spend: 0, cap: 0, unknown: true }
      : allow;
  }

  if (sawUnknown) return decision;
  scopeCache.set(cacheKey, { at: Date.now(), d: decision });
  if (scopeCache.size > 5000) {
    for (const [k, v] of scopeCache) if (Date.now() - v.at > TTL_MS) scopeCache.delete(k);
  }
  return decision;
}

/** Human-readable refusal for a blocked call. */
export function budgetMessage(d: BudgetDecision): string {
  // R250: a refusal because a figure could not be read is not "reached".
  if (d.unknown) {
    return "Your AI budget could not be checked just now, and this deployment refuses calls it cannot check (BUDGET_FAIL_CLOSED). Try again in a moment.";
  }
  const cap = `$${d.cap.toFixed(2)}`;
  if (d.scope === "credential") {
    return `This integration has reached its monthly AI budget (${cap}). Its owner can raise the limit.`;
  }
  if (d.scope === "group") {
    return `Your team has reached its monthly AI budget (${cap}). An administrator can raise the limit.`;
  }
  return `You have reached your monthly AI budget (${cap}).`;
}
