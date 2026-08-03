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

describe("the models page matches the provider schema", () => {
  const page = readFileSync("src/routes/docs.models.tsx", "utf8");
  const types = readFileSync("src/utils/providers/types.ts", "utf8");
  const creds = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");

  it("lists every provider id, and no others", () => {
    const union = types.slice(types.indexOf("export type ProviderId ="));
    const ids = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids.length, "the ProviderId union was not parsed").toBeGreaterThan(5);
    expect(page, "the stated provider count is stale").toContain(`all ${ids.length}`);
    for (const id of ids) {
      expect(page, `provider ${id} is missing from the table`).toContain(`>${id}<`);
    }
  });

  it("names the exact fields each cloud provider asks for", () => {
    // Wrong field names here are a support ticket, so they are read from the
    // save schema rather than remembered.
    const schema = creds.slice(
      creds.indexOf("const SaveSchema"),
      creds.indexOf("export const save"),
    );
    for (const provider of ["bedrock", "vertex", "azure_openai", "oci_genai", "qwen"]) {
      const start = schema.indexOf(`  ${provider}: z`);
      expect(start, `${provider} is not in the save schema`).toBeGreaterThan(-1);
      // Terminate on the z.object's own closing brace, NOT on ".optional()" —
      // the inner fields carry .optional() too, so that cut the block short and
      // a field added after the first optional one went unchecked. Caught by
      // mutation: adding bedrock.roleArn left the guard green.
      const block = schema.slice(start, schema.indexOf("\n    })", start));
      const fields = [...block.matchAll(/^\s{6}([a-zA-Z]+): z\./gm)].map((m) => m[1]);
      expect(fields.length, `no fields parsed for ${provider}`).toBeGreaterThan(0);
      for (const f of fields) {
        expect(page, `${provider}.${f} is undocumented`).toContain(`>${f}<`);
      }
    }
  });

  it("documents the Azure deployment-name trap with the real URL shape", () => {
    const azure = readFileSync("src/utils/providers/adapters/azure.server.ts", "utf8");
    expect(azure).toContain("/openai/deployments/");
    expect(page).toContain("/openai/deployments/");
    // And the default api-version, which the page quotes.
    const version = azure.match(/config\.apiVersion \|\| "([^"]+)"/)?.[1];
    expect(version).toBeTruthy();
    expect(page, "the quoted Azure API version is stale").toContain(version!);
  });

  it("does not claim the private-network block covers provider calls", () => {
    // It does not: the ollama/vllm adapters call fetch directly, deliberately,
    // because a model server on a private address is the point of them. Saying
    // otherwise sends someone to change a setting that will not help.
    for (const f of [
      "src/utils/providers/adapters/vllm.server.ts",
      "src/utils/providers/adapters/openai-compat.server.ts",
    ]) {
      expect(readFileSync(f, "utf8"), `${f} now guards its fetch`).not.toContain("safeFetch");
    }
    expect(page).toMatch(/private-network block does not apply/i);
  });
});

describe("the quickstart sends people at things that exist", () => {
  const page = readFileSync("src/routes/docs.quickstart.tsx", "utf8");
  const templates = readFileSync("src/lib/swarmTemplates.ts", "utf8");

  it("names a swarm template that ships", () => {
    // It named "Product Support Assistant" — no such template. The first
    // concrete instruction on the first page a new user opens pointed at
    // something that was not there.
    const titles = [...templates.matchAll(/^\s{4}title: "([^"]+)"/gm)].map((m) => m[1]);
    expect(titles.length, "no templates found to check against").toBeGreaterThan(5);

    // Flattened first: prettier reflows JSX across lines and inserts {" "},
    // so a structural regex against the raw file matches nothing and the guard
    // silently checks zero names.
    const flat = page.replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
    const named = [...flat.matchAll(/<strong>([A-Z][A-Za-z ]{4,40})<\/strong> ?template/g)].map(
      (m) => m[1].trim(),
    );
    expect(named.length, "the quickstart no longer names a template").toBeGreaterThan(0);
    for (const n of named) {
      expect(titles, `quickstart names a template that does not exist: ${n}`).toContain(n);
    }
  });

  it("quotes the example question the template actually ships with", () => {
    const support = templates.slice(templates.indexOf('id: "support-copilot"'));
    const example = support.match(/exampleInput:\s*\n?\s*"([^"]+)"/)?.[1];
    expect(example, "support-copilot has no exampleInput").toBeTruthy();
    // The page wraps it across lines, so compare on words rather than shape.
    const words = example!
      .replace(/[^a-z ]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 5);
    const flat = page.replace(/\s+/g, " ");
    for (const w of words) {
      expect(flat, `the quoted question drifted from the template: ${w}`).toContain(w);
    }
  });

  it("points at a knowledge base that is really seeded", () => {
    // The claim "needs no setup" rests entirely on this row existing.
    const kbId = templates.match(/SAMPLE_KB_ID = "([0-9a-f-]+)"/)?.[1];
    expect(kbId).toBeTruthy();
    const seed = readFileSync(
      "supabase/migrations/20260604135439_9ab0db3f-61dc-4cde-98cc-e4d84a45a5d8.sql",
      "utf8",
    );
    expect(seed).toContain(kbId!);
    expect(seed, "the sample KB is no longer readable by everyone").toContain("is_sample");
    const name = seed.match(/'(Sample · [^']+)'/)?.[1];
    expect(name, "the seeded sample KB has no name").toBeTruthy();
    expect(page, "the quickstart names a different sample base").toContain(name!);
  });

  it("states a total that the sample CSV actually adds up to", () => {
    // A page about not trusting a model's arithmetic cannot get its own
    // arithmetic wrong. Computed from the CSV as printed.
    const csv = page.match(/<Code lang="csv">\{`([\s\S]*?)`\}<\/Code>/)?.[1];
    expect(csv, "the sample CSV is gone").toBeTruthy();
    const rows = csv!
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(","));
    const march = rows.filter((r) => r[4].startsWith("2026-03"));
    const total = march.reduce((s, r) => s + Number(r[3]), 0);
    expect(page, `March total is ${total.toFixed(2)} across ${march.length} rows`).toContain(
      total.toFixed(2),
    );
    expect(page).toMatch(
      new RegExp(
        `across ${["", "one", "two", "three", "four", "five", "six", "seven"][march.length]} rows`,
      ),
    );
  });

  it("tells a fresh instance how to get a model before step 1", () => {
    // Every step needs a provider and .env.example ships the key empty, so a
    // reader following this in order hits a wall on the first instruction.
    expect(readFileSync(".env.example", "utf8")).toMatch(/^OPENROUTER_API_KEY=""$/m);
    expect(page, "the provider prerequisite is missing").toContain("OPENROUTER_API_KEY");
    expect(page.indexOf("OPENROUTER_API_KEY"), "the prerequisite comes after step 1").toBeLessThan(
      page.indexOf('id="step-1"'),
    );
  });
});

