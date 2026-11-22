// The search index kept in the browser (src/hooks/use-object-index.ts).
//
// It is read in two parts: everything in the database, and the lakehouse
// tables, which come from their own engine and can answer tens of seconds
// later. These pin what a reader is told while the second part is on its way,
// what a refresh may take away, and that a read overtaken by a sign-out never
// writes the previous person's names.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ObjectEntry } from "@/lib/objectKinds";

type MainAnswer =
  | { ok: true; entries: ObjectEntry[]; capped: string[]; failed: string[] }
  | { ok: false; error: string };
type LakeAnswer = { ok: true; entries: ObjectEntry[] } | { ok: false; error: string };
type Waiting = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const h = vi.hoisted(() => ({
  user: "ada" as string | null,
  main: [] as Waiting[],
  lake: [] as Waiting[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: {} } }) } },
}));
vi.mock("@/lib/sessionUser", () => ({
  sessionUser: async () => (h.user ? { id: h.user } : null),
}));
vi.mock("@/utils/objectSearch.functions", () => {
  // Each call waits until the test answers it, so the order answers arrive in
  // is the test's to choose.
  const queued = (list: Waiting[]) => () =>
    new Promise((resolve, reject) => {
      list.push({ resolve, reject });
    });
  return {
    objectIndex: queued(h.main),
    objectIndexLakehouse: queued(h.lake),
    objectSearchMore: async () => ({ entries: [] }),
  };
});

import {
  clearObjectIndex,
  ensureObjectIndex,
  indexUnread,
  readObjectIndex,
} from "@/hooks/use-object-index";

const entry = (kind: ObjectEntry["kind"], id: string, name = id): ObjectEntry => ({
  kind,
  id,
  name,
  mine: true,
});
const agent = entry("agent", "a1", "Support agent");
const table = (id: string) => entry("lakehouse_table", id);

