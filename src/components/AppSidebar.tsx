import {
  LayoutDashboard,
  Layers,
  Puzzle,
  Bot,
  MessageSquare,
  BookOpen,
  LogOut,
  Zap,
  Network,
  Plug,
  BarChart3,
  FileClock,
  ScrollText,
  Settings,
  Database,
  ShieldCheck,
  Boxes,
  KeyRound,
  BookMarked,
  Wand2,
  Image as ImageIcon,
  Columns,
  NotebookPen,
  PieChart,
  Code2,
  Server,
  LifeBuoy,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { Link, useLocation } from "@tanstack/react-router";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";
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

// Grouped by what the user is trying to do, so the (long) nav stays scannable.
type NavItem = { title: string; url: string; icon: LucideIcon };

const overviewItems: NavItem[] = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  // The handbook was reachable from the marketing site only, which is the one
  // place you are NOT standing when you get stuck using the product.
  { title: "Documentation", url: "/docs", icon: LifeBuoy },
];

const buildItems: NavItem[] = [
  { title: "Agent Builder", url: "/agents", icon: Bot },
  { title: "Agent Chat", url: "/playground", icon: MessageSquare },
  { title: "Agent Swarms", url: "/swarms", icon: Network },
  // Authoring MCP servers, as opposed to connecting to someone else's — that
  // stays under Integrations as "MCP Servers".
  { title: "MCP Builder", url: "/mcp-builder", icon: Wrench },
];

const experimentItems: NavItem[] = [
  { title: "Prompt Compare", url: "/prompt-compare", icon: Columns },
  { title: "Image Playground", url: "/image-playground", icon: ImageIcon },
];

const dataItems: NavItem[] = [
  { title: "Data Catalog", url: "/data-sql", icon: Database },
  { title: "Knowledge Base", url: "/knowledge", icon: BookOpen },
  { title: "Semantic Layer", url: "/semantics", icon: Layers },
  { title: "BI Workspace", url: "/bi", icon: PieChart },
  { title: "Developer workspace", url: "/notebooks", icon: NotebookPen },
];

const libraryItems: NavItem[] = [
  { title: "Prompt Library", url: "/prompts", icon: BookMarked },
  { title: "Skill Library", url: "/skills", icon: Wand2 },
];

const opsItems: NavItem[] = [
  { title: "Analytics", url: "/analytics", icon: BarChart3 },
  { title: "Swarm Traces", url: "/analytics/observability", icon: Network },
  { title: "Traces & Logs", url: "/traces", icon: ScrollText },
  { title: "Audit Log", url: "/audit", icon: FileClock },
  { title: "Budgets", url: "/budgets", icon: Settings },
];

const integrationItems: NavItem[] = [
  { title: "Integrations", url: "/integrations", icon: Puzzle },
  { title: "Web Embedding", url: "/embeds", icon: Code2 },
  { title: "Secrets", url: "/secrets", icon: KeyRound },
  { title: "MCP Servers", url: "/mcp", icon: Plug },
  { title: "Model Registry", url: "/model-registry", icon: Boxes },
];

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
                  {item.title === "Developer workspace" && !collapsed && (
                    <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                      New
                    </span>
                  )}
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
      <SidebarHeader className="p-4">
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
