// The audit triggers on governed resources (migration 20260772000000).
//
// These can only be tested against a real database — the whole point is that
// the trail is written by Postgres rather than by application code, so there is
// nothing to unit test. "Is it audited?" is a question about the schema.
//
// NOTE ON RESIDUE: this suite creates and deletes real rows, which leaves a
// handful of genuine audit events behind. That is deliberate and unavoidable.
// Audit events must NEVER be deleted — a gap in chain_seq makes the hash chain
// look tampered with permanently — so the events these tests generate stay.
// The resources themselves are always cleaned up.

import { afterAll, describe, expect, it } from "vitest";

import { verifyChain, type ChainEvent } from "@/lib/auditChain";
import { admin, hasSupabase, TEST_PREFIX } from "./setup";

/** An existing user to own the test rows; these tables require a real user_id. */
async function anyUserId(): Promise<string | null> {
  const { data } = await admin().from("audit_events").select("user_id").limit(1).maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

/** Audit events recorded for one resource id, newest first. */
async function eventsFor(resourceId: string) {
  const { data, error } = await admin()
    .from("audit_events")
    .select("action, resource_type, resource_name, detail")
    .eq("resource_id", resourceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

describe.skipIf(!hasSupabase)("audit triggers on governed resources", () => {
  const created: string[] = [];

  afterAll(async () => {
    // Remove the RESOURCES. The audit events they produced are left in place
    // on purpose — deleting them would break the chain.
    for (const id of created) {
      await admin().from("bi_dashboards").delete().eq("id", id);
    }
  });

  it("records creation and deletion of a dashboard", async () => {
    const userId = await anyUserId();
    if (!userId) return; // a brand-new project has no users yet

    const name = `${TEST_PREFIX}audit-dashboard`;
    const { data, error } = await admin()
      .from("bi_dashboards")
      .insert({ user_id: userId, name, widgets: [], layout: [] })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    created.push(id);

    const afterCreate = await eventsFor(id);
    expect(afterCreate.map((e) => e.action)).toContain("dashboard.create");
    expect(afterCreate[0].resource_type).toBe("dashboard");
    expect(afterCreate[0].resource_name).toBe(name);

    // A rename is governance-relevant and must be recorded.
    await admin()
      .from("bi_dashboards")
      .update({ name: `${name}-renamed` })
      .eq("id", id);
    expect((await eventsFor(id)).map((e) => e.action)).toContain("dashboard.update");

    await admin().from("bi_dashboards").delete().eq("id", id);
    created.pop();
    const afterDelete = await eventsFor(id);
    expect(afterDelete.map((e) => e.action)).toContain("dashboard.delete");
  });

  it("does NOT record an ordinary content save", async () => {
    // Autosave must not drown the events a review actually asks about, and
    // every audit insert takes the hash chain's advisory lock.
    const userId = await anyUserId();
    if (!userId) return;

    const { data, error } = await admin()
      .from("bi_dashboards")
      .insert({ user_id: userId, name: `${TEST_PREFIX}audit-quiet`, widgets: [], layout: [] })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = data.id as string;
    created.push(id);

    const before = (await eventsFor(id)).length;
    await admin()
      .from("bi_dashboards")
      .update({ widgets: [{ id: "w1", kind: "chart" }] })
      .eq("id", id);
    expect(await eventsFor(id)).toHaveLength(before);
  });

  it("marks a service-role write as such, so it is not read as a person", async () => {
    const userId = await anyUserId();
    if (!userId) return;
    const { data } = await admin()
      .from("bi_dashboards")
      .insert({ user_id: userId, name: `${TEST_PREFIX}audit-actor`, widgets: [], layout: [] })
      .select("id")
      .single();
    const id = data!.id as string;
    created.push(id);

    const events = await eventsFor(id);
    const detail = events[0].detail as { actor?: string; op?: string };
    // These tests write with the service role, which has no auth.uid().
    expect(detail.actor).toBe("service");
    expect(detail.op).toBe("INSERT");
  });

  it("leaves the hash chain intact after all of that", async () => {
    // The triggers add rows to audit_events, which the chain trigger then
    // hashes. If the two interact badly, tamper-evidence silently breaks —
    // and a broken chain is indistinguishable from an attack.
    const { data, error } = await admin()
      .from("audit_events")
      .select(
        "chain_seq, chain_hash, user_id, action, resource_type, resource_id, resource_name, detail",
      )
      .not("chain_seq", "is", null)
      .order("chain_seq", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const verdict = verifyChain((data ?? []) as unknown as ChainEvent[]);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });
});