/** Let every promise that can settle, settle. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const answerMain = (v: MainAnswer, at = h.main.length - 1) => h.main[at].resolve(v);
const answerLake = (v: LakeAnswer, at = h.lake.length - 1) => h.lake[at].resolve(v);
const mainOk = (entries: ObjectEntry[]): MainAnswer => ({
  ok: true,
  entries,
  capped: [],
  failed: [],
});
const ids = () =>
  readObjectIndex()
    .entries.map((e) => e.id)
    .sort();

describe("the search index in the browser", () => {
  beforeEach(async () => {
    // Finish anything a previous test left unanswered, then start empty.
    for (const w of [...h.main, ...h.lake]) w.resolve({ ok: false, error: "left over" });
    await settle();
    h.main.length = 0;
    h.lake.length = 0;
    h.user = "ada";
    clearObjectIndex();
  });

  it("says it is reading from the moment it is asked, before anything is awaited", async () => {
    expect(indexUnread(readObjectIndex())).toBe(true);
    const done = ensureObjectIndex();
    // Nothing awaited yet: who is signed in has not even been looked up.
    expect(readObjectIndex().loading).toBe(true);
    expect(indexUnread(readObjectIndex())).toBe(false);
    await settle();
    answerMain(mainOk([agent]));
    answerLake({ ok: true, entries: [] });
    await done;
    expect(readObjectIndex().loading).toBe(false);
    expect(indexUnread(readObjectIndex())).toBe(false);
    // Thrown away (someone else signed in): not read yet, once more.
    clearObjectIndex();
    expect(indexUnread(readObjectIndex())).toBe(true);
  });

  it("puts a failure into words even when it arrives without any", async () => {
    const first = ensureObjectIndex();
    await settle();
    answerMain({ ok: false, error: "" });
    await first;
    expect(readObjectIndex().error).toBe("The server did not answer. Try again in a moment.");
    // A failure is not "nothing read yet": nothing asks again on its own.
    expect(indexUnread(readObjectIndex())).toBe(false);

    // Asking again says "reading" at once and forgets the old failure.
    const again = ensureObjectIndex();
    expect(readObjectIndex().loading).toBe(true);
    expect(readObjectIndex().error).toBeNull();
    await settle();
    h.main[h.main.length - 1].reject(new Error(""));
    await again;
    expect(readObjectIndex().error).toBe("Search could not load");
    expect(readObjectIndex().loading).toBe(false);
  });

  it("asks the server nothing when nobody is signed in", async () => {
    h.user = null;
    await ensureObjectIndex();
    expect(h.main.length).toBe(0);
    expect(h.lake.length).toBe(0);
    expect(readObjectIndex().error).toBe("Sign in to search your work.");
    expect(readObjectIndex().loading).toBe(false);
    expect(indexUnread(readObjectIndex())).toBe(false);
  });

  it("says the lakehouse tables are still being read until they arrive", async () => {
    const done = ensureObjectIndex();
    await settle();
    expect(readObjectIndex().loading).toBe(true);

    answerMain(mainOk([agent]));
    await settle();
    // Everything else is searchable at once...
    expect(readObjectIndex().loading).toBe(false);
    expect(ids()).toEqual(["a1"]);
    // ...and the part that is not here yet is named, not passed over.
    expect(readObjectIndex().pending).toEqual(["lakehouse_table"]);

    answerLake({ ok: true, entries: [table("sales.orders")] });
    await done;
    expect(readObjectIndex().pending).toEqual([]);
    expect(ids()).toEqual(["a1", "sales.orders"]);
  });

  it("keeps the tables read last time on screen while a refresh is on its way", async () => {
    const first = ensureObjectIndex();
    await settle();
    answerMain(mainOk([agent]));
    answerLake({ ok: true, entries: [table("sales.orders"), table("sales.old")] });
    await first;

    const again = ensureObjectIndex(true);
    await settle();
    answerMain(mainOk([agent, entry("agent", "a2")]));
    await settle();
    // The new answer for everything else must not make the tables vanish.
    expect(ids()).toEqual(["a1", "a2", "sales.old", "sales.orders"]);
    // Nothing is missing from what is shown, so nothing is "still reading".
    expect(readObjectIndex().pending).toEqual([]);

    answerLake({ ok: true, entries: [table("sales.orders")] });
    await again;
    // The new list replaces the old one: a dropped table goes.
    expect(ids()).toEqual(["a1", "a2", "sales.orders"]);
  });

  it("drops the old tables and says so when the lakehouse cannot be listed", async () => {
    const first = ensureObjectIndex();
    await settle();
    answerMain(mainOk([agent]));
    answerLake({ ok: true, entries: [table("sales.orders")] });
    await first;

    const again = ensureObjectIndex(true);
    await settle();
    answerMain(mainOk([agent]));
    answerLake({ ok: false, error: "engine is starting" });
    await again;
    expect(ids()).toEqual(["a1"]);
    expect(readObjectIndex().failed).toContain("lakehouse_table");
    expect(readObjectIndex().pending).toEqual([]);
  });

  it("stops saying it is still reading when the whole index fails", async () => {
    const done = ensureObjectIndex();
    await settle();
    answerMain({ ok: false, error: "no connection" });
    await done;
    expect(readObjectIndex().error).toBe("no connection");
    expect(readObjectIndex().pending).toEqual([]);
    expect(readObjectIndex().loading).toBe(false);
  });

  it("says so in words when the server answers with nothing at all", async () => {
    // What a server that is restarting does: the call resolves, empty.
    const done = ensureObjectIndex();
    await settle();
    h.main[0].resolve(undefined);
    h.lake[0].resolve(undefined);
    await done;
    expect(readObjectIndex().error).toBe("The server did not answer. Try again in a moment.");
    expect(readObjectIndex().loading).toBe(false);
    expect(readObjectIndex().pending).toEqual([]);
  });

  it("lists everything else when only the lakehouse answers with nothing", async () => {
    const done = ensureObjectIndex();
    await settle();
    answerMain(mainOk([agent]));
    h.lake[0].resolve(undefined);
    await done;
    expect(ids()).toEqual(["a1"]);
    expect(readObjectIndex().failed).toContain("lakehouse_table");
    expect(readObjectIndex().error).toBeNull();
  });

  it("never writes names that arrive after the person signed out", async () => {
    const adas = ensureObjectIndex();
    await settle();
    // Ada signs out while her index is still being read.
    clearObjectIndex();
    answerMain(mainOk([agent]));
    answerLake({ ok: true, entries: [table("sales.orders")] });
    await adas;
    await settle();
    expect(readObjectIndex().entries).toEqual([]);
    expect(readObjectIndex().loadedAt).toBe(0);
  });

  it("gives the next person only their own names, whichever answer lands last", async () => {
    const adas = ensureObjectIndex();
    await settle();
    answerMain(mainOk([agent]));
    await settle();
    // Ada's lakehouse answer is still out when Grace signs in on the same tab.
    clearObjectIndex();
    h.user = "grace";
    const graces = ensureObjectIndex();
    await settle();
    answerMain(mainOk([entry("agent", "g1")]));
    answerLake({ ok: true, entries: [table("grace.t")] });
    await graces;
    // Now Ada's late answer arrives.
    answerLake({ ok: true, entries: [table("sales.orders")] }, 0);
    await adas;
    await settle();
    expect(ids()).toEqual(["g1", "grace.t"]);
  });

  it("does not read twice when an overtaken read ends after its replacement began", async () => {
    const adas = ensureObjectIndex();
    await settle();
    clearObjectIndex();
    const next = ensureObjectIndex();
    await settle();
    // The overtaken read ends now; the newer one is still in flight.
    answerMain({ ok: false, error: "gone" }, 0);
    await adas;
    await settle();
    const same = ensureObjectIndex();
    await settle();
    expect(h.main.length).toBe(2);
    answerMain(mainOk([agent]));
    answerLake({ ok: true, entries: [] });
    await Promise.all([next, same]);
    expect(ids()).toEqual(["a1"]);
  });
});
