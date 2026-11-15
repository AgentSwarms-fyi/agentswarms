// The secrets the signed-in user may use, by name: one listing shared by
// every secret picker on the page (R493).
//
// A connection form can hold several key fields, and a swarm inspector one per
// header row; each asking the server for the same list would be a request per
// field, and a secret created from one field would not appear in the next. So
// the listing lives here, module-wide, like the approver directory. A picker
// re-reads it when it opens (a secret made on /secrets meanwhile shows up), and
// a secret created inline re-reads it for every field at once.
//
// Never values: listSecrets selects names, descriptions, owners and allowed
// hosts, and nothing a picker renders can be a secret's value.
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { listSecrets, type SecretSummary } from "@/utils/secrets.functions";

export type SecretList = {
  /** True once a listing has answered (with secrets or an error). */
  loaded: boolean;
  secrets: SecretSummary[];
  /** The caller's user id, as the listing saw it: owned secrets carry it. */
  me: string | null;
  /** Why the last listing failed, or null. */
  error: string | null;
};

const INITIAL: SecretList = { loaded: false, secrets: [], me: null, error: null };

let state: SecretList = INITIAL;
/** Bumped by every listing; only the latest one's answer is kept. */
let generation = 0;
let inflight: Promise<void> | null = null;
let watchingAuth = false;
const listeners = new Set<() => void>();

function publish(next: SecretList) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => state;

/**
 * Read the listing again. Every call starts a new read, so the one made right
 * after a secret is created is sure to include it.
 */
export function refreshSecretList(): Promise<void> {
  const mine = ++generation;
  const run = (async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      if (mine === generation) publish({ ...INITIAL, loaded: true, error: "You are signed out." });
      return;
    }
    try {
      const res = await listSecrets({ data: { access_token: token } });
      if (mine !== generation) return;
      publish(
        res.ok
          ? { loaded: true, secrets: res.secrets, me: res.me, error: null }
          : { ...state, loaded: true, error: res.error },
      );
    } catch (e) {
      if (mine !== generation) return;
      publish({
        ...state,
        loaded: true,
        error: e instanceof Error ? e.message : "Could not reach the server",
      });
    }
  })();
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}

/** Another account signing in must never see the last one's names. */
function watchAuth() {
  if (watchingAuth) return;
  watchingAuth = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    const id = session?.user?.id ?? null;
    if (state.me !== null && id !== state.me) {
      generation++;
      publish(INITIAL);
      if (id && listeners.size > 0) void refreshSecretList();
    }
  });
}

/** The shared listing, read once per page and re-read on request. */
export function useSecretList(): SecretList & { reload: () => Promise<void> } {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    watchAuth();
    if (!state.loaded && !inflight) void refreshSecretList();
  }, []);
  return { ...list, reload: refreshSecretList };
}