describe("the secrets page describes the resolver that exists", () => {
  const page = readFileSync("src/routes/docs.secrets.tsx", "utf8");
  const resolver = readFileSync("src/utils/secrets.server.ts", "utf8");

  it("quotes the name rule the database enforces", () => {
    // Two separate places agree on this pattern: the CHECK constraint on the
    // table and the reference regex. The page states it once, so it has to
    // match the constraint that actually rejects a bad name.
    const migration = readFileSync(
      "supabase/migrations/20260720400000_secrets_manager.sql",
      "utf8",
    );
    expect(migration).toContain("^[A-Za-z][A-Za-z0-9_]*$");
    expect(page, "the documented name pattern is not the enforced one").toContain(
      "^[A-Za-z][A-Za-z0-9_]*$",
    );
    expect(migration).toContain("length(name) <= 64");
    expect(page).toContain("64");
  });

  it("documents the precedence and ambiguity rules, which change how you name things", () => {
    // Own-beats-shared and ambiguous-shared are both real branches, and both
    // are invisible until they bite someone in a shared workspace.
    expect(resolver).toContain("Own secret wins");
    expect(resolver).toMatch(/is ambiguous — multiple shared secrets use that name/);
    expect(page, "precedence is undocumented").toMatch(/own secret wins/i);
    expect(page, "the ambiguity failure is undocumented").toMatch(/ambiguous/i);
  });

  it("does not claim a missing secret fails loudly everywhere", () => {
    // It does on the HTTP node, connections and integrations — resolveSecretRefs
    // throws. It does NOT for MCP env bindings, which catch and skip, leaving
    // the variable absent. A page that states the general rule without the
    // exception sends someone debugging the wrong layer.
    const bundle = readFileSync("src/routes/api/notebook.runtime.source.ts", "utf8");
    const loop = bundle.slice(
      bundle.indexOf("for (const binding"),
      bundle.indexOf("return json(200"),
    );
    expect(loop, "the binding loop no longer swallows a failed lookup").toContain("catch");
    expect(page, "the MCP binding exception is not documented").toMatch(
      /environment bindings are the exception/i,
    );

    expect(resolver, "resolveSecretRefs no longer throws on a missing secret").toMatch(
      /throw new Error\(\s*`Secret "\$\{name\}" not found/,
    );
  });

  it("lists a surface only if something resolves references there", () => {
    // The page used to say "any templated field on a swarm node", which is not
    // true of any node but the HTTP one.
    const nodes = readFileSync("src/utils/swarmNodes.server.ts", "utf8");
    expect(nodes).toContain("resolveSecretRefs(userId, p.url)");
    expect(nodes).toContain("resolveSecretRefs(userId, h.value)");
    expect(page, "the over-broad any-field claim came back").not.toMatch(
      /any templated field on a[\s\S]{0,40}swarm node/,
    );
    for (const f of [
      "src/utils/warehouse/connections.server.ts",
      "src/utils/providers/integrationConfig.server.ts",
    ]) {
      expect(readFileSync(f, "utf8"), `${f} no longer resolves refs`).toContain(
        "resolveSecretRefsInObject",
      );
    }
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
