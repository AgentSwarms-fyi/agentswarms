// Properties of the agent tool registry that are load-bearing and invisible.
//
// Audited registry.server.ts (1,688 lines) for the three things that matter
// when model output reaches an action. All three hold today; none of them is
// enforced by anything, and each would be easy to break by adding a tool:
//
//   1. NO SERVICE ROLE. Every database read runs under the caller's own JWT,
//      so RLS decides what a tool can see. One supabaseAdmin import would
//      quietly hand every agent the whole workspace.
//   2. EVERY OUTBOUND FETCH is either a fixed vendor host with the model's
//      input encoded into it, or goes through safeFetch. web_browse is the
//      exception that proves it: its URL IS model-chosen, so it calls
//      assertPublicUrl first.
//   3. THAT GUARD RUNS BEFORE the request, not after — an SSRF check that
//      happens once the fetch has already left is decoration.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REGISTRY = "src/utils/tools/registry.server.ts";
const src = readFileSync(REGISTRY, "utf8");

describe("tools read as the caller, never as the service role", () => {
  it("does not import or use supabaseAdmin", () => {
    // The tool context carries an RLS-scoped client precisely so a tool cannot
    // see past the user's grants. Reaching for the admin client would bypass
    // every row filter, column mask and IAM grant in one line.
    expect(src, "a tool now reads with the service role").not.toContain("supabaseAdmin");
  });

  it("holds for the SQL and metric tool modules too", () => {
    // These are where a bypass would matter most: they return rows.
    for (const f of ["src/utils/tools/sql.server.ts", "src/utils/tools/metric.server.ts"]) {
      expect(readFileSync(f, "utf8"), `${f} uses the service role`).not.toContain("supabaseAdmin");
    }
  });
});

describe("every outbound request is either a fixed host or guarded", () => {
  /** Plain `fetch(` calls — safeFetch is matched separately and is fine. */
  const plainFetches = [...src.matchAll(/(?<!safe)\bfetch\(\s*([^\n]*)/g)].map((m) => m[1].trim());

  it("found the call sites to check", () => {
    expect(plainFetches.length).toBeGreaterThan(3);
  });

  it("every plain fetch names a literal vendor host or a URL built from one", () => {
    // A call whose target is a bare variable is the shape that becomes SSRF
    // when someone later lets a model choose it. Each is checked against the
    // surrounding function, where the literal host must appear.
    const offenders: string[] = [];
    for (const m of src.matchAll(/(?<!safe)\bfetch\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) {
      const varName = m[1];
      // Walk back to the enclosing function and look for a literal https host
      // assigned to that variable.
      const before = src.slice(Math.max(0, m.index! - 1200), m.index!);
      const fnStart = Math.max(
        before.lastIndexOf("async function"),
        before.lastIndexOf("function"),
      );
      const scope = fnStart >= 0 ? before.slice(fnStart) : before;
      const literalHost = new RegExp(
        `(const\\s+${varName}\\s*=\\s*(new URL\\()?\\s*\`?"?https://)|${varName}\\s*=\\s*\`https://`,
      );
      // fetchOpenMeteo takes its URL as a parameter; its callers pass literals.
      if (/function fetchOpenMeteo/.test(scope)) continue;
      if (!literalHost.test(scope)) offenders.push(`${varName} @ ${m.index}`);
    }
    expect(offenders, `fetch target not provably a fixed host: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("routes the integration calls through safeFetch", () => {
    // n8n and webhook endpoints are USER-supplied config, so they are the
    // genuine SSRF surface among the integrations.
    expect(src).toContain("safeFetch(");
    const n8n = src.slice(src.indexOf("/api/v1/workflows?limit=50") - 400);
    expect(n8n.slice(0, 500)).toContain("safeFetch");
  });
});

describe("web_browse checks before it fetches", () => {
  it("calls assertPublicUrl on the model-chosen URL", () => {
    expect(src).toContain("assertPublicUrl(url)");
  });

  it("refuses before reaching any provider path", () => {
    // Ordering is the whole property. The guard sits above the provider
    // branch, so neither the direct nor the proxied path can run first.
    //
    // SCOPED TO runWebBrowse. A first version searched the whole file and
    // failed, because runWebSearch picks a provider the same way ~30 lines
    // earlier — and that one takes a QUERY, not a URL, so it has no SSRF
    // surface and needs no guard. Whole-file offsets compared two unrelated
    // functions and called it a finding.
    const fn = src.slice(src.indexOf("export async function runWebBrowse"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 1));
    expect(body.length, "runWebBrowse was not found").toBeGreaterThan(200);

    const at = body.indexOf("const safe = await assertPublicUrl(url)");
    const provider = body.indexOf('const provider = (cfg?.provider || "firecrawl_builtin")');
    expect(at, "the guard is gone from runWebBrowse").toBeGreaterThan(-1);
    expect(provider, "the provider branch moved").toBeGreaterThan(-1);
    expect(at, "the SSRF check now runs after the provider is chosen").toBeLessThan(provider);
    expect(body.slice(at, provider)).toMatch(/if \(!safe\.ok\) return/);
  });

  it("still rejects a non-http scheme up front", () => {
    expect(src).toContain("Invalid URL — must start with http(s)://");
  });
});
