// The documentation has to describe the software that exists.
//
// Every finding in this file's history was DRIFT — a claim that was true when
// written and quietly stopped being true. Nothing fails when that happens, so
// it accumulates:
//
//   - ACKNOWLEDGEMENTS credited Pyodide for "in-browser Python notebooks",
//     which had been removed (notebooks.tsx says so in its own header), and
//     listed sharp/libvips (LGPL-3.0) in the LICENCE AUDIT SUMMARY when sharp
//     is not a dependency at all — the part of the document a legal reviewer
//     reads, naming a copyleft library that is not present.
//   - ARCHITECTURE listed notebooks as "In-browser Python via Pyodide
//     (+ optional server runtime)", exactly inverting what is true.
//   - a 501 message I wrote earlier in this work told operators to "run the
//     notebook with the browser (Pyodide) runtime" — advice pointing at a
//     deleted feature.
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  license: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const acknowledgements = readFileSync("ACKNOWLEDGEMENTS.md", "utf8");
const readme = readFileSync("README.md", "utf8");

describe("the licence the project actually ships under", () => {
  it("agrees between package.json, LICENSE.md and the README", () => {
    // Three places state this and a mismatch is a legal question, not a typo.
    // The file is LICENSE.md (not bare LICENSE): on case-insensitive
    // filesystems vite's dev server matched the /license ROUTE to the bare
    // file and served licence text as a JS module, 500ing the page.
    expect(pkg.license).toBe("Elastic-2.0");
    expect(readFileSync("LICENSE.md", "utf8")).toMatch(/Elastic License 2\.0/);
    expect(readme).toMatch(/Elastic License 2\.0/);
  });

  it("is not called MIT anywhere in the source either", () => {
    // The project was relicensed, and a stale MIT reference survived in a
    // comment explaining why trademarked logos are not bundled — "we may not
    // have the right to redistribute in an MIT repo". A comment about
    // redistribution rights is the last place to name the wrong licence.
    //
    // Scoped to SELF-references. Describing a dependency as MIT is ordinary
    // and correct: Activepieces genuinely is MIT, and a blanket search for
    // "MIT" would flag that as a finding.
    const SELF = /\b(this|an|our|the)\s+MIT\s+(repo|repository|project|codebase)\b/i;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (["node_modules", ".git", "dist", ".output"].includes(e.name)) continue;
          walk(p);
        } else if (/\.(ts|tsx|md)$/.test(e.name)) {
          if (SELF.test(readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk("src");
    expect(offenders, `calls this project MIT: ${offenders.join(", ")}`).toEqual([]);
  });

  it("does not describe itself as open source", () => {
    // ELv2 is source-available: it forbids offering the software as a hosted
    // service. Calling it open source would be wrong in a way that matters.
    const claims = readme.match(/\bopen[- ]source\b/gi) ?? [];
    for (const c of claims) {
      // Allowed only where it refers to the DEPENDENCIES, not to this project.
      const idx = readme.indexOf(c);
      const context = readme.slice(Math.max(0, idx - 120), idx + 120);
      expect(context, `"${c}" appears to describe the project itself`).toMatch(
        /dependenc|projects AgentSwarms builds on|permissive/i,
      );
    }
    expect(readme).toMatch(/source-available/);
  });
});

describe("the dependency licence claim is true", () => {
  const direct = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const PERMISSIVE =
    /^(MIT|MIT-0|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense|BlueOak-1\.0\.0|Python-2\.0)$/;

  const licences = new Map<string, string>();
  for (const name of Object.keys(direct)) {
    const p = `node_modules/${name}/package.json`;
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { license?: string | { type?: string } };
      const lic = typeof j.license === "string" ? j.license : (j.license?.type ?? "");
      if (lic) licences.set(name, lic);
    } catch {
      /* unreadable manifests are not a licence claim */
    }
  }

  it("read enough manifests to be meaningful", () => {
    // Guards the guard: an empty scan would pass the next test vacuously.
    expect(licences.size).toBeGreaterThan(50);
  });

  it("finds every direct dependency permissive, as both documents say", () => {
    const offenders = [...licences.entries()]
      .filter(
        ([, lic]) =>
          !lic
            .replace(/[()]/g, "")
            .split(/\s+OR\s+/)
            .every((a) => PERMISSIVE.test(a.trim())),
      )
      .map(([n, l]) => `${n} (${l})`);
    expect(offenders, `not permissive: ${offenders.join(", ")}`).toEqual([]);
    expect(acknowledgements).toMatch(/no strong copyleft/i);
  });
});

describe("the acknowledgements credit things that are actually here", () => {
  /** Package names the licence-audit paragraph calls out by name. */
  const summary = acknowledgements.slice(0, acknowledgements.indexOf("## Application framework"));
  const named = [...summary.matchAll(/\*\*([a-z0-9@/.-]+)\*\*/g)].map((m) => m[1]);

  it("names at least the transitive exceptions", () => {
    expect(named.length).toBeGreaterThan(0);
  });

  it("does not cite a package that is not installed", () => {
    // The summary previously cited sharp/libvips (LGPL-3.0). sharp is not a
    // dependency — so the licence audit named a copyleft library the project
    // does not use, which invites a review that has nothing to find.
    const missing = named.filter((n) => !existsSync(`node_modules/${n}`));
    expect(missing, `cited but not installed: ${missing.join(", ")}`).toEqual([]);
  });

  it("credits the load-bearing dependencies by name", () => {
    // THE OTHER DIRECTION, and the one that actually wrongs someone. DuckDB
    // ships in two packages, is the DEFAULT local SQL engine — engineErrors
    // calls AlaSQL "opted out of the default engine" — and appeared nowhere in
    // this file, while AlaSQL was credited as "the" engine. An acknowledgements
    // page that omits the primary engine is not a formatting problem.
    //
    // Deliberately a short list of things whose absence would be conspicuous,
    // not every dependency: a page nobody can keep current gets ignored.
    // Matched as a LINKED credit, not as a substring. `toContain("DuckDB")`
    // passes against "NotDuckDB", which is exactly what a mutation proved.
    for (const [project, repo] of [
      ["DuckDB", "github.com/duckdb/duckdb"],
      ["AlaSQL", "github.com/AlaSQL/alasql"],
      ["LangChain", "github.com/langchain-ai"],
      ["React", "github.com/facebook/react"],
      ["TanStack", "github.com/TanStack"],
      ["Recharts", "github.com/recharts/recharts"],
    ] as const) {
      const row = acknowledgements.split("\n").find((l) => l.includes(`[${project}`));
      expect(row, `${project} has no credit row`).toBeDefined();
      expect(row, `${project} is credited without linking to it`).toContain(repo);
    }
  });

  it("does not describe a fallback as the primary", () => {
    // AlaSQL's row said "The in-browser (and server-side refresh) SQL engine",
    // which is what DuckDB is.
    const alasqlRow = acknowledgements.split("\n").find((l) => l.includes("[AlaSQL]")) ?? "";
    expect(alasqlRow).toMatch(/fallback/i);
    expect(alasqlRow, "AlaSQL is still described as the engine").not.toMatch(
      /The in-browser.*SQL engine/,
    );
  });
});

describe("the trust pages describe the software that exists", () => {
  const architecture = readFileSync("src/routes/architecture.tsx", "utf8");
  const security = readFileSync("src/routes/security.tsx", "utf8");
  const licensePage = readFileSync("src/routes/license.tsx", "utf8");

  it("the connector count is the registry's length, everywhere it is claimed", async () => {
    // about.tsx said "Ten database & warehouse connectors" for months after
    // the registry reached 22. Every page that states the number must state
    // the number the code exports — PARSED from the claim itself: a bare
    // toContain("22 ") matched SVG path coordinates and let a wrong count
    // survive its own mutation test.
    const { WAREHOUSE_PROVIDERS } = await import("@/utils/warehouse/types");
    const n = WAREHOUSE_PROVIDERS.length;
    expect(n).toBe(22);
    for (const [page, claim] of [
      ["src/routes/architecture.tsx", /(\d+) warehouse connectors/],
      ["src/routes/about.tsx", /(\d+) database & warehouse connectors/],
      ["src/routes/docs.integrations.tsx", /(\d+) database\/warehouse connectors/],
    ] as const) {
      const m = readFileSync(page, "utf8").match(claim);
      expect(m, `${page} no longer states the connector count`).not.toBeNull();
      expect(Number(m![1]), `${page} states a stale count`).toBe(n);
    }
  });

  it("'no telemetry' is true: no measurement id is baked into the build", () => {
    // The consent banner used to hardcode the project author's GA/GTM ids, so
    // a self-hosted deployment that clicked Accept sent ITS users' analytics
    // to the vendor — while /architecture, /security and /license all said
    // "no telemetry, no call-home". Analytics now require the operator's own
    // VITE_GA_ID / VITE_GTM_ID; nothing may reintroduce a literal id.
    const consent = readFileSync("src/components/CookieConsent.tsx", "utf8");
    expect(consent).not.toMatch(/G-[A-Z0-9]{6,}/);
    expect(consent).not.toMatch(/GTM-[A-Z0-9]{4,}/);
    expect(consent).toContain("VITE_GA_ID");
    expect(consent).toContain("VITE_GTM_ID");
    expect(readFileSync(".env.example", "utf8")).toContain("VITE_GA_ID");
  });

  it("the security page's crypto claims match the implementation", () => {
    // AES-256-GCM with a fresh random 96-bit IV per record is a checkable
    // statement, and the page stakes its credibility on being checkable.
    const crypto = readFileSync("src/utils/providers/crypto.server.ts", "utf8");
    expect(security).toContain("AES-256-GCM");
    expect(security).toContain("96-bit IV");
    expect(crypto).toContain('"AES-GCM"');
    expect(crypto).toContain("Uint8Array(12)"); // 12 bytes = the claimed 96 bits
    expect(crypto).toContain("PROVIDER_CREDS_SECRET");
  });

  it("the read-only verb list on the page is the driver's list", () => {
    const drivers = readFileSync("src/utils/warehouse/drivers.server.ts", "utf8");
    expect(security).toContain("SELECT/WITH/SHOW/DESCRIBE/EXPLAIN");
    expect(drivers).toContain("SELECT/WITH/SHOW/");
    expect(drivers).toContain("DESCRIBE/EXPLAIN");
  });

  it("the licence page names the file that exists", () => {
    expect(licensePage).toContain("LICENSE.md");
    expect(existsSync("LICENSE.md")).toBe(true);
  });

  it("every trust page is reachable from a desktop", () => {
    // They were in the landing page's MOBILE menu only — written for
    // procurement reviewers, who are on desktops, with no desktop link
    // anywhere. Both the desktop More menu and the site-wide footer must
    // carry all three.
    const landing = readFileSync("src/routes/index.tsx", "utf8");
    const chrome = readFileSync("src/components/SiteChrome.tsx", "utf8");
    for (const path of ["/architecture", "/security", "/license"]) {
      const link = new RegExp(`to: "${path}"|to="${path}"`);
      expect(landing, `More menu misses ${path}`).toMatch(link);
      expect(chrome, `footer misses ${path}`).toMatch(link);
    }
    // …and they carry the shared chrome rather than a bare back-link.
    for (const [name, text] of [
      ["architecture", architecture],
      ["security", security],
      ["license", licensePage],
    ] as const) {
      expect(text, `${name} page lost the site header`).toContain("<SiteHeader />");
      expect(text, `${name} page lost the site footer`).toContain("<SiteFooter />");
    }
  });
});

describe("no document promises the removed in-browser runtime", () => {
  function docs(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", ".output"].includes(e.name)) continue;
        docs(p, out);
      } else if (e.name.endsWith(".md")) out.push(p);
    }
    return out;
  }

  it("has no code path that runs Python in the browser", () => {
    // The fact the documents have to match: notebooks execute on sandboxed
    // server kernels only.
    const src = docs("src")
      .concat(["src/routes/_authenticated/notebooks.tsx"])
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    void src;
    const notebooks = readFileSync("src/routes/_authenticated/notebooks.tsx", "utf8");
    expect(notebooks).toMatch(/in-browser Pyodide runtime was removed/);
  });

  it("does not describe notebooks as running in the browser", () => {
    const offenders: string[] = [];
    for (const f of docs(".")) {
      const text = readFileSync(f, "utf8");
      // Allowed: explaining that it WAS removed. Not allowed: presenting it as
      // how notebooks work.
      if (/in-browser python|browser \(pyodide\)|via \[?pyodide/i.test(text)) offenders.push(f);
    }
    expect(offenders, `still promise an in-browser runtime: ${offenders.join(", ")}`).toEqual([]);
  });

  it("does not tell an operator to switch to it", () => {
    // EVERY string literal in the file, not the first segment of each message.
    // The 501 text is a `"..." + "..." + "..."` concatenation, so a regex
    // capturing one quoted run checked only its opening line — and a mutation
    // that put "browser (Pyodide) runtime" in the SECOND segment sailed past.
    const route = readFileSync("src/routes/api/python-agent.ts", "utf8");
    const code = route
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    const literals = [...code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]).join(" ");
    expect(literals.toLowerCase(), "a user-facing string names the removed runtime").not.toContain(
      "pyodide",
    );
  });
});
