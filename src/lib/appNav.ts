// The app's navigation map — single source of truth shared by the sidebar,
// the command palette and the session-restore labels, so a new page added
// here appears in all of them.
//
// GROUP LABELS ARE A PUBLIC NAME. The docs write nav paths as
// "Observability → AI Budgets", and scripts/check-docs.mjs checks those
// claims against this map, so a group renamed here renames a sentence in
// every page that cites it.
//
// A GROUP IS A JOB. Each one answers "I am here to…": build an agent, get
// data in and shaped, work out what it says, train a model, connect something,
// see what ran. A group that grows past eight pages has stopped being one job
// and is split (Data & BI was fourteen: three jobs in one list), which a test
// holds to.
//
// ORDER WITHIN A GROUP IS THE ORDER OF THE WORK, not the alphabet and not the
// order pages were built. Data engineering reads as the journey one table
// takes: find it, move it, store it, shape it, run it on a clock, watch it.
// Analysis picks the table up there: say what it means, then ask it questions.
// Someone who scans a group top to bottom should be reading a pipeline,
// because that is how they will actually use it.
//
// A GROUP'S NAME IS NOT ANOTHER MENU'S NAME. The first data group is "Data
// engineering" and not "Data" because the Sheets editor has a Data menu, and
// "Data → Sort A to Z" was already written in the documents: one name for two
// things leaves the reader, and the docs checker, guessing which was meant.
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
  FileSpreadsheet,
  FlaskConical,
  GraduationCap,
  HeartPulse,
  History,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
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
  Shapes,
  ShieldCheck,
  Sigma,
  Star,
  Timer,
  Trash2,
  type LucideIcon,
  Wand2,
  Warehouse,
  Waypoints,
  Workflow,
  Wrench,
} from "lucide-react";

