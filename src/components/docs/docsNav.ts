// The handbook's sidebar: its groups, their pages in reading order, and the
// contents map under a page's title. DocsShell.tsx renders it; the docs
// checker (scripts/check-docs.mjs) and the docs tests read it (R346: moved
// out of DocsShell.tsx).
import {
  Activity,
  Blocks,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Code2,
  Compass,
  Database,
  GraduationCap,
  HeartPulse,
  KeyRound,
  Layers,
  LayoutDashboard,
  Library,
  MessageSquare,
  Network,
  Notebook,
  PieChart,
  Plug,
  Rocket,
  Server,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Table2,
  Wallet,
  Warehouse,
  Waypoints,
  Webhook,
  Workflow,
  Wrench,
} from "lucide-react";

export const DOCS_GROUPS: DocGroup[] = [
  {
    label: "Getting started",
    items: [
      { to: "/docs", label: "Introduction", icon: Compass },
      { to: "/docs/quickstart", label: "Quickstart", icon: Rocket },
      { to: "/docs/concepts", label: "Core concepts", icon: GraduationCap },
      { to: "/docs/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/docs/account", label: "Account", icon: Settings },
    ],
  },
  {
    label: "Build",
    items: [
      { to: "/docs/agents", label: "Agent Builder", icon: Bot },
      { to: "/docs/playground", label: "Agent Chat", icon: MessageSquare },
      { to: "/docs/swarms", label: "Swarm Canvas", icon: Network },
      { to: "/docs/skills", label: "Skills & Prompt Library", icon: Library },
      { to: "/docs/notebooks", label: "Developer workspace", icon: Notebook },
    ],
  },
  {
    label: "Data & analytics",
    items: [
      // Same journey the app's own rail follows: find it, move it, store it,
      // shape it, say what it means, then use it.
      { to: "/docs/data", label: "Data Catalog & SQL", icon: Database },
      { to: "/docs/data-prep", label: "Data preparation", icon: Workflow },
      { to: "/docs/etl", label: "ETL Pipelines", icon: Waypoints },
      { to: "/docs/lakehouse", label: "Lakehouse", icon: Warehouse },
      { to: "/docs/sql-models", label: "SQL Models", icon: Blocks },
      { to: "/docs/semantics", label: "Semantic Layer", icon: Layers },
      { to: "/docs/bi", label: "BI Workspace", icon: PieChart },
      { to: "/docs/ml", label: "ML Models", icon: Brain },
      { to: "/docs/ml/training", label: "Training", icon: Brain, parent: "/docs/ml" },
      { to: "/docs/ml/predictions", label: "Predictions", icon: Brain, parent: "/docs/ml" },
      { to: "/docs/ml/serving", label: "Serving", icon: Brain, parent: "/docs/ml" },
      { to: "/docs/ml/trust", label: "Trust", icon: Brain, parent: "/docs/ml" },
      { to: "/docs/ml/operations", label: "Operations", icon: Brain, parent: "/docs/ml" },
      { to: "/docs/workflows", label: "Workflows", icon: Workflow },
      { to: "/docs/data-monitors", label: "Data monitors", icon: HeartPulse },
      { to: "/docs/sheets", label: "Sheets", icon: Table2 },
      { to: "/docs/ai-sql", label: "AI in SQL", icon: Sparkles },
      { to: "/docs/knowledge", label: "Knowledge Base", icon: BookOpen },
    ],
  },
  {
    label: "Integrate & ship",
    items: [
      { to: "/docs/integrations", label: "Integrations", icon: Plug },
      { to: "/docs/models", label: "Models & providers", icon: Boxes },
      { to: "/docs/mcp", label: "MCP servers", icon: Share2 },
      { to: "/docs/embedding", label: "Web embedding", icon: Code2 },
      { to: "/docs/api", label: "API & webhooks", icon: Webhook },
      { to: "/docs/gateway", label: "AI Gateway", icon: KeyRound },
      { to: "/docs/secrets", label: "Secrets", icon: KeyRound },
    ],
  },
  {
    label: "Govern & operate",
    items: [
      { to: "/docs/iam", label: "Access control", icon: ShieldCheck },
      { to: "/docs/guardrails", label: "Guardrails & PII", icon: ShieldAlert },
      { to: "/docs/budgets", label: "Budgets & cost", icon: Wallet },
      { to: "/docs/debugging", label: "Logs & traces", icon: Wrench },
      { to: "/docs/analytics", label: "Analytics & audit", icon: Activity },
    ],
  },
  {
    label: "Self-hosting",
    items: [
      { to: "/docs/self-hosting", label: "Install & deploy", icon: Server },
      {
        to: "/docs/self-hosting/configuration",
        label: "Configuration",
        icon: Server,
        parent: "/docs/self-hosting",
      },
      {
        to: "/docs/self-hosting/kubernetes",
        label: "Kubernetes",
        icon: Server,
        parent: "/docs/self-hosting",
      },
      {
        to: "/docs/self-hosting/operations",
        label: "Operations",
        icon: Server,
        parent: "/docs/self-hosting",
      },
    ],
  },
];

