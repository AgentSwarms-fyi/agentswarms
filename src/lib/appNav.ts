// The app's navigation map — single source of truth shared by the sidebar,
// the command palette and the session-restore labels, so a new page added
// here appears in all of them.
//
// GROUP LABELS ARE A PUBLIC NAME. The docs write nav paths as
// "Observability → AI Budgets", and scripts/check-docs.mjs checks those
// claims against this map, so a group renamed here renames a sentence in
// every page that cites it.
//
// ORDER WITHIN A GROUP IS THE ORDER OF THE WORK, not the alphabet and not the
// order pages were built. Data & BI reads as the journey one table takes:
// find it, move it, store it, shape it, define what it means, then ask it
// questions. Someone who scans the rail top to bottom should be reading a
// pipeline, because that is how they will actually use it.
import {
  Activity,
  BarChart3,
  Blocks,
  BookMarked,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  Code2,
  Columns,
  Database,
  FileClock,
  FlaskConical,
  HeartPulse,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  MessageSquare,
  Network,
  NotebookPen,
  PieChart,
  Plug,
  Puzzle,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Sigma,
  type LucideIcon,
  Wand2,
  Warehouse,
  Waypoints,
  Wrench,
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
    // In the order data moves through the platform. The four pages that
    // produce or shape tables come first, then the two that say what those
    // tables MEAN, then the three that consume them.
    items: [
      // 1. Find it.
      { title: "Data Catalog", url: "/data-sql", icon: Database },
      // 2. Move it.
      { title: "ETL Pipelines", url: "/etl", icon: Waypoints },
      // 3. Store it.
      { title: "Lakehouse", url: "/lakehouse", icon: Warehouse },
      // 4. Shape it. Directly after the Lakehouse because a model IS a
      // lakehouse table, and directly before the Semantic Layer because
      // defining metrics on what a model built is the next thing you do.
      { title: "SQL Models", url: "/sql-models", icon: Blocks },
      // 5. Define what it means.
      { title: "Semantic Layer", url: "/semantics", icon: Layers },
      // 6. Browse those definitions: authors go to Semantic Layer, everyone
      // else comes here to find a metric to use.
      { title: "Metrics", url: "/metrics", icon: Sigma },
      // 7-9. Consume it.
      { title: "AI Analyst", url: "/ai-analyst", icon: BrainCircuit },
      { title: "BI Workspace", url: "/bi", icon: PieChart },
      { title: "ML Models", url: "/ml", icon: Brain },
      // 10. Watch it, once it is all running.
      { title: "Data monitors", url: "/data-monitors", icon: HeartPulse },
      // 11. The escape hatch, last, for when none of the above fits.
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
    // What you connect, then what those connections need, then what you ship
    // outward. Web Embedding is last because it is the only one that points
    // away from the platform rather than into it.
    items: [
      { title: "Integrations", url: "/integrations", icon: Puzzle },
      { title: "MCP Servers", url: "/mcp", icon: Plug },
      { title: "Model Registry", url: "/model-registry", icon: Boxes },
      // Underneath all three above: every one of them stores a credential.
      { title: "Secrets", url: "/secrets", icon: KeyRound },
      { title: "Web Embedding", url: "/embeds", icon: Code2 },
    ],
  },
  {
    label: "Observability",
    // Widening out: one run, then all runs, then the money, then the record,
    // then the machine. Analytics leads because it is the summary everyone
    // opens first and the place the other pages are reached from.
    items: [
      { title: "Analytics", url: "/analytics", icon: BarChart3 },
      // The two trace pages are adjacent on purpose: same question, one for
      // a single turn and one for a swarm.
      { title: "Traces & Logs", url: "/traces", icon: ScrollText },
      { title: "Swarm Traces", url: "/analytics/observability", icon: Network },
      { title: "AI Budgets", url: "/budgets", icon: Settings },
      { title: "Audit Log", url: "/audit", icon: FileClock },
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
