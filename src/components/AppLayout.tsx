import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ApprovalInbox } from "@/components/ApprovalInbox";
import { NotificationCenter } from "@/components/NotificationCenter";
import { UserMenu } from "@/components/UserMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { OnboardingDialog } from "@/components/OnboardingDialog";
import { MobileLabNotice } from "@/components/MobileLabNotice";
import { GlobalCreateMenu } from "@/components/GlobalCreateMenu";
import { Link, Outlet } from "@tanstack/react-router";
import { GraduationCap } from "lucide-react";

export function AppLayout() {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <header className="flex h-12 items-center justify-between border-b border-border px-4">
            <SidebarTrigger />
            <div className="flex items-center gap-2">
              <GlobalCreateMenu />
              <Link
                to="/learn"
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/50 hover:bg-card hover:text-primary"
                aria-label="Open full curriculum and tutorials"
              >
                <GraduationCap className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Curriculum & Tutorials</span>
                <span className="sm:hidden">Learn</span>
              </Link>
              <ThemeToggle />
              <ApprovalInbox />
              <NotificationCenter />
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
