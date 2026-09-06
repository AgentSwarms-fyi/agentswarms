// The app's navigation map — single source of truth shared by the sidebar,
// the command palette and the session-restore labels, so a new page added
// here appears in all of them.
//
// GROUP LABELS ARE A PUBLIC NAME. The docs write nav paths as
// "Observability → AI Budgets", and scripts/check-docs.mjs checks those
// claims against this map, so a group renamed here renames a sentence in
// every page that cites it. Order is free; names are not.
import {
  Warehouse,
  BrainCircuit,
  LayoutDashboard,
  Layers,
  Sigma,
  Puzzle,
  Bot,
  MessageSquare,
  BookOpen,
  Network,
  Plug,
  BarChart3,
  FileClock,
  ScrollText,
  Settings,
  Database,
  Boxes,
  KeyRound,
  BookMarked,
  Wand2,
  Image as ImageIcon,
  Columns,
  FlaskConical,
  Activity,
  NotebookPen,
  PieChart,
  Waypoints,
  Code2,
  LifeBuoy,
  Wrench,
  Server,
  ShieldCheck,
  type LucideIcon,
  Brain,
  HeartPulse,
} from "lucide-react";

export type NavItem = { title: string; url: string; icon: LucideIcon };
export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      // The handbook was reachable from the marketing site only, which is the
      // one place you are NOT standing when you get stuck using the product.
      { title: "Documentation", url: "/docs", icon: LifeBuoy },
    ],
  },
  {
    label: "Build",
    items: [
      { title: "Agent Builder", url: "/agents", icon: Bot },
      // Next to the builder because a knowledge base is something you attach
      // to an agent, not a place people go to analyse data.
      { title: "Knowledge Base", url: "/knowledge", icon: BookOpen },
      { title: "Agent Chat", url: "/playground", icon: MessageSquare },
      { title: "Agent Swarms", url: "/swarms", icon: Network },
      // Authoring MCP servers, as opposed to connecting to someone else's —
      // that stays under Integrations as "MCP Servers".
      { title: "MCP Builder", url: "/mcp-builder", icon: Wrench },
    ],
  },
  {
    label: "Data & BI",
    items: [
      { title: "AI Analyst", url: "/ai-analyst", icon: BrainCircuit },
      { title: "Data Catalog", url: "/data-sql", icon: Database },
      { title: "Semantic Layer", url: "/semantics", icon: Layers },
      // The catalog sits beside the layer that defines it: authors go to
      // Semantic Layer, everyone else comes here to find a metric to use.
      { title: "Metrics", url: "/metrics", icon: Sigma },
      { title: "BI Workspace", url: "/bi", icon: PieChart },
      { title: "ETL Pipelines", url: "/etl", icon: Waypoints },
      { title: "Lakehouse", url: "/lakehouse", icon: Warehouse },
      { title: "ML Models", url: "/ml", icon: Brain },
      { title: "Data monitors", url: "/data-monitors", icon: HeartPulse },
      { title: "Developer workspace", url: "/notebooks", icon: NotebookPen },
    ],
  },
  {
    label: "Library",
    items: [
      { title: "Prompt Library", url: "/prompts", icon: BookMarked },
      { title: "Skill Library", url: "/skills", icon: Wand2 },
    ],
  },
  // Beside the libraries: both are where an agent's raw material is written
  // and tried out, rather than where the product is operated.
  {
    label: "Experiment",
    items: [
      { title: "Prompt Compare", url: "/prompt-compare", icon: Columns },
      { title: "Evaluations", url: "/evaluations", icon: FlaskConical },
      { title: "Image Playground", url: "/image-playground", icon: ImageIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { title: "Integrations", url: "/integrations", icon: Puzzle },
      { title: "Web Embedding", url: "/embeds", icon: Code2 },
      { title: "Secrets", url: "/secrets", icon: KeyRound },
      { title: "MCP Servers", url: "/mcp", icon: Plug },
      { title: "Model Registry", url: "/model-registry", icon: Boxes },
    ],
  },
  {
    label: "Observability",
    items: [
      { title: "Analytics", url: "/analytics", icon: BarChart3 },
      { title: "Swarm Traces", url: "/analytics/observability", icon: Network },
      { title: "Traces & Logs", url: "/traces", icon: ScrollText },
      { title: "Audit Log", url: "/audit", icon: FileClock },
      { title: "AI Budgets", url: "/budgets", icon: Settings },
      // Superadmin-only page; the route itself enforces that, and the link
      // is harmless for everyone else (it explains the restriction).
      { title: "Monitoring", url: "/monitoring", icon: Activity },
    ],
  },
];

/**
 * Shown only to superadmins, by the sidebar and the palette alike — which is
 * why it lives here rather than being written out twice. The routes enforce
 * the restriction themselves; hiding the links is courtesy, not security.
 */
export const ADMIN_GROUP: NavGroup = {
  label: "Admin",
  items: [
    { title: "IAM", url: "/admin/iam", icon: ShieldCheck },
    { title: "Developer runtime", url: "/admin/runtime", icon: Server },
  ],
};

/**
 * The nav item a path is "in", by longest matching url: /ml/<id> belongs to
 * ML Models, and /analytics/observability to Swarm Traces rather than to
 * Analytics, which is a prefix of it. Exported because the sidebar's
 * highlight, the group that opens with it and the session-restore label all
 * have to answer this question the same way.
 */
export function navItemForPath(path: string, groups: NavGroup[] = NAV_GROUPS): NavItem | undefined {
  const pathname = path.split("?")[0].split("#")[0];
  let best: NavItem | undefined;
  for (const group of groups) {
    for (const item of group.items) {
      const hit = pathname === item.url || pathname.startsWith(`${item.url}/`);
      if (hit && (!best || item.url.length > best.url.length)) best = item;
    }
  }
  return best;
}
