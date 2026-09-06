import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ApprovalInbox } from "@/components/ApprovalInbox";
import { NotificationBell } from "@/components/NotificationBell";
import { UserMenu } from "@/components/UserMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { OnboardingDialog } from "@/components/OnboardingDialog";
import { MobileLabNotice } from "@/components/MobileLabNotice";
import { GlobalCreateMenu } from "@/components/GlobalCreateMenu";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { Search } from "lucide-react";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useSessionRestore } from "@/hooks/use-session-restore";
import { SessionRestoreBanner } from "@/components/SessionRestoreBanner";

export function AppLayout() {
  // Route-change motion is the router's defaultViewTransition (see
  // router.tsx) — a browser-level cross-fade with no blank frame. The keyed
  // CSS enter-animation that used to live here flashed and jumped.
  const palette = useCommandPalette();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
  const { orphanedSession, restore, startFresh } = useSessionRestore();

  /**
   * How much chrome sits above the routed page: the header, plus the
   * session-restore banner when it is up.
   *
   * Published as `--app-chrome-h` so a full-height route can say
   * `calc(100dvh - var(--app-chrome-h))` and be right in both states. Canvas
   * routes used to hard-code 3rem, the header alone — correct until the
   * banner appears, and then off by exactly its height, which pushes the
   * bottom row of the page under the fold. A chat composer nobody could reach
   * without scrolling is what found this.
   *
   * Measured from where <main> actually starts rather than from a constant,
   * so nothing has to be kept in sync with the header's styling.
   */
  const colRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const [chromeH, setChromeH] = useState("3rem");
  useEffect(() => {
    const col = colRef.current;
    const main = mainRef.current;
    if (!col || !main || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const gap = main.getBoundingClientRect().top - col.getBoundingClientRect().top;
      if (gap >= 0) setChromeH(`${Math.round(gap)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(col);
    ro.observe(main);
    return () => ro.disconnect();
  }, [orphanedSession]);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div
          ref={colRef}
          className="flex flex-1 flex-col min-w-0"
          style={{ "--app-chrome-h": chromeH } as React.CSSProperties}
        >
          {orphanedSession && (
            <SessionRestoreBanner
              session={orphanedSession}
              onRestore={restore}
              onStartFresh={startFresh}
            />
          )}
          {/* Sticky: on window-scrolling pages (dashboard, lists) the create/
              approvals/alerts controls otherwise leave the screen one scroll
              in. Canvas-style routes pin their own height and never scroll
              the window, so this changes nothing for them. */}
          <header
            data-app-header
            className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-header-border bg-header px-4 text-header-foreground backdrop-blur-md"
          >
            <SidebarTrigger />
            <div className="flex items-center gap-2">
              {/* Search-field-shaped trigger: the affordance teaches the
                  shortcut, and the shortcut makes the affordance optional. */}
              <button
                type="button"
                onClick={() => palette.setOpen(true)}
                className="hidden h-8 items-center gap-2 rounded-md border border-border/60 bg-card/60 px-3 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground sm:inline-flex"
              >
                <Search className="h-3.5 w-3.5" />
                Search
                <kbd className="rounded border border-border/60 bg-muted px-1 font-mono text-[10px]">
                  {isMac ? "⌘" : "Ctrl"} K
                </kbd>
              </button>
              <GlobalCreateMenu />
              <ThemeToggle />
              <ApprovalInbox />
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          <main ref={mainRef} className="flex-1 min-w-0 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
      <OnboardingDialog />
      <MobileLabNotice />
    </SidebarProvider>
  );
}
