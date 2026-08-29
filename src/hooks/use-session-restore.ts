// Route-level session restoration: if a tab gets closed/crashed while the
// user was deep in some page (Swarm Canvas, Agent Chat, a notebook...), the
// next time the app loads we offer to jump straight back to it instead of
// silently landing on the dashboard.
//
// Scope, deliberately: this tracks *which page the user was on*, not a full
// serialization of that page's internal state (canvas nodes, chat drafts,
// etc). Restoring means "take me back to that URL" — every page here already
// owns its own persistence for anything more specific (e.g. the Swarm Canvas
// autosaves to Supabase; AgentForm has its own sessionStorage draft). This
// hook is the thing that gets the user back to the right page to find it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { NAV_GROUPS } from "@/lib/appNav";

const SESSION_STORAGE_KEY = "agentswarms:lastSession";
// Bump this whenever the payload shape changes. A stored payload with a
// stale version is treated exactly like a corrupted one — discarded
// wholesale, never partially trusted (see readStoredSession).
const SESSION_SCHEMA_VERSION = 1;
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
const AUTOSAVE_DEBOUNCE_MS = 800;

// Never worth restoring to. This hook is mounted inside the authenticated
// app shell (see AppLayout.tsx) so in practice `href` is always one of
// these anyway — this is a second, cheap line of defense against ever
// recommending a login/redirect loop if that ever changes.
const EXCLUDED_PATH_PREFIXES = ["/login", "/docs", "/about", "/contact", "/privacy", "/terms"];

type SessionPayload = {
  version: number;
  href: string;
  savedAt: number;
};

export type OrphanedSession = {
  href: string;
  /** Human-readable page name for the banner, e.g. "Agent Swarms". */
  label: string;
  savedAt: number;
};

function isExcluded(href: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some(
    (p) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`),
  );
}

// Looks the saved path up in the same nav map the sidebar and command
// palette use, so this never has its own, second opinion about what a page
// is called.
function labelFor(href: string): string {
  const pathname = href.split("?")[0].split("#")[0];
  for (const group of NAV_GROUPS) {
    const match = group.items.find(
      (item) => pathname === item.url || pathname.startsWith(`${item.url}/`),
    );
    if (match) return match.title;
  }
  return pathname;
}

/**
 * Reads, validates, and — if invalid for any reason — purges the stored
 * session. Every failure mode (corrupted JSON, wrong schema version,
 * expired, storage disabled) collapses to the same "nothing to restore"
 * result rather than trying to partially recover a payload that might not
 * mean what its shape suggests.
 */
function readStoredSession(): SessionPayload | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null; // storage disabled (private mode, policy) — nothing to do
  }
  if (!raw) return null;

  let parsed: Partial<SessionPayload>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted value — clear it so it doesn't keep failing to parse on
    // every future load.
    purgeStoredSession();
    return null;
  }

  const isWellFormed =
    parsed.version === SESSION_SCHEMA_VERSION &&
    typeof parsed.href === "string" &&
    typeof parsed.savedAt === "number";
  if (!isWellFormed) {
    // Either a genuinely malformed object, or a payload written by an
    // older/newer app version whose shape this version doesn't promise to
    // understand. Same handling either way: discard, don't guess.
    purgeStoredSession();
    return null;
  }

  const session = parsed as SessionPayload;
  if (Date.now() - session.savedAt > SESSION_EXPIRY_MS) {
    purgeStoredSession();
    return null;
  }
  return session;
}

function writeStoredSession(href: string) {
  try {
    const payload: SessionPayload = { version: SESSION_SCHEMA_VERSION, href, savedAt: Date.now() };
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full/disabled — autosave silently no-ops, same as every other
    // localStorage write in this app.
  }
}

function purgeStoredSession() {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore — there's nothing left to clean up either way.
  }
}

export function useSessionRestore() {
  const location = useLocation();
  const [orphaned, setOrphaned] = useState<OrphanedSession | null>(null);
  // Flips true after the one-time "is there a leftover session" check.
  // Belt-and-braces guard on the autosave effect below so a stored session
  // can never be overwritten before it's had a chance to be read — see that
  // effect's comment for why the debounce alone already makes this safe in
  // practice.
  const hasCheckedRef = useRef(false);

  // One-time detection, on mount. Deliberately an effect and not something
  // read during the initial render: this app is server-rendered, and the
  // server has no `window` — reading localStorage synchronously during
  // render would make the first client render (which might find a session)
  // disagree with the no-`window` server render, which React reports as a
  // hydration error. Same pattern as the sidebar's width/collapsed-state
  // restore and the schema-health dismissal flag elsewhere in this app.
  useEffect(() => {
    const stored = readStoredSession();
    if (stored && stored.href !== location.href && !isExcluded(stored.href)) {
      setOrphaned({ href: stored.href, label: labelFor(stored.href), savedAt: stored.savedAt });
    }
    hasCheckedRef.current = true;
    // Intentionally runs only once. `location.href` is read for the initial
    // "don't restore to where I already am" comparison, not tracked — the
    // effect below owns responding to navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave: records the current page so the *next* app load has
  // something fresh to offer. Paused while `orphaned` is set — until the
  // user restores or dismisses, a reload mid-decision must not silently
  // overwrite the very session being offered back to them.
  useEffect(() => {
    if (!hasCheckedRef.current || orphaned) return;
    if (isExcluded(location.href)) return;

    const timer = window.setTimeout(() => writeStoredSession(location.href), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [location.href, orphaned]);

  const restore = useCallback(() => {
    if (!orphaned) return;
    // A hard navigation, not the router's client-side `navigate()`: the
    // restored href is an arbitrary runtime string — whatever page the user
    // happened to be on — not one of the router's statically-typed route
    // literals, and a full reload is a trivial cost for a once-per-crash
    // recovery action.
    window.location.href = orphaned.href;
  }, [orphaned]);

  const startFresh = useCallback(() => {
    purgeStoredSession();
    setOrphaned(null);
  }, []);

  return { orphanedSession: orphaned, restore, startFresh };
}
