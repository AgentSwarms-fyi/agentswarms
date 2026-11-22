// The names search works over, loaded once and kept for a minute.
//
// The palette and the results page share one copy: opening the palette, typing
// and then pressing "see all results" must not read the index three times.
// Typing never waits on the network — the index is in memory and every
// keystroke ranks it locally. Only a kind too large for the index asks the
// server again, and that answer is merged in when it arrives.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { ObjectEntry, ObjectKindId } from "@/lib/objectKinds";
import { mergeEntries } from "@/lib/objectSearch";
import { sessionUser } from "@/lib/sessionUser";
import {
  objectIndex,
  objectIndexLakehouse,
  objectSearchMore,
} from "@/utils/objectSearch.functions";

export type ObjectIndexState = {
  entries: ObjectEntry[];
  capped: ObjectKindId[];
  failed: ObjectKindId[];
  /**
   * Kinds still being read with nothing of theirs listed yet. Until they
   * arrive, "nothing matches" is not something search can say about them.
   */
  pending: ObjectKindId[];
  /** Nothing has loaded yet. */
  loading: boolean;
  /** The whole index failed to load, with why. */
  error: string | null;
  loadedAt: number;
};

const EMPTY: ObjectIndexState = {
  entries: [],
  capped: [],
  failed: [],
  pending: [],
  loading: false,
  error: null,
  loadedAt: 0,
};

type MainAnswer = Awaited<ReturnType<typeof objectIndex>>;
type LakeAnswer = Awaited<ReturnType<typeof objectIndexLakehouse>>;

/** The one kind listed through its own engine, which can answer much later. */
const SLOW_KIND = "lakehouse_table" as const;

/** How long a loaded index is used before it is read again. */
export const INDEX_TTL_MS = 60_000;

let state: ObjectIndexState = EMPTY;
let inFlight: Promise<void> | null = null;
/**
 * Counts every time the index is thrown away. A read that started before the
 * last count belongs to whoever was signed in then, and must not write.
 */
let generation = 0;
const listeners = new Set<() => void>();

