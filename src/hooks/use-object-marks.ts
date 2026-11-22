// One person's favourites and recently opened things, read once and shared by
// every star on the page.
//
// A star answers the moment it is pressed: the change is shown first and
// written second, and put back with a message if the write fails. Opening
// something is written at most once a minute per object.
//
// Like the search index, this holds something only one person may see and it
// outlives the page that read it, so it is thrown away the moment the
// signed-in person changes.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import type { ObjectKindId } from "@/lib/objectKinds";
import {
  markKey,
  marksFromRows,
  marksTableMissing,
  withOpened,
  withoutOpened,
  withStar,
  worthRecording,
  type ObjectMark,
} from "@/lib/objectMarks";
import { sessionUser } from "@/lib/sessionUser";

export type MarksState = {
  marks: Map<string, ObjectMark>;
  /** Read at least once for the person signed in. */
  loaded: boolean;
  loading: boolean;
  /**
   * The table is not there: this install runs the new app on a database that
   * has not had its migration. Stars are left out instead of failing.
   */
  unavailable: boolean;
  error: string | null;
};

const EMPTY: MarksState = {
  marks: new Map(),
  loaded: false,
  loading: false,
  unavailable: false,
  error: null,
};

/** How many of each list are read: every favourite a person plausibly has. */
const STARRED_CAP = 1000;
const OPENED_CAP = 200;
const COLUMNS = "kind, object_id, starred_at, opened_at";

let state: MarksState = EMPTY;
let inFlight: Promise<void> | null = null;
/** Counts every time the marks are thrown away; an older read must not write. */
let generation = 0;
let owner: string | null = null;
let watching = false;
const listeners = new Set<() => void>();

function set(next: MarksState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Forget the marks: on sign-out, so the next person never sees these. */
export function clearObjectMarks() {
  generation++;
  inFlight = null;
  owner = null;
  set(EMPTY);
}

function watchWhoIsSignedIn() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  supabase.auth.onAuthStateChange((event, session) => {
    const now = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || (owner !== null && now !== owner)) clearObjectMarks();
  });
}

async function load(): Promise<void> {
  watchWhoIsSignedIn();
  const reader = (await sessionUser())?.id ?? null;
  if (owner !== null && reader !== owner) {
    generation++;
    set(EMPTY);
  }
  owner = reader;
  const mine = generation;
  const write = (next: MarksState) => {
    if (mine === generation) set(next);
  };
  if (reader === null) {
    write({ ...EMPTY, loaded: true });
    return;
  }
  write({ ...state, loading: true, error: null });
  try {
    const [starred, opened] = await Promise.all([
      supabase
        .from("object_marks")
        .select(COLUMNS)
        .eq("user_id", reader)
        .not("starred_at", "is", null)
        .order("starred_at", { ascending: false })
        .limit(STARRED_CAP),
      supabase
        .from("object_marks")
        .select(COLUMNS)
        .eq("user_id", reader)
        .not("opened_at", "is", null)
        .order("opened_at", { ascending: false })
        .limit(OPENED_CAP),
    ]);
    const failed = starred.error ?? opened.error;
    if (failed) {
      if (marksTableMissing(failed)) {
        write({ ...EMPTY, loaded: true, unavailable: true });
        return;
      }
      write({ ...state, loading: false, loaded: true, error: failed.message });
      return;
    }
    // A change made while the read was in the air is newer than the read.
    const read = marksFromRows([...(starred.data ?? []), ...(opened.data ?? [])]);
    for (const [key, m] of pendingWrites) read.set(key, m);
    write({ marks: read, loaded: true, loading: false, unavailable: false, error: null });
  } catch (e) {
    write({
      ...state,
      loading: false,
      loaded: true,
      error: (e instanceof Error && e.message) || "Favourites could not be read",
    });
  }
}

/** Changes shown but not yet confirmed written, so a read cannot undo them. */
const pendingWrites = new Map<string, ObjectMark>();

export function ensureObjectMarks(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && state.loaded) return Promise.resolve();
  const started: Promise<void> = load().finally(() => {
    if (inFlight === started) inFlight = null;
  });
  inFlight = started;
  return started;
}

