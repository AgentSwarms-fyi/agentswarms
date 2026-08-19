#!/usr/bin/env node
// Consistency checks for the in-app documentation (src/routes/docs.*.tsx).
//
// These pages make thousands of factual claims about the app: which tab comes
// third, what a default is, which sidebar group holds a page, which
// environment variables exist. Prose review does not catch a claim that was
// true when written and stopped being true when something was renamed, and
// that is where every documentation bug found so far has come from — never
// from careless writing, always from drift.
//
// So this checks the claims that can be checked mechanically, against the code
// as ground truth. It cannot judge whether an explanation is any good; it can
// promise that a link resolves, an anchor exists, a documented tool id is real,
// and a documented environment variable is one the runtime actually reads.
//
//   node scripts/check-docs.mjs          list every finding
//   node scripts/check-docs.mjs --quiet   summary only
//
// Exits non-zero when anything fails, so CI can gate on it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROUTES = "src/routes";
const DOCS = fs.readdirSync(ROUTES).filter((f) => /^docs\./.test(f));
const read = (p) => fs.readFileSync(p, "utf8");
const quiet = process.argv.includes("--quiet");

const findings = [];
const fail = (check, detail) => findings.push({ check, detail });

// ── Ground truth ────────────────────────────────────────────────────────────

const docRoutes = new Set(
  DOCS.filter((f) => f !== "docs.tsx").map((f) =>
    f === "docs.index.tsx"
      ? "/docs"
      : "/docs/" +
        f
          .replace(/^docs\./, "")
          .replace(/\.tsx$/, "")
          .replace(/\./g, "/"),
  ),
);

const idsOf = (route) => {
  const file =
    route === "/docs"
      ? "docs.index.tsx"
      : "docs." + route.replace(/^\/docs\//, "").replace(/\//g, ".") + ".tsx";
  const p = path.join(ROUTES, file);
  return fs.existsSync(p)
    ? new Set([...read(p).matchAll(/<H[23]\s+id="([^"]+)"/g)].map((m) => m[1]))
    : null;
};

/** Sidebar groups, read from the shell so the docs' own nav is the source. */
const groupOfRoute = new Map();
for (const g of read("src/components/docs/DocsShell.tsx").matchAll(
  /label: "([^"]+)",\s*items: \[([\s\S]*?)\],\s*\}/g,
)) {
  for (const i of g[2].matchAll(/to: "([^"]+)"/g)) groupOfRoute.set(i[1], g[1]);
}

