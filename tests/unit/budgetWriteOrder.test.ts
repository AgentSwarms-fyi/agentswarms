// Budgets: the last thing typed is the last thing written.
//
// FOUND IN R293. Every change was its own request, all of them in flight
// together. Typing 2500 into the monthly cap sent 2, 25, 250 and 2500; the
// replies came back 2, 2500, 250, 25, and a reload showed a $25 cap under a
// field that had said 2500 and a status that had said Saved. On an agent with
// no limit row, typing 25 sent two inserts (the field snapped back to the
// default 10 between keys, so the second was 105); the second was refused as
// a duplicate and $2 was stored. A failed write also put back the value from
// before its own keystroke over newer ones, and an emptied field wrote 0,
// which the budget guard reads as no cap.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fieldsLeft, makePatchWriter, typedAmount, type WriteReply } from "@/lib/latestWrite";

type Cap = { monthly_cap_usd?: number; alerts_enabled?: boolean; alert_thresholds?: number[] };

/** A write whose replies the test hands out, in any order it likes. */
function heldWrites() {
  const calls: { patch: Cap; reply: (r: WriteReply<unknown>) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const write = (patch: Cap) =>
    new Promise<WriteReply<unknown>>((resolve) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({
        patch,
        reply: (r) => {
          inFlight--;
          resolve(r);
        },
      });
    });
  return { calls, write, maxInFlight: () => maxInFlight };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("makePatchWriter", () => {
  it("writes the last edit last, one write at a time", async () => {
    const held = heldWrites();
    const saved: Cap[] = [];
    const w = makePatchWriter<Cap>(held.write, {
      saved: (p) => saved.push(p),
      failed: () => {
        throw new Error("no write fails here");
      },
    });
    const done = w.set({ monthly_cap_usd: 2 });
    void w.set({ monthly_cap_usd: 25 });
    void w.set({ monthly_cap_usd: 250 });
    void w.set({ monthly_cap_usd: 2500 });
    await tick();
    // The first keystroke is on its way; the rest wait for it.
    expect(held.calls.map((c) => c.patch)).toEqual([{ monthly_cap_usd: 2 }]);
    held.calls[0].reply({ error: null });
    await tick();
    expect(held.calls.map((c) => c.patch)).toEqual([
      { monthly_cap_usd: 2 },
      { monthly_cap_usd: 2500 },
    ]);
    held.calls[1].reply({ error: null });
    await done;
    expect(held.maxInFlight()).toBe(1);
    expect(saved.at(-1)).toEqual({ monthly_cap_usd: 2500 });
  });

  it("merges edits to different fields into the next write", async () => {
    const held = heldWrites();
    const w = makePatchWriter<Cap>(held.write, { saved: () => {}, failed: () => {} });
    void w.set({ alerts_enabled: true });
    void w.set({ monthly_cap_usd: 50 });
    void w.set({ alert_thresholds: [75, 90] });
    await tick();
    held.calls[0].reply({ error: null });
    await tick();
    expect(held.calls[1].patch).toEqual({ monthly_cap_usd: 50, alert_thresholds: [75, 90] });
  });

  it("reports a failure with the edit that supersedes it", async () => {
    const held = heldWrites();
    const failed: [Cap, string, Cap | null][] = [];
    const w = makePatchWriter<Cap>(held.write, {
      saved: () => {},
      failed: (p, e, newer) => failed.push([p, e.message, newer]),
    });
    void w.set({ monthly_cap_usd: 2 });
    void w.set({ monthly_cap_usd: 2500 });
    await tick();
    held.calls[0].reply({ error: { message: "Failed to fetch" } });
    await tick();
    expect(failed).toEqual([
      [{ monthly_cap_usd: 2 }, "Failed to fetch", { monthly_cap_usd: 2500 }],
    ]);
    // Nothing of the failed write is left to undo: the newer one covers it.
    expect(fieldsLeft(failed[0][0], failed[0][2])).toEqual([]);
    // ...and the newer one is still written.
    expect(held.calls[1].patch).toEqual({ monthly_cap_usd: 2500 });
  });

  it("the last failure has nothing newer, so all of it is undone", async () => {
    const held = heldWrites();
    let newer: Cap | null | undefined;
    const w = makePatchWriter<Cap>(held.write, {
      saved: () => {},
      failed: (_p, _e, n) => (newer = n),
    });
    void w.set({ monthly_cap_usd: 2500 });
    await tick();
    held.calls[0].reply({ error: { message: "refused" } });
    await tick();
    expect(newer).toBeNull();
    expect(fieldsLeft({ monthly_cap_usd: 2500 }, null)).toEqual(["monthly_cap_usd"]);
  });

  it("undoes only the fields nothing newer writes", () => {
    expect(
      fieldsLeft({ alerts_enabled: true, monthly_cap_usd: 5 }, { monthly_cap_usd: 50 }),
    ).toEqual(["alerts_enabled"]);
  });

  it("a write that throws is a failure, and the writer goes on", async () => {
    let n = 0;
    const errors: string[] = [];
    const saved: Cap[] = [];
    const w = makePatchWriter<Cap>(
      async () => {
        n++;
        if (n === 1) throw new Error("socket closed");
        return { error: null };
      },
      { saved: (p) => saved.push(p), failed: (_p, e) => errors.push(e.message) },
    );
    await w.set({ monthly_cap_usd: 30 });
    await w.set({ monthly_cap_usd: 40 });
    expect(errors).toEqual(["socket closed"]);
    expect(saved).toEqual([{ monthly_cap_usd: 40 }]);
  });
});

describe("typedAmount", () => {
  it("an emptied field stands for no amount, not 0", () => {
    expect(typedAmount("")).toBeNull();
    expect(typedAmount("  ")).toBeNull();
    expect(typedAmount("-5")).toBeNull();
    expect(typedAmount("abc")).toBeNull();
  });

  it("a typed figure is that figure", () => {
    expect(typedAmount("0")).toBe(0);
    expect(typedAmount("2.50")).toBe(2.5);
    expect(typedAmount("2500")).toBe(2500);
  });
});

describe("the Budgets page", () => {
  const page = readFileSync("src/routes/_authenticated/budgets.tsx", "utf8");
  const between = (a: string, b: string) => page.slice(page.indexOf(a), page.indexOf(b));

  it("writes through one writer per row", () => {
    const budget = between("const updateBudget = (", "const upsertLimit = (");
    expect(budget).toContain("budgetWriterRef.current ??= makePatchWriter<Partial<Budget>>(");
    expect(budget).toContain("void budgetWriterRef.current.set(patch);");
    const limit = between("const upsertLimit = (", "if (loadError !== null)");
    expect(limit).toContain("limitWritersRef.current.set(agent_id, writer);");
    expect(limit).toContain("void writer.set(patch);");
  });

  it("writes an agent's limit with one upsert, never a second insert", () => {
    expect(page).toContain(
      '.upsert({ user_id: user.id, agent_id, ...p }, { onConflict: "agent_id" })',
    );
    expect(page).not.toMatch(/from\("agent_limits"\)\s*\.(insert|update)\(/);
  });

  it("shows an agent's new limit at once, row or no row", () => {
    const limit = between("const upsertLimit = (", "let writer = ");
    expect(limit).toContain(
      "[agent_id]: { ...(l[agent_id] ?? defaultLimit(agent_id)), ...patch },",
    );
  });

  it("undoes a failure to what is stored, not to the screen before its keystroke", () => {
    expect(page).not.toContain("const before =");
    expect(page).toContain("setBudget((b) => (b ? { ...b, ...pick(saved, undo) } : b));");
    expect(page).toContain(
      "const saved = savedLimitsRef.current[agent_id] ?? defaultLimit(agent_id);",
    );
    expect(page).toContain("savedBudgetRef.current = res.data.budget as Budget;");
    expect(page).toContain(
      "savedLimitsRef.current = res.data.limits as Record<string, AgentLimit>;",
    );
  });

  it("never writes an emptied amount field as 0", () => {
    expect(page).not.toContain("Number(e.target.value)");
    expect((page.match(/<AmountInput\b/g) ?? []).length).toBe(2);
    const field = between("function AmountInput(", "const THRESHOLD_PRESETS");
    expect(field).toContain("const n = typedAmount(e.target.value);");
    expect(field).toContain("if (n !== null) onAmount(n);");
  });
});