function set(next: ObjectIndexState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Forget the index — on sign-out, so the next person never sees these names. */
export function clearObjectIndex() {
  generation++;
  inFlight = null;
  owner = null;
  set(EMPTY);
}

/** Whose names these are. A different person signed in is a different index. */
let owner: string | null = null;
let watching = false;

/**
 * Drop the index the moment the signed-in person changes. It holds names only
 * one person may see, and it outlives the page that loaded it — a second
 * person signing in on the same tab within the minute would otherwise search
 * the first one's work.
 */
function watchWhoIsSignedIn() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  supabase.auth.onAuthStateChange((event, session) => {
    const now = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || (owner !== null && now !== owner)) clearObjectIndex();
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
  // Answers that arrive after a sign-out (or after someone else signed in)
  // carry the previous person's names: they are dropped, not written.
  const mine = generation;
  const write = (next: (now: ObjectIndexState) => ObjectIndexState) => {
    if (mine === generation) set(next(state));
  };
  const ofSlowKind = (e: ObjectEntry) => e.kind === SLOW_KIND;

  // Nobody is signed in (a sign-out just happened): there is nothing to read
  // and no call worth making. Saying so also ends the "not read yet" state.
  if (reader === null) {
    write(() => ({ ...EMPTY, error: "Sign in to search your work." }));
    return;
  }

  write((now) => ({
    ...now,
    loading: now.loadedAt === 0,
    // Only "still reading" while there is nothing of that kind to show: on a
    // refresh the tables read last time stay listed until the new list lands.
    pending: now.entries.some(ofSlowKind) ? [] : [SLOW_KIND],
    error: null,
  }));
  // The lakehouse is listed through its own engine and can take much longer
  // (tens of seconds on a cold start); it is asked for at the same time and
  // added whenever it answers.
  const lake = objectIndexLakehouse({})
    .then((r: LakeAnswer | undefined) => (r?.ok ? r.entries : null))
    .catch(() => null);
  try {
    // A server that is restarting can answer with nothing at all. That is
    // "could not load", said in words, not a missing field to trip over.
    const main: MainAnswer | undefined = await objectIndex({});
    if (!main?.ok) {
      const why = main?.error || "The server did not answer. Try again in a moment.";
      write((now) => ({ ...now, loading: false, pending: [], error: why }));
      return;
    }
    write((now) => ({
      entries: mergeEntries(main.entries, now.entries.filter(ofSlowKind)),
      capped: main.capped,
      failed: main.failed,
      pending: now.pending,
      loading: false,
      error: null,
      loadedAt: Date.now(),
    }));
    const tables = await lake;
    write((now) => {
      const rest = now.entries.filter((e) => !ofSlowKind(e));
      // A list that could not be read is said so, and the one from last time
      // goes with it: "not searched just now" above results would be untrue.
      if (tables === null) {
        return {
          ...now,
          entries: rest,
          pending: [],
          failed: [...new Set([...now.failed, SLOW_KIND])],
        };
      }
      return { ...now, entries: [...rest, ...tables], pending: [] };
    });
  } catch (e) {
    write((now) => ({
      ...now,
      loading: false,
      pending: [],
      // Never empty: a failure with no words would read as "nothing read yet".
      error: (e instanceof Error && e.message) || "Search could not load",
    }));
  }
}

/** The index as it is right now, without loading anything. */
export function readObjectIndex(): ObjectIndexState {
  return state;
}

/**
 * Nothing read, nothing being read and no failure to report: an index nobody
 * has asked for yet, or one thrown away when the signed-in person changed.
 * "Nothing matches" is not an answer it can give.
 */
export function indexUnread(s: ObjectIndexState): boolean {
  return s.loadedAt === 0 && !s.loading && !s.error;
}

/** Load the index unless a fresh one is already here. */
export function ensureObjectIndex(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && state.loadedAt && Date.now() - state.loadedAt < INDEX_TTL_MS) {
    return Promise.resolve();
  }
  // A read that was overtaken finishes later than the one that replaced it;
  // it must not clear the newer one's marker.
  const started: Promise<void> = load().finally(() => {
    if (inFlight === started) inFlight = null;
  });
  inFlight = started;
  // Said at once, before the read has awaited anything. Finding out who is
  // signed in can take a network round trip (an expired session is renewed
  // first), and "nothing matches" must not be the answer meanwhile.
  if (state.loadedAt === 0 && !state.loading) set({ ...state, loading: true, error: null });
  return started;
}

/**
 * The index, loaded when `active` first becomes true and refreshed when it is
 * older than a minute. Pass false to read whatever is already in memory.
 */
export function useObjectIndex(active: boolean): ObjectIndexState & { refresh: () => void } {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
  // `unread` turns true again when the index is thrown away (someone else
  // signed in) while this is on screen, which reads it for the new person.
  const unread = indexUnread(snapshot);
  useEffect(() => {
    if (active) void ensureObjectIndex();
  }, [active, unread]);
  const refresh = useCallback(() => void ensureObjectIndex(true), []);
  // The first frame comes before the effect above: an index about to be read
  // is "reading", not an empty one to search.
  return { ...snapshot, loading: snapshot.loading || (active && unread), refresh };
}

/**
 * Older names in kinds the index could not hold in full, for `query`. Empty
 * until the server answers; a newer query discards an older answer.
 */
export function useCappedMatches(query: string, capped: readonly ObjectKindId[]): ObjectEntry[] {
  const [extra, setExtra] = useState<ObjectEntry[]>([]);
  const latest = useRef(0);
  const key = capped.join(",");
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !key) {
      setExtra([]);
      return;
    }
    const run = ++latest.current;
    const timer = setTimeout(() => {
      objectSearchMore({ data: { q, kinds: key.split(",") } })
        .then((r) => {
          if (run === latest.current) setExtra(r.entries);
        })
        .catch(() => {
          if (run === latest.current) setExtra([]);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, key]);
  return extra;
}
