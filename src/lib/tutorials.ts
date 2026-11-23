// Tutorials done in the app itself, on the sample data every workspace has.
//
// A tutorial here is not a tour of screenshots. Each step asks for something
// real (an analyst, a dashboard, a check on a table) and ticks when that thing
// exists, worked out on the server from what the person made since they
// started (src/lib/tutorialChecks.ts). Nothing can be ticked by hand, so the
// list is never ahead of the person following it, and what they make is
// theirs to keep.
//
// Each step says what to do in the words the page uses, and links to the page
// where it is done. The links are the same ones search and the New menu use
// (src/lib/objectKinds.ts), so a tutorial cannot point at a page that moved.
import type { ObjectLink } from "@/lib/objectKinds";
import { SAMPLE_TABLE_NAME, SUPPLY_SHIPMENTS_TABLE_NAME } from "@/lib/sampleDatasetNames";

export const TUTORIAL_AREAS = ["Analysis", "Data engineering", "Data science", "Agents"] as const;
export type TutorialArea = (typeof TUTORIAL_AREAS)[number];

/**
 * What a tutorial cannot be done without. Said before it is started, with a
 * way to put it right, instead of discovered on step three.
 */
export type TutorialNeed = "model" | "lakehouse";

export type TutorialStep = {
  id: string;
  /** What this step leaves behind, as an instruction: "Add a check on it". */
  title: string;
  /** How, in the words the page uses for its controls. */
  how: string;
  /** Where it is done. The guide may send the person to what they made instead. */
  link: ObjectLink;
  /** The button that goes there. */
  cta: string;
};

export type Tutorial = {
  id: TutorialId;
  title: string;
  /** What the person has at the end, as one sentence. */
  outcome: string;
  area: TutorialArea;
  /** Honest minutes for someone new to the page, waiting included. */
  minutes: number;
  needs: TutorialNeed[];
  steps: TutorialStep[];
};

/** The sample both analysis tutorials read. */
export const SALES_TABLE = SAMPLE_TABLE_NAME;
/** The sample both lakehouse tutorials bring in: its order dates are real dates. */
export const SHIPMENTS_TABLE = SUPPLY_SHIPMENTS_TABLE_NAME;

/** The swarm sample whose run stops to ask before it sends a reply. */
export const APPROVAL_SWARM_TEMPLATE = "support-copilot";

export const TUTORIAL_IDS = [
  "ask_analyst",
  "dashboard",
  "rest_api",
  "lake_watch",
  "forecast",
  "swarm_approval",
] as const;
export type TutorialId = (typeof TUTORIAL_IDS)[number];

