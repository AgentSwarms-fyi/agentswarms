// What a person has starred and what they opened last, joined to the names
// search already knows.
//
// A mark holds no name: only which object, and when. It gets its name by being
// looked up among the things its owner may see right now (the search index).
// So something deleted, or no longer shared, stops being listed without
// anybody tidying up, and a mark can never show a name its page would not.
//
// Everything here is plain arithmetic over two lists, so "My work", the search
// palette and the star on a row cannot disagree about what is a favourite.
import { isObjectKindId, type ObjectEntry, type ObjectKindId } from "@/lib/objectKinds";

export type ObjectMark = {
  kind: ObjectKindId;
  id: string;
  /** Set while it is a favourite. */
  starredAt: string | null;
  /** The last time its owner opened it. */
  openedAt: string | null;
};

export type MarkMap = ReadonlyMap<string, ObjectMark>;

/** How many recently opened things are listed. */
export const RECENT_LIMIT = 50;
/** How many of each the search palette shows before anything is typed. */
export const PALETTE_MARKS = 5;
/** An object opened again within this long is not written again. */
export const REOPEN_QUIET_MS = 60_000;

export const markKey = (kind: string, id: string) => `${kind}:${id}`;

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
};

/** A row of the marks table as the database returns it; null when it is not one. */
export function markFromRow(row: unknown): ObjectMark | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!isObjectKindId(r.kind)) return null;
  if (typeof r.object_id !== "string" || !r.object_id) return null;
  const starredAt = iso(r.starred_at);
  const openedAt = iso(r.opened_at);
  // A row that says neither is a star taken off something never opened.
  if (!starredAt && !openedAt) return null;
  return { kind: r.kind, id: r.object_id, starredAt, openedAt };
}

export function marksFromRows(rows: readonly unknown[]): Map<string, ObjectMark> {
  const out = new Map<string, ObjectMark>();
  for (const row of rows) {
    const m = markFromRow(row);
    if (m) out.set(markKey(m.kind, m.id), m);
  }
  return out;
}

const time = (v?: string | null) => {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/** One of the reader's things, with what they have done with it. */
export type WorkEntry = ObjectEntry & {
  starred: boolean;
  starredAt: string | null;
  /** The last time the reader opened it, whatever happened to it since. */
  openedAt: string | null;
  /**
   * When the reader last opened it. For their own work that they have not
   * opened, when it last changed instead.
   */
  touchedAt: string | null;
  /** Which of the two `touchedAt` is. */
  touched: "opened" | "changed" | null;
};

/** Every entry with its mark. Entries without one are still returned. */
export function withMarks(entries: readonly ObjectEntry[], marks: MarkMap): WorkEntry[] {
  return entries.map((e) => {
    const m = marks.get(markKey(e.kind, e.id));
    const opened = time(m?.openedAt);
    // An opening is the reader's own doing, and once there is one it is the
    // time that counts, whatever changed the object since: a dashboard saves
    // itself while it is open and a synced dataset changes every night, and
    // "Changed 5 minutes ago" over something only looked at was untrue. For
    // work never opened, when it last changed stands in, and only for the
    // reader's own: somebody else changing a thing they shared is not the
    // reader having touched it, and a bundled sample is nobody's work.
    const changed = e.mine && !e.sample ? time(e.updatedAt) : 0;
    const touched = opened ? "opened" : changed ? "changed" : null;
    return {
      ...e,
      starred: Boolean(m?.starredAt),
      starredAt: m?.starredAt ?? null,
      openedAt: m?.openedAt ?? null,
      touched,
      touchedAt:
        touched === "opened"
          ? (m?.openedAt ?? null)
          : touched === "changed"
            ? (e.updatedAt ?? null)
            : null,
    };
  });
}

const byName = (a: ObjectEntry, b: ObjectEntry) =>
  a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

/** Favourites, the most recently starred first. */
export function favourites(work: readonly WorkEntry[]): WorkEntry[] {
  return work
    .filter((e) => e.starred)
    .sort((a, b) => time(b.starredAt) - time(a.starredAt) || byName(a, b));
}

/**
 * The Favourites list while it is on screen: what is starred now, and what
 * had its star taken off since the list was opened, each where it was.
 *
 * A row that vanished the moment its star was pressed pulled the next row up
 * under the pointer, so a double click took the star off two things. The row
 * stays, with an empty star one press from being put back, until the list is
 * left. `shownBefore` is what the list showed last, as keys in order;
 * anything starred since goes ahead of it.
 */
export function favouritesInView(
  work: readonly WorkEntry[],
  shownBefore: readonly string[],
): WorkEntry[] {
  const byKey = new Map(work.map((e) => [markKey(e.kind, e.id), e]));
  const before = new Set(shownBefore);
  const fresh = favourites(work).filter((e) => !before.has(markKey(e.kind, e.id)));
  const kept = shownBefore
    .map((key) => byKey.get(key))
    .filter((e): e is WorkEntry => e !== undefined);
  return [...fresh, ...kept];
}

/** What the reader opened, and their own work not yet opened, newest first. */
export function recents(work: readonly WorkEntry[], limit = RECENT_LIMIT): WorkEntry[] {
  return work
    .filter((e) => e.touched !== null)
    .sort((a, b) => time(b.touchedAt) - time(a.touchedAt) || byName(a, b))
    .slice(0, Math.max(0, limit));
}

/** What other people shared with the reader, most recently changed first. */
export function sharedWithMe(work: readonly WorkEntry[]): WorkEntry[] {
  return work
    .filter((e) => !e.mine && !e.sample)
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || byName(a, b));
}

