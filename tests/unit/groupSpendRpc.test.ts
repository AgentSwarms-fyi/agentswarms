// What a group spend query actually sends to the database.
//
// MEASURED on this deployment, from the admin Budgets tab with one real group:
// the spend cell read "unknown", and the error behind it was
//
//   22P02  invalid input syntax for type uuid: ""
//
// `budget_spend_since(_user_id uuid, ...)` is called by both group callers with
// `userId: ""` and a member array, so Postgres was asked to cast an empty
// string to uuid on every group query the product has ever made. Proven against
// the live database while writing this:
//
//   _user_id ""    -> 400 invalid input syntax for type uuid: ""
//   _user_id null  -> 200 1.677463
//   single user    -> 200 1.677463   (control)
//
// The error does not match the "function is missing" test in `spendSince`, so
// it returns ok:false without trying the row-scan fallback, and `groupSpend`
// turns that into null. What null costs depends on a setting: with
// BUDGET_FAIL_CLOSED off (the default) the guard SKIPS the group cap, so a team
// ceiling is configured, rendered in the admin UI, and enforces nothing; with it
// on, every member of every capped group is refused on every call with spend
// reported as $0. Neither is visible outside one console.warn.
//
// Every budget test in the suite passed throughout, because all of them are
// source-anchored and none had ever put an argument on the wire. This one does.
import { beforeEach, describe, expect, it, vi } from "vitest";

type RpcArgs = Record<string, unknown>;
const calls: RpcArgs[] = [];
let reply: { data: unknown; error: { message: string } | null } = { data: 4.2, error: null };

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (_fn: string, args: RpcArgs) => {
      calls.push(args);
      return Promise.resolve(reply);
    },
    // unpricedSince runs after a successful aggregate; give it a terminal
    // builder so the ok path can complete.
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "gte", "eq", "in", "range"]) q[m] = () => q;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (q as any).then = (res: (v: unknown) => unknown) => res({ count: 0, data: [], error: null });
      return q;
    },
  },
}));

const { spendSince, monthStartIso } = await import("@/utils/budgetSpend.server");

const MEMBERS = ["c8e0b22d-2e40-44b7-8df0-29d5980abd36", "27eef7c2-9286-4d8d-8d20-0c34c6e40820"];

describe("the arguments a group spend query puts on the wire", () => {
  beforeEach(() => {
    calls.length = 0;
    reply = { data: 4.2, error: null };
  });

  it("sends NULL for _user_id, never an empty string", async () => {
    // THE finding. `uuid` has no empty value, and the function's own
    // authorisation branch is written for this shape:
    //   (_user_ids IS NULL AND auth.uid() = _user_id) OR is_superadmin(...)
    // so a group query is meant to arrive with _user_id null.
    await spendSince({ userId: "", since: monthStartIso(), userIds: MEMBERS });

    expect(calls).toHaveLength(1);
    expect(calls[0]._user_id).toBeNull();
    expect(calls[0]._user_id).not.toBe("");
    expect(calls[0]._user_ids).toEqual(MEMBERS);
  });

  it("still sends the id for a single-user query", async () => {
    await spendSince({ userId: MEMBERS[0], since: monthStartIso() });

    expect(calls[0]._user_id).toBe(MEMBERS[0]);
    expect(calls[0]._user_ids).toBeNull();
  });

  it("never sends a value that is neither a uuid nor null", async () => {
    // The general rule behind the specific bug: whatever the caller passes,
    // what reaches a `uuid` column is a uuid or nothing.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const args of [
      { userId: "", since: monthStartIso(), userIds: MEMBERS },
      { userId: MEMBERS[0], since: monthStartIso() },
    ]) {
      calls.length = 0;
      await spendSince(args);
      const sent = calls[0]._user_id;
      expect(sent === null || (typeof sent === "string" && UUID.test(sent))).toBe(true);
    }
  });

  it("reports a real RPC failure rather than falling back to a row scan", async () => {
    // 22P02 is not "the function is missing", so re-running the slow path would
    // only produce the same error more expensively. The caller gets ok:false,
    // which is what the display turns into "unknown" instead of "$0.00".
    reply = { data: null, error: { message: 'invalid input syntax for type uuid: ""' } };
    const r = await spendSince({ userId: "", since: monthStartIso(), userIds: MEMBERS });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid input syntax");
  });
});
