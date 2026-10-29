// Python packages with a known advisory below a version (R404,
// VA-2026-10-25-26). The doc renderer pins exact versions; the notebook runtime
// leaves its frameworks unpinned, so a fresh build takes current releases, but
// Docker reuses the cached install layer until requirements.txt changes. These
// floors are what both images must install at least; osv-scanner on the built
// images found the advisories they close.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Requirement = { name: string; op: string; version: string };

/** Requirement lines of a pip requirements file, comments and extras removed. */
function requirements(path: string): Requirement[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(==|>=)?\s*([0-9][0-9.]*)?/.exec(line);
      if (!m) throw new Error(`unparsed requirement in ${path}: ${line}`);
      return { name: normalize(m[1]), op: m[2] ?? "", version: m[3] ?? "" };
    });
}

/** PEP 503: case, `-`, `_` and `.` do not distinguish package names. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Numeric, part by part, so 1.10 > 1.9 and 2026.10.19 > 2026.7.22. */
function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const DOCGEN = "docgen-service/requirements.txt";
const RUNTIME = "docker/notebook-runtime/requirements.txt";

const FLOORS: [file: string, name: string, floor: string, why: string][] = [
  [DOCGEN, "pillow", "13.0.0", "41 image-parsing advisories"],
  [DOCGEN, "cairosvg", "2.9.1", "GHSA-c3jg-qh8m-j3h2"],
  [DOCGEN, "starlette", "1.3.1", "seven advisories in 0.41.3"],
  [DOCGEN, "certifi", "2026.10.19", "GHSA-6q48-6c7w-9gw2"],
  [RUNTIME, "pillow", "13.0.0", "41 image-parsing advisories"],
  [RUNTIME, "tornado", "6.6", "the kernel gateway's HTTP server"],
  [RUNTIME, "aiohttp", "3.14.4", "GHSA-2g87-pp6c-29x5 and seven more"],
  [RUNTIME, "authlib", "1.9.1", "JWS/JWT signature forgery"],
  [RUNTIME, "nbconvert", "7.17.2", "GHSA-pjvx-prjx-h659"],
  [RUNTIME, "fastmcp", "4.1.2", "GHSA-7xgj-8392-5q4r, GHSA-vqqp-x5qm-5qp4"],
  [RUNTIME, "langgraph", "1.2.14", "GHSA-3fx2-cqw9-xr3c"],
  [RUNTIME, "langgraph-sdk", "0.4.6", "GHSA-3fx2-cqw9-xr3c"],
  [RUNTIME, "dnspython", "2.9.0", "GHSA-45c3-73f7-pv4m"],
  [RUNTIME, "opentelemetry-api", "1.45.1", "GHSA-xcq7-p3pf-p88h"],
  [RUNTIME, "nltk", "3.10.4", "GHSA-j456-xh4h-cpf2"],
  [RUNTIME, "setuptools", "84.1.0", "GHSA-xmj3-9gf7-h52w"],
  [RUNTIME, "certifi", "2026.10.19", "GHSA-6q48-6c7w-9gw2"],
];

describe("Python packages with a known advisory below a version", () => {
  for (const [file, name, floor, why] of FLOORS) {
    it(`${file}: ${name} is at least ${floor} (${why})`, () => {
      const req = requirements(file).find((r) => r.name === name);
      expect(req, `${name} is listed`).toBeDefined();
      // A bare name would take whatever the cached layer or the index has.
      expect(["==", ">="], `${name} has a version`).toContain(req!.op);
      expect(atLeast(req!.version, floor), `${name}${req!.op}${req!.version}`).toBe(true);
    });
  }

  it("lists each package once per file, so a later line cannot undo a floor", () => {
    for (const file of [DOCGEN, RUNTIME]) {
      const names = requirements(file).map((r) => r.name);
      expect(
        names.filter((n, i) => names.indexOf(n) !== i),
        file,
      ).toEqual([]);
    }
  });

  it("keeps the kernel image's DuckDB on the app's major version", () => {
    // Lakehouse nodes write the DuckLake catalog the app's DuckDB also reads.
    // An unpinned rebuild for R404 took duckdb 2.0.0 while the app ran 1.5.
    const app = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@duckdb/node-api"];
    const major = Number(/(\d+)\./.exec(app)![1]);
    const line = readFileSync(RUNTIME, "utf8")
      .split("\n")
      .find((l) => /^duckdb\b/.test(l));
    expect(line, "duckdb is listed").toBeDefined();
    expect(line!.replace(/#.*/, "").replace(/\s/g, "")).toMatch(new RegExp(`,<${major + 1}$`));
  });

  it("pins every doc-renderer package exactly, except the CA bundle", () => {
    for (const r of requirements(DOCGEN)) {
      expect(r.op, r.name).toBe(r.name === "certifi" ? ">=" : "==");
    }
  });

  it("reads names and versions the way pip does", () => {
    expect(normalize("Jupyter_Kernel.Gateway")).toBe("jupyter-kernel-gateway");
    expect(atLeast("1.10.0", "1.9.0")).toBe(true);
    expect(atLeast("6.6", "6.5.10")).toBe(true);
    expect(atLeast("6.5.10", "6.6")).toBe(false);
    expect(atLeast("2026.7.22", "2026.10.19")).toBe(false);
  });
});