export type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  /**
   * What this page used to be called. Search still finds it by that, so a
   * rename does not strand the people who learned the old word.
   */
  formerly?: string;
};
export type NavGroup = {
  label: string;
  /** The job this group is for, in a few words: shown when a group is pointed at. */
  hint: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    hint: "Where things stand, your work, and where to start",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      // Everything of yours across every page: what you opened last, what you
      // starred, and what other people shared with you.
      { title: "My work", url: "/my-work", icon: Star },
      // Everything that ran for you, every kind in one list: what needs a look.
      { title: "Runs", url: "/runs", icon: Timer },
      // What was deleted in the last thirty days, to restore or delete for good.
      { title: "Trash", url: "/trash", icon: Trash2 },
      // Tutorials done in the app on the sample data, and what is new: the
      // handbook explains a page, this walks through using several.
      { title: "Learn", url: "/learn", icon: GraduationCap },
      // Every ready-made starting point, of every kind, each opening on its
      // own page (R530).
      { title: "Templates", url: "/templates", icon: LayoutTemplate },
      // The handbook was reachable from the marketing site only, which is the
      // one place you are NOT standing when you get stuck using the product.
      { title: "Documentation", url: "/docs", icon: LifeBuoy },
    ],
  },
  {
    label: "Build",
    hint: "Make agents and what they work with",
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
  // The next two sit straight after Build because they are the same job seen
  // from the side: where an agent's raw material is written, then tried out.
  {
    label: "Library",
    hint: "Prompts and skills to reuse",
    items: [
      { title: "Prompt Library", url: "/prompts", icon: BookMarked },
      { title: "Skill Library", url: "/skills", icon: Wand2 },
    ],
  },
  {
    label: "Experiment",
    hint: "Try prompts and models, and score the answers",
    items: [
      { title: "Prompt Compare", url: "/prompt-compare", icon: Columns },
      { title: "Evaluations", url: "/evaluations", icon: FlaskConical },
      { title: "Image Playground", url: "/image-playground", icon: ImageIcon },
    ],
  },
  {
    label: "Data engineering",
    hint: "Bring data in, shape it, run it on a schedule, watch it",
    // In the order one table moves through the platform.
    items: [
      // 1. Find it.
      { title: "Data Catalog", url: "/data-sql", icon: Database },
      // 2. Move it.
      { title: "ETL Pipelines", url: "/etl", icon: Waypoints },
      // 3. Store it.
      { title: "Lakehouse", url: "/lakehouse", icon: Warehouse },
      // 4. Shape it. Directly after the Lakehouse because a model IS a
      // lakehouse table.
      { title: "SQL Models", url: "/sql-models", icon: Blocks },
      // 5. Run it all on one clock. After the things it orchestrates,
      // because a graph is what you draw once the pieces exist.
      { title: "Workflows", url: "/workflows", icon: Workflow },
      // 6. Watch it, once it is all running.
      { title: "Data monitors", url: "/data-monitors", icon: HeartPulse },
      // 7. See every query that ran, for whom and at what cost (R531).
      { title: "Query history", url: "/query-history", icon: History },
    ],
  },
  {
    label: "Analysis",
    hint: "Say what the data means, then ask it questions",
    // The two halves of one job: the three pages that say what the tables
    // MEAN, then the three that put questions to them.
    items: [
      // 1. Define what it means. First, because defining metrics on what a
      // model built is the next thing you do after building it.
      { title: "Semantic Layer", url: "/semantics", icon: Layers },
      // 2. Browse those definitions: authors go to Semantic Layer, everyone
      // else comes here to find a metric to use.
      { title: "Metrics", url: "/metrics", icon: Sigma },
      // 3. Model the business itself: the things the metrics are about, how
      // they connect, what must hold true and what may be changed. After the
      // metrics because an ontology hangs its metrics on its object types.
      { title: "Enterprise Ontology", url: "/ontology", icon: Shapes },
      // 4-6. Ask. Sheets first: the spreadsheet is where most people already
      // do analysis, now over the lakehouse's tables.
      { title: "Sheets", url: "/sheets", icon: FileSpreadsheet },
      { title: "AI Analyst", url: "/ai-analyst", icon: BrainCircuit },
      { title: "BI Workspace", url: "/bi", icon: PieChart },
    ],
  },
  {
    label: "Data science",
    hint: "Train models and write code against your data",
    items: [
      { title: "ML Models", url: "/ml", icon: Brain },
      // The escape hatch, last, for when no page above fits: notebooks.
      { title: "Developer workspace", url: "/notebooks", icon: NotebookPen },
    ],
  },
  {
    label: "Integrations",
    hint: "Connect models, tools and other systems",
    // What you connect, then what those connections need, then what you ship
    // outward. Web Embedding is last because it is the only one that points
    // away from the platform rather than into it.
    items: [
      { title: "Integrations", url: "/integrations", icon: Puzzle },
      { title: "MCP Servers", url: "/mcp", icon: Plug },
      // The models other people host, to pick from. Named for what it holds
      // so nobody opens it looking for the models they trained (ML Models).
      {
        title: "AI Model Catalog",
        url: "/model-registry",
        icon: Boxes,
        formerly: "Model Registry",
      },
      // Underneath all three above: every one of them stores a credential.
      { title: "Secrets", url: "/secrets", icon: KeyRound },
      { title: "Web Embedding", url: "/embeds", icon: Code2 },
    ],
  },
  {
    label: "Observability",
    hint: "See what ran, what it cost and who did what",
    // Widening out: one run, then all runs, then the money, then the record.
    // Analytics leads because it is the summary everyone opens first and the
    // place the other pages are reached from.
    items: [
      { title: "Analytics", url: "/analytics", icon: BarChart3 },
      // The two trace pages are adjacent on purpose: same question, one for
      // a single turn and one for a swarm.
      { title: "Traces & Logs", url: "/traces", icon: ScrollText },
      { title: "Swarm Traces", url: "/analytics/observability", icon: Network },
      { title: "AI Budgets", url: "/budgets", icon: Settings },
      { title: "Audit Log", url: "/audit", icon: FileClock },
    ],
  },
];

/**
 * Shown only to superadmins, by the sidebar and the palette alike — which is
 * why it lives here rather than being written out twice. The routes enforce
 * the restriction themselves; hiding the links is courtesy, not security.
 *
 * Every page only a superadmin can use is here and nowhere else: a link in
 * another group that most people can open only to be told "not for you" is a
 * row of the rail spent on a refusal.
 */
export const ADMIN_GROUP: NavGroup = {
  label: "Admin",
  hint: "People, access and the machines this runs on",
  items: [
    { title: "IAM", url: "/admin/iam", icon: ShieldCheck },
    // The machine, after the people: which services are up, which release.
    { title: "Monitoring", url: "/monitoring", icon: Activity },
    { title: "Developer runtime", url: "/admin/runtime", icon: Server },
  ],
};

/**
 * Every group, the superadmin's included. For questions about a page somebody
 * is already on or has been on — what is it called, which group is it in —
 * where leaving Admin out would only make the answer "unknown".
 */
export const ALL_NAV_GROUPS: NavGroup[] = [...NAV_GROUPS, ADMIN_GROUP];

/** The most pages one group may hold before it is more than one job. */
export const MAX_GROUP_ITEMS = 8;

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

/**
 * The group a path is "in" — what a page prints above its title. Asked of the
 * same map the rail is drawn from, so the two cannot disagree: a page that
 * wrote its own group name kept saying "Data & BI" after it had moved.
 */
export function navGroupForPath(
  path: string,
  groups: NavGroup[] = ALL_NAV_GROUPS,
): NavGroup | undefined {
  const item = navItemForPath(path, groups);
  return item ? groups.find((g) => g.items.includes(item)) : undefined;
}
