import { LogOut, ShieldCheck, Server } from "lucide-react";

import { Link, useLocation } from "@tanstack/react-router";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import { NAV_GROUPS } from "@/lib/appNav";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";

// Nav data lives in @/lib/appNav so the command palette and this sidebar
// can never disagree about what pages exist.
const overviewItems = NAV_GROUPS.find((g) => g.label === "Overview")!.items;
const buildItems = NAV_GROUPS.find((g) => g.label === "Build")!.items;
const experimentItems = NAV_GROUPS.find((g) => g.label === "Experiment")!.items;
const dataItems = NAV_GROUPS.find((g) => g.label === "Data & BI")!.items;
const libraryItems = NAV_GROUPS.find((g) => g.label === "Library")!.items;
const opsItems = NAV_GROUPS.find((g) => g.label === "Observability")!.items;
const integrationItems = NAV_GROUPS.find((g) => g.label === "Integrations")!.items;

type NavItem = import("@/lib/appNav").NavItem;

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { signOut, user } = useAuth();
  const isSuperadmin = useIsSuperadmin();

  const isActive = (path: string) => location.pathname === path;

  const renderGroup = (label: string, items: NavItem[]) => (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                <Link to={item.url}>
                  <item.icon className="h-4 w-4" />
                  <span className="flex-1">{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="p-4 group-data-[collapsible=icon]:p-2">
        <Link to="/" className="flex items-center gap-2" title="Back to AgentSwarms home">
          <img
            src={agentSwarmsLogo}
            alt="AgentSwarms"
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-lg font-bold tracking-tight">AgentSwarms</span>
              <span className="text-[9px] uppercase leading-snug tracking-wider text-muted-foreground">
                Unified Agentic AI &amp; Business Intelligence
              </span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {renderGroup("Overview", overviewItems)}
        {renderGroup("Build", buildItems)}
        {renderGroup("Data & BI", dataItems)}
        {renderGroup("Library", libraryItems)}
        {renderGroup("Integrations", integrationItems)}
        {renderGroup("Observability", opsItems)}
        {renderGroup("Experiment", experimentItems)}
        {isSuperadmin &&
          renderGroup("Admin", [
            { title: "IAM", url: "/admin/iam", icon: ShieldCheck },
            { title: "Developer runtime", url: "/admin/runtime", icon: Server },
          ])}
      </SidebarContent>

      <SidebarFooter className="p-2">
        {!collapsed && user && (
          <div className="mb-2 truncate px-2 text-xs text-muted-foreground">{user.email}</div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && <span>Sign Out</span>}
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
