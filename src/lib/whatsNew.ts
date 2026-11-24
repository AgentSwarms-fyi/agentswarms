// What changed for the people using the app, newest first (R529).
//
// The CHANGELOG is written for whoever runs the server: migrations, settings,
// what to apply before upgrading. This is the same news for the people inside
// the app, one or two sentences each, with a link to the page where it is and,
// when there is one, the tutorial that walks through it. A test holds every
// entry to that: a real page, a known tutorial, a date, newest first.
import type { ObjectLink } from "@/lib/objectKinds";
import type { TutorialId } from "@/lib/tutorials";

export type WhatsNewEntry = {
  /** Stable, so "seen up to here" survives entries being added above it. */
  id: string;
  /** The day it reached the app, YYYY-MM-DD. */
  date: string;
  title: string;
  /** What it does for the reader, in one or two sentences. */
  body: string;
  link: ObjectLink;
  cta: string;
  tutorial?: TutorialId;
};

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "kserve-endpoints",
    date: "2026-11-24",
    title: "Model endpoints Kubernetes scales",
    body: "On Kubernetes with KServe, a deployed model's pods are added and removed by the cluster as load changes, and the Deployment panel shows how many are serving and why any are not.",
    link: { to: "/docs/ml/serving" },
    cta: "Read how it works",
  },
  {
    id: "query-history",
    date: "2026-11-24",
    title: "Every query run for you, and what it cost",
    body: "Query history lists the queries you ran and those dashboards, agents and schedules ran for you, with the time, rows and data read, and a price where the engine charges by the query.",
    link: { to: "/query-history" },
    cta: "Open Query history",
  },
  {
    id: "templates",
    date: "2026-11-23",
    title: "Every template in one place",
    body: "Templates lists the ready-made swarms, agents, pipelines, MCP servers, API connectors, notebooks, workbooks and skills, each opening on its own page, ready to change.",
    link: { to: "/templates" },
    cta: "Open Templates",
  },
  {
    id: "result-values",
    date: "2026-11-23",
    title: "Long values in results, one line each",
    body: "A result row keeps to one line however long its values are. Click a shortened value to read all of it, with JSON indented, and copy it.",
    link: { to: "/data-sql" },
    cta: "Open the Data Catalog",
  },
  {
    id: "tutorials",
    date: "2026-11-23",
    title: "Tutorials you do in the app",
    body: "Six short tutorials on the sample data, from a first question to a forecast. Each step ticks when what it asks for exists, and what you make is yours to keep.",
    link: { to: "/learn" },
    cta: "Open Learn",
  },
  {
    id: "rest-api",
    date: "2026-11-23",
    title: "Connect any REST API",
    body: "Describe an API (its host, where the key goes, how it pages) and it syncs into datasets like the built-in apps. Start from a template, and preview a stream's first rows before syncing.",
    link: { to: "/integrations", search: { tab: "apps" } },
    cta: "Open Apps",
    tutorial: "rest_api",
  },
  {
    id: "models-from-chat",
    date: "2026-11-23",
    title: "Models proposed in chat, trained on your yes",
    body: "An agent with Propose ML models suggests a model checked against the table's real columns. It waits in the approvals inbox and trains only when you approve.",
    link: { to: "/agents" },
    cta: "Open Agent Builder",
  },
  {
    id: "model-lineage",
    date: "2026-11-23",
    title: "What a model reads and what uses it",
    body: "A model's Overview names its tables and everything built on it: prediction tables, dashboards, agents, schedules and pipelines. A table's catalog entry names its models.",
    link: { to: "/ml" },
    cta: "Open ML Models",
  },
  {
    id: "experiments-trained-here",
    date: "2026-11-23",
    title: "Every training run in one place",
    body: "Experiments lists each version trained here beside the runs logged from notebooks, on the same scores, with what started it.",
    link: { to: "/ml", search: { tab: "experiments" } },
    cta: "Open Experiments",
  },
  {
    id: "monitor-edit",
    date: "2026-11-23",
    title: "Change a data monitor after it is made",
    body: "A check's column, thresholds, schedule, severity and name can be changed in place, keeping its history.",
    link: { to: "/data-monitors" },
    cta: "Open Data monitors",
    tutorial: "lake_watch",
  },
  {
    id: "forecast-series",
    date: "2026-11-23",
    title: "Forecasts per series",
    body: "A forecast can be split by a column such as region or product, each with its own winning method, chosen over three backtest windows instead of one holdout.",
    link: { to: "/ml" },
    cta: "Open ML Models",
    tutorial: "forecast",
  },
  {
    id: "run-fixes",
    date: "2026-11-23",
    title: "Fixes for what keeps failing",
    body: "On Runs, a check or pipeline that needs a look offers Suggest a fix: why it failed, and the exact change that fixes it when there is one.",
    link: { to: "/runs" },
    cta: "Open Runs",
  },
  {
    id: "personal-data",
    date: "2026-11-22",
    title: "Personal data, found from what a column holds",
    body: "A dataset's columns of emails, phone numbers, card numbers and the like are found from their values, and can be hidden from everyone it is shared with.",
    link: { to: "/data-sql" },
    cta: "Open Data Catalog",
  },
  {
    id: "assistant",
    date: "2026-11-22",
    title: "An assistant on every page",
    body: "Ask how to do something, or where something of yours is, without leaving the page. It answers from the handbook and your own work.",
    link: { to: "/dashboard" },
    cta: "Open Dashboard",
  },
  {
    id: "dataset-page",
    date: "2026-11-22",
    title: "A page for every dataset",
    body: "A sample of its rows, how its columns changed, who it is shared with, its checks, and everything built on it.",
    link: { to: "/data-sql" },
    cta: "Open Data Catalog",
  },
  {
    id: "runs",
    date: "2026-11-22",
    title: "Everything that ran, in one list",
    body: "Pipelines, checks, schedules, swarms and reports in one place, with one word for how each went.",
    link: { to: "/runs" },
    cta: "Open Runs",
  },
  {
    id: "trash",
    date: "2026-11-22",
    title: "Deleted things can be brought back",
    body: "What you delete waits in Trash for thirty days, with what depended on it, and returns as it was.",
    link: { to: "/trash" },
    cta: "Open Trash",
  },
  {
    id: "my-work",
    date: "2026-11-22",
    title: "My work",
    body: "Everything you starred, opened last, or had shared with you, across every kind of object.",
    link: { to: "/my-work" },
    cta: "Open My work",
  },
  {
    id: "search",
    date: "2026-11-22",
    title: "Search finds your work",
    body: "Ctrl K (⌘ K on a Mac) finds agents, dashboards, tables and models by name, not just pages, and starts anything new from one menu.",
    link: { to: "/search" },
    cta: "Open Search",
  },
  {
    id: "dashboard-pdf",
    date: "2026-11-19",
    title: "Dashboards emailed as PDFs",
    body: "Schedule a dashboard and it arrives as a PDF laid out for paper, every visual drawn.",
    link: { to: "/bi" },
    cta: "Open BI Workspace",
    tutorial: "dashboard",
  },
];

/** Entries newer than the one last seen; every entry when none was. */
export function unseenCount(entries: WhatsNewEntry[], seenId: string | null): number {
  if (!seenId) return entries.length;
  const at = entries.findIndex((e) => e.id === seenId);
  // An id no longer listed: count what is newer than nothing we can place.
  return at < 0 ? entries.length : at;
}

/** Where "seen up to here" is kept: per browser, a convenience only. */
export const WHATS_NEW_SEEN_KEY = "agentswarms:whats-new-seen.v1";
