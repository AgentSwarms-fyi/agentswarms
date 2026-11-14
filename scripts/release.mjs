#!/usr/bin/env node
// Releases (R469). docs/RELEASING.md is the maintainer's guide; in short:
//
//   npm run release:prepare -- 1.7.0
//       package.json and package-lock.json say 1.7.0; the CHANGELOG's
//       "Unreleased" entries become "## 1.7.0 — <today>", with a marker where
//       the release's summary paragraph goes. Write the summary, commit, tag
//       v1.7.0 and push the tag: .github/workflows/release.yml does the rest.
//
//   node scripts/release.mjs plan                (the workflow's first job)
//       Reads GITHUB_REF_TYPE and GITHUB_REF_NAME. On a tag: refuses a tag that
//       is not v<package.json version>, a CHANGELOG with no section for it, and
//       a section whose summary was never written. Prints the version, the
//       image tags, and the build matrix (deploy/release/images.json x the two
//       architectures) as `key=value` lines for $GITHUB_OUTPUT. Anywhere else
//       (a manual run): a rehearsal that builds and tests but publishes nothing.
//
//   node scripts/release.mjs notes <version> --released <dir> [--previous <tag>]
//       The GitHub Release's text: the CHANGELOG section, then each image with
//       its digest and how to check its signature, then the migrations since
//       the previous release and any that remove something (-- contract:).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SUMMARY_MARKER =
  "**Summary: replace this line with one paragraph on what this release is for.**";
const RUNNERS = { "linux/amd64": "ubuntu-24.04", "linux/arm64": "ubuntu-24.04-arm" };

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) throw new Error(`"${v}" is not a version (MAJOR.MINOR.PATCH, optionally -prerelease)`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** <0, 0 or >0, semver order (a prerelease sorts before its release). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The docker tags a version is published under. `released` is every version
 * already tagged: `latest` moves only to the newest release, and `X.Y` only to
 * the newest of its line, so a patch on an older line moves neither back.
 */
export function imageTags(version, released = []) {
  const v = parseVersion(version);
  if (v.pre) return [version];
  const releases = released.filter((r) => VERSION_RE.test(r) && parseVersion(r).pre === null);
  const newer = (r) => compareVersions(r, version) > 0;
  const tags = [version];
  const line = (r) => {
    const p = parseVersion(r);
    return p.major === v.major && p.minor === v.minor;
  };
  if (!releases.some((r) => line(r) && newer(r))) tags.push(`${v.major}.${v.minor}`);
  if (!releases.some(newer)) tags.push("latest");
  return tags;
}

/** [start, end) of the section headed `heading` (a line starting with it). */
function sectionBounds(text, startsWith) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(startsWith));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}

/** The body of the CHANGELOG section for `version`, without its heading. */
export function changelogSection(text, version) {
  const b = sectionBounds(text, `## ${version} — `);
  if (!b) return null;
  return b.lines
    .slice(b.start + 1, b.end)
    .join("\n")
    .trim();
}

/** Moves "## Unreleased" into a section for `version`, dated `date`. */
export function prepareChangelog(text, version, date) {
  const b = sectionBounds(text, "## Unreleased");
  if (!b) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  if (sectionBounds(text, `## ${version} — `))
    throw new Error(`CHANGELOG.md already has ${version}`);
  const body = b.lines
    .slice(b.start + 1, b.end)
    .join("\n")
    .trim();
  if (!body || body === "Nothing yet.") throw new Error("nothing under Unreleased to release");
  const before = b.lines.slice(0, b.start);
  const after = b.lines.slice(b.end);
  return [
    ...before,
    "## Unreleased",
    "",
    "Nothing yet.",
    "",
    `## ${version} — ${date}`,
    "",
    SUMMARY_MARKER,
    "",
    body,
    "",
    ...after,
  ].join("\n");
}

/** package.json and package-lock.json text with the version set. */
export function setPackageVersion(pkgText, lockText, version) {
  const pkg = JSON.parse(pkgText);
  pkg.version = version;
  const lock = JSON.parse(lockText);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return {
    pkg: `${JSON.stringify(pkg, null, 2)}\n`,
    lock: `${JSON.stringify(lock, null, 2)}\n`,
  };
}

/**
 * What the release workflow does for this ref. Throws, with the reason, when
 * a tag must not be published.
 */
