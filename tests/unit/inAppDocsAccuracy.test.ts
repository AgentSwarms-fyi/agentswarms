// The in-app documentation has to describe the running software.
//
// These pages are what an operator configures from, so a stale claim here is
// not a typo — it is someone sizing a rate limit wrongly, or believing a cap
// holds when it does not. Two real examples, both found by this check:
//
//   - "Rate and concurrency limits are per process… N instances means N times
//     the limit" appeared on both the self-hosting and API pages. It stopped
//     being true when those limits moved to a Postgres-backed counter, and an
//     operator reading it would over-provision or, worse, assume the ceiling
//     was softer than it is.
//   - TRUSTED_PROXY_HOPS and BUDGET_FAIL_CLOSED shipped in .env.example and
//     reached no in-app page at all — settings nobody would know to set.
//
// Note the deliberate asymmetry: WAREHOUSE_* concurrency IS still per process
// (governor.server holds an in-memory Map), so the docs saying so are correct
// and must not be "fixed".
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const DOC_PAGES = readdirSync("src/routes")
  .filter((f) => f.startsWith("docs.") && f.endsWith(".tsx"))
  .map((f) => `src/routes/${f}`);

const docText = DOC_PAGES.map((f) => readFileSync(f, "utf8")).join("\n");

/** Everything the code actually reads, including via the envInt/envBool helpers. */
function envVarsInCode(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", ".output"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
        const src = readFileSync(p, "utf8");
        for (const re of [
          /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
          /process\.env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g,
          /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
          /env(?:Int|Bool|Num|Str)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
          /\benv\.([A-Z][A-Z0-9_]{2,})/g,
        ]) {
          for (const m of src.matchAll(re)) out.add(m[1]);
        }
      }
    }
  };
  walk("src");
  walk("scripts");
  walk("services");
  return out;
}

describe("the pages found something to check", () => {
  it("reads every docs route", () => {
    expect(DOC_PAGES.length).toBeGreaterThan(20);
    expect(docText.length).toBeGreaterThan(100_000);
  });
});

describe("no page promises a setting the code does not read", () => {
  const code = envVarsInCode();

  /**
   * Every setting `.env.example` declares — the authoritative list of what an
   * operator is invited to configure.
   *
   * Scoped this way DELIBERATELY. A first version scanned every `<C>` tag for
   * an upper-case token, but `<C>` is generic inline code: it flagged SELECT,
   * WHERE, HAVING, a Snowflake role name and a SQL Server instance name. The
   * question worth asking is not "does every capitalised word exist" but
   * "does everything we invite people to set actually do something".
   */
  const declared = [
    ...readFileSync(".env.example", "utf8").matchAll(/^([A-Z][A-Z0-9_]{2,})=/gm),
  ].map((m) => m[1]);

  /** Read by a sibling service rather than the app — still real settings. */
  const EXTERNAL_READERS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

  it("found the declared settings", () => {
    expect(declared.length).toBeGreaterThan(50);
  });

  it("declares only settings something actually reads", () => {
    // A variable in .env.example that nothing reads is an operator setting it
    // and believing it took effect.
    const dead = declared.filter((v) => !code.has(v) && !EXTERNAL_READERS.has(v)).sort();
    expect(dead, `declared in .env.example but read by nothing: ${dead.join(", ")}`).toEqual([]);
  });

  it("lists the settings that govern a security control in the reference", () => {
    // Each of these changes whether something is ENFORCED, so an operator who
    // never hears about it gets the default silently.
    //
    // Checked against the environment REFERENCE, not the whole page. Asserting
    // the name appeared anywhere passed while the reference row was deleted,
    // because prose and the recipes below still mentioned it — and the
    // reference is where someone goes to find out what a setting does.
    //
    // WHAT THIS DOES NOT CATCH, stated rather than implied: moving a setting
    // from its table row into surrounding prose within this same section. That
    // survives, and it should — the setting is still documented where someone
    // would look. Removing it from the page altogether is caught.
    const selfHosting = readFileSync("src/routes/docs.self-hosting.tsx", "utf8");
    const reference = selfHosting.slice(
      selfHosting.indexOf('id="env"'),
      selfHosting.indexOf('id="recipes"'),
    );
    expect(reference.length, "the environment reference section was not found").toBeGreaterThan(
      2000,
    );
    for (const v of [
      "ENFORCE_BUDGET_CAP",
      "BUDGET_FAIL_CLOSED",
      "TRUSTED_PROXY_HOPS",
      "BLOCK_PRIVATE_NETWORK_FETCH",
      "PROVIDER_CREDS_SECRET",
      "INTERNAL_RUN_SECRET",
    ]) {
      expect(reference, `${v} is missing from the environment reference`).toContain(v);
    }
  });
});

