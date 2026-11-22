// Every kind of thing a person makes here, in one list.
//
// Search (Ctrl/⌘-K and the results page) and the "New" menu both read this, so
// a kind added here can be found and created from everywhere at once, and the
// two can never disagree about what exists. Before this list the palette knew
// five things to create and the "+" menu a different three, and neither could
// find a dashboard by its name.
//
// A kind says three things: what it is called, how to OPEN one, and how to
// START one. Opening is a link, never a callback, so a result can be opened in
// a new tab and a link can be pasted to a colleague.
import {
  Blocks,
  BookMarked,
  BookOpen,
  Bot,
  Brain,
  BrainCircuit,
  Code2,
  Database,
  FileBarChart,
  FileSpreadsheet,
  FlaskConical,
  HeartPulse,
  Layers,
  type LucideIcon,
  MessagesSquare,
  Network,
  NotebookPen,
  PieChart,
  Plug,
  Shapes,
  Sigma,
  Table2,
  Wand2,
  Waypoints,
  Workflow,
  Wrench,
} from "lucide-react";

export type ObjectKindId =
  | "agent"
  | "swarm"
  | "knowledge_base"
  | "mcp_app"
  | "dataset"
  | "etl_pipeline"
  | "lakehouse_table"
  | "sql_model"
  | "semantic_model"
  | "metric"
  | "ontology"
  | "workbook"
  | "ai_analyst"
  | "analysis"
  | "dashboard"
  | "report"
  | "ml_model"
  | "workflow"
  | "data_monitor"
  | "notebook"
  | "prompt"
  | "skill"
  | "evaluation"
  | "mcp_server"
  | "embed";

/** A place in the app: a path and what it is asked to do when it gets there. */
export type ObjectLink = { to: string; search?: Record<string, string | number> };

/** What search knows about one object. Names only — never its contents. */
export type ObjectEntry = {
  kind: ObjectKindId;
  id: string;
  name: string;
  /** A description, or what the object belongs to (an analysis's analyst). */
  detail?: string;
  updatedAt?: string | null;
  /** False when it was shared with the reader, or is a bundled sample. */
  mine: boolean;
  sample?: boolean;
  /** The object this one lives inside, when opening it needs both ids. */
  parentId?: string;
};

/** The sections the "New" menu is laid out in, in the order they are shown. */
export const CREATE_SECTIONS = ["Agents", "Data", "Analysis", "Automation", "Connections"] as const;
export type CreateSection = (typeof CREATE_SECTIONS)[number];

export type ObjectKind = {
  id: ObjectKindId;
  /** Singular, as a row's label: "Dashboard". */
  label: string;
  /** Plural, as a heading and a filter: "Dashboards". */
  plural: string;
  icon: LucideIcon;
  /** The page that lists this kind — its entry in the navigation. */
  page: string;
  open: (entry: Pick<ObjectEntry, "id" | "name" | "parentId">) => ObjectLink;
  create?: { title: string; hint: string; section: CreateSection; link: ObjectLink };
};

/** A list page asked to open one of its objects. */
const onPage =
  (page: string) =>
  (e: Pick<ObjectEntry, "id">): ObjectLink => ({ to: page, search: { open: e.id } });

/** A list page asked to start a new object. */
const newOn = (page: string): ObjectLink => ({ to: page, search: { new: 1 } });