export function planRelease({
  refType,
  refName,
  sha,
  pkgVersion,
  changelog,
  manifest,
  released = [],
}) {
  const tagged = refType === "tag";
  let version;
  if (tagged) {
    if (refName !== `v${pkgVersion}`) {
      throw new Error(
        `tag ${refName} does not match package.json (${pkgVersion}): run npm run release:prepare first`,
      );
    }
    version = pkgVersion;
    const section = changelogSection(changelog, version);
    if (section === null) throw new Error(`CHANGELOG.md has no "## ${version} — <date>" section`);
    if (section.includes(SUMMARY_MARKER))
      throw new Error(`CHANGELOG.md: write the ${version} summary before tagging`);
  } else {
    version = `${pkgVersion}-dev.${(sha ?? "local").slice(0, 7)}`;
  }
  const matrix = [];
  for (const img of manifest.images) {
    for (const platform of manifest.platforms) {
      matrix.push({
        image: img.name,
        title: img.title,
        context: img.context,
        dockerfile: img.dockerfile,
        smoke: img.smoke,
        platform,
        arch: platform.split("/")[1],
        runner: RUNNERS[platform],
      });
    }
  }
  return {
    version,
    publish: tagged,
    prerelease: parseVersion(version).pre !== null,
    tags: tagged ? imageTags(version, released) : [],
    registry: manifest.registry,
    source: manifest.source,
    matrix: { include: matrix },
    images: manifest.images.map((i) => i.name),
  };
}

/** The `-- contract:` lines in a migration (what it removes on purpose). */
export function contractsIn(sql) {
  return [...sql.matchAll(/^[ \t]*--[ \t]*contract:[ \t]*(public\.[A-Za-z0-9_.]+)/gim)].map((m) =>
    m[1].replace(/\.+$/, ""),
  );
}

/** The GitHub Release's markdown. */
/** GitHub refuses a release whose body is longer than this (HTTP 422). */
export const RELEASE_BODY_LIMIT = 125_000;

/**
 * A version's section, cut to what a release page must say when the whole of
 * it does not fit: the summary, the Upgrading entries, and where the rest is.
 * 1.7.0's section ran past the limit, and its release failed to publish on
 * the last step (R483).
 */
export function condensedSection(section, version, repo) {
  const firstHeading = section.search(/^### /m);
  const summary = (firstHeading === -1 ? section : section.slice(0, firstHeading)).trim();
  const up = /^### Upgrading[ \t]*$/m.exec(section);
  let upgrading = "";
  if (up) {
    const rest = section.slice(up.index);
    const next = rest.slice(1).search(/^### /m);
    upgrading = (next === -1 ? rest : rest.slice(0, next + 1)).trim();
  }
  const link = `https://github.com/${repo}/blob/v${version}/CHANGELOG.md`;
  return [
    summary,
    "",
    `Everything ${version} changes, adds and fixes is in [CHANGELOG.md](${link}): the whole of it is longer than a GitHub release may be.`,
    "",
    upgrading,
  ]
    .join("\n")
    .trim();
}

export function releaseNotes({ version, changelog, released, repo, previous, migrations }) {
  const section = changelogSection(changelog, version);
  if (section === null) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const full = renderNotes(section, { released, repo, previous, migrations });
  if (full.length <= RELEASE_BODY_LIMIT) return full;
  const short = renderNotes(condensedSection(section, version, repo), {
    released,
    repo,
    previous,
    migrations,
  });
  if (short.length > RELEASE_BODY_LIMIT) {
    throw new Error(
      `The release notes are ${short.length} characters even without the full changelog, over GitHub's ${RELEASE_BODY_LIMIT}: shorten ${version}'s summary or Upgrading entries`,
    );
  }
  return short;
}

function renderNotes(section, { released, repo, previous, migrations }) {
  const out = [section, "", "## Images", ""];
  out.push(
    `Each is built for linux/amd64 and linux/arm64, signed with Sigstore (keyless, from this repository's release workflow), and carries an SBOM and build provenance.`,
    "",
    "| Image | Tags | Digest |",
    "| --- | --- | --- |",
  );
  for (const r of released) {
    out.push(
      `| \`${r.repository}\` | ${r.tags.map((t) => `\`${t}\``).join(" ")} | \`${r.digest}\` |`,
    );
  }
  const mirrors = released.flatMap((r) => r.mirrors ?? []);
  if (mirrors.length) {
    out.push("", "Mirrored to Amazon ECR Public, same digests:", "");
    for (const m of mirrors) out.push(`- \`${m}\``);
  }
  const first = released[0];
  if (first) {
    out.push(
      "",
      "Check a signature before you run an image:",
      "",
      "```bash",
      `cosign verify ${first.repository}@${first.digest} \\`,
      `  --certificate-identity-regexp '^https://github\\.com/${repo.replace(/\./g, "\\.")}/\\.github/workflows/release\\.yml@refs/tags/v' \\`,
      "  --certificate-oidc-issuer https://token.actions.githubusercontent.com",
      "```",
    );
  }
  out.push("", "## Database", "");
  if (!migrations || migrations.length === 0) {
    out.push(`No new migrations${previous ? ` since ${previous}` : ""}.`);
  } else {
    out.push(
      `${migrations.length} new migration${migrations.length === 1 ? "" : "s"}${previous ? ` since ${previous}` : ""}. ` +
        "They run before the new app starts: `npx supabase db push --remote`, or the `db-migrate` image as a one-off task. " +
        "The previous release runs on the new schema, so rolling the app back one release needs no database change " +
        '(docs/DEPLOYMENT.md, "Rolling back one release").',
      "",
    );
    for (const m of migrations) out.push(`- \`${m.name}\``);
    const removes = migrations.flatMap((m) => m.contracts.map((c) => `\`${c}\` (${m.name})`));
    if (removes.length) {
      out.push(
        "",
        "**Removed on purpose** (the previous release may not run where it used these):",
        "",
      );
      for (const r of removes) out.push(`- ${r}`);
    }
  }
  return `${out.join("\n").trim()}\n`;
}

