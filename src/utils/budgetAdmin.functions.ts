// Month-to-date spend per IAM group, for the admin Budgets tab.
//
// The tab computed this in the browser, from one read:
//
//   supabase.from("execution_traces").select("user_id, cost_usd").gte("created_at", iso)
//   → bucket by user → sum per group
//
// which is three separate findings of the partiality sweep in a single line.
//
//   * PostgREST caps the response at db-max-rows, 1,000 on a default Supabase
//     project, and returns the short page with no error. MEASURED on this
//     deployment while writing this: 1,104 traces in the current month. So the
//     sum was already over a PREFIX — a group's spend rendered low, its
//     percentage-of-cap rendered low, and the red "over" colouring withheld.
//   * `traces ?? []` reads a failed query as an empty month, which sums to $0
//     and renders as "nothing spent" rather than "we could not tell".
//   * `cost_usd ?? 0` counts a call on an unpriced model as free. R34 fixed
//     exactly that in the ENFORCING path; the display beside it kept doing it.
//
// The enforcing path already had a correct answer — `spendSince`, which prefers
// the database aggregate and reports unpriced calls — and the fix is to ask it
// rather than to write a fourth version of the same sum. Two surfaces, one
// figure.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { monthStartIso, spendSince } from "@/utils/budgetSpend.server";
import { requireSuperadmin } from "@/utils/iam.server";
import { scanRows } from "@/lib/cursorScan";

/** Enough membership rows for any real directory; the point is that a client
 *  read cannot be unbounded, not that this should ever bite. */
const MAX_MEMBERSHIPS = 200_000;

export type GroupSpend =
  | {
      ok: true;
      /** Sum of what is known, in USD. */
      total: number;
      /** Calls that contributed $0 because no price was known, or null when
       *  that could not be established — either way the total is a floor. */
      unpricedRows: number | null;
    }
  | { ok: false; error: string };

export const groupSpendTotals = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Record<string, GroupSpend>> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) throw new Error("Only a superadmin can read group spend");

    // Membership is read by cursor for the same reason the traces were: an
    // unbounded select is a select of the first thousand rows, and a member
    // missing from the page makes the group's total quietly too small.
    const members = await scanRows<{ id: string; group_id: string; user_id: string }>(
      async (after, pageSize) => {
        let q = supabaseAdmin
          .from("iam_group_members")
          .select("id, group_id, user_id")
          .order("id", { ascending: true })
          .limit(pageSize);
        if (after) q = q.gt("id", after);
        const { data: page, error } = await q;
        if (error) throw new Error(error.message);
        return (page ?? []) as { id: string; group_id: string; user_id: string }[];
      },
      (r) => r.id,
      { maxRows: MAX_MEMBERSHIPS },
    );

    const byGroup = new Map<string, string[]>();
    for (const m of members.rows) {
      if (!m.user_id) continue;
      const list = byGroup.get(m.group_id);
      if (list) list.push(m.user_id);
      else byGroup.set(m.group_id, [m.user_id]);
    }

    const out: Record<string, GroupSpend> = {};
    for (const [groupId, userIds] of byGroup) {
      if (!members.complete) {
        // Every total would be a floor of a floor. Say nothing rather than
        // something low.
        out[groupId] = { ok: false, error: "Group membership could not be read in full" };
        continue;
      }
      const r = await spendSince({ userId: "", since: monthStartIso(), userIds });
      out[groupId] = r.ok
        ? { ok: true, total: r.spend, unpricedRows: r.unpriced }
        : { ok: false, error: r.error };
    }
    return out;
  });