const toolIds = new Set(
  (read("src/lib/swarmRuntime.ts").match(/export type SwarmToolId =([\s\S]*?);/)?.[1] ?? "")
    .match(/"([a-z0-9_]+)"/g)
    ?.map((s) => s.replace(/"/g, "")) ?? [],
);

/** Signed-in app screens, e.g. /traces — docs deep-link into these. */
const appRoutes = new Set(
  fs
    .readdirSync(path.join(ROUTES, "_authenticated"))
    .filter((f) => f.endsWith(".tsx"))
    .map(
      (f) =>
        "/" +
        f
          .replace(/\.tsx$/, "")
          .replace(/_\./g, "/")
          .replace(/\./g, "/"),
    ),
);

/** Public pages, e.g. /engine-check. */
const publicRoutes = new Set(
  fs
    .readdirSync(ROUTES)
    .filter((f) => f.endsWith(".tsx") && !/^docs|^_/.test(f))
    .map((f) => "/" + f.replace(/\.tsx$/, "").replace(/\./g, "/")),
);

/**
 * The signed-in app's sidebar, group by group, as the docs describe it when
 * they write "Open X → Y". Kept here rather than derived because the rail is
 * assembled across several components; if it is reorganised, this list and the
 * pages that cite it move together, which is the point.
 */
const APP_NAV = {
  Overview: ["Dashboard"],
  Build: ["Agent Builder", "Knowledge Base", "Agent Chat", "Agent Swarms", "MCP Builder"],
  "Data & BI": [
    "AI Analyst",
    "Data Catalog",
    "Semantic Layer",
    "Metrics",
    "BI Workspace",
    "Developer workspace",
  ],
  Library: ["Prompt Library", "Skill Library"],
  Integrations: ["Integrations", "Web Embedding", "Secrets", "MCP Servers", "Model Registry"],
  Observability: [
    "Analytics",
    "Swarm Traces",
    "Traces & Logs",
    "Audit Log",
    "AI Budgets",
    "Monitoring",
  ],
  Experiment: ["Prompt Compare", "Evaluations", "Image Playground"],
  Admin: ["IAM", "Developer runtime"],
};

/** Tabs within a screen, for "Integrations → Apps" style page → tab paths. */
const PAGE_TABS = {
  Integrations: [
    "LLM Providers",
    "Data Sources",
    "Apps",
    "LLM Gateway",
    "Web Search",
    "Notifications",
    "Slack",
    "n8n Workflows",
  ],
  IAM: ["Users", "Groups", "Access", "Attributes", "Budgets", "SSO", "Settings"],
  "Knowledge Base": ["Vector Store", "Embedding", "Chunking", "Retrieval", "Documents", "Sources"],
  "RAG Settings": ["Vector Store", "Embedding", "Chunking", "Retrieval", "Documents", "Sources"],
  "Agent Builder": ["General", "Model", "Knowledge", "Memory", "Guardrails", "Tools"],
};

const apiRoutes = new Set(
  fs
    .readdirSync(path.join(ROUTES, "api"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => "/api/" + f.replace(/\.ts$/, "").split(".").join("/")),
);

/** Everything the runtime and deployment config can read. */
const envHaystack = (() => {
  const parts = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|dist|\.git/.test(p)) walk(p);
      } else if (/\.(ts|tsx|sh|yml|yaml)$/.test(e.name)) {
        // The doc pages themselves are not evidence. They live under
        // src/routes, so including them let a variable prove its own existence
        // by being mentioned — a typo validating against its own typo. Found
        // by mutating a documented variable and watching this check pass.
        if (!/^docs\./.test(e.name)) parts.push(read(p));
      }
    }
  };
  walk("src");
  walk("scripts");
  for (const f of [".env.example", "docker-compose.yml", "Dockerfile"])
    if (fs.existsSync(f)) parts.push(read(f));
  return parts.join("\n");
})();

// ── Checks ──────────────────────────────────────────────────────────────────

