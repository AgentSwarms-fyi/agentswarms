#!/usr/bin/env node
// Do the commands and paths the docs tell you to run actually exist?
//
//   node scripts/check-doc-commands.mjs
//
// check-docs.mjs already validates the in-app pages against the code: links
// resolve, anchors exist, documented environment variables are ones the runtime
// reads. This covers the other class of claim that rots silently and that no
// reader can verify without trying it — an `npm run` whose script was renamed, a
// `bash scripts/…` that moved, a `deploy/**.yaml` that was deleted, a
// `--profile` that no longer exists in docker-compose.yml.
//
// It runs over BOTH doc sets, because the in-repo Markdown and the in-app pages
// drift apart exactly when someone updates one of them.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/…" and
// every lookup silently finds nothing, which reads as a clean bill of health.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(path.join(REPO, p), "utf8");
const has = (p) => existsSync(path.join(REPO, p));

const docs = [
  "README.md",
  ...readdirSync(path.join(REPO, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  ...readdirSync(path.join(REPO, "src/routes"))
    .filter((f) => /^docs\..*\.tsx$/.test(f))
    .map((f) => `src/routes/${f}`),
];

const compose = has("docker-compose.yml") ? rd("docker-compose.yml") : "";
const npmScripts = new Set(Object.keys(JSON.parse(rd("package.json")).scripts ?? {}));

const problems = [];
const check = (cond, msg) => cond || problems.push(msg);

for (const doc of docs) {
  const text = rd(doc);
  const at = (m) => `${doc}: ${m}`;

  for (const [, name] of text.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
    check(npmScripts.has(name), at(`npm run ${name} — no such script in package.json`));
  }
  for (const [, file] of text.matchAll(/(?:bash |sh |\.\/|node )(scripts\/[A-Za-z0-9._-]+)/g)) {
    check(has(file), at(`${file} — file does not exist`));
  }
  for (const [, file] of text.matchAll(/(deploy\/[A-Za-z0-9._/-]+\.ya?ml)/g)) {
    check(has(file), at(`${file} — file does not exist`));
  }
  for (const [, profile] of text.matchAll(/--profile ([a-z]+)/g)) {
    check(
      compose.includes(profile),
      at(`--profile ${profile} — not declared in docker-compose.yml`),
    );
  }
}

const unique = [...new Set(problems)];
for (const p of unique) console.log(`  ${p}`);
console.log(
  unique.length
    ? `\ndoc command check: ${unique.length} problem(s) across ${docs.length} docs.`
    : `doc command check: ${docs.length} docs, no problems found.`,
);
process.exit(unique.length ? 1 : 0);
