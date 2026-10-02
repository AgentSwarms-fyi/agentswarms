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
  | {
      ok: true;
      spend: number;
      /**
       * Calls in the window that contributed $0 because no price was known for
       * their model, or `null` when that could not be established.
       *
       * A call on an unpriced model is recorded at cost_usd 0 — honest on the
       * row, and the Traces page labels it "unpriced". A SUM cannot carry that
       * label, so any total above is a FLOOR: the true spend is at least this,
       * and possibly more. The gate's own comment on the Traces page said
       * "budgets summed exactly that", and budgets did.
       */
      unpriced: number | null;
    }
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
      // NULL, not "", when the question is about a group.
      //
      // `_user_id` is `uuid` and both group callers pass `userId: ""` with a
      // member array, so Postgres was asked to cast an empty string and
      // answered `22P02 invalid input syntax for type uuid: ""` — every time,
      // since the feature shipped. MEASURED against this deployment:
      //
      //   _user_id ""   -> 400 invalid input syntax for type uuid
      //   _user_id null -> 200 1.677463
      //
      // The error does not match the "function is missing" test below, so it
      // returns ok:false without trying the fallback, and `groupSpend` turns
      // that into null. What null means depends on a setting: with
      // BUDGET_FAIL_CLOSED off (the default) the guard skips the group cap, so
      // a team ceiling is configured, displayed, and enforces nothing; with it
      // on, every member of every capped group is refused on every call with
      // spend reported as $0. Both were invisible outside one console.warn.
      //
      // The function's own authorisation branch is written for this shape:
      // `_user_ids IS NULL AND auth.uid() = _user_id`, so a group query is
      // meant to arrive with _user_id null.
      _user_id: args.userId || null,
      _since: args.since,
      _scope_type: args.scope?.type ?? null,
      _scope_id: args.scope?.id ?? null,
      _user_ids: args.userIds ?? null,
    });
    if (!error) {
      const n = Number(data ?? 0);
      if (!Number.isFinite(n)) return { ok: false, error: "non-numeric sum" };
      return { ok: true, spend: n, unpriced: await unpricedSince(args) };
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

/**
 * How many calls in the window had no known price, or null when the count
 * itself could not be read.
 *
 * Null is deliberately distinct from 0: "no unpriced calls" and "we do not know
 * whether there were any" lead to different decisions under a fail-closed cap,
 * and collapsing them is the same mistake as reading a failed sum as $0.
 */
async function unpricedSince(args: {
  userId: string;
  since: string;
  scope?: { type: string; id: string } | null;
  userIds?: string[] | null;
}): Promise<number | null> {
  let q = supabaseAdmin
    .from("execution_traces")
    .select("id", { count: "exact", head: true })
    .gte("created_at", args.since)
    .eq("request_payload->>pricing_missing", "true");
  q = args.scope
    ? q.eq("cost_scope_type", args.scope.type).eq("cost_scope_id", args.scope.id)
    : args.userIds
      ? q.in("user_id", args.userIds)
      : q.eq("user_id", args.userId);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

async function fallbackSum(args: {
  userId: string;
  since: string;
  scope?: { type: string; id: string } | null;
  userIds?: string[] | null;
}): Promise<SpendResult> {
  let total = 0;
  let unpriced = 0;
  // The same rule `lib/pagedSelect` uses, for the same reason: a page shorter
  // than the REQUEST proves nothing, because `db-max-rows` is the operator's
  // setting and a project tuned below PAGE answers every request short. A page
  // shorter than one the server has already produced proves the end. This loop
  // sums as it goes rather than collecting, so it cannot call the shared helper
  // — a budget path must not hold fifty thousand rows to add up a column.
  let offset = 0;
  let observedMax = 0;
  while (offset < MAX_FALLBACK_ROWS) {
    let q = supabaseAdmin
      .from("execution_traces")
      .select("cost_usd, pricing_missing:request_payload->>pricing_missing")
      .gte("created_at", args.since)
      .range(offset, offset + PAGE - 1);
    q = args.scope
      ? q.eq("cost_scope_type", args.scope.type).eq("cost_scope_id", args.scope.id)
      : args.userIds
        ? q.in("user_id", args.userIds)
        : q.eq("user_id", args.userId);

    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = data ?? [];
    if (rows.length === 0) return { ok: true, spend: total, unpriced };
    for (const r of rows) {
      const row = r as { cost_usd: number | null; pricing_missing?: string | null };
      total += Number(row.cost_usd ?? 0);
      // Counted here rather than by a second query: this path is already
      // reading every row.
      if (row.pricing_missing === "true") unpriced += 1;
    }
    offset += rows.length;
    const prevMax = observedMax;
    observedMax = Math.max(observedMax, rows.length);
    if (rows.length < prevMax) return { ok: true, spend: total, unpriced };
  }
  return {
    ok: false,
    error:
      `more than ${MAX_FALLBACK_ROWS} traces this period — run the budget_spend_since ` +
      `migration (20260780000000) so spend is summed in the database`,
  };
}
