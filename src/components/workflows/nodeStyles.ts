// What each kind of step looks like.
//
// Colour is doing real work here, not decoration. A graph of fifteen possible
// step types is unreadable in one grey; giving each family its own hue means
// "the data steps are green, the control flow is purple" is legible at a
// glance, before you have read a single label. The families are the same ones
// the palette groups by, so the canvas and the picker teach each other.
import {
  Bell,
  Blocks,
  Brain,
  Braces,
  CheckSquare,
  Database,
  GitBranch,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Network,
  NotebookPen,
  Timer,
  Wand2,
  Waypoints,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from "lucide-react";

import type { WorkflowNodeKind } from "@/lib/workflows";

export type KindStyle = {
  icon: LucideIcon;
  /** Border on the canvas node. */
  ring: string;
  /** The icon's own chip. */
  chip: string;
  /** The palette button, tinted so a family reads as one. */
  tile: string;
  /** One line saying what it does, shown in the palette. */
  blurb: string;
};

export const KIND_STYLE: Record<WorkflowNodeKind, KindStyle> = {
  pipeline: {
    icon: Waypoints,
    ring: "border-emerald-500/60",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    tile: "border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
    blurb: "Run one of your ETL pipelines",
  },
  sql_models: {
    icon: Blocks,
    ring: "border-sky-500/60",
    chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    tile: "border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300",
    blurb: "Build models, in dependency order",
  },
  sql: {
    icon: Database,
    ring: "border-cyan-500/60",
    chip: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    tile: "border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300",
    blurb: "One statement on the lakehouse",
  },
  prep_flow: {
    icon: Wand2,
    ring: "border-teal-500/60",
    chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    tile: "border-teal-500/40 bg-teal-500/10 hover:bg-teal-500/20 text-teal-700 dark:text-teal-300",
    blurb: "Refresh a data-prep flow",
  },
  ml_schedule: {
    icon: Brain,
    ring: "border-violet-500/60",
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    tile: "border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-300",
    blurb: "Retrain, or predict a batch",
  },
  notebook: {
    icon: NotebookPen,
    ring: "border-amber-500/60",
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    tile: "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300",
    blurb: "Run a notebook in a sandbox",
  },
  swarm: {
    icon: Network,
    ring: "border-fuchsia-500/60",
    chip: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
    tile: "border-fuchsia-500/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300",
    blurb: "Run a published agent swarm",
  },
  dashboard_refresh: {
    icon: LayoutDashboard,
    ring: "border-indigo-500/60",
    chip: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    tile: "border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300",
    blurb: "Refresh a dashboard snapshot",
  },
  data_monitor: {
    icon: HeartPulse,
    ring: "border-rose-500/60",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    tile: "border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300",
    blurb: "Stop if the data is wrong",
  },
  http: {
    icon: Globe,
    ring: "border-orange-500/60",
    chip: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    tile: "border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/20 text-orange-700 dark:text-orange-300",
    blurb: "Call somebody else's API",
  },
  notify: {
    icon: Bell,
    ring: "border-yellow-500/60",
    chip: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
    tile: "border-yellow-500/40 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-700 dark:text-yellow-300",
    blurb: "Tell someone it happened",
  },
  condition: {
    icon: GitBranch,
    ring: "border-purple-500/60",
    chip: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    tile: "border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-700 dark:text-purple-300",
    blurb: "Branch on a parameter",
  },
  wait: {
    icon: Timer,
    ring: "border-slate-400/60",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    tile: "border-slate-400/40 bg-slate-500/10 hover:bg-slate-500/20 text-slate-700 dark:text-slate-300",
    blurb: "Pause before carrying on",
  },
  approval: {
    icon: CheckSquare,
    ring: "border-pink-500/60",
    chip: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
    tile: "border-pink-500/40 bg-pink-500/10 hover:bg-pink-500/20 text-pink-700 dark:text-pink-300",
    blurb: "Wait for a person to say yes",
  },
  sub_workflow: {
    icon: WorkflowIcon,
    ring: "border-lime-500/60",
    chip: "bg-lime-500/15 text-lime-600 dark:text-lime-400",
    tile: "border-lime-500/40 bg-lime-500/10 hover:bg-lime-500/20 text-lime-700 dark:text-lime-300",
    blurb: "Run another workflow whole",
  },
};

/** The palette's groups, in the order somebody builds a graph. */
export const KIND_GROUPS: { label: string; hint: string; kinds: WorkflowNodeKind[] }[] = [
  {
    label: "Move and shape data",
    hint: "The work that produces tables",
    kinds: ["pipeline", "sql_models", "sql", "prep_flow"],
  },
  {
    label: "Models and agents",
    hint: "What runs on top of those tables",
    kinds: ["ml_schedule", "notebook", "swarm"],
  },
  {
    label: "Publish and check",
    hint: "What people and systems see",
    kinds: ["dashboard_refresh", "data_monitor", "notify", "http"],
  },
  {
    label: "Control flow",
    hint: "Shape the run itself",
    kinds: ["condition", "wait", "approval", "sub_workflow"],
  },
];

export { Braces };
