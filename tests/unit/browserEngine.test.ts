// The browser SQL engine is DuckDB-Wasm, and must stay that way.
//
// WHAT THIS FILE CAN AND CANNOT DO. It runs in Node, so it cannot instantiate
// WebAssembly in a worker or execute a query — that is what `/engine-check`
// exists for, and it was run in a real browser (10/10) before this landed.
// What IS checkable here is everything that made the old arrangement wrong:
// which engine the browser reaches for, which dialect it compiles, and whether
// the two engines still share one definition of a value.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { toJsValue } from "@/lib/duckdbValues";

const browserEngine = readFileSync("src/lib/browserDuckdb.ts", "utf8");
const sqlEngine = readFileSync("src/lib/sqlEngine.ts", "utf8");

describe("the browser runs DuckDB, not AlaSQL", () => {
  it("no longer imports or calls alasql", () => {
    // The whole point. Two different engines over one dataset produced three
    // SILENTLY wrong answers — a running total of 0 for every row among them.
    //
    // Matched as CODE, not as the word: both files explain at length why
    // AlaSQL is gone, and an earlier version of this assertion failed on its
    // own explanation. Prose that says "it used to be AlaSQL" must not read as
    // "it is AlaSQL".
    expect(sqlEngine).not.toMatch(/from ["']alasql["']/);
    expect(sqlEngine).not.toMatch(/\balasql\s*\(/);
    expect(sqlEngine).not.toMatch(/typeof alasql/);
  });

  it("routes every query through the DuckDB-Wasm module", () => {
    expect(sqlEngine).toContain("runBrowserSql");
    expect(browserEngine).toContain("@duckdb/duckdb-wasm");
  });

  it("keeps the read-only guard on the browser path", () => {
    // Reachable by model-written SQL, so this is a real boundary and not a
    // formality. It must be the SHARED predicate, not a local re-implementation.
    expect(browserEngine).toContain("assertLocalReadOnlySql");
  });
});

describe("the wasm is fetched, never bundled or CDN-loaded", () => {
  it("imports the binaries as URLs so they stay separate assets", () => {
    // A 34 MB module inlined into the entry bundle would be an outage, not a
    // slow page.
    expect(browserEngine).toMatch(/duckdb-eh\.wasm\?url/);
    expect(browserEngine).toMatch(/duckdb-mvp\.wasm\?url/);
    expect(browserEngine).toMatch(/duckdb-browser-eh\.worker\.js\?url/);
  });

  it("self-hosts rather than pointing at a CDN", () => {
    // An air-gapped or CSP-restricted deployment cannot reach a CDN, and an
    // enterprise's analytics should not depend on one being up.
    //
    // Checks for a CDN URL or the duckdb helper that produces them — NOT for
    // the word "jsDelivr", which the file uses to say it does not use one.
    expect(browserEngine).not.toMatch(/https?:\/\/[^\s"']*(?:jsdelivr|unpkg)/i);
    expect(browserEngine).not.toMatch(/getJsDelivrBundles\s*\(/);
    // The bundles come from local ?url imports instead.
    expect(browserEngine).toMatch(/const BUNDLES:/);
  });

  it("loads the engine module lazily, on first use", () => {
    // A static import would put the glue in whatever chunk imports sqlEngine.
    expect(browserEngine).toMatch(/await import\(["']@duckdb\/duckdb-wasm["']\)/);
    expect(browserEngine).toMatch(/import type \* as duckdb/);
  });

  it("shares ONE initialisation across concurrent callers", () => {
    // Twelve widgets mounting at once must trigger one download, not twelve.
    expect(browserEngine).toMatch(/let handle: Promise<Handle> \| null/);
  });

  it("clears the cached promise when init fails, so a retry can work", () => {
    // A transient failure fetching 34 MB must not poison the tab for ever.
    // Matched on the ASSIGNMENT rather than the catch's signature: pinning
    // `catch(() => {` broke the moment the handler took an error parameter to
    // report it through status.
    expect(browserEngine).toMatch(/handle\.catch\(/);
    const onFail = browserEngine.slice(browserEngine.indexOf("handle.catch("));
    expect(onFail.slice(0, 260)).toMatch(/handle = null/);
  });
});

describe("both engines agree on what a value is", () => {
  // toJsValue was MOVED to lib/duckdbValues rather than copied, so the server
  // and the browser cannot drift. These assert the rules that matter when a
  // value crosses out of DuckDB.
  it("turns COUNT's BigInt into a number", () => {
    expect(toJsValue(BigInt(42))).toBe(42);
  });

  it("keeps a BigInt beyond 2^53 as a string rather than losing precision", () => {
    const huge = BigInt("9007199254740993");
    expect(toJsValue(huge)).toBe(huge.toString());
  });

  it("normalises null and undefined to null", () => {
    expect(toJsValue(null)).toBeNull();
    expect(toJsValue(undefined)).toBeNull();
  });

  it("leaves an empty string as an empty string", () => {
    expect(toJsValue("")).toBe("");
  });

  it("is imported by the server engine rather than redefined there", () => {
    const server = readFileSync("src/utils/data/duckdb.server.ts", "utf8");
    expect(server).toMatch(/from ["']@\/lib\/duckdbValues["']/);
    // And no second implementation hiding in it.
    expect(server).not.toMatch(/export function toJsValue/);
  });
});

describe("browser-compiled SQL targets the browser's dialect", () => {
  it("names the dialect once, as a constant", () => {
    expect(browserEngine).toMatch(/export const BROWSER_SQL_DIALECT = "duckdb"/);
  });

  it("compiles prep flows for DuckDB, not AlaSQL", () => {
    // buildPrepSql still DEFAULTS to alasql, because the server's escape hatch
    // relies on that default. The browser therefore has to be explicit — and
    // was not, which is how backtick-quoted identifiers reached an engine that
    // rejects them.
    for (const f of ["src/lib/dataPrep.ts", "src/components/bi/DataPrepTab.tsx"]) {
      const src = readFileSync(f, "utf8");
      const calls = [...src.matchAll(/buildPrepSql\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length, `${f} compiles no prep SQL`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args, `${f}: buildPrepSql without an explicit dialect`).toContain(
          "BROWSER_SQL_DIALECT",
        );
      }
    }
  });

  it("has no backtick-quoted identifiers left in browser SQL", () => {
    // DuckDB treats a backtick as a syntax error. These were AlaSQL's quoting
    // and every one of them would have failed at parse time.
    const files = [
      "src/components/bi/BiBuilderPane.tsx",
      "src/components/bi/BiExploreDialog.tsx",
      "src/components/catalog/CatalogView.tsx",
      "src/lib/docGen/biData.ts",
      "src/routes/_authenticated/semantics.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // A backtick-quoted identifier inside a template literal: \`${...}\`
      expect(src, `${f} still quotes an identifier with backticks`).not.toMatch(
        /\\`\$\{[^}]+\}\\`/,
      );
    }
  });
});

describe("the first-query wait is explained, not silent", () => {
  const statusUi = readFileSync("src/components/data/SqlEngineStatus.tsx", "utf8");

  it("reports real bytes rather than an indeterminate spinner", () => {
    // duckdb-wasm's instantiate() takes a progress handler. ~8 MB with no
    // number attached is indistinguishable from a hang.
    expect(browserEngine).toMatch(/db\.instantiate\([^)]*\(p\) =>/s);
    expect(browserEngine).toMatch(/bytesLoaded: p\.bytesLoaded/);
    expect(browserEngine).toMatch(/bytesTotal: p\.bytesTotal/);
  });

  it("has all four phases, including a failure the UI can explain", () => {
    for (const phase of ["idle", "loading", "ready", "error"]) {
      expect(browserEngine, `EngineStatus is missing "${phase}"`).toContain(`"${phase}"`);
    }
    // A blocked CSP or a mangled .wasm must surface as an explained failure,
    // not a Run button that does nothing.
    //
    // Whitespace-tolerant: prettier reflows this call across lines once the
    // message argument makes it long enough, and an exact-string assertion
    // broke the moment it did.
    expect(browserEngine).toMatch(/setStatus\(\{\s*phase: "error"/);
  });

  it("pre-warms on hydration so the download overlaps the row fetch", () => {
    // Every surface goes through hydrateFromSupabase, so doing it there covers
    // the workbench, BI, catalog and prep flows without each remembering.
    expect(sqlEngine).toMatch(/prewarmBrowserEngine\(\)/);
    const hydrate = sqlEngine.slice(sqlEngine.indexOf("export async function hydrateFromSupabase"));
    const beforeFirstAwait = hydrate.slice(0, hydrate.indexOf("await supabase"));
    expect(
      beforeFirstAwait,
      "prewarm must start BEFORE the first Supabase round trip, or it does not overlap",
    ).toContain("prewarmBrowserEngine()");
  });

  it("a failed prewarm cannot become an unhandled rejection", () => {
    expect(browserEngine).toMatch(/prewarmBrowserEngine[\s\S]{0,220}\.catch\(/);
  });

  it("shows nothing once the engine is ready", () => {
    // A permanent "engine: ok" badge is noise. The interesting states are the
    // two the user cannot otherwise explain.
    expect(statusUi).toMatch(/phase === "idle" \|\| status\.phase === "ready"\) return null/);
  });

  it("is announced to assistive technology", () => {
    expect(statusUi).toContain('role="status"');
    expect(statusUi).toContain('aria-live="polite"');
  });

  it("points at the diagnostic when loading fails", () => {
    expect(statusUi).toContain("/engine-check");
  });
});

describe("the AlaSQL date shims are gone", () => {
  it("no longer hand-implements what DuckDB provides", () => {
    // ~120 lines of JS strftime/date_trunc/split_part existed only because
    // AlaSQL lacked them. One was actively wrong: the shim took
    // strftime(format, value) where every real engine takes (value, format).
    expect(sqlEngine).not.toMatch(/function registerCustomFunctions/);
    expect(sqlEngine).not.toMatch(/fn\.strftime =/);
  });
});
