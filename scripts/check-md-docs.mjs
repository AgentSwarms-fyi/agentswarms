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

const quiet = process.argv.includes("--quiet");
const findings = [];
const fail = (check, detail) => findings.push({ check, detail });
const read = (p) => fs.readFileSync(p, "utf8");

const FILES = [
  "README.md",
  "sdk/react/README.md",
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
