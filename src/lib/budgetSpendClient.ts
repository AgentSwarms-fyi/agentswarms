// Month-to-date spend for the signed-in user, for DISPLAY.
//
// The budgets page and the dashboard both used to do this:
//
//   .from("execution_traces").select("cost_usd").gte("created_at", monthStart)
//   → reduce(+) in the browser
//
// which is the same shape as the server-side bug fixed in budgetSpend.server:
// no aggregate, no LIMIT, and `data ?? []` reading every failure as an empty
// month. Three ways that misleads, all of them silently:
//
//   * PostgREST caps rows. Past the cap the browser sums a PREFIX of the month
//     and renders it as the total — "$40 of your $100 cap" when it is $400.
//   * A timeout or a permissions error yields [], which sums to $0, which
//     renders as "nothing spent" rather than "we could not tell".
//   * At the public-embed rate limit a single key can write ~1.3M rows a
//     month, and this pulls all of them into a phone.
//
// These figures gate nothing — the enforcing path is budgetGuard.server — but
// a spend number a human reads and acts on has to be right or say it is not.
// Hence a discriminated result rather than a bare number, matching the server.
import { supabase } from "@/integrations/supabase/client";

export type ClientSpend = { ok: true; spend: number } | { ok: false; error: string };

/** First instant of the current UTC month, as an ISO string. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Sum the caller's own spend since `since`, in the database.
 *
 * Goes through budget_spend_since, which is SECURITY DEFINER and authorises
 * `auth.uid() = _user_id` — so a browser may ask for its OWN total and nothing
 * else. No fallback to the row scan: the whole point is that a figure we
 * cannot compute correctly is reported as unavailable, not approximated.
 */
export async function mySpendSince(userId: string, since: string): Promise<ClientSpend> {
  // Cast for the same reason budgetSpend.server does: types.ts is generated
  // from the deployed schema, and this function ships in migration
  // 20260780000000. Regenerating types after applying it removes the need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)("budget_spend_since", {
    _user_id: userId,
    _since: since,
  });
  if (error) return { ok: false, error: error.message };
  const n = Number(data ?? 0);
  if (!Number.isFinite(n)) return { ok: false, error: "Spend total was not a number" };
  return { ok: true, spend: n };
}