// In the order the navigation presents them: what you build, the data, what
// you do with the data, then what runs and connects it.
export const OBJECT_KINDS: ObjectKind[] = [
  {
    id: "agent",
    label: "Agent",
    plural: "Agents",
    icon: Bot,
    page: "/agents",
    open: onPage("/agents"),
    create: {
      title: "Agent",
      hint: "A model with instructions, tools and knowledge",
      section: "Agents",
      link: newOn("/agents"),
    },
  },
  {
    id: "swarm",
    label: "Swarm",
    plural: "Swarms",
    icon: Network,
    page: "/swarms",
    open: (e) => ({ to: "/swarms", search: { swarm: e.id, view: "canvas" } }),
    create: {
      title: "Swarm",
      hint: "Several agents working on one canvas",
      section: "Agents",
      link: { to: "/swarms", search: { view: "canvas", new: 1 } },
    },
  },
  {
    id: "knowledge_base",
    label: "Knowledge base",
    plural: "Knowledge bases",
    icon: BookOpen,
    page: "/knowledge",
    open: onPage("/knowledge"),
    create: {
      title: "Knowledge base",
      hint: "Documents and pages an agent can search",
      section: "Agents",
      link: newOn("/knowledge"),
    },
  },
  {
    id: "mcp_app",
    label: "MCP project",
    plural: "MCP projects",
    icon: Wrench,
    page: "/mcp-builder",
    open: (e) => ({ to: `/mcp-builder/${e.id}` }),
    create: {
      title: "MCP server",
      hint: "Write tools in Python and host them here",
      section: "Agents",
      link: newOn("/mcp-builder"),
    },
  },
  {
    id: "prompt",
    label: "Prompt",
    plural: "Prompts",
    icon: BookMarked,
    page: "/prompts",
    open: onPage("/prompts"),
    create: {
      title: "Prompt",
      hint: "A reusable prompt for the library",
      section: "Agents",
      link: newOn("/prompts"),
    },
  },
  {
    id: "skill",
    label: "Skill",
    plural: "Skills",
    icon: Wand2,
    page: "/skills",
    open: onPage("/skills"),
    create: {
      title: "Skill",
      hint: "Instructions an agent loads when it needs them",
      section: "Agents",
      link: newOn("/skills"),
    },
  },
  {
    id: "evaluation",
    label: "Evaluation set",
    plural: "Evaluation sets",
    icon: FlaskConical,
    page: "/evaluations",
    open: onPage("/evaluations"),
    create: {
      title: "Evaluation set",
      hint: "Questions and expected answers to score agents with",
      section: "Agents",
      link: newOn("/evaluations"),
    },
  },
  {
    id: "dataset",
    label: "Dataset",
    plural: "Datasets",
    icon: Database,
    page: "/data-sql",
    open: onPage("/data-sql"),
    create: {
      title: "Dataset",
      hint: "Upload a CSV, Excel or JSON file",
      section: "Data",
      link: newOn("/data-sql"),
    },
  },
  {
    id: "lakehouse_table",
    label: "Lakehouse table",
    plural: "Lakehouse tables",
    icon: Table2,
    page: "/lakehouse",
    // The id IS schema.table: a lakehouse table has no other identity.
    open: onPage("/lakehouse"),
  },
  {
    id: "etl_pipeline",
    label: "Pipeline",
    plural: "Pipelines",
    icon: Waypoints,
    page: "/etl",
    open: onPage("/etl"),
    create: {
      title: "Pipeline",
      hint: "Move and reshape data on a schedule",
      section: "Data",
      link: newOn("/etl"),
    },
  },
  {
    id: "sql_model",
    label: "SQL model",
    plural: "SQL models",
    icon: Blocks,
    page: "/sql-models",
    open: onPage("/sql-models"),
    create: {
      title: "SQL model",
      hint: "A lakehouse table built from a query",
      section: "Data",
      link: newOn("/sql-models"),
    },
  },
  {
    id: "semantic_model",
    label: "Semantic model",
    plural: "Semantic models",
    icon: Layers,
    page: "/semantics",
    open: onPage("/semantics"),
    create: {
      title: "Semantic model",
      hint: "Governed metrics and dimensions over a table",
      section: "Data",
      link: newOn("/semantics"),
    },
  },
  {
    id: "metric",
    label: "Metric",
    plural: "Metrics",
    icon: Sigma,
    page: "/metrics",
    open: onPage("/metrics"),
  },
  {
    id: "ontology",
    label: "Ontology",
    plural: "Ontologies",
    icon: Shapes,
    page: "/ontology",
    open: (e) => ({ to: `/ontology/${e.id}` }),
    create: {
      title: "Ontology",
      hint: "The things your business is about and how they connect",
      section: "Data",
      link: newOn("/ontology"),
    },
  },
  {
    id: "data_monitor",
    label: "Data monitor",
    plural: "Data monitors",
    icon: HeartPulse,
    page: "/data-monitors",
    open: onPage("/data-monitors"),
    create: {
      title: "Data monitor",
      hint: "Checks that run on a schedule and raise incidents",
      section: "Data",
      link: newOn("/data-monitors"),
    },
  },
  {
    id: "ai_analyst",
    label: "AI analyst",
    plural: "AI analysts",
    icon: BrainCircuit,
    page: "/ai-analyst",
    open: onPage("/ai-analyst"),
    create: {
      title: "AI analyst",
      hint: "A model paired with the data it may answer from",
      section: "Analysis",
      link: newOn("/ai-analyst"),
    },
  },
  {
    id: "analysis",
    label: "Analysis",
    plural: "Analyses",
    icon: MessagesSquare,
    page: "/ai-analyst",
    // An analysis is opened inside its analyst, so the link carries both.
    open: (e) => {
      const search: Record<string, string> = { thread: e.id };
      if (e.parentId) search.open = e.parentId;
      return { to: "/ai-analyst", search };
    },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    plural: "Dashboards",
    icon: PieChart,
    page: "/bi",
    open: (e) => ({ to: `/bi/${e.id}` }),
    create: {
      title: "Dashboard",
      hint: "Charts and KPIs over your data",
      section: "Analysis",
      link: newOn("/bi"),
    },
  },
  {
    id: "report",
    label: "Report",
    plural: "Reports",
    icon: FileBarChart,
    page: "/bi",
    open: (e) => ({ to: `/bi/report/${e.id}` }),
    create: {
      title: "Report",
      hint: "A paginated document for print and email",
      section: "Analysis",
      link: { to: "/bi", search: { tab: "reports", new: 1 } },
    },
  },
  {
    id: "workbook",
    label: "Workbook",
    plural: "Workbooks",
    icon: FileSpreadsheet,
    page: "/sheets",
    open: (e) => ({ to: `/sheets/${e.id}` }),
    create: {
      title: "Workbook",
      hint: "A spreadsheet over lakehouse tables",
      section: "Analysis",
      link: newOn("/sheets"),
    },
  },
  {
    id: "ml_model",
    label: "ML model",
    plural: "ML models",
    icon: Brain,
    page: "/ml",
    open: (e) => ({ to: `/ml/${e.id}` }),
    create: {
      title: "ML model",
      hint: "Train on a table without writing code",
      section: "Analysis",
      link: { to: "/ml/new" },
    },
  },
  {
    id: "notebook",
    label: "Notebook",
    plural: "Notebooks",
    icon: NotebookPen,
    page: "/notebooks",
    open: (e) => ({ to: `/notebooks/py/${e.id}` }),
    create: {
      title: "Notebook",
      hint: "Python on a sandboxed kernel",
      section: "Analysis",
      link: newOn("/notebooks"),
    },
  },
  {
    id: "workflow",
    label: "Workflow",
    plural: "Workflows",
    icon: Workflow,
    page: "/workflows",
    open: onPage("/workflows"),
    create: {
      title: "Workflow",
      hint: "Run pipelines, models and swarms on one clock",
      section: "Automation",
      link: newOn("/workflows"),
    },
  },
  {
    id: "mcp_server",
    label: "MCP server",
    plural: "MCP servers",
    icon: Plug,
    page: "/mcp",
    open: onPage("/mcp"),
    create: {
      title: "MCP connection",
      hint: "Connect an MCP server somebody else runs",
      section: "Connections",
      link: newOn("/mcp"),
    },
  },
  {
    id: "embed",
    label: "Embed",
    plural: "Embeds",
    icon: Code2,
    page: "/embeds",
    open: onPage("/embeds"),
    create: {
      title: "Embed",
      hint: "Put an agent, swarm or dashboard on another site",
      section: "Connections",
      link: newOn("/embeds"),
    },
  },
];

const BY_ID = new Map(OBJECT_KINDS.map((k) => [k.id, k]));

export function objectKind(id: ObjectKindId): ObjectKind {
  const k = BY_ID.get(id);
  if (!k) throw new Error(`Unknown object kind: ${id}`);
  return k;
}

export function isObjectKindId(v: unknown): v is ObjectKindId {
  return typeof v === "string" && BY_ID.has(v as ObjectKindId);
}

/** Where an entry opens. */
export function linkToObject(
  entry: Pick<ObjectEntry, "kind" | "id" | "name" | "parentId">,
): ObjectLink {
  return objectKind(entry.kind).open(entry);
}

export type CreateAction = {
  kind: ObjectKindId;
  title: string;
  hint: string;
  section: CreateSection;
  icon: LucideIcon;
  link: ObjectLink;
};

/** Everything that can be started from a link, in menu order. */
export function createActions(): CreateAction[] {
  const out: CreateAction[] = [];
  for (const section of CREATE_SECTIONS) {
    for (const k of OBJECT_KINDS) {
      if (k.create?.section === section) {
        out.push({ kind: k.id, icon: k.icon, ...k.create });
      }
    }
  }
  return out;
}
