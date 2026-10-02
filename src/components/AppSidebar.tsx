// The app's left rail.
//
// THIRTY-FIVE PAGES DO NOT FIT ON A SCREEN. Rendered flat, the rail was a
// list you scrolled to navigate, which is the one thing a navigation rail
// must not be. Every group is a disclosure now: closed, the whole product is
// eight rows; open, it is the group you are working in. What is open is
// remembered per browser, and the group holding the page you are on opens
// itself, so the rail always shows where you are without being asked.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LogOut } from "lucide-react";

import { Link, useLocation } from "@tanstack/react-router";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
import { ADMIN_GROUP, NAV_GROUPS, navItemForPath, type NavGroup } from "@/lib/appNav";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";

/** Which groups the reader last had open. Per browser, not per account. */
const STORAGE_KEY = "agentswarms:nav-groups.v1";

/** Open on a first visit, whichever page you land on: the way back out. */
const DEFAULT_OPEN = new Set(["Overview"]);

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { signOut, user } = useAuth();
  const isSuperadmin = useIsSuperadmin();

  const groups = useMemo(
    () => (isSuperadmin ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS),
    [isSuperadmin],
  );

  // The page you are on, by longest matching url, so a detail route like
  // /ml/<id> still lights up ML Models and opens Data & BI with it.
  const activeUrl = useMemo(
    () => navItemForPath(location.pathname, groups)?.url,
    [location.pathname, groups],
  );
  const activeGroup = useMemo(
    () => groups.find((g) => g.items.some((i) => i.url === activeUrl))?.label,
    [groups, activeUrl],
  );

  // Only the reader's explicit choices live here; everything else falls back
  // to DEFAULT_OPEN, so a group added later arrives closed rather than
  // silently "remembered" as open by an older stored object.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);

  // Read after mount, never in a useState initialiser: the first paint has to
  // match the server's, and localStorage does not exist there.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const stored: unknown = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        // Anything already set in this session (the active group, below) was
        // chosen by where the reader is now and outranks the stored copy.
        setOpenGroups((prev) => ({ ...(stored as Record<string, boolean>), ...prev }));
      }
    } catch {
      // Private mode, cleared storage, a corrupt value: defaults are fine.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(openGroups));
    } catch {
      // Nothing to do: the rail still works, it just forgets.
    }
  }, [openGroups, hydrated]);

  // Navigating into a group opens it — otherwise the rail would hide the page
  // you just asked for. Written into state rather than forced at render time
  // so the chevron still works: collapse it and it stays collapsed until you
  // navigate into it again.
  useEffect(() => {
    if (!activeGroup) return;
    setOpenGroups((prev) => (prev[activeGroup] ? prev : { ...prev, [activeGroup]: true }));
  }, [activeGroup]);

  const isOpen = (label: string) => openGroups[label] ?? DEFAULT_OPEN.has(label);

  const renderGroup = (group: NavGroup) => {
    const open = isOpen(group.label);
    const holdsActive = group.label === activeGroup;
    return (
      <Collapsible
        key={group.label}
        open={open}
        onOpenChange={(next) => setOpenGroups((prev) => ({ ...prev, [group.label]: next }))}
      >
        <SidebarGroup className="py-1">
          <SidebarGroupLabel asChild>
            <CollapsibleTrigger
              className={cn(
                "w-full justify-between gap-2 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                holdsActive && !open && "text-sidebar-accent-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                    open && "rotate-90",
                  )}
                />
                <span className="truncate text-[11px] font-semibold uppercase tracking-wider">
                  {group.label}
                </span>
              </span>
              {/* Closed, the count says how much is folded away — and turns
                  primary when the page you are on is one of them. */}
              {!open && (
                <span
                  className={cn(
                    "shrink-0 text-[10px] tabular-nums",
                    holdsActive ? "text-primary" : "text-sidebar-foreground/40",
                  )}
                >
                  {group.items.length}
                </span>
              )}
            </CollapsibleTrigger>
          </SidebarGroupLabel>
          <CollapsibleContent className="nav-group-content overflow-hidden">
            <SidebarGroupContent className="pt-1">
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={item.url === activeUrl}
                      tooltip={item.title}
                    >
                      <Link to={item.url}>
                        <item.icon className="h-4 w-4" />
                        <span className="flex-1">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>
    );
  };

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-sidebar-border">
      <SidebarHeader className="shrink-0 border-b border-sidebar-border/60 p-4">
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
                Unified Agentic AI and Data Platform
              </span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-0 py-1">{groups.map(renderGroup)}</SidebarContent>

      <SidebarFooter className="shrink-0 border-t border-sidebar-border/60 p-2">
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
      <SidebarRail />
    </Sidebar>
  );
}
