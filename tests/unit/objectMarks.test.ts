// My work (R515): favourites, recently opened and shared-with-me are three
// readings of two lists, the search index and a person's marks. These tests
// hold the readings; the store and the page only draw them.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { navGroupForPath, navItemForPath } from "@/lib/appNav";
import { MY_WORK_TABS, myWorkTabFrom } from "@/lib/myWorkTabs";
import { isObjectKindId, OBJECT_KINDS, type ObjectEntry } from "@/lib/objectKinds";
import {
  favourites,
  favouritesInView,
  markFromRow,
  markKey,
  marksFromRows,
  marksTableMissing,
  marksToLookUp,
  paletteMarks,
  recents,
  sharedWithMe,
  starredAmong,
  withMarks,
  withOpened,
  withoutOpened,
  withStar,
  worthRecording,
  type ObjectMark,
} from "@/lib/objectMarks";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

let n = 0;
const entry = (over: Partial<ObjectEntry> & Pick<ObjectEntry, "kind" | "name">): ObjectEntry => ({
  id: `id${++n}`,
  mine: true,
  updatedAt: null,
  ...over,
});
const marks = (...list: ObjectMark[]) => new Map(list.map((m) => [markKey(m.kind, m.id), m]));
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}T12:00:00.000Z`;

describe("a mark read from the database", () => {
  it("is a kind, an id and when", () => {
    expect(
      markFromRow({ kind: "agent", object_id: "a1", starred_at: day(3), opened_at: null }),
    ).toEqual({ kind: "agent", id: "a1", starredAt: day(3), openedAt: null });
  });

  it("is refused when it names no kind the app has, or says nothing", () => {
    expect(markFromRow({ kind: "spaceship", object_id: "a1", starred_at: day(3) })).toBeNull();
    expect(markFromRow({ kind: "agent", object_id: "", starred_at: day(3) })).toBeNull();
    // A star taken off something never opened.
    expect(
      markFromRow({ kind: "agent", object_id: "a1", starred_at: null, opened_at: null }),
    ).toBeNull();
    expect(markFromRow({ kind: "agent", object_id: "a1", starred_at: "soon" })).toBeNull();
    expect(markFromRow(null)).toBeNull();
    expect(markFromRow("agent:a1")).toBeNull();
  });

  it("is keyed by kind and id, so one id in two kinds is two things", () => {
    const m = marksFromRows([
      { kind: "agent", object_id: "x", starred_at: day(1), opened_at: null },
      { kind: "dashboard", object_id: "x", starred_at: null, opened_at: day(2) },
      { kind: "nope", object_id: "x", starred_at: day(1) },
    ]);
    expect([...m.keys()]).toEqual(["agent:x", "dashboard:x"]);
  });
});

describe("favourites", () => {
  const a = entry({ kind: "agent", name: "Support", id: "a" });
  const b = entry({ kind: "dashboard", name: "Sales", id: "b" });
  const c = entry({ kind: "dataset", name: "orders", id: "c" });

  it("are what is starred, the most recently starred first", () => {
    const work = withMarks(
      [a, b, c],
      marks(
        { kind: "agent", id: "a", starredAt: day(2), openedAt: null },
        { kind: "dashboard", id: "b", starredAt: day(5), openedAt: null },
        { kind: "dataset", id: "c", starredAt: null, openedAt: day(9) },
      ),
    );
    expect(favourites(work).map((e) => e.name)).toEqual(["Sales", "Support"]);
  });

  it("leave out a star whose object is not among what the reader may see", () => {
    // Deleted, or no longer shared: the mark is still there, the name is not.
    const work = withMarks(
      [a],
      marks(
        { kind: "agent", id: "a", starredAt: day(2), openedAt: null },
        { kind: "dashboard", id: "gone", starredAt: day(5), openedAt: null },
      ),
    );
    expect(favourites(work).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("a list holds still while it is being pressed", () => {
  const a = entry({ kind: "agent", name: "A", id: "a" });
  const b = entry({ kind: "agent", name: "B", id: "b" });
  const c = entry({ kind: "agent", name: "C", id: "c" });
  const star = (id: string, d: number): ObjectMark => ({
    kind: "agent",
    id,
    starredAt: day(d),
    openedAt: null,
  });

  it("keeps a favourite's row where it was after its star is taken off", () => {
    const opened = favouritesInView(withMarks([a, b, c], marks(star("a", 1), star("b", 2))), []);
    expect(opened.map((e) => e.id)).toEqual(["b", "a"]);
    const shown = opened.map((e) => markKey(e.kind, e.id));
    // B's star is taken off. The row vanishing pulled A up under the pointer,
    // and a double click took A's star off as well.
    const after = favouritesInView(withMarks([a, b, c], marks(star("a", 1))), shown);
    expect(after.map((e) => [e.id, e.starred])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("puts something starred meanwhile ahead of what was already listed", () => {
    const shown = ["agent:b", "agent:a"];
    const after = favouritesInView(
      withMarks([a, b, c], marks(star("a", 1), star("b", 2), star("c", 9))),
      shown,
    );
    expect(after.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("drops a row whose object is gone, and is the plain list when nothing was shown", () => {
    const work = withMarks([a], marks(star("a", 1)));
    expect(favouritesInView(work, ["agent:gone", "agent:a"]).map((e) => e.id)).toEqual(["a"]);
    expect(favouritesInView(work, [])).toEqual(favourites(work));
  });

  it("is what My work draws, and its tab counts only what is starred", () => {
    const page = flat(rd("src/routes/_authenticated/my-work.tsx"));
    expect(page).toContain("favouritesInView(work, favShown)");
    expect(page).toContain(
      't === "favourites" ? lists.favourites.filter((e) => e.starred).length : lists[t].length',
    );
  });

  it("ranks a search by the stars as they stood when it was typed", () => {
    // Ranked by the live stars, a result jumped to the top the moment it was
    // starred, from under the pointer.
    const page = flat(rd("src/routes/_authenticated/search.tsx"));
    expect(page).toContain("starredFirst(rankObjects(entries, text), rankMarks)");
    expect(page).toContain("setRankMarks(liveMarks.current); }, [text, marksRead]);");
    expect(page).not.toContain("starredFirst(rankObjects(entries, text), marks)");
  });
});

describe("recently", () => {
  it("goes by the opening once there is one, whatever changed the thing since", () => {
    // Opened on the 3rd; a schedule (or the page saving itself) changed it on
    // the 9th. It read "Changed" over something its reader had only looked at.
    const synced = entry({ kind: "dataset", name: "Synced", id: "s", updatedAt: day(9) });
    const untouched = entry({ kind: "dataset", name: "Untouched", id: "u", updatedAt: day(5) });
    const work = withMarks(
      [synced, untouched],
      marks({ kind: "dataset", id: "s", starredAt: null, openedAt: day(3) }),
    );
    expect(recents(work).map((e) => [e.name, e.touched, e.touchedAt])).toEqual([
      ["Untouched", "changed", day(5)],
      ["Synced", "opened", day(3)],
    ]);
  });

  it("is what you opened, and your own work you have not opened, newest first", () => {
    const opened = entry({ kind: "dashboard", name: "Opened", id: "o", updatedAt: day(1) });
    const changed = entry({ kind: "agent", name: "Changed", id: "c", updatedAt: day(8) });
    const both = entry({ kind: "dataset", name: "Both", id: "b", updatedAt: day(3) });
    const work = withMarks(
      [opened, changed, both],
      marks(
        { kind: "dashboard", id: "o", starredAt: null, openedAt: day(6) },
        { kind: "dataset", id: "b", starredAt: null, openedAt: day(10) },
      ),
    );
    const list = recents(work);
    expect(list.map((e) => e.name)).toEqual(["Both", "Changed", "Opened"]);
    expect(list.map((e) => e.touched)).toEqual(["opened", "changed", "opened"]);
    expect(list.map((e) => e.touchedAt)).toEqual([day(10), day(8), day(6)]);
  });

  it("does not count somebody else's change, or a sample, as yours", () => {
    const shared = entry({ kind: "dashboard", name: "Theirs", mine: false, updatedAt: day(9) });
    const sample = entry({
      kind: "dataset",
      name: "Sample",
      mine: true,
      sample: true,
      updatedAt: day(9),
    });
    expect(recents(withMarks([shared, sample], new Map()))).toEqual([]);
    // Opening it is yours, whoever made it.
    const work = withMarks(
      [shared],
      marks({ kind: "dashboard", id: shared.id, starredAt: null, openedAt: day(4) }),
    );
    expect(recents(work).map((e) => [e.name, e.touched])).toEqual([["Theirs", "opened"]]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      entry({ kind: "agent", name: `A${i}`, updatedAt: day(1 + (i % 20)) }),
    );
    expect(recents(withMarks(many, new Map()))).toHaveLength(50);
    expect(recents(withMarks(many, new Map()), 3)).toHaveLength(3);
  });
});

describe("shared with me", () => {
  it("is what is not mine and not a sample, most recently changed first", () => {
    const work = withMarks(
      [
        entry({ kind: "agent", name: "Mine" }),
        entry({ kind: "dataset", name: "Sample", mine: false, sample: true }),
        entry({ kind: "dashboard", name: "Older", mine: false, updatedAt: day(2) }),
        entry({ kind: "workbook", name: "Newer", mine: false, updatedAt: day(7) }),
        entry({ kind: "dataset", name: "Masked share", mine: false, updatedAt: null }),
      ],
      new Map(),
    );
    expect(sharedWithMe(work).map((e) => e.name)).toEqual(["Newer", "Older", "Masked share"]);
  });
});

describe("what the palette offers before anything is typed", () => {
  it("is a few favourites, then what was opened last that is not one of them", () => {
    const list = Array.from({ length: 9 }, (_, i) =>
      entry({ kind: "agent", name: `A${i}`, id: `a${i}`, updatedAt: day(20) }),
    );
    const m = marks(
      ...list.map((e, i) => ({
        kind: e.kind,
        id: e.id,
        starredAt: i < 2 ? day(10 + i) : null,
        openedAt: i < 8 ? day(1 + i) : null,
      })),
    );
    const got = paletteMarks(withMarks(list, m), 3);
    expect(got.favourites.map((e) => e.id)).toEqual(["a1", "a0"]);
    // By when each was opened, though every one of them was changed later.
    // a8 was changed on the 20th and never opened: it is not "where you were".
    expect(got.recent.map((e) => e.id)).toEqual(["a7", "a6", "a5"]);
    expect(got.recent.map((e) => e.openedAt)).toEqual([day(8), day(7), day(6)]);
  });
});

describe("marks the index has no name for", () => {
  const have = [entry({ kind: "agent", name: "Here", id: "here" })];
  const m = marks(
    { kind: "agent", id: "here", starredAt: day(1), openedAt: null },
    { kind: "agent", id: "old", starredAt: day(1), openedAt: null },
    { kind: "dashboard", id: "gone", starredAt: day(1), openedAt: null },
  );

  it("are looked up only in kinds the index could not hold in full", () => {
    expect(marksToLookUp(m, have, ["agent"])).toEqual({ agent: ["old"] });
    // The index holds every dashboard: one it has no name for is gone.
    expect(marksToLookUp(m, have, [])).toEqual({});
    expect(marksToLookUp(m, have, ["dashboard", "agent"])).toEqual({
      agent: ["old"],
      dashboard: ["gone"],
    });
  });
});

describe("changing a mark", () => {
  const none = new Map<string, ObjectMark>();

  it("stars and unstars without losing when it was opened", () => {
    const opened = withOpened(none, "agent", "a", day(3));
    const starred = withStar(opened, "agent", "a", true, day(4));
    expect(starred.get("agent:a")).toEqual({
      kind: "agent",
      id: "a",
      starredAt: day(4),
      openedAt: day(3),
    });
    // Starring again keeps the first date: the list must not reshuffle.
    expect(withStar(starred, "agent", "a", true, day(9)).get("agent:a")?.starredAt).toBe(day(4));
    const off = withStar(starred, "agent", "a", false, day(5));
    expect(off.get("agent:a")).toEqual({
      kind: "agent",
      id: "a",
      starredAt: null,
      openedAt: day(3),
    });
    // The maps handed in are never changed.
    expect(opened.get("agent:a")?.starredAt).toBeNull();
    expect(none.size).toBe(0);
  });

  it("forgets a mark that says nothing any more", () => {
    const starred = withStar(none, "agent", "a", true, day(1));
    expect(withStar(starred, "agent", "a", false, day(2)).has("agent:a")).toBe(false);
  });

  it("clears what was opened and keeps the favourites", () => {
    let m = withOpened(none, "agent", "a", day(1));
    m = withOpened(m, "dashboard", "b", day(2));
    m = withStar(m, "dashboard", "b", true, day(3));
    const cleared = withoutOpened(m);
    expect([...cleared.keys()]).toEqual(["dashboard:b"]);
    expect(cleared.get("dashboard:b")).toEqual({
      kind: "dashboard",
      id: "b",
      starredAt: day(3),
      openedAt: null,
    });
  });
});

describe("whether an opening is written", () => {
  const at = Date.parse(day(5));
  const m = withOpened(new Map(), "agent", "a", day(5));

  it("is yes the first time, and again once a minute has passed", () => {
    expect(worthRecording(new Map(), "agent", "a", at)).toBe(true);
    expect(worthRecording(m, "agent", "a", at + 59_000)).toBe(false);
    expect(worthRecording(m, "agent", "a", at + 60_000)).toBe(true);
    // Another object is another opening.
    expect(worthRecording(m, "agent", "b", at + 1)).toBe(true);
  });

  it("is no for an id the table would refuse", () => {
    expect(worthRecording(new Map(), "agent", "", at)).toBe(false);
    expect(worthRecording(new Map(), "agent", "x".repeat(401), at)).toBe(false);
  });
});

describe("an install that has not run the migration", () => {
  it("is told apart from a real failure", () => {
    expect(marksTableMissing({ code: "PGRST205", message: "" })).toBe(true);
    expect(marksTableMissing({ code: "42P01", message: "" })).toBe(true);
    expect(
      marksTableMissing({
        message: "Could not find the table 'public.object_marks' in the schema cache",
      }),
    ).toBe(true);
    expect(marksTableMissing({ code: "42501", message: "permission denied" })).toBe(false);
    expect(marksTableMissing({ message: "fetch failed" })).toBe(false);
    expect(marksTableMissing(null)).toBe(false);
  });
});

describe("the table behind it", () => {
  const dir = path.join(REPO, "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_object_marks.sql"));
  const sql = file ? readFileSync(path.join(dir, file), "utf8") : "";

  it("belongs to one person and stores no name", () => {
    expect(file).toBeTruthy();
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    // Four policies, every one of them the owner's.
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(4);
    expect(sql.match(/auth\.uid\(\) = user_id/g)?.length).toBe(5);
    // Names are looked up when a mark is read, never kept beside it.
    const table = sql.slice(sql.indexOf("CREATE TABLE"), sql.indexOf(");") + 2);
    expect(table).not.toMatch(/\bname\b|\btitle\b|\bdetail\b/);
    // No definer function reads it for anybody else.
    expect(sql).not.toContain("SECURITY DEFINER");
  });

  it("does not list the kinds: a new kind needs no migration", () => {
    expect(sql).not.toMatch(/kind\s+IN\s*\(/i);
  });

  it("is in the database types the app is compiled against", () => {
    const types = rd("src/integrations/supabase/types.ts");
    const at = types.indexOf("      object_marks: {");
    expect(at).toBeGreaterThan(0);
    const row = types.slice(at, types.indexOf("Insert:", at));
    for (const column of ["kind", "object_id", "opened_at", "starred_at", "user_id"]) {
      expect(row, column).toContain(`${column}:`);
    }
  });
});

describe("the star", () => {
  const src = flat(rd("src/components/StarButton.tsx"));

  it("says what pressing it will do, and whether it is on", () => {
    expect(src).toContain("aria-pressed={on}");
    expect(src).toContain("`Remove ${name} from favourites`");
    expect(src).toContain("`Add ${name} to favourites`");
    // A button, not a clickable span: it is reached and pressed from the keyboard.
    expect(src).toContain('<button type="button"');
  });

  it("does not also open the row it sits on", () => {
    expect(src).toContain("event.preventDefault();");
    expect(src).toContain("event.stopPropagation();");
  });

  it("is left out where the database has no table for it", () => {
    expect(src).toContain("if (marks.unavailable) return null;");
  });

  it("can keep out of the way in a narrow rail, but never when it is on", () => {
    // A star on every row of a narrow rail cut each name short. Quiet, it
    // shows when the row is pointed at or holds the keyboard — and always when
    // it is a favourite, or on a screen with nothing to point with.
    expect(src).toContain("quiet && !on && QUIET[quiet],");
    for (const mode of ["collapse", "fade"]) {
      const rule = new RegExp(`${mode}:\\s*"([^"]+)"`).exec(src)?.[1] ?? "";
      expect(rule, mode).toContain("group-hover/star:");
      expect(rule, mode).toContain("group-focus-within/star:");
      expect(rule, mode).toContain("[@media(hover:none)]:");
    }
  });

  it("is quiet only on a row that says it is one", () => {
    // `quiet` reads the row's hover through the class group/star: without it
    // the star would never appear.
    for (const file of [
      "src/routes/_authenticated/lakehouse.tsx",
      "src/routes/_authenticated/workflows.tsx",
      "src/routes/_authenticated/ai-analyst.tsx",
      "src/routes/_authenticated/data-sql.tsx",
      "src/components/catalog/CatalogView.tsx",
    ]) {
      const text = rd(file);
      expect(text, file).toMatch(/quiet="(collapse|fade)"/);
      expect(text, file).toContain("group/star");
    }
  });
});

