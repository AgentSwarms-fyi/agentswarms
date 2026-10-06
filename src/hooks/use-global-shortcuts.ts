// Global keyboard shortcuts: "?" for help, Ctrl/⌘+, for Settings, and
// Gmail/Linear/GitHub-style "G then <letter>" navigation. Ctrl/⌘+K (command
// palette) and Ctrl/⌘+B / Ctrl/⌘+\ (sidebar) already have their own listeners
// (useCommandPalette, SidebarProvider) — this hook only owns the ones that
// don't yet exist anywhere, plus the shortcuts-help dialog's open state.
//
// Every entry here is mirrored in src/lib/shortcuts.ts, which is what the
// help dialog actually renders — that's the single source of truth for what
// a shortcut is CALLED; this file is only responsible for making it work.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { GO_TO_SHORTCUTS, firstVisitShowsShortcuts } from "@/lib/shortcuts";

// How long a bare "g" stays "waiting for the next letter" before it's just a
// stray keystroke again. Long enough to not feel rushed, short enough that
// "g" typed into a search field a moment later can't misfire as a nav intent.
const SEQUENCE_WINDOW_MS = 900;

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return (
    !!node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable)
  );
}

export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingGoToRef = useRef<number | null>(null); // timestamp of the last bare "g", or null

  // Shown by itself once, on the first visit (firstVisitShowsShortcuts);
  // after that only on "?". A mount effect, not a render-time read: this app
  // is server-rendered and the server has no localStorage, so reading it
  // synchronously would make the first client render disagree with the
  // server's — the same hydration-mismatch reasoning behind every other
  // localStorage-gated dialog in this app (SessionRestoreBanner,
  // SchemaHealthGuard).
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    if (firstVisitShowsShortcuts(storage)) setHelpOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl/⌘+, → Settings. A deliberate modifier combo — fires even from
      // inside a text field, matching the "Cmd+," preferences convention
      // most desktop apps and OSes already share.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === ",") {
        e.preventDefault();
        pendingGoToRef.current = null;
        void navigate({ to: "/settings" });
        return;
      }

      // Everything else here is a bare letter/character shortcut — never
      // fire those while the user is typing, or alongside a modifier that
      // isn't ours to interpret.
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        pendingGoToRef.current = null;
        setHelpOpen(true);
        return;
      }

      const now = Date.now();
      const key = e.key.toLowerCase();

      if (pendingGoToRef.current !== null && now - pendingGoToRef.current < SEQUENCE_WINDOW_MS) {
        const dest = GO_TO_SHORTCUTS.find((g) => g.key === key);
        pendingGoToRef.current = null;
        if (dest) {
          e.preventDefault();
          void navigate({ to: dest.url });
        }
        return;
      }

      if (key === "g") {
        pendingGoToRef.current = now;
      } else {
        pendingGoToRef.current = null;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return { helpOpen, setHelpOpen };
}
