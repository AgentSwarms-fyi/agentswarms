#!/usr/bin/env node
// Every package the built server imports is still installed after the image
// drops its dev dependencies (R469).
//
// The image's runtime stage keeps only production dependencies (`npm prune
// --omit=dev`). The server bundle (dist/server) imports the packages Vite left
// external by name, so a runtime import of a package listed under
// devDependencies would not fail the build: it would fail the first request
// that reaches that code, in production.
//
// Two passes, in the image's build stage:
//
//   node scripts/check-runtime-imports.mjs --record /tmp/imports.json   # before the prune
//   npm prune --omit=dev
//   node scripts/check-runtime-imports.mjs --verify /tmp/imports.json   # after it
//
// The first reads every bare specifier the bundle and the server's own modules
// name, and keeps the ones that resolve with every dependency installed. A
// name that does not resolve even then is text, not an import (the bundle
// carries code examples as strings: `import { ChatAnthropic } from
// "@langchain/anthropic"` in an agent export), since a real import of it would
// have failed the build. The second resolves each recorded package again and
// fails if the prune took one away.
import { builtinModules, createRequire } from "node:module";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** The package name a bare specifier names: `a/b` -> `a`, `@s/a/b` -> `@s/a`. */
export function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Bare specifiers a module names in import, export-from, import() and require(). */
export function bareSpecifiers(source) {
  const found = new Set();
  // A comment may sit before the name: `import(/* @vite-ignore */ "nodemailer")`
  // is how the bundle loads an optional driver (measured, R469).
  const C = String.raw`\s*(?:\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*)*`;
  const patterns = [
    /\bimport\s+(?:[^'"`;()]*?\s+from\s+)?["']([^"'`\s]+)["']/g,
    /\bexport\s+[^'"`;()]*?\s+from\s+["']([^"'`\s]+)["']/g,
    new RegExp(String.raw`\bimport\(${C}["']([^"'\x60\s]+)["']\s*\)`, "g"),
    new RegExp(String.raw`\b(?:__)?require\(${C}["']([^"'\x60\s]+)["']\s*\)`, "g"),
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("node:")) continue; // a URL
      if (BUILTIN.has(spec) || BUILTIN.has(spec.split("/")[0])) continue;
      found.add(spec);
    }
  }
  return [...found];
}

/** The packages the server's code names, each with one file that names it. */
export function importedPackages(root) {
  const sources = [
    ...files(path.join(root, "dist", "server")),
    ...readdirSync(root)
      .filter((f) => /^server.*\.mjs$/.test(f))
      .map((f) => path.join(root, f)),
  ];
  const packages = new Map();
  for (const file of sources) {
    for (const spec of bareSpecifiers(readFileSync(file, "utf8"))) {
      const pkg = packageOf(spec);
      if (!packages.has(pkg)) packages.set(pkg, path.relative(root, file).replace(/\\/g, "/"));
    }
  }
  return { packages, files: sources.length };
}

function resolves(req, pkg) {
  for (const target of [`${pkg}/package.json`, pkg]) {
    try {
      req.resolve(target);
      return true;
    } catch {
      // try the next form: some packages do not export package.json
    }
  }
  return false;
}

function main(argv) {
  const mode = argv[0];
  const file = argv[1];
  const root = path.resolve(argv[2] ?? ".");
  if (!["--record", "--verify"].includes(mode) || !file) {
    console.error("usage: check-runtime-imports.mjs --record|--verify <file> [dir]");
    process.exit(2);
  }
  const req = createRequire(pathToFileURL(path.join(root, "package.json")));

  if (mode === "--record") {
    const { packages, files: n } = importedPackages(root);
    const real = [];
    const text = [];
    for (const [pkg, from] of packages) (resolves(req, pkg) ? real : text).push({ pkg, from });
    writeFileSync(file, JSON.stringify({ packages: real }, null, 2));
    console.log(`runtime imports: ${real.length} packages imported by ${n} files`);
    if (text.length) {
      console.log(
        `  not installed even with dev dependencies, so named in text, not imported: ${text.map((t) => t.pkg).join(", ")}`,
      );
    }
    return;
  }

  const { packages } = JSON.parse(readFileSync(file, "utf8"));
  const missing = packages.filter(({ pkg }) => !resolves(req, pkg));
  if (missing.length) {
    console.error(
      `runtime imports: the prune removed ${missing.length} package(s) the server imports:`,
    );
    for (const { pkg, from } of missing) console.error(`  ${pkg} (imported by ${from})`);
    console.error("Move each to `dependencies` in package.json: the image keeps only those.");
    process.exit(1);
  }
  console.log(`runtime imports: all ${packages.length} still installed without dev dependencies`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
