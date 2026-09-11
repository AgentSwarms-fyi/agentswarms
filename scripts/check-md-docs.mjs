#!/usr/bin/env node
// Consistency checks for the markdown documentation (docs/*.md, README.md,
// and the SDK README) — the corpus someone reads on GitHub before installing.
//
// Same reasoning as scripts/check-docs.mjs, which covers the in-app pages:
// these files make checkable claims — a file path, an npm script, an
// environment variable, a link to another document — and every documentation
// bug found in this campaign has been drift, not bad writing. The claims that
// can be checked mechanically now are.
//
//   node scripts/check-md-docs.mjs           list every finding
//   node scripts/check-md-docs.mjs --quiet   summary only
import fs from "node:fs";
import path from "node:path";

import { PAGE_TABS, readAppNav } from "./lib/navPaths.mjs";

const quiet = process.argv.includes("--quiet");
const findings = [];
const fail = (check, detail) => findings.push({ check, detail });
const read = (p) => fs.readFileSync(p, "utf8");

const FILES = [
  "README.md",
  "sdk/react/README.md",
  // The files someone opens BEFORE the docs: the contribution and reporting
  // paths, the roadmap, the credits. They were the one part of the corpus
  // nothing checked, and they are read by people with no way to tell a stale
  // instruction from a current one. CONTRIBUTING alone names npm scripts and
  // file paths in every other paragraph.
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "ROADMAP.md",
  "ACKNOWLEDGEMENTS.md",
  // Service-local READMEs, for the same reason: they describe a directory
  // whose contents move.
  "docgen-service/README.md",
  "docs/screenshots/README.md",
  "src/assets/README.md",
  ...fs
    .readdirSync("docs")
    // The adversarial log is a historical record of an audit, quoting file
    // names in their on-disk dot form and deliberately hostile strings.
    // Judging it against today's tree produces only noise.
    .filter((f) => f.endsWith(".md") && f !== "ADVERSARIAL_LOG.md")
    .map((f) => "docs/" + f),
  // readdirSync returns the top level only, so the engineering chapters would
  // otherwise be the one part of the corpus nothing checks — which is exactly
  // where stale file paths accumulate, since every page is about the source.
  ...fs
    .readdirSync("docs/engineering")
    .filter((f) => f.endsWith(".md"))
    .map((f) => "docs/engineering/" + f),
];

/**
 * All-caps names that look like our environment variables and are not:
 * configuration of services we sit on top of, or database catalog objects.
 * Each entry earns a reason.
 */
const FOREIGN_NAMES = [
  /^GOTRUE_/, // Supabase Auth (GoTrue) server config — set on that service, not here
  /^USER_TAB_COLUMNS$/, // Oracle's data-dictionary view, quoted in the Oracle connector notes
];

// ── Ground truth ────────────────────────────────────────────────────────────

const pkg = JSON.parse(read("package.json"));
const npmScripts = new Set(Object.keys(pkg.scripts ?? {}));

const APP_NAV = readAppNav();

/**
 * Every screen a nav path can start at, and what sits one level inside it.
 *
 * Merged, not layered: "Integrations" is BOTH a sidebar group (holding Web
 * Embedding, Secrets, …) and a screen with tabs (Apps, Slack, …), and building
 * this with a later entry overwriting an earlier one hid the group's items
 * behind the tabs — which reported four correct paths as wrong.
 */
const NAV_PARENTS = new Map();
for (const [k, v] of [...Object.entries(APP_NAV), ...Object.entries(PAGE_TABS)]) {
  NAV_PARENTS.set(k, [...(NAV_PARENTS.get(k) ?? []), ...v]);
}

const apiRoutes = new Set(
  fs
    .readdirSync("src/routes/api")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => "/api/" + f.replace(/\.ts$/, "").split(".").join("/")),
);

/** Everything the runtime and deploy tooling read — markdown is not evidence. */
const envHaystack = (() => {
  const parts = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|dist|\.git/.test(p)) walk(p);
      } else if (/\.(ts|tsx|sh|mjs|yml|yaml|sql|py)$/.test(e.name)) parts.push(read(p));
    }
  };
  walk("src");
  walk("scripts");
  walk("supabase");
  walk("docgen-service");
  walk("deploy");
  walk("docker");
  // TESTING.md documents variables the test and eval harnesses read
  // (EVAL_BASE_URL, DUCKDB_DIFFERENCES); leaving these out declared them all
  // unknown.
  walk("tests");
  walk("evals");
  for (const f of [".env.example", "docker-compose.yml", "Dockerfile"])
    if (fs.existsSync(f)) parts.push(read(f));
  return parts.join("\n");
})();

