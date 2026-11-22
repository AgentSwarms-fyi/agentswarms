// A person's favourites and recently opened things, kept in the browser
// (src/hooks/use-object-marks.ts).
//
// What is held here: a star answers before the database does and is put back
// if the write fails; an opening is written once, not on every render; a
// database without the table turns the feature off instead of failing every
// page; and nothing of one person's is left for the next.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = {
  table: string;
  op: "select" | "upsert" | "update" | "delete";
  values?: Record<string, unknown>;
  options?: Record<string, unknown>;
  filters: unknown[][];
  limit?: number;
};
type Answer = { data: unknown; error: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  user: "ada" as string | null,
  calls: [] as Call[],
  respond: ((_call: Call) => ({ data: [], error: null })) as (call: Call) => unknown,
  toasts: [] as string[],
}));

vi.mock("sonner", () => ({ toast: { error: (m: string) => void h.toasts.push(m) } }));
vi.mock("@/lib/sessionUser", () => ({
  sessionUser: async () => (h.user ? { id: h.user } : null),
}));
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    h.calls.push(call);
    const q = {
      select: () => q,
      upsert(values: Record<string, unknown>, options: Record<string, unknown>) {
        call.op = "upsert";
        call.values = values;
        call.options = options;
        return q;
      },
      update(values: Record<string, unknown>) {
        call.op = "update";
        call.values = values;
        return q;
      },
      delete() {
        call.op = "delete";
        return q;
      },
      eq: (...a: unknown[]) => (call.filters.push(["eq", ...a]), q),
      not: (...a: unknown[]) => (call.filters.push(["not", ...a]), q),
      is: (...a: unknown[]) => (call.filters.push(["is", ...a]), q),
      order: () => q,
      limit: (n: number) => ((call.limit = n), q),
      // Awaiting the query runs it, as the real client's builder does.
      then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(h.respond(call)).then(ok, fail),
    };
    return q;
  };
  return {
    supabase: { from, auth: { onAuthStateChange: () => ({ data: { subscription: {} } }) } },
  };
});

import {
  clearObjectMarks,
  clearOpened,
  ensureObjectMarks,
  readObjectMarks,
  recordOpened,
  setStar,
} from "@/hooks/use-object-marks";