// ── commands ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function cmdPrepare(args) {
  const version = args[0];
  if (!version) throw new Error("usage: npm run release:prepare -- <version> [--date YYYY-MM-DD]");
  parseVersion(version);
  const current = readJson("package.json").version;
  if (compareVersions(version, current) <= 0)
    throw new Error(`${version} is not after the current ${current}`);
  const di = args.indexOf("--date");
  const date = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);
  const changelog = prepareChangelog(readFileSync("CHANGELOG.md", "utf8"), version, date);
  const { pkg, lock } = setPackageVersion(
    readFileSync("package.json", "utf8"),
    readFileSync("package-lock.json", "utf8"),
    version,
  );
  writeFileSync("CHANGELOG.md", changelog);
  writeFileSync("package.json", pkg);
  writeFileSync("package-lock.json", lock);
  console.log(`Prepared ${version} (was ${current}). Next:`);
  console.log(`  1. CHANGELOG.md: replace the summary marker under "## ${version} — ${date}".`);
  console.log(`  2. git commit -am "Release ${version}"`);
  console.log(`  3. git tag -a v${version} -m "AgentSwarms ${version}"`);
  console.log(
    `  4. git push origin main v${version}   (the tag starts .github/workflows/release.yml)`,
  );
}

function cmdPlan() {
  // Every version tag here (the workflow checks out the whole history).
  const released = git(["tag", "--list", "v[0-9]*"])
    .split("\n")
    .map((t) => t.trim().replace(/^v/, ""))
    .filter(Boolean);
  const plan = planRelease({
    refType: process.env.GITHUB_REF_TYPE ?? "",
    refName: process.env.GITHUB_REF_NAME ?? "",
    sha: process.env.GITHUB_SHA,
    pkgVersion: readJson("package.json").version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    manifest: readJson("deploy/release/images.json"),
    released,
  });
  const out = {
    version: plan.version,
    publish: String(plan.publish),
    prerelease: String(plan.prerelease),
    tags: plan.tags.join(" "),
    registry: plan.registry,
    source: plan.source,
    matrix: JSON.stringify(plan.matrix),
    images: JSON.stringify(plan.images),
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function cmdNotes(args) {
  const version = args[0];
  const ri = args.indexOf("--released");
  const dir = ri >= 0 ? args[ri + 1] : "released";
  const pi = args.indexOf("--previous");
  let previous = pi >= 0 ? args[pi + 1] : null;
  if (!previous) {
    try {
      previous = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `v${version}^`]);
    } catch {
      previous = null;
    }
  }
  const released = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => readJson(path.join(dir, f)))
    : [];
  let migrations = [];
  if (previous) {
    const added = git([
      "diff",
      "--name-only",
      "--diff-filter=A",
      `${previous}..v${version}`,
      "--",
      "supabase/migrations",
    ])
      .split("\n")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    migrations = added.map((f) => ({
      name: path.basename(f),
      contracts: contractsIn(readFileSync(f, "utf8")),
    }));
  }
  const repo = (readJson("deploy/release/images.json").source ?? "").replace(
    /^https:\/\/github\.com\//,
    "",
  );
  process.stdout.write(
    releaseNotes({
      version,
      changelog: readFileSync("CHANGELOG.md", "utf8"),
      released,
      repo,
      previous,
      migrations,
    }),
  );
}

function main(argv) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === "prepare") cmdPrepare(args);
    else if (cmd === "plan") cmdPlan();
    else if (cmd === "notes") cmdNotes(args);
    else
      throw new Error(
        "usage: release.mjs prepare <version> | plan | notes <version> --released <dir>",
      );
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