describe("a row of search results and of My work", () => {
  const src = flat(rd("src/components/search/parts.tsx"));
  const row = src.slice(src.indexOf("export function ObjectRow"));

  it("keeps the star beside the link, never inside it", () => {
    // A button inside a link is two things to press in one.
    expect(row.indexOf("</Link>")).toBeGreaterThan(0);
    expect(row.indexOf("<StarButton")).toBeGreaterThan(row.indexOf("</Link>"));
  });

  it("notes the opening on a click, and on a middle click into a new tab", () => {
    expect(row).toContain("const opened = () => void recordOpened(entry.kind, entry.id);");
    expect(row).toContain("onClick={opened}");
    expect(row).toContain("onAuxClick={opened}");
  });

  it("is the one row both pages draw", () => {
    expect(rd("src/routes/_authenticated/search.tsx")).toContain("<ObjectRow");
    expect(rd("src/routes/_authenticated/my-work.tsx")).toContain("<ObjectRow");
  });
});

describe("the tabs of My work", () => {
  it("are recent, favourites and shared with me, in that order", () => {
    expect([...MY_WORK_TABS]).toEqual(["recent", "favourites", "shared"]);
  });

  it("open the first tab for an address that names none of them", () => {
    expect(myWorkTabFrom("favourites")).toBe("favourites");
    expect(myWorkTabFrom("shared")).toBe("shared");
    for (const odd of [undefined, null, "", "nonsense", 3, "Favourites"]) {
      expect(myWorkTabFrom(odd), String(odd)).toBe("recent");
    }
  });

  it("are read at use, not only when the address is checked", () => {
    // The router merges what validateSearch returns over the raw address, so
    // a tab that is not one still reaches the page: it is made one there.
    const page = flat(rd("src/routes/_authenticated/my-work.tsx"));
    expect(page).toContain("const tab = myWorkTabFrom(search.tab);");
    expect(page).toContain('if (typeof s.tab === "string") out.tab = myWorkTabFrom(s.tab);');
  });

  it("is a page in the menu, under Overview", () => {
    expect(navGroupForPath("/my-work")?.label).toBe("Overview");
    expect(navItemForPath("/my-work")?.title).toBe("My work");
  });
});