/**
 * What the search palette offers before anything is typed: a few favourites,
 * then the last few things opened that are not already among them.
 */
export function paletteMarks(
  work: readonly WorkEntry[],
  each = PALETTE_MARKS,
): { favourites: WorkEntry[]; recent: WorkEntry[] } {
  const favs = favourites(work).slice(0, each);
  const shown = new Set(favs.map((e) => markKey(e.kind, e.id)));
  // By when it was OPENED, whatever was changed since: the palette is for
  // getting back to where you were. "Recently changed" is a list page's own
  // order already, and something edited by a schedule is not somewhere you were.
  const recent = work
    .filter((e) => e.openedAt !== null && !shown.has(markKey(e.kind, e.id)))
    .sort((a, b) => time(b.openedAt) - time(a.openedAt) || byName(a, b))
    .slice(0, Math.max(0, each));
  return { favourites: favs, recent };
}

/** Which of these ids, of one kind, are favourites. For a list page's filter. */
export function starredAmong(
  marks: MarkMap,
  kind: ObjectKindId,
  ids: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (marks.get(markKey(kind, id))?.starredAt) out.add(id);
  }
  return out;
}

/**
 * Search results with favourites ahead of other matches that are just as
 * good. A better match still comes first: a star breaks ties, it does not
 * outrank what was typed.
 */
export function starredFirst<T extends { kind: ObjectKindId; id: string; score: number }>(
  ranked: readonly T[],
  marks: MarkMap,
): T[] {
  const star = (e: T) => (marks.get(markKey(e.kind, e.id))?.starredAt ? 1 : 0);
  // The sort is stable: within a tie the order handed in is kept.
  return [...ranked].sort((a, b) => b.score - a.score || star(b) - star(a));
}

/**
 * Marks with no name yet, in kinds the index could not hold in full. For every
 * other kind the index is complete, so a mark it has no name for points at
 * something the reader can no longer see, and there is nothing to ask.
 */
export function marksToLookUp(
  marks: MarkMap,
  entries: readonly ObjectEntry[],
  capped: readonly ObjectKindId[],
): Partial<Record<ObjectKindId, string[]>> {
  if (!capped.length) return {};
  const have = new Set(entries.map((e) => markKey(e.kind, e.id)));
  const wanted = new Set(capped);
  const out: Partial<Record<ObjectKindId, string[]>> = {};
  for (const m of marks.values()) {
    if (!wanted.has(m.kind) || have.has(markKey(m.kind, m.id))) continue;
    (out[m.kind] ??= []).push(m.id);
  }
  return out;
}

/** The map after a star is put on or taken off, without touching the original. */
export function withStar(
  marks: MarkMap,
  kind: ObjectKindId,
  id: string,
  starred: boolean,
  now: string,
): Map<string, ObjectMark> {
  const next = new Map(marks);
  const key = markKey(kind, id);
  const was = next.get(key);
  const mark: ObjectMark = {
    kind,
    id,
    openedAt: was?.openedAt ?? null,
    starredAt: starred ? (was?.starredAt ?? now) : null,
  };
  if (!mark.starredAt && !mark.openedAt) next.delete(key);
  else next.set(key, mark);
  return next;
}

/** The map after an object is opened. */
export function withOpened(
  marks: MarkMap,
  kind: ObjectKindId,
  id: string,
  now: string,
): Map<string, ObjectMark> {
  const next = new Map(marks);
  const key = markKey(kind, id);
  const was = next.get(key);
  next.set(key, { kind, id, starredAt: was?.starredAt ?? null, openedAt: now });
  return next;
}

/** The map after "Clear recently opened": favourites stay, as favourites only. */
export function withoutOpened(marks: MarkMap): Map<string, ObjectMark> {
  const next = new Map<string, ObjectMark>();
  for (const [key, m] of marks) {
    if (m.starredAt) next.set(key, { ...m, openedAt: null });
  }
  return next;
}

/**
 * Should opening this be written? Not when it was written a moment ago: a page
 * re-renders many times while an object is open, and each is not an opening.
 */
export function worthRecording(
  marks: MarkMap,
  kind: ObjectKindId,
  id: string,
  nowMs: number,
  quietMs = REOPEN_QUIET_MS,
): boolean {
  if (!id || id.length > 400) return false;
  const was = time(marks.get(markKey(kind, id))?.openedAt);
  return !was || nowMs - was >= quietMs;
}

/**
 * Is this the database saying the marks table is not there? An install that
 * has the new app but not yet its migration answers every read this way, and
 * the app then leaves the stars out instead of failing on each page.
 */
export function marksTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return (
    /object_marks/.test(error.message ?? "") && /not find|does not exist/i.test(error.message ?? "")
  );
}