describe("limits are described with the scope they actually have", () => {
  it("does not claim the fleet-wide limits are per process", () => {
    // The swarm-run and public-endpoint limits are counted in Postgres. Saying
    // otherwise tells an operator to divide their intended ceiling by the
    // instance count.
    const offenders = DOC_PAGES.filter((f) => {
      const src = readFileSync(f, "utf8");
      // WAREHOUSE_* concurrency genuinely is per-instance, so a page may say so
      // as long as it is talking about that.
      const claims = /per process|per-process|per application process|N times the/i.test(src);
      const aboutWarehouse = /WAREHOUSE_MAX_CONCURRENT|per instance/i.test(src);
      return claims && !aboutWarehouse;
    });
    expect(offenders, `still claim per-process limits: ${offenders.join(", ")}`).toEqual([]);
  });

  it("says where the count actually lives", () => {
    expect(docText).toMatch(/counted in Postgres|Postgres, shared by every instance/i);
  });
});

describe("every internal link goes somewhere", () => {
  /**
   * Routes that actually exist, from the filesystem router's own conventions.
   *
   * Three shapes matter and missing any of them invents findings: flat
   * `docs.x.tsx`, nested `_authenticated/x.tsx`, and top-level `x.tsx`. A first
   * pass handled only the flat ones and reported 14 broken links, 13 of which
   * were real routes it could not see.
   */
  function existingRoutes(): Set<string> {
    const out = new Set<string>(["/docs", "/"]);
    const add = (p: string) => out.add(p.replace(/\/index$/, "") || "/");

    for (const f of readdirSync("src/routes")) {
      if (!f.endsWith(".tsx")) continue;
      const base = f.replace(/\.tsx$/, "");
      if (base.startsWith("docs.")) add("/docs/" + base.slice(5).replace(/^index$/, ""));
      else if (!base.startsWith("_") && !base.startsWith("api.")) add("/" + base);
    }
    for (const dir of ["src/routes/_authenticated"]) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".tsx")) continue;
        // A dot is a PATH SEPARATOR in this router, so admin.iam.tsx serves
        // /admin/iam. Treating it literally reported that real page as a dead
        // link — the detector's bug, not the docs'.
        add(
          "/" +
            f
              .replace(/\.tsx$/, "")
              .replace(/_$/, "")
              .replace(/\./g, "/"),
        );
      }
    }
    return out;
  }

  it("resolved a plausible set of routes", () => {
    const routes = existingRoutes();
    expect(routes.size).toBeGreaterThan(40);
    expect(routes.has("/docs/self-hosting")).toBe(true);
    expect(routes.has("/agents")).toBe(true);
  });

  it("links to no page that does not exist", () => {
    // A dead link in the docs is a reader hitting a 404 at the moment they
    // went looking for help. /docs/observability was one — the audit trail
    // lives on the analytics page.
    const routes = existingRoutes();
    const broken: string[] = [];
    for (const f of DOC_PAGES) {
      for (const m of readFileSync(f, "utf8").matchAll(/to=["'](\/[^"']*)["']/g)) {
        const target = m[1].split("#")[0].replace(/\/$/, "") || "/";
        if (/[$:]/.test(target)) continue; // dynamic segment
        if (!routes.has(target)) broken.push(`${f.replace("src/routes/", "")} → ${m[1]}`);
      }
    }
    expect([...new Set(broken)], `dead links: ${broken.join(", ")}`).toEqual([]);
  });
});

