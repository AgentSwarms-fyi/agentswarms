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
import { Outlet, useLocation } from "@tanstack/react-router";

export function AppLayout() {
  // Keying the routed content by pathname replays the entrance animation on
  // every navigation. Routes are distinct components anyway, so the remount
  // is the one that was already happening.
  const { pathname } = useLocation();
  const palette = useCommandPalette();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          {/* Sticky: on window-scrolling pages (dashboard, lists) the create/
              approvals/alerts controls otherwise leave the screen one scroll
              in. Canvas-style routes pin their own height and never scroll
              the window, so this changes nothing for them. */}
          <header className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md">
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
          <main className="flex-1 min-w-0 overflow-hidden">
            <div key={pathname} className="animate-page-in h-full min-w-0">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
      <OnboardingDialog />
      <MobileLabNotice />
    </SidebarProvider>
  );
}