describe("the Favourites filter on a list page", () => {
  const m = marks(
    { kind: "agent", id: "a", starredAt: day(1), openedAt: null },
    { kind: "agent", id: "b", starredAt: null, openedAt: day(2) },
    { kind: "dashboard", id: "c", starredAt: day(3), openedAt: null },
    { kind: "agent", id: "gone", starredAt: day(4), openedAt: null },
  );

  it("counts what is starred among the page's own things, of its own kind", () => {
    // "gone" is starred but not on the page; "c" is another kind with the id of nothing here.
    expect([...starredAmong(m, "agent", ["a", "b", "c"])]).toEqual(["a"]);
    expect(starredAmong(m, "agent", []).size).toBe(0);
    expect([...starredAmong(m, "dashboard", ["a", "c"])]).toEqual(["c"]);
  });

  const ui = flat(rd("src/components/FavouritesFilter.tsx"));
  const state = flat(rd("src/hooks/use-favourites-filter.ts"));

  it("is not drawn until something on the page is starred", () => {
    expect(ui).toContain("if (filter.count === 0) return null;");
  });

  it("never leaves a list empty: off when nothing is starred, and stays off", () => {
    expect(state).toContain("const on = wanted && starred.size > 0;");
    expect(state).toContain("keep: (id) => !on || starred.has(id),");
    // Starring something later must not narrow the list by surprise.
    expect(state).toContain("if (wanted && none) setWanted(false);");
  });

  it("is a button that says whether it is on", () => {
    expect(ui).toContain('<button type="button" aria-pressed={filter.on}');
  });
});