describe("the configuration recipes are usable", () => {
  const selfHosting = readFileSync("src/routes/docs.self-hosting.tsx", "utf8");

  it("covers the deployment shapes an operator actually has", () => {
    // A reference table lists every knob; it does not tell you which ones go
    // together. These are the combinations.
    for (const id of [
      "recipe-eval",
      "recipe-team",
      "recipe-public",
      "recipe-regulated",
      "recipe-fleet",
    ]) {
      expect(selfHosting, `missing recipe: ${id}`).toContain(id);
    }
  });

  it("hardens the public-embed recipe, which is the exposed one", () => {
    const recipe = selfHosting.slice(
      selfHosting.indexOf('id="recipe-public"'),
      selfHosting.indexOf('id="recipe-regulated"'),
    );
    // Anonymous visitors spend the owner's credits here, so the cap must bite
    // and an unknown spend figure must not read as zero.
    expect(recipe).toContain("ENFORCE_BUDGET_CAP");
    expect(recipe).toContain("BUDGET_FAIL_CLOSED");
    expect(recipe).toContain("BLOCK_PRIVATE_NETWORK_FETCH");
  });
});

describe("the MCP page's code examples are the ones that actually deploy", () => {
  const mcp = readFileSync("src/routes/docs.mcp.tsx", "utf8");
  const templates = readFileSync("src/lib/mcpTemplates.ts", "utf8");

  it("shows the decorator form that works on every FastMCP version", () => {
    // The page said `@mcp.tool`. The shipped templates use `@mcp.tool()` on
    // purpose — bare needs 2.11+, and a reader copying the docs onto an older
    // image gets a server that will not load.
    expect(templates, "the templates changed form").toContain("@mcp.tool()");
    // The sentence that TELLS you what to write, not merely a mention: the page
    // also names the bare form once, to warn that it needs 2.11+.
    expect(mcp, "the contract sentence recommends the version-fragile form").toContain(
      "with <C>@mcp.tool()</C> functions",
    );
    const bare = [...mcp.matchAll(/@mcp\.tool(?!\()/g)];
    expect(
      bare,
      `bare @mcp.tool appears ${bare.length}x — only the warning may use it`,
    ).toHaveLength(1);
  });

  it("quotes the starter template rather than an invented server", () => {
    // Every line the page shows as Python must exist in a template that the
    // product itself ships and that survives a Deploy.
    const shown = [...mcp.matchAll(/<Code lang="python">\{`([\s\S]*?)`\}<\/Code>/g)].map(
      (m) => m[1],
    );
    expect(shown.length, "no python examples on the page").toBeGreaterThanOrEqual(2);
    const body = shown.join("\n");
    for (const line of ["def greet(name: str) -> str:", "def get_customer(customer_id: str)"]) {
      expect(body, `example drifted from the template: ${line}`).toContain(line);
      expect(templates, `template no longer has: ${line}`).toContain(line);
    }
  });

  it("names the endpoint contract the edge route enforces", () => {
    const proto = readFileSync("src/utils/mcpApps/protocol.ts", "utf8");
    const route = readFileSync("src/routes/api/mcp.s.$slug.ts", "utf8");
    const keys = readFileSync("src/utils/mcpApps/keys.ts", "utf8");

    // Protocol revision, key prefix and POST-only are all quoted on the page.
    const version = proto.match(/MCP_PROTOCOL_VERSION = "([^"]+)"/)?.[1];
    expect(version).toBeTruthy();
    expect(mcp, "the page quotes a stale protocol revision").toContain(version!);
    expect(keys).toContain('MCP_KEY_PREFIX = "mcps_"');
    expect(mcp).toContain("mcps_");
    expect(route, "GET no longer answers 405").toContain("method_not_allowed");
    expect(mcp).toContain("405");
  });

  it("lists every forwarded method, not just the tool ones", () => {
    // The page named four of six. The two notification methods are forwarded
    // too, and a client author needs to know that.
    const proto = readFileSync("src/utils/mcpApps/protocol.ts", "utf8");
    const forwarded = proto.slice(
      proto.indexOf("FORWARDED_METHODS"),
      proto.indexOf("]", proto.indexOf("FORWARDED_METHODS")),
    );
    const methods = [...forwarded.matchAll(/"([a-z/]+)"/g)].map((m) => m[1]);
    expect(methods).toHaveLength(6);
    for (const m of methods) {
      // `notifications/initialized` is written as "initialized" in prose.
      const shown = m.replace("notifications/", "");
      expect(mcp, `the page omits the forwarded method ${m}`).toContain(shown);
    }
  });
});