export function readObjectMarks(): MarksState {
  return state;
}

/** Put a star on, or take it off. Shown at once; put back if it cannot be saved. */
export async function setStar(kind: ObjectKindId, id: string, starred: boolean): Promise<void> {
  await ensureObjectMarks();
  if (state.unavailable || !owner) return;
  const reader = owner;
  const mine = generation;
  const key = markKey(kind, id);
  const before = state.marks;
  const now = new Date().toISOString();
  const next = withStar(before, kind, id, starred, now);
  const mark = next.get(key) ?? { kind, id, starredAt: null, openedAt: null };
  pendingWrites.set(key, mark);
  set({ ...state, marks: next });
  const { error } = starred
    ? await supabase
        .from("object_marks")
        .upsert(
          { user_id: reader, kind, object_id: id, starred_at: mark.starredAt },
          { onConflict: "user_id,kind,object_id" },
        )
    : await supabase
        .from("object_marks")
        .update({ starred_at: null })
        .eq("user_id", reader)
        .eq("kind", kind)
        .eq("object_id", id);
  if (pendingWrites.get(key) === mark) pendingWrites.delete(key);
  if (!error || mine !== generation) return;
  // Put back only this object's mark: another star may have changed meanwhile.
  const restored = new Map(state.marks);
  const was = before.get(key);
  if (was) restored.set(key, was);
  else restored.delete(key);
  set({ ...state, marks: restored });
  toast.error(
    starred
      ? `Could not add it to your favourites: ${error.message}`
      : `Could not take it out of your favourites: ${error.message}`,
  );
}

/** Note that something was opened. Quiet: a failure here is nobody's problem. */
export async function recordOpened(kind: ObjectKindId, id: string): Promise<void> {
  await ensureObjectMarks();
  if (state.unavailable || !owner) return;
  if (!worthRecording(state.marks, kind, id, Date.now())) return;
  const reader = owner;
  const now = new Date().toISOString();
  const key = markKey(kind, id);
  const next = withOpened(state.marks, kind, id, now);
  const mark = next.get(key)!;
  pendingWrites.set(key, mark);
  set({ ...state, marks: next });
  await supabase
    .from("object_marks")
    .upsert(
      { user_id: reader, kind, object_id: id, opened_at: now },
      { onConflict: "user_id,kind,object_id" },
    )
    .then(
      () => undefined,
      () => undefined,
    );
  if (pendingWrites.get(key) === mark) pendingWrites.delete(key);
}

/** Forget everything that was opened. Favourites stay. */
export async function clearOpened(): Promise<boolean> {
  await ensureObjectMarks();
  if (state.unavailable || !owner) return false;
  const reader = owner;
  const mine = generation;
  const before = state.marks;
  set({ ...state, marks: withoutOpened(before) });
  const gone = await supabase
    .from("object_marks")
    .delete()
    .eq("user_id", reader)
    .is("starred_at", null);
  const kept = gone.error
    ? gone
    : await supabase
        .from("object_marks")
        .update({ opened_at: null })
        .eq("user_id", reader)
        .not("starred_at", "is", null);
  const error = gone.error ?? kept.error;
  if (!error) return true;
  if (mine === generation) {
    set({ ...state, marks: before });
    toast.error(`Could not clear what you opened: ${error.message}`);
  }
  return false;
}

/** The marks, read when first asked for. */
export function useObjectMarks(active = true) {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
  const unread = !snapshot.loaded && !snapshot.loading;
  useEffect(() => {
    if (active) void ensureObjectMarks();
  }, [active, unread]);
  const isStarred = useCallback(
    (kind: ObjectKindId, id: string) => Boolean(snapshot.marks.get(markKey(kind, id))?.starredAt),
    [snapshot.marks],
  );
  return { ...snapshot, isStarred };
}

/**
 * Notes that the object with this id is open, once per opening. Pass nothing
 * while nothing is open.
 */
export function useRecordOpened(kind: ObjectKindId, id: string | null | undefined) {
  useEffect(() => {
    if (id) void recordOpened(kind, id);
  }, [kind, id]);
}
