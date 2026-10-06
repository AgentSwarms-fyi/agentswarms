// The document parsers are served from this app's own origin (R321).
//
// FOUND IN THE GAP REVIEW. pdf.js and mammoth were imported from esm.sh and
// jsdelivr at runtime: an install without internet access could not read a
// PDF or DOCX upload, third-party code ran inside the signed-in app, and the
// versions fetched were not the ones the lockfile pins and audits. The build
// now copies them into public/vendor and the parsers load them from there.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAMMOTH_URL, PDFJS_URL, PDFJS_WORKER_URL, VENDORED_PARSERS } from "@/lib/vendoredParsers";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, { version?: string }>;
};

describe("what is vendored", () => {
  it("is each file the lockfile installed, at the version it pins", () => {
    for (const f of VENDORED_PARSERS) {
      expect(existsSync(f.from), f.from).toBe(true);
      const pkg = f.from.split("/").slice(0, 2).join("/");
      expect(f.version, pkg).toBe(lock.packages[pkg]?.version);
    }
  });

  it("is loaded from this origin, under the path the build writes, with the version", () => {
    expect(PDFJS_URL).toBe(
      `/vendor/pdfjs/pdf.min.mjs?v=${lock.packages["node_modules/pdfjs-dist"].version}`,
    );
    expect(PDFJS_WORKER_URL).toMatch(/^\/vendor\/pdfjs\/pdf\.worker\.min\.mjs\?v=\d/);
    expect(MAMMOTH_URL).toBe(
      `/vendor/mammoth/mammoth.browser.min.js?v=${lock.packages["node_modules/mammoth"].version}`,
    );
  });

  it("pairs pdf.js with its own worker", () => {
    expect(VENDORED_PARSERS[0].version).toBe(VENDORED_PARSERS[1].version);
  });
});

describe("the build", () => {
  const cfg = readFileSync("vite.config.ts", "utf8");

  it("copies every vendored file into public at build start, for dev and build alike", () => {
    const plugin = cfg.slice(cfg.indexOf("function vendorDocumentParsers()"));
    expect(plugin).toContain("buildStart() {");
    expect(plugin).toContain("for (const file of VENDORED_PARSERS) {");
    expect(plugin).toContain("copyFileSync(path.resolve(rootDir, file.from), to);");
    expect(cfg).toMatch(/const plugins: PluginOption\[\] = \[\s*vendorDocumentParsers\(\),/);
  });

  it("does not commit the copies", () => {
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^public\/vendor\/$/m);
  });

  it("leaves the copies out of lint and formatting: Prettier spent half an hour on the worker", () => {
    const eslint = readFileSync("eslint.config.js", "utf8");
    expect(eslint).toMatch(/\{ ignores: \[[^\]]*"public\/vendor"[^\]]*\] \}/);
    expect(readFileSync(".prettierignore", "utf8")).toMatch(/^public\/vendor$/m);
  });
});

describe("the parsers", () => {
  const src = readFileSync("src/lib/fileParsers.ts", "utf8");

  it("load pdf.js, its worker and mammoth from the vendored paths", () => {
    expect(src).toContain("await import(/* @vite-ignore */ PDFJS_URL)");
    expect(src).toContain("pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;");
    expect(src).toContain("script.src = MAMMOTH_URL;");
  });

  it("say where the DOCX reader failed to load from", () => {
    expect(src).toContain("The DOCX reader could not be loaded from this server (${MAMMOTH_URL}).");
  });
});

describe("no code from a public CDN", () => {
  // Images (provider logos) degrade to a letter; code that does not load
  // breaks the feature, and runs with the signed-in user's rights when it does.
  const CDN_CODE =
    /(esm\.sh|unpkg\.com|cdn\.skypack\.dev|cdn\.jsdelivr\.net\/npm\/[^"'`\s]+\.(m?js|cjs))/;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });

  // Comment lines may name a CDN (this module's history does); code may not.
  const code = (f: string) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("is imported or loaded anywhere in src", () => {
    const offenders = files("src").filter((f) => CDN_CODE.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("would be found in a string", () => {
    expect(CDN_CODE.test("const u = `https://esm.sh/pdfjs-dist@4/build/pdf.mjs`;")).toBe(true);
    expect(CDN_CODE.test('src="https://cdn.jsdelivr.net/npm/x@1/dist/x.min.js"')).toBe(true);
    expect(CDN_CODE.test('"https://cdn.jsdelivr.net/npm/simple-icons@11/icons/openai.svg"')).toBe(
      false,
    );
  });
});