// Flat, ordered list used for prev/next navigation.
export const DOCS_NAV: DocItem[] = DOCS_GROUPS.flatMap((g) => g.items);

/**
 * "On this page" rail, shown from xl up where there is a third column for it.
 *
 * H3s are included because leaving them out hid 143 subsections across these
 * pages — 42% of every heading written, each already carrying an id and so
 * already linkable, just unreachable from the rail. On the long pages that is
 * the difference between a rail that navigates the page and one that lists its
 * chapter titles: /docs/swarms has 11 H2s and 19 H3s.
 */
/**
 * The H2 whose section holds the active heading — the active H3's parent,
 * or the active H2 itself. The rail expands only that section's H3s: with
 * every H3 shown, the ML guide's rail ran to fifty-eight entries and read
 * as a second page rather than a map of the first.
 */
export function activeSectionOf(
  headings: { id: string; level: number }[],
  activeId: string | null,
): string | null {
  if (!activeId) return null;
  let section: string | null = null;
  for (const h of headings) {
    if (h.level === 2) section = h.id;
    if (h.id === activeId) return section;
  }
  return null;
}

/**
 * "In this guide": the page's sections as a row of links under the title,
 * on pages with CONTENTS_FROM_SECTIONS or more. The rail on the right does
 * the same job from xl up, but a reader arriving on a long page sees the
 * title, a paragraph, and no idea what the next two thousand lines hold;
 * below xl the rail is a collapsed disclosure. Rendered from the headings
 * in the DOM, so it cannot drift from the page.
 */
/**
 * What the map lists: the sections, when the page has enough of them;
 * otherwise sections and subsections together, for a page that is one or
 * two sections deep in subsections (the Kubernetes walk-through is one
 * section with a cloud per subsection). Nothing on a short page.
 */
export function contentsEntries<T extends { level: number }>(headings: T[]): T[] {
  const sections = headings.filter((h) => h.level === 2);
  if (sections.length >= CONTENTS_FROM_SECTIONS) return sections;
  const all = headings.filter((h) => h.level === 2 || h.level === 3);
  return all.length >= CONTENTS_FROM_SECTIONS ? all : [];
}

export type DocItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * A sub-page of a longer guide: the route of the page it belongs to. It
   * sits indented under that page in the sidebar, shown only while the
   * reader is inside the family, so the rail stays as short as it was
   * before the guides were split. Kept flat (no nested arrays) because
   * scripts/check-docs.mjs reads the groups from this file with a regex.
   */
  parent?: string;
};

export type DocGroup = {
  label: string;
  items: DocItem[];
};

/** A page is long enough to want a map at the top from this many sections. */
export const CONTENTS_FROM_SECTIONS = 5;