describe("every kind of thing can be starred where it is listed", () => {
  /** Every .tsx under a folder: its path and its source. */
  const sources = (dir: string): Array<{ file: string; text: string }> =>
    readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? sources(path.join(dir, d.name))
        : d.name.endsWith(".tsx")
          ? [{ file: path.join(dir, d.name).replace(/\\/g, "/"), text: rd(path.join(dir, d.name)) }]
          : [],
    );
  const all = [...sources("src/routes"), ...sources("src/components")];
  const starred = new Set(
    all.flatMap(({ text }) =>
      [...flat(text).matchAll(/<StarButton kind="([a-z_]+)"/g)].map((m) => m[1]),
    ),
  );

  it("has a star on a page for each kind in the registry", () => {
    // A kind added to the registry is found by search and offered by New at
    // once; this is what makes it something you can keep at hand as well.
    for (const k of OBJECT_KINDS) expect([...starred].sort(), k.id).toContain(k.id);
  });

  it("stars nothing the registry does not know", () => {
    for (const kind of starred) expect(isObjectKindId(kind), kind).toBe(true);
  });

  // Things that are pressed as one. A star written inside one of them is a
  // button inside a link or a button: invalid, and a screen reader announces
  // only the outer one.
  const PRESSED = new Set([
    "a",
    "button",
    "Link",
    "Button",
    "DialogTrigger",
    "DropdownMenuTrigger",
    "CollapsibleTrigger",
    "PopoverTrigger",
    "TabsTrigger",
    "AccordionTrigger",
    "CommandItem",
  ]);

  /** Every <StarButton> that sits inside something pressed, by parsing the source. */
  const starsInsidePressed = (file: string, text: string): string[] => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (node: ts.Node, inside: string | null) => {
      const isStar =
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(sf) === "StarButton";
      if (isStar && inside) found.push(`${file}: a star inside <${inside}>`);
      let now = inside;
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(sf);
        if (PRESSED.has(tag)) now = tag;
      }
      ts.forEachChild(node, (child) => visit(child, now));
    };
    visit(sf, null);
    return found;
  };

  it("tells a star inside a link or a button from one beside it", () => {
    const beside = `const x = <li><Link to="/a">Name</Link><StarButton kind="agent" id="1" name="n" /></li>;`;
    const inside = `const x = <Link to="/a">Name <StarButton kind="agent" id="1" name="n" /></Link>;`;
    const deep = `const x = <button onClick={() => go()}><span><Icon /><StarButton kind="agent" id="1" name="n" /></span></button>;`;
    expect(starsInsidePressed("beside.tsx", beside)).toEqual([]);
    expect(starsInsidePressed("inside.tsx", inside)).toEqual(["inside.tsx: a star inside <Link>"]);
    expect(starsInsidePressed("deep.tsx", deep)).toEqual(["deep.tsx: a star inside <button>"]);
  });

  it("never puts a star inside a link or another button, on any page", () => {
    const offenders = all
      .filter(({ text }) => text.includes("<StarButton"))
      .flatMap(({ file, text }) => starsInsidePressed(file, text));
    expect(offenders).toEqual([]);
  });
});

describe("what the palette records", () => {
  const ui = flat(rd("src/components/CommandPalette.tsx"));

  it("is the opening of whatever is chosen from it", () => {
    expect(ui).toContain("void recordOpened(e.kind, e.id); go(linkToObject(e));");
  });

  it("opens on favourites and what was opened last, drawn by the one row", () => {
    expect(ui).toContain('<CommandGroup heading="Favourites">');
    expect(ui).toContain('<CommandGroup heading="Opened last">');
    expect(ui).toContain('results.recent.map((e) => objectRow(e, "recent", agoLabel(e.openedAt)))');
  });
});
