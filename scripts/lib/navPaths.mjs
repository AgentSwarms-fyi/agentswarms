// "Open Admin → Developer runtime" is a claim about the app's sidebar, and it
// is the kind of claim that goes wrong quietly: a nav item gets renamed, and
// every document that walks a reader there keeps naming the old one. The first
// one found in this project was wrong on BOTH halves — "Observe → Budgets"
// where the group is Observability and the item is AI Budgets.
//
// The judging lives here because both corpora make the claim — the in-app
// pages in <strong> tags, the markdown in running prose — and a rule enforced
// on one of them is a rule an author can escape by writing in the other.
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");

/**
 * The sidebar, read from src/lib/appNav.ts — what the rail actually renders.
 *
 * This used to be a hand-kept copy in the checker, on the reasoning that the
 * rail was assembled across several components. It is not, and has not been
 * for a long time. A copy of the ground truth is not ground truth: it agrees
 * until somebody adds a nav item, and then the checker confidently approves
 * the old name and rejects the new one, silently both times.
 */
export function readAppNav() {
  const body = read("src/lib/appNav.ts");
  const groups = {};
  let current = null;
  for (const m of body
    .slice(body.indexOf("export const NAV_GROUPS"))
    .matchAll(/label:\s*"([^"]+)"|title:\s*"([^"]+)"/g)) {
    if (m[1]) groups[(current = m[1])] = [];
    else if (current) groups[current].push(m[2]);
  }
  // A parse that quietly returned nothing would approve every nav path in the
  // corpus, including the wrong ones. The rail has eight groups; fewer than
  // five means appNav.ts changed shape and this reader has to change with it.
  const count = Object.keys(groups).length;
  if (count < 5) {
    console.error(
      `navPaths: read only ${count} groups from src/lib/appNav.ts — the parser is stale`,
    );
    process.exit(2);
  }
  return groups;
}

/**
 * Tabs within a screen. Still written out, unlike the rail: a tab strip is
 * <TabsTrigger> markup spread through a page component, with labels that are
 * sometimes expressions, and a parser for it would be guessing.
 */
export const PAGE_TABS = {
  Integrations: [
    "LLM Providers",
    "Data Sources",
    "Apps",
    "LLM Gateway",
    "Web Search",
    "Notifications",
    "Slack",
    "Teams",
    "n8n Workflows",
  ],
  IAM: ["Users", "Groups", "Access", "Attributes", "Budgets", "SSO", "Settings"],
  "Knowledge Base": ["Vector Store", "Embedding", "Chunking", "Retrieval", "Documents", "Sources"],
  "RAG Settings": ["Vector Store", "Embedding", "Chunking", "Retrieval", "Documents", "Sources"],
  "Agent Builder": ["General", "Model", "Knowledge", "Memory", "Guardrails", "Tools"],
};

/** Split "Admin → IAM → Access" into its segments. */
export function navSegments(text) {
  return text
    .replace(/&amp;/g, "&")
    .split(/→|&rarr;/)
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * What is wrong with this nav path, or null.
 *
 * Returns null for anything whose first segment is neither a sidebar group nor
 * a screen with tabs. That is deliberate and load-bearing: the same arrow is
 * written for page → tab paths, for another product's UI ("Project Settings →
 * API Keys" in Supabase), and for plain prose ("Quarter → Region"). Judging
 * those would mean inventing rules about somebody else's software.
 */
export function navPathProblem(parts, appNav, pageTabs = PAGE_TABS) {
  if (parts.length < 2) return null;
  const [first, second, third] = parts;
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const has = (names, v) => names.some((i) => eq(i, v));
  const path = parts.join(" → ");

  // Screen names are matched case-insensitively: pages write "RAG settings"
  // where the tab list says "RAG Settings", and that is not an error.
  const tabsOf = (name) => Object.entries(pageTabs).find(([k]) => eq(k, name))?.[1] ?? null;

  // "Integrations" is both a sidebar group and a screen with tabs, so
  // "Integrations → Apps" and "Integrations → Secrets" are both correct.
  // Accept whichever reading holds rather than privileging one.
  const asGroup = appNav[first] ? has(appNav[first], second) : false;
  const asPage = tabsOf(first) ? has(tabsOf(first), second) : false;

  // A screen can nest one level before its tabs — the Knowledge Base page
  // reaches its tabs through a RAG Settings panel — so a middle segment that
  // is itself a known tab set is followed rather than rejected.
  const viaPanel = tabsOf(second) ? (third ? has(tabsOf(second), third) : true) : false;

  if (asGroup || asPage || viaPanel) {
    if (asGroup && !viaPanel && third && tabsOf(second) && !has(tabsOf(second), third))
      return `"${path}" — "${second}" has no "${third}" tab`;
    return null;
  }
  if (appNav[first] || tabsOf(first)) {
    const real = Object.entries(appNav).find(([, items]) => has(items, second))?.[0];
    return `"${path}" — ${real ? `"${second}" is under "${real}"` : `no "${second}" under "${first}"`}`;
  }
  // Neither a sidebar group nor a screen with tabs. A nav path has to start at
  // one of those, so this is a group that was renamed or never existed.
  const real = Object.entries(appNav).find(([, items]) => has(items, second))?.[0];
  if (real) return `"${path}" — "${second}" is under "${real}", and there is no "${first}" group`;
  if (
    Object.values(appNav)
      .flat()
      .some((i) => i.toLowerCase().endsWith(second.toLowerCase()))
  )
    return `"${path}" — no "${first}" group, and no item named exactly "${second}"`;
  return null;
}
