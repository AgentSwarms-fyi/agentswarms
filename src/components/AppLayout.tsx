import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ApprovalInbox } from "@/components/ApprovalInbox";
import { NotificationBell } from "@/components/NotificationBell";
import { UserMenu } from "@/components/UserMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { OnboardingDialog } from "@/components/OnboardingDialog";
import { MobileLabNotice } from "@/components/MobileLabNotice";
import { GlobalCreateMenu } from "@/components/GlobalCreateMenu";
import { Outlet } from "@tanstack/react-router";

export function AppLayout() {
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
              <GlobalCreateMenu />
              <ThemeToggle />
              <ApprovalInbox />
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          <main className="flex-1 min-w-0 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
      <OnboardingDialog />
      <MobileLabNotice />
    </SidebarProvider>
  );
}
