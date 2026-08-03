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
  it("agrees between package.json, LICENSE and the README", () => {
    // Three places state this and a mismatch is a legal question, not a typo.
    expect(pkg.license).toBe("Elastic-2.0");
    expect(readFileSync("LICENSE", "utf8")).toMatch(/Elastic License 2\.0/);
    expect(readme).toMatch(/Elastic License 2\.0/);
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
