// The tutorial being followed, kept current while the person works (R529).
//
// It is read again when the page changes, when the window comes back into
// focus, when Learn starts or puts away a tutorial, and every half minute while
// the tab is visible: a step ticks a moment after the thing it asks for is
// made, wherever it was made. A hidden tab is not asked at all.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useAuth } from "@/hooks/use-auth";
import { TUTORIAL_CHANGED_EVENT } from "@/lib/tutorials";
import { tutorialGuideState, type GuideState } from "@/utils/tutorials.functions";

/** How often a visible tab looks again with nothing else to prompt it. */
const LOOK_EVERY_MS = 30_000;
/** A page change waits this long, so a burst of redirects is one read. */
const SETTLE_MS = 700;

export type ActiveTutorial = Extract<GuideState, { ready: true }>["active"];

export function useTutorialGuide() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const read = useServerFn(tutorialGuideState);
  const [active, setActive] = useState<ActiveTutorial>(null);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const userId = user?.id ?? null;

  const refresh = useCallback(async () => {
    if (!userId || busy.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    busy.current = true;
    setChecking(true);
    try {
      const state = await read({ data: {} });
      setActive(state.ready ? state.active : null);
    } catch {
      // The guide is help, not a page: a failed look keeps what it showed.
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [read, userId]);

  // A different person signed in on this tab sees their own tutorial, or none.
  useEffect(() => {
    setActive(null);
  }, [userId]);

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [pathname, refresh]);

  useEffect(() => {
    const now = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", now);
    window.addEventListener(TUTORIAL_CHANGED_EVENT, now);
    document.addEventListener("visibilitychange", onVisible);
    const every = window.setInterval(now, LOOK_EVERY_MS);
    return () => {
      window.removeEventListener("focus", now);
      window.removeEventListener(TUTORIAL_CHANGED_EVENT, now);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(every);
    };
  }, [refresh]);

  return { active, checking, refresh, setActive };
}