/**
 * GitHub-style anchor for a heading.
 *
 * GitHub does NOT collapse runs of whitespace — every space becomes its own
 * hyphen, so "Web search & browsing" slugs to web-search--browsing with two
 * hyphens where the ampersand fell out. The first version collapsed them and
 * declared four perfectly good anchors dead.
 */
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");

const anchorsOf = new Map();
for (const f of FILES) {
  if (!fs.existsSync(f)) continue;
  const heads = [...read(f).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
  anchorsOf.set(path.resolve(f), new Set(heads));
}

// ── Checks ──────────────────────────────────────────────────────────────────

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = read(file);
  const dir = path.dirname(file);
  const name = file.replace(/^docs\//, "");

  // Fenced code blocks make bad evidence for link/path checks (they quote
  // hypothetical paths on purpose), so strip them for those passes but keep
  // them for env vars, where a fence is exactly where a variable is set.
  const prose = src.replace(/```[\s\S]*?```/g, "");

  // 1. Relative markdown links resolve, including their anchors.
  for (const m of prose.matchAll(/\]\(([^)\s#]+\.md)(#[^)\s]+)?\)/g)) {
    const target = path.resolve(dir, m[1]);
    if (!fs.existsSync(target)) {
      fail("dead md link", `${name}: ${m[1]}`);
      continue;
    }
    if (m[2]) {
      const set = anchorsOf.get(target);
      if (set && !set.has(m[2].slice(1))) fail("dead md anchor", `${name}: ${m[1]}${m[2]}`);
    }
  }

  // 2. Same-file anchors.
  for (const m of prose.matchAll(/\]\(#([^)\s]+)\)/g)) {
    const set = anchorsOf.get(path.resolve(file));
    if (set && !set.has(m[1])) fail("dead same-file anchor", `${name}: #${m[1]}`);
  }

  // 3. Backticked repo paths exist. Only unambiguous shapes are judged:
  //    something with a slash that starts like a repo directory.
  for (const m of src.matchAll(
    /`((?:src|scripts|docs|supabase|deploy|docker|sdk|evals|tests|public)\/[^`\s]+)`/g,
  )) {
    const p = m[1].replace(/[.,;:]+$/, "");
    if (/[*{$<>]/.test(p)) continue; // globs and placeholders are examples
    // supabase/postgres is the Docker image the deployment doc pins, and
    // supabase/docker is the directory inside Supabase's own cloned repo —
    // both look exactly like paths in this tree and are not.
    if (/^supabase\/(postgres|docker)\b/.test(p)) continue;
    if (!fs.existsSync(p)) fail("missing path", `${name}: ${p}`);
  }

  // 4. npm run <script> — every script named must exist.
  for (const m of src.matchAll(/npm run ([a-z0-9:._-]+)/g)) {
    if (!npmScripts.has(m[1])) fail("unknown npm script", `${name}: npm run ${m[1]}`);
  }

  // 5. API endpoints named in prose resolve to a route. /api/v1/… is exempt:
  //    this app has no v1 prefix, so anything shaped that way is another
  //    service's API being quoted (OpenRouter's /api/v1/models, for one).
  for (const m of src.matchAll(/`(\/api\/[a-z0-9/._$-]+)`/g)) {
    const ep = m[1].replace(/[.,)]+$/, "");
    if (ep.startsWith("/api/v1/")) continue;
    const hit =
      apiRoutes.has(ep) ||
      (ep.endsWith("/") && [...apiRoutes].some((r) => r.startsWith(ep))) ||
      [...apiRoutes].some((r) =>
        new RegExp("^" + r.replace(/\$[a-z]+/gi, "[^/]+") + "$", "i").test(ep),
      );
    if (!hit) fail("unknown endpoint", `${name}: ${ep}`);
  }

  // 6. Environment variables the runtime never reads. The same user-named
  //    exemption as the in-app checker: {{secret:NAME}} names are the
  //    reader's own.
  // A document that declares itself a design is describing variables that do
  // not exist yet, on purpose — KEY_MANAGEMENT.md opens with "Status: design.
  // Not implemented." and then specifies KMS_PROVIDER. Honouring that marker
  // beats maintaining an allowlist of everything a design might name.
  const isDesignDoc = /\*\*Status: design\b/i.test(src.slice(0, 600));
  const userNamed = new Set(
    [...src.matchAll(/\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]),
  );
  for (const m of src.matchAll(/`([A-Z][A-Z0-9_]{5,})`/g)) {
    const v = m[1];
    if (
      /^(SELECT|INSERT|UPDATE|DELETE|CREATE|WHERE|GROUP|ORDER|LIMIT|POST|GET|PUT|HEAD|TODO|NOTE|WARNING|ERROR|LEFT|INNER|NULLIF|EXISTS|HAVING|JSON|YAML|HTTPS?|README|LICENSE|GENERATED)$/.test(
        v,
      )
    )
      continue;
    if (userNamed.has(v)) continue;
    if (isDesignDoc) continue;
    if (FOREIGN_NAMES.some((re) => re.test(v))) continue;
    if (!envHaystack.includes(v)) fail("unknown env var", `${name}: ${v}`);
  }

  // 7. Documented DEFAULTS, not just documented names. A table row saying a
  //    variable defaults to 500000 is the number an operator plans capacity
  //    against, and it is the half most likely to rot: the name survives a
  //    change to the value, so the check above stays green while the table
  //    starts lying. Checked by looking for the same number near a read of
  //    that variable, which is where a default is written.
  for (const m of src.matchAll(/\|\s*`([A-Z][A-Z0-9_]{3,})`\s*\|[^|]*?`([0-9][0-9_,]*)`/g)) {
    const [, v, shown] = m;
    if (FOREIGN_NAMES.some((re) => re.test(v))) continue;
    if (isDesignDoc) continue;
    const want = shown.replace(/[,_]/g, "");
    let found = false;
    for (const hit of envHaystack.matchAll(new RegExp(v, "g"))) {
      const window = envHaystack.slice(Math.max(0, hit.index - 120), hit.index + 400);
      // Sizes are written as arithmetic far more often than as a literal:
      // 100 * 1024 * 1024 is how a 100 MB cap appears in code, and comparing
      // digits alone called the one correct row in the corpus a lie.
      const literals = [...window.matchAll(/\b[0-9][0-9_]*(?:\s*\*\s*[0-9][0-9_]*)*\b/g)].map((n) =>
        String(
          n[0]
            .replace(/_/g, "")
            .split("*")
            .map((x) => Number(x.trim()))
            .reduce((a, b) => a * b, 1),
        ),
      );
      if (literals.includes(want)) {
        found = true;
        break;
      }
    }
    if (!found) fail("documented default not in the code", `${name}: ${v} = ${shown}`);
  }

  // 8. "Open Admin → Developer runtime" is a claim about the sidebar, checked
  //    against src/lib/appNav.ts. The in-app pages have had this check for a
  //    while; these documents make the same claim — 19 times for that one item
  //    — in running prose, and nothing read them. A rule enforced on one
  //    corpus is a rule an author escapes by writing in the other.
  //
  //    Only the group → item hop is judged, and only by PREFIX. Prose has no
  //    boundaries: a path runs into the sentence after it ("…under Admin →
  //    Developer runtime and takes effect on the next job") and is wrapped
  //    mid-path by the formatter, so demanding a clean segment produced four
  //    findings that were all correct paths split across two lines. A prefix
  //    match ignores the trailing sentence and still catches the thing this is
  //    for: an item that was renamed and left behind in the docs.
  const flowed = prose.replace(/[*_`]/g, " ").replace(/\s+/g, " ");
  for (const m of flowed.matchAll(/([A-Za-z0-9&/ -]{1,60}?)\s*→\s*([A-Za-z0-9&/ -]{1,60})/g)) {
    const words = m[1].trim().split(" ");
    const parent = [4, 3, 2, 1]
      .map((n) => words.slice(-n).join(" "))
      .find((cand) => NAV_PARENTS.has(cand));
    if (!parent) continue;
    const after = m[2].trim().split(" ");
    // A nav item is a proper noun. An arrow into lowercase prose is somebody
    // describing a drill-down in words — "Agent Builder → the sql_query tool →
    // tables" — and judging it would mean deciding what English may say.
    if (!/^[A-Z0-9]/.test(after[0] ?? "")) continue;
    const children = NAV_PARENTS.get(parent);
    const named = [1, 2, 3, 4].some((n) => {
      const cand = after.slice(0, n).join(" ").toLowerCase();
      return children.some((c) => c.toLowerCase() === cand);
    });
    if (!named) {
      const real = [...NAV_PARENTS].find(([, items]) =>
        items.some((i) => i.toLowerCase() === after.slice(0, 2).join(" ").toLowerCase()),
      )?.[0];
      fail(
        "bad nav path",
        `${name}: "${parent} → ${after.slice(0, 3).join(" ")}…" — ${
          real ? `that is under "${real}"` : `nothing under "${parent}" is called that`
        }`,
      );
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const byCheck = new Map();
for (const x of findings) byCheck.set(x.check, [...(byCheck.get(x.check) ?? []), x.detail]);

if (!findings.length) {
  console.log(
    `md docs check: ${FILES.filter((f) => fs.existsSync(f)).length} files, no problems found.`,
  );
  process.exit(0);
}
for (const [check, list] of byCheck) {
  console.log(`\n${check} (${list.length})`);
  if (!quiet) for (const d of list) console.log(`  ${d}`);
}
console.log(`\n${findings.length} problem(s).`);
process.exit(1);
