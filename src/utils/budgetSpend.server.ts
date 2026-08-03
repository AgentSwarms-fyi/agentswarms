// Month-to-date spend, asked for once and answered honestly.
//
// This was computed in five places by SELECTing every execution_traces row for
// the month and adding cost_usd up in JavaScript. Two things were wrong with
// that, and the second is the one that matters:
//
//   1. Volume. Every model call writes a trace row, and a public embed key at
//      its 30/min limit can produce ~1.3M rows a month. The budget guard
//      fetched all of them, once a minute per user, to total one column.
//
//   2. IT FAILED OPEN, SILENTLY. Every call site read the result as
//      `data ?? []`, so a statement timeout — or any error at all — produced
//      an empty array, which sums to $0, which is under every cap. The gate
//      stopped enforcing exactly when there was the most spend to enforce
//      against, and reported nothing.
//
// So the return type distinguishes the two outcomes. `ok: false` means the
// figure is unknown, which is not the same as zero, and the caller decides what
// to do about it — see budgetGuard's fail-open/fail-closed policy.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SpendResult =
  | { ok: true; spend: number }
  /** The lookup failed. `spend` is unknown — NOT zero. */
  | { ok: false; error: string };

/** First instant of the current UTC month. */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Spend since `since`, for a user or for one credential.
 *
 * Prefers the database aggregate (migration 20260780000000). Falls back to the
 * previous fetch-and-sum when the function is absent, so an instance that has
 * not run `supabase db push` yet keeps working — but the fallback is BOUNDED
 * and reports truncation rather than under-counting in silence.
 */
export async function spendSince(args: {
  userId: string;
  since: string;
  scope?: { type: string; id: string } | null;
  /** Group caps: sum across these members instead of one user. */
  userIds?: string[] | null;
}): Promise<SpendResult> {
  try {
    // Cast because the generated Supabase types are regenerated from a pushed
    // schema, and this function ships in migration 20260780000000. The fallback
    // below is what runs until that migration is applied.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin.rpc as any)("budget_spend_since", {
      _user_id: args.userId,
      _since: args.since,
      _scope_type: args.scope?.type ?? null,
      _scope_id: args.scope?.id ?? null,
      _user_ids: args.userIds ?? null,
    });
    if (!error) {
      const n = Number(data ?? 0);
      return Number.isFinite(n) ? { ok: true, spend: n } : { ok: false, error: "non-numeric sum" };
    }
    // Anything other than "the function does not exist" is a real failure and
    // must not be papered over by re-running the slow path.
    if (!/does not exist|schema cache|not find the function/i.test(error.message)) {
      return { ok: false, error: error.message };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "spend lookup failed" };
  }

  return fallbackSum(args);
}

/**
 * The pre-migration path: page through the rows and add them up.
 *
 * Kept only so an un-migrated instance still enforces something. It is capped,
 * and hitting the cap is reported as a FAILURE rather than as a total — a
 * truncated sum is an under-count, and an under-count on a budget gate lets
 * spend through.
 */
const MAX_FALLBACK_ROWS = 50_000;
const PAGE = 1_000;

async function fallbackSum(args: {
  userId: string;
  since: string;
  scope?: { type: string; id: string } | null;
  userIds?: string[] | null;
}): Promise<SpendResult> {
  let total = 0;
  for (let offset = 0; offset < MAX_FALLBACK_ROWS; offset += PAGE) {
    let q = supabaseAdmin
      .from("execution_traces")
      .select("cost_usd")
      .gte("created_at", args.since)
      .range(offset, offset + PAGE - 1);
    q = args.scope
      ? q.eq("cost_scope_type", args.scope.type).eq("cost_scope_id", args.scope.id)
      : args.userIds
        ? q.in("user_id", args.userIds)
        : q.eq("user_id", args.userId);

    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    for (const r of data ?? []) total += Number((r as { cost_usd: number | null }).cost_usd ?? 0);
    if ((data?.length ?? 0) < PAGE) return { ok: true, spend: total };
  }
  return {
    ok: false,
    error:
      `more than ${MAX_FALLBACK_ROWS} traces this period — run the budget_spend_since ` +
      `migration (20260780000000) so spend is summed in the database`,
  };
}
