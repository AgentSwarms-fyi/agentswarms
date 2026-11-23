// How many What's new entries this browser has not seen (R529).
//
// Kept in the browser, not the account: it only decides whether Learn shows a
// dot. Losing it (a private window, cleared storage) shows the dot again,
// which costs one look at Learn.
import { useEffect, useState } from "react";

import { unseenCount, WHATS_NEW, WHATS_NEW_SEEN_KEY } from "@/lib/whatsNew";

const SEEN_EVENT = "agentswarms:whats-new-seen";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return null;
  }
}

/** Entries not seen in this browser. 0 until the browser has been asked. */
export function useWhatsNewUnseen(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => setCount(unseenCount(WHATS_NEW, readSeen()));
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === WHATS_NEW_SEEN_KEY) read();
    };
    window.addEventListener(SEEN_EVENT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SEEN_EVENT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return count;
}

/**
 * Mark every entry seen, and say how many were new before this look, so the
 * page can still label them on this visit.
 */
export function markWhatsNewSeen(): number {
  const before = unseenCount(WHATS_NEW, readSeen());
  try {
    if (WHATS_NEW[0]) window.localStorage.setItem(WHATS_NEW_SEEN_KEY, WHATS_NEW[0].id);
  } catch {
    /* nothing to remember it in: the dot simply comes back */
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
  return before;
}