const OK: Answer = { data: [], error: null };
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}T12:00:00.000Z`;
const has = (call: Call, ...filter: unknown[]) =>
  call.filters.some((f) => JSON.stringify(f) === JSON.stringify(filter));
/** The rows a read returns: favourites to the one read, openings to the other. */
const rows = (starred: unknown[], opened: unknown[]) => (call: Call) =>
  call.op === "select"
    ? { data: has(call, "not", "starred_at", "is", null) ? starred : opened, error: null }
    : OK;
const writes = () => h.calls.filter((c) => c.op !== "select");
const mark = (key: string) => readObjectMarks().marks.get(key);
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("favourites and openings in the browser", () => {
  beforeEach(() => {
    h.user = "ada";
    h.calls.length = 0;
    h.toasts.length = 0;
    h.respond = () => OK;
    clearObjectMarks();
  });

  it("reads favourites and openings in two reads, for the person signed in", async () => {
    h.respond = rows(
      [{ kind: "dashboard", object_id: "d1", starred_at: day(2), opened_at: day(4) }],
      [
        { kind: "dashboard", object_id: "d1", starred_at: day(2), opened_at: day(4) },
        { kind: "agent", object_id: "a1", starred_at: null, opened_at: day(3) },
      ],
    );
    await ensureObjectMarks();
    expect(h.calls).toHaveLength(2);
    for (const c of h.calls) {
      expect(c.table).toBe("object_marks");
      expect(has(c, "eq", "user_id", "ada")).toBe(true);
      expect(c.limit).toBeGreaterThan(0);
    }
    expect([...readObjectMarks().marks.keys()].sort()).toEqual(["agent:a1", "dashboard:d1"]);
    expect(readObjectMarks().loaded).toBe(true);
    // Read once: asking again does not go back to the database.
    await ensureObjectMarks();
    expect(h.calls).toHaveLength(2);
  });

  it("asks the database nothing when nobody is signed in", async () => {
    h.user = null;
    await ensureObjectMarks();
    await setStar("agent", "a1", true);
    await recordOpened("agent", "a1");
    expect(h.calls).toHaveLength(0);
    expect(readObjectMarks().loaded).toBe(true);
    expect(readObjectMarks().marks.size).toBe(0);
  });

  it("turns itself off on a database that has no table for it", async () => {
    h.respond = () => ({
      data: null,
      error: {
        code: "PGRST205",
        message: "Could not find the table 'public.object_marks' in the schema cache",
      },
    });
    await ensureObjectMarks();
    const s = readObjectMarks();
    expect(s.unavailable).toBe(true);
    // Not a failure to report on every page: the feature is simply absent.
    expect(s.error).toBeNull();
    const reads = h.calls.length;
    await setStar("agent", "a1", true);
    await recordOpened("agent", "a1");
    expect(await clearOpened()).toBe(false);
    expect(h.calls).toHaveLength(reads);
    expect(h.toasts).toEqual([]);
  });

  it("says so when the read fails for any other reason", async () => {
    h.respond = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    await ensureObjectMarks();
    expect(readObjectMarks().unavailable).toBe(false);
    expect(readObjectMarks().error).toBe("statement timeout");
  });

  it("shows a star the moment it is pressed, then writes it", async () => {
    let answer: (v: Answer) => void = () => {};
    h.respond = (call) =>
      call.op === "upsert" ? new Promise<Answer>((resolve) => (answer = resolve)) : OK;
    const pressed = setStar("agent", "a1", true);
    await settle();
    // Shown, and the database has not answered yet.
    expect(mark("agent:a1")?.starredAt).toBeTruthy();
    const [write] = writes();
    expect(write.op).toBe("upsert");
    expect(write.options).toEqual({ onConflict: "user_id,kind,object_id" });
    expect(write.values).toEqual({
      user_id: "ada",
      kind: "agent",
      object_id: "a1",
      starred_at: mark("agent:a1")?.starredAt,
    });
    // Nothing about when it was opened is sent, so that is left as it is.
    expect(write.values).not.toHaveProperty("opened_at");
    answer(OK);
    await pressed;
    expect(mark("agent:a1")?.starredAt).toBeTruthy();
    expect(h.toasts).toEqual([]);
  });

  it("puts the star back, and says why, when it could not be saved", async () => {
    await ensureObjectMarks();
    h.respond = (call) =>
      call.op === "upsert" ? { data: null, error: { message: "permission denied" } } : OK;
    await setStar("agent", "a1", true);
    expect(mark("agent:a1")).toBeUndefined();
    expect(h.toasts).toEqual(["Could not add it to your favourites: permission denied"]);
    // And the other way: a star that could not be taken off is still on.
    h.respond = () => OK;
    await setStar("agent", "a1", true);
    h.respond = (call) =>
      call.op === "update" ? { data: null, error: { message: "offline" } } : OK;
    await setStar("agent", "a1", false);
    expect(mark("agent:a1")?.starredAt).toBeTruthy();
    expect(h.toasts[1]).toBe("Could not take it out of your favourites: offline");
  });

  it("takes a star off by clearing it, so when it was opened is kept", async () => {
    h.respond = rows(
      [{ kind: "agent", object_id: "a1", starred_at: day(2), opened_at: day(4) }],
      [{ kind: "agent", object_id: "a1", starred_at: day(2), opened_at: day(4) }],
    );
    await setStar("agent", "a1", false);
    const [write] = writes();
    expect(write.op).toBe("update");
    expect(write.values).toEqual({ starred_at: null });
    expect(has(write, "eq", "user_id", "ada")).toBe(true);
    expect(has(write, "eq", "kind", "agent")).toBe(true);
    expect(has(write, "eq", "object_id", "a1")).toBe(true);
    expect(mark("agent:a1")).toEqual({
      kind: "agent",
      id: "a1",
      starredAt: null,
      openedAt: day(4),
    });
  });

  it("writes an opening once, not each time the page draws", async () => {
    await recordOpened("dashboard", "d1");
    await recordOpened("dashboard", "d1");
    await recordOpened("dashboard", "d1");
    expect(writes()).toHaveLength(1);
    const [write] = writes();
    expect(write.values).toMatchObject({ user_id: "ada", kind: "dashboard", object_id: "d1" });
    // The star is not in the write, so opening a favourite leaves it one.
    expect(write.values).not.toHaveProperty("starred_at");
    expect(mark("dashboard:d1")?.openedAt).toBeTruthy();
    // Another object is another opening.
    await recordOpened("dashboard", "d2");
    expect(writes()).toHaveLength(2);
  });

  it("keeps quiet when an opening cannot be written", async () => {
    await ensureObjectMarks();
    h.respond = (call) => (call.op === "upsert" ? Promise.reject(new Error("offline")) : OK);
    await expect(recordOpened("agent", "a1")).resolves.toBeUndefined();
    expect(h.toasts).toEqual([]);
  });

  it("does not let a read that lands later undo a star just pressed", async () => {
    await ensureObjectMarks();
    let answer: (v: Answer) => void = () => {};
    h.respond = (call) =>
      call.op === "upsert" ? new Promise<Answer>((resolve) => (answer = resolve)) : OK;
    const pressed = setStar("agent", "a1", true);
    await settle();
    // A fresh read comes back before the write has landed, without the star.
    await ensureObjectMarks(true);
    expect(mark("agent:a1")?.starredAt).toBeTruthy();
    answer(OK);
    await pressed;
    expect(mark("agent:a1")?.starredAt).toBeTruthy();
  });

  it("forgets what was opened, and keeps the favourites", async () => {
    h.respond = rows(
      [{ kind: "dashboard", object_id: "d1", starred_at: day(2), opened_at: day(4) }],
      [
        { kind: "dashboard", object_id: "d1", starred_at: day(2), opened_at: day(4) },
        { kind: "agent", object_id: "a1", starred_at: null, opened_at: day(3) },
      ],
    );
    expect(await clearOpened()).toBe(true);
    const [gone, kept] = writes();
    // Rows that were only an opening go; a favourite keeps its row and its star.
    expect(gone.op).toBe("delete");
    expect(has(gone, "eq", "user_id", "ada")).toBe(true);
    expect(has(gone, "is", "starred_at", null)).toBe(true);
    expect(kept.op).toBe("update");
    expect(kept.values).toEqual({ opened_at: null });
    expect(has(kept, "not", "starred_at", "is", null)).toBe(true);
    expect([...readObjectMarks().marks.values()]).toEqual([
      { kind: "dashboard", id: "d1", starredAt: day(2), openedAt: null },
    ]);
  });

  it("leaves the list as it was when clearing fails", async () => {
    h.respond = rows([], [{ kind: "agent", object_id: "a1", starred_at: null, opened_at: day(3) }]);
    await ensureObjectMarks();
    h.respond = (call) =>
      call.op === "delete" ? { data: null, error: { message: "offline" } } : OK;
    expect(await clearOpened()).toBe(false);
    expect(mark("agent:a1")?.openedAt).toBe(day(3));
    expect(h.toasts).toEqual(["Could not clear what you opened: offline"]);
    // The second write is not attempted after the first failed.
    expect(writes()).toHaveLength(1);
  });

  it("holds nothing of one person's for the next", async () => {
    h.respond = rows([{ kind: "agent", object_id: "a1", starred_at: day(2), opened_at: null }], []);
    await ensureObjectMarks();
    expect(readObjectMarks().marks.size).toBe(1);
    // Somebody else signs in on the same tab.
    h.user = "bob";
    clearObjectMarks();
    expect(readObjectMarks().marks.size).toBe(0);
    expect(readObjectMarks().loaded).toBe(false);
    h.calls.length = 0;
    h.respond = () => OK;
    await ensureObjectMarks();
    expect(h.calls.every((c) => has(c, "eq", "user_id", "bob"))).toBe(true);
    expect(readObjectMarks().marks.size).toBe(0);
  });

  it("drops a write's bad news when its person has signed out meanwhile", async () => {
    await ensureObjectMarks();
    let answer: (v: Answer) => void = () => {};
    h.respond = (call) =>
      call.op === "upsert" ? new Promise<Answer>((resolve) => (answer = resolve)) : OK;
    const pressed = setStar("agent", "a1", true);
    await settle();
    clearObjectMarks();
    answer({ data: null, error: { message: "JWT expired" } });
    await pressed;
    // Nothing is put back into the next person's (empty) marks, and nobody is told.
    expect(readObjectMarks().marks.size).toBe(0);
    expect(h.toasts).toEqual([]);
  });
});