for (const f of DOCS) {
  const src = read(path.join(ROUTES, f));
  const page = f.replace(/^docs\.?/, "").replace(/\.tsx$/, "") || "index";

  // Links and anchors. Both spellings are in use: an inline "#hash" and
  // TanStack's own hash prop.
  const links = [
    ...[...src.matchAll(/to="(\/docs[^"#]*)#([^"]+)"/g)].map((m) => [m[1], m[2]]),
    ...[...src.matchAll(/to="(\/docs[^"#]*)"\s+hash="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  ];
  for (const m of src.matchAll(/\bto="(\/docs[^"]*)"/g)) {
    const route = m[1].split("#")[0];
    if (!docRoutes.has(route)) fail("dead link", `${page}: ${m[1]}`);
  }

  // Docs also link straight into the app — "open /traces" — and those were
  // unchecked because they do not start with /docs. Same failure, different
  // prefix: the route gets renamed and the link rots.
  for (const m of src.matchAll(/<DocLink[^>]*to="(\/[a-z0-9-]+)"/g)) {
    const t = m[1];
    if (t.startsWith("/docs")) continue;
    if (!appRoutes.has(t) && !publicRoutes.has(t)) fail("dead app link", `${page}: ${t}`);
  }
  for (const [route, hash] of links) {
    const ids = idsOf(route);
    if (ids && !ids.has(hash)) fail("dead anchor", `${page}: ${route}#${hash}`);
  }

  // The on-this-page rail keys off ids, so a duplicate collides and a heading
  // without one is unreachable from the rail.
  const h2 = [...src.matchAll(/<H2 id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(h2.filter((id, i) => h2.indexOf(id) !== i))];
  if (dupes.length) fail("duplicate heading id", `${page}: ${dupes.join(", ")}`);
  for (const tag of ["H2", "H3"]) {
    const bare = (src.match(new RegExp(`<${tag}>`, "g")) || []).length;
    if (bare) fail("heading without id", `${page}: ${bare} <${tag}> absent from the rail`);
  }

  // A page's eyebrow should name the sidebar group it is filed under.
  if (f !== "docs.tsx") {
    const route =
      f === "docs.index.tsx"
        ? "/docs"
        : "/docs/" +
          f
            .replace(/^docs\./, "")
            .replace(/\.tsx$/, "")
            .replace(/\./g, "/");
    const eyebrow = src.match(/eyebrow="([^"]+)"/)?.[1];
    const group = groupOfRoute.get(route);
    if (group && eyebrow && eyebrow !== group)
      fail("eyebrow mismatch", `${page}: "${eyebrow}" but filed under "${group}"`);
  }

  // "Open Observe → Budgets" is a claim about the app's sidebar, and it was
  // wrong on both halves: the group is Observability and the item is AI
  // Budgets. Checked from APP_NAV below, which mirrors the real rail.
  //
  // Only claims whose left side is a known group are judged, because the same
  // arrow is also used for page → tab paths ("Integrations → Apps") and for
  // prose. A wrong group name therefore has to be caught by its right side —
  // which is why the item list is checked in both directions.
  // Scoped to <strong>…</strong>, which is how these pages write a nav path.
  // Matching bare prose instead made the capture run into the sentence and
  // could not tell a route from a turn of phrase.
  for (const m of src.matchAll(/<strong>([^<]*(?:→|&rarr;)[^<]*)<\/strong>/g)) {
    const parts = m[1]
      .replace(/&amp;/g, "&")
      .split(/→|&rarr;/)
      .map((t) => t.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (parts.length < 2) continue;
    const [first, second, third] = parts;
    const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
    const has = (names, v) => names.some((i) => eq(i, v));
    const path = parts.join(" → ");

    // Screen names are matched case-insensitively: pages write "RAG settings"
    // where the tab list says "RAG Settings", and that is not an error.
    const tabsOf = (name) => Object.entries(PAGE_TABS).find(([k]) => eq(k, name))?.[1] ?? null;

    // "Integrations" is both a sidebar group and a screen with tabs, so
    // "Integrations → Apps" and "Integrations → Secrets" are both correct.
    // Accept whichever reading holds rather than privileging one.
    const asGroup = APP_NAV[first] ? has(APP_NAV[first], second) : false;
    const asPage = tabsOf(first) ? has(tabsOf(first), second) : false;

    // A screen can nest one level before its tabs — the Knowledge Base page
    // reaches its tabs through a RAG Settings panel — so a middle segment that
    // is itself a known tab set is followed rather than rejected.
    const viaPanel = tabsOf(second) ? (third ? has(tabsOf(second), third) : true) : false;

    if (asGroup || asPage || viaPanel) {
      if (asGroup && !viaPanel && third && tabsOf(second) && !has(tabsOf(second), third))
        fail("bad nav path", `${page}: "${path}" — "${second}" has no "${third}" tab`);
    } else if (APP_NAV[first] || tabsOf(first)) {
      const real = Object.entries(APP_NAV).find(([, items]) => has(items, second))?.[0];
      fail(
        "bad nav path",
        `${page}: "${path}" — ${real ? `"${second}" is under "${real}"` : `no "${second}" under "${first}"`}`,
      );
    } else {
      // Neither a sidebar group nor a screen with tabs. A nav path has to start
      // at one of those, so this is a group that was renamed or never existed.
      const real = Object.entries(APP_NAV).find(([, items]) => has(items, second))?.[0];
      if (real)
        fail(
          "bad nav path",
          `${page}: "${path}" — "${second}" is under "${real}", and there is no "${first}" group`,
        );
      else if (
        Object.values(APP_NAV)
          .flat()
          .some((i) => i.toLowerCase().endsWith(second.toLowerCase()))
      )
        fail(
          "bad nav path",
          `${page}: "${path}" — no "${first}" group, and no item named exactly "${second}"`,
        );
    }
  }

  // Every widget the BI picker offers should appear on the BI page. The two
  // that plot nothing — a Markdown text block and an image — were missing for
  // exactly the reason they are easy to miss: the page is organised around
  // chart types, and these are not charts.
  if (page === "bi") {
    const meta = read("src/lib/biVizMeta.ts");
    const seg = meta.slice(
      meta.indexOf("VIZ_REQUIREMENTS"),
      meta.indexOf("\n};", meta.indexOf("VIZ_REQUIREMENTS")),
    );
    const widgets = [...new Set([...seg.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]))];
    const absent = widgets.filter((w) => !new RegExp(`<C[^>]*>${w}</C>`).test(src));
    if (absent.length) fail("undocumented widget", `${page}: ${absent.join(", ")}`);
  }

  // Tool ids named in prose must exist in the registry.
  for (const m of src.matchAll(/<C[^>]*>([a-z][a-z0-9_]{3,})<\/C>/g)) {
    if (/^(kb|web|mcp|sql|metric|n8n)_/.test(m[1]) && !toolIds.has(m[1]))
      fail("unknown tool id", `${page}: ${m[1]}`);
  }

  // Where a page promises the whole list, it has to be the whole list. Core
  // concepts introduced seven of the eleven tools under "Tools available
  // here", which reads as complete and quietly taught that four do not exist.
  if (page === "concepts") {
    const seg = src.slice(src.indexOf('<H2 id="tools">'), src.indexOf('<H2 id="retrieval">'));
    const listed = new Set([...seg.matchAll(/<C[^>]*>([a-z][a-z0-9_]+)<\/C>/g)].map((m) => m[1]));
    const absent = [...toolIds].filter((t) => !listed.has(t));
    if (absent.length) fail("incomplete tool table", `${page}: missing ${absent.join(", ")}`);
  }

  // Endpoints must resolve to a route file, allowing for path params written
  // as a placeholder.
  for (const m of src.matchAll(/\/api\/[a-z0-9/._$-]+/g)) {
    const ep = m[0].replace(/[.,)]+$/, "");
    if (apiRoutes.has(ep)) continue;
    if (ep.endsWith("/") && [...apiRoutes].some((r) => r.startsWith(ep))) continue;
    const matches = [...apiRoutes].some((r) =>
      new RegExp("^" + r.replace(/\$[a-z]+/gi, "[^/]+") + "$", "i").test(ep),
    );
    if (!matches) fail("unknown endpoint", `${page}: ${ep}`);
  }

  // A documented variable the runtime never reads is worse than an
  // undocumented one: it gets set, nothing happens, and there is nothing to
  // search for.
  //
  // Not every SHOUTING_NAME is one, though. The docs also teach users to name
  // their OWN things in the same style — a Secrets entry, a binding on an MCP
  // deploy — and those are examples that should not resolve to anything. They
  // are recognisable by the {{secret:NAME}} syntax that references them, so
  // any name used that way on the page is treated as the user's, not ours.
  const userNamed = new Set(
    [...src.matchAll(/\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]),
  );
  const teachesSecretNaming = /secret:/.test(src);
  for (const m of src.matchAll(/<C[^>]*>([A-Z][A-Z0-9_]{5,})<\/C>/g)) {
    const v = m[1];
    if (
      /^(SELECT|INSERT|UPDATE|DELETE|CREATE|GROUP|ORDER|WHERE|DONE|PASS|FAIL|TODO|NOTE|JSON|HTTP|HTTPS|POST|GET)$/.test(
        v,
      )
    )
      continue;
    if (userNamed.has(v)) continue;
    if (envHaystack.includes(v)) continue;
    // On a page whose whole subject is naming your own secrets, an unknown
    // name is the example working as intended.
    if (teachesSecretNaming && page === "secrets") continue;
    fail("unknown env var", `${page}: ${v}`);
  }
}

// The search box filters a generated index. If a heading is added and the
// index is not rebuilt, that section is simply unfindable — silently, since
// the page itself looks perfect.
{
  const gen = spawnSync(process.execPath, ["scripts/build-docs-index.mjs", "--check"], {
    encoding: "utf8",
  });
  if (gen.status !== 0) fail("stale search index", "run: npm run docs:index");
}

// ── Report ──────────────────────────────────────────────────────────────────

const byCheck = new Map();
for (const x of findings) byCheck.set(x.check, [...(byCheck.get(x.check) ?? []), x.detail]);

if (!findings.length) {
  console.log(`docs check: ${DOCS.length} pages, no problems found.`);
  process.exit(0);
}
for (const [check, list] of byCheck) {
  console.log(`\n${check} (${list.length})`);
  if (!quiet) for (const d of list) console.log(`  ${d}`);
}
console.log(`\n${findings.length} problem(s) across ${DOCS.length} doc pages.`);
process.exit(1);