export const TUTORIALS: Tutorial[] = [
  {
    id: "ask_analyst",
    title: "Ask your data a question",
    outcome:
      "An analyst on the sample sales, an answer it checked before showing you, and the same question answered again every week.",
    area: "Analysis",
    minutes: 5,
    needs: ["model"],
    steps: [
      {
        id: "analyst",
        title: "Make an analyst that reads the sample sales",
        how: `On AI Analyst choose New analyst, give it a name, and under Data pick ${SALES_TABLE} (or leave it reading every dataset).`,
        link: { to: "/ai-analyst", search: { new: 1 } },
        cta: "New analyst",
      },
      {
        id: "ask",
        title: "Ask it a question",
        how: "Ask, for example, “Which region grew fastest last year, and by how much?” It writes the SQL, runs it, and checks its own answer before showing it.",
        link: { to: "/ai-analyst" },
        cta: "Open AI Analyst",
      },
      {
        id: "schedule",
        title: "Have it asked again every week",
        how: "In that conversation choose Schedule and pick Weekly. Turn on email to have each new answer sent to you.",
        link: { to: "/ai-analyst" },
        cta: "Open AI Analyst",
      },
    ],
  },
  {
    id: "dashboard",
    title: "Build a dashboard that comes to you",
    outcome:
      "A dashboard on the sample sales with a headline number and a chart, emailed to you as a PDF every week.",
    area: "Analysis",
    minutes: 8,
    needs: [],
    steps: [
      {
        id: "make",
        title: "Make a dashboard on the sample sales",
        how: `On BI Workspace choose New BI project, then add a chart that reads ${SALES_TABLE}.`,
        link: { to: "/bi", search: { new: 1 } },
        cta: "New BI project",
      },
      {
        id: "visuals",
        title: "Give it a headline number and a chart",
        how: "Add a KPI card (total sales, for example) and a chart beside it, such as sales by region.",
        link: { to: "/bi" },
        cta: "Open BI Workspace",
      },
      {
        id: "email",
        title: "Have it emailed to you every week",
        how: "On the dashboard choose Schedule, pick Weekly, and turn on the email.",
        link: { to: "/bi" },
        cta: "Open BI Workspace",
      },
    ],
  },
  {
    id: "rest_api",
    title: "Bring in data from an API",
    outcome:
      "A source reading a public repository's releases through the GitHub API, a dataset of them refreshed every day, and a chart of them.",
    area: "Data engineering",
    minutes: 8,
    needs: [],
    steps: [
      {
        id: "connect",
        title: "Connect Any REST API from a template",
        how: "On Apps choose Connect or Add another on Any REST API. Start from GitHub repository, enter cli/cli and choose Fill in, then Connect and list streams. Tick Releases only and choose Save and sync.",
        link: { to: "/integrations", search: { tab: "apps" } },
        cta: "Open Apps",
      },
      {
        id: "sync",
        title: "Sync the releases every day",
        how: "Each ticked stream becomes a dataset named after the source and the stream. Leave Sync automatically on Every day so new releases arrive by themselves. This ticks when the first sync is in.",
        link: { to: "/integrations", search: { tab: "apps" } },
        cta: "Open Apps",
      },
      {
        id: "chart",
        title: "Chart the releases",
        how: "On BI Workspace choose New BI project, then add a chart that reads the releases dataset, such as releases by author.",
        link: { to: "/bi", search: { new: 1 } },
        cta: "New BI project",
      },
    ],
  },
  {
    id: "lake_watch",
    title: "Watch a table for problems",
    outcome:
      "The sample shipments as a lakehouse table, a check that tells you when it goes wrong, and the check's first result.",
    area: "Data engineering",
    minutes: 6,
    needs: ["lakehouse"],
    steps: [
      {
        id: "import",
        title: "Bring the sample shipments into the lakehouse",
        how: `On Lakehouse open a schema, choose New table, then Import dataset, and pick ${SHIPMENTS_TABLE}.`,
        link: { to: "/lakehouse" },
        cta: "Open Lakehouse",
      },
      {
        id: "check",
        title: "Add a check on it",
        how: "On Data monitors choose New check and pick the table you just made. Volume keeps its row count in a normal range; Schema warns when its columns change.",
        link: { to: "/data-monitors", search: { new: 1 } },
        cta: "New check",
      },
      {
        id: "run",
        title: "Run it now",
        how: "Choose Run now on the check. This result, and every one after it, is on the check and on Runs.",
        link: { to: "/data-monitors" },
        cta: "Open Data monitors",
      },
    ],
  },
  {
    id: "forecast",
    title: "Forecast next quarter's orders",
    outcome:
      "A forecasting model of weekly order value, trained on the sample shipments, with the method that won its backtests in production.",
    area: "Data science",
    minutes: 12,
    needs: ["lakehouse"],
    steps: [
      {
        id: "table",
        title: "Have the sample shipments in the lakehouse",
        how: `Already done if you followed Watch a table for problems. Otherwise, on Lakehouse open a schema, choose New table, then Import dataset, and pick ${SHIPMENTS_TABLE}.`,
        link: { to: "/lakehouse" },
        cta: "Open Lakehouse",
      },
      {
        id: "train",
        title: "Train a forecast of weekly order value",
        how: "On ML Models choose New model and pick Forecast. Choose the shipments table, Order Value as the number, Order Date as the time, and Week as the period.",
        link: { to: "/ml/new" },
        cta: "New model",
      },
      {
        id: "promote",
        title: "Put it in production",
        how: "When training finishes, promote the best version to Production on the model's page. Agents, dashboards and the API read that version.",
        link: { to: "/ml" },
        cta: "Open ML Models",
      },
    ],
  },
  {
    id: "swarm_approval",
    title: "Run a swarm that asks before it acts",
    outcome:
      "Your own copy of the Support Copilot sample, a run of it, and the reply it drafted, approved or refused by you.",
    area: "Agents",
    minutes: 8,
    needs: ["model"],
    steps: [
      {
        id: "copy",
        title: "Make your own Support Copilot",
        how: "Open the sample and choose Save, so the swarm is yours to change and run.",
        link: { to: "/swarms", search: { template: APPROVAL_SWARM_TEMPLATE } },
        cta: "Open the sample",
      },
      {
        id: "run",
        title: "Run it on a billing question",
        how: "Replace the example with a billing question, such as “I was charged twice this month, can you refund one?”, and choose Run. It drafts a reply, then stops before sending it.",
        link: { to: "/swarms" },
        cta: "Open Agent Swarms",
      },
      {
        id: "answer",
        title: "Answer it in the approvals inbox",
        how: "Open the approvals inbox at the top of the page, read the drafted reply, and approve or reject it. The run carries on either way.",
        link: { to: "/swarms" },
        cta: "Open Agent Swarms",
      },
    ],
  },
];

export function tutorialById(id: string): Tutorial | undefined {
  return TUTORIALS.find((t) => t.id === id);
}

export function isTutorialId(id: unknown): id is TutorialId {
  return typeof id === "string" && (TUTORIAL_IDS as readonly string[]).includes(id);
}

/** One person's start of one tutorial, as stored (tutorial_runs). */
export type TutorialRun = {
  tutorial_id: string;
  started_at: string;
  finished_at: string | null;
  hidden: boolean;
};

/**
 * The tutorial the guide follows: the one started last that is still showing.
 * A finished one stays the guide's until it is put away, so the person sees
 * the last tick land and what they made.
 */
export function activeTutorialRun(runs: TutorialRun[]): TutorialRun | null {
  let best: TutorialRun | null = null;
  for (const r of runs) {
    if (r.hidden || !isTutorialId(r.tutorial_id)) continue;
    if (!best || r.started_at > best.started_at) best = r;
  }
  return best;
}

/** The first step not done, or -1 when every step is. */
export function nextStepIndex(done: boolean[]): number {
  return done.findIndex((d) => !d);
}

/**
 * Whether a step's link points at the page already open: its path, and each
 * search value it names. The guide offers no button to the page you are on.
 */
export function linkIsHere(
  link: ObjectLink,
  pathname: string,
  search: Record<string, unknown> | undefined,
): boolean {
  if (pathname.replace(/\/+$/, "") !== link.to.replace(/\/+$/, "")) return false;
  return Object.entries(link.search ?? {}).every(([k, v]) => String(search?.[k]) === String(v));
}

/**
 * Sent on the window after a tutorial is started, resumed or put away, so the
 * guide on the page reads it again at once instead of on its next look.
 */
export const TUTORIAL_CHANGED_EVENT = "agentswarms:tutorial-changed";

export function announceTutorialChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TUTORIAL_CHANGED_EVENT));
}
