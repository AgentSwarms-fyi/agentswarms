// Rate limits have to count across instances, not per process.
//
// There are two limiters. rateLimited() keeps hits in a module-level Map, so
// each app instance counts on its own; rateLimitedGlobal() takes the count in
// Postgres, shared by every instance.
//
// /api/swarm/run already used the global one, and said why: "these are the
// ceilings an operator configures and reads back in the docs, and a
// per-instance count silently multiplied them by the number of instances."
// Every other rate-limited route used the per-process one — including the
// PUBLIC embed endpoints, where the limit is the only thing between an
// anonymous visitor and the owner's model spend.
//
// On a single VM the two are identical, which is why nothing showed up. On the
// autoscaled fleet in DEPLOYMENT.md option C the limit becomes N times the
// configured value, and grows as the fleet scales — weakest exactly when load
// is highest.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Every route file, since the rule is about routes rather than any one of them. */
function routeFiles(dir = "src/routes/api", out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) routeFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("no route counts a rate limit per process", () => {
  it("uses the cross-instance limiter everywhere", () => {
    const offenders: string[] = [];
    for (const f of routeFiles()) {
      const src = readFileSync(f, "utf8");
      // The bare name, not the Global one — a word boundary is not enough
      // because "rateLimitedGlobal" starts with it.
      if (/(?<![A-Za-z])rateLimited(?![A-Za-z])/.test(src)) offenders.push(f);
    }
    expect(offenders, `these count per instance: ${offenders.join(", ")}`).toEqual([]);
  });

  it("still has the per-process limiter available as the fallback", () => {
    // Not deleted — rateLimitedGlobal falls back to it when Postgres is
    // unreachable, so a database blip degrades governance instead of failing
    // every request.
    const lim = readFileSync("src/utils/rateLimit.server.ts", "utf8");
    expect(lim).toContain("export function rateLimited(");
    const global = lim.slice(lim.indexOf("export async function rateLimitedGlobal"));
    expect(global).toContain("return rateLimited(bucket, maxPerMinute);");
  });
});

describe("the public embed endpoints are the ones that matter most", () => {
  // Anonymous, unauthenticated, and every call spends the owner's money.
  for (const f of ["src/routes/api/embed.chat.ts", "src/routes/api/embed.ts"]) {
    it(`${f.split("/").pop()} limits across instances and refuses when over budget`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("await rateLimitedGlobal(");
      // ASKING is not ENFORCING. A first version matched getBudgetDecision
      // appearing anywhere, which survived deleting the line that acts on the
      // answer — the decision was computed, ignored, and the model called
      // anyway. Same shape as a limit that is read and never compared.
      expect(src, "budget never consulted").toContain("getBudgetDecision(");
      expect(src, "budget decision computed but not acted on").toMatch(
        /if \(budget\.over\)\s*return/,
      );
      // Metered against the credential the visitor is spending through.
      expect(src).toMatch(/type: "embed_key"/);
    });
  }

  it("the swarm embed still cannot reach nodes the owner did not publish", () => {
    // The graph orchestrates in the VISITOR's browser, so the client chooses
    // which node runs next. What stops that mattering is that the request
    // carries only a node id: the server loads that node's real provider,
    // model and prompt from the owner's stored swarm.
    const runtime = readFileSync("src/lib/swarmRuntime.ts", "utf8");
    const body = runtime.slice(runtime.indexOf("const chatBody = embedTransport"));
    // Delimit on the closing brace of the embed branch. A first version looked
    // for "} : {", which prettier does not emit here — the slice ran on into
    // the SIGNED-IN branch, which legitimately sends provider and model, and
    // the test failed against correct code.
    const embedBranch = body.slice(0, body.indexOf("      }\n    : {"));
    expect(embedBranch, "embed branch not delimited").toContain("nodeId: node.id");
    for (const field of ["provider", "model", "systemPrompt", "temperature", "maxTokens"]) {
      expect(embedBranch, `embed request carries client-chosen ${field}`).not.toMatch(
        new RegExp(`\\b${field}[,:]`),
      );
    }
  });

  it("the graph sent to a visitor is an allow-list, not a redaction list", () => {
    // A deny-list leaks every field added later. SAFE_NODE_FIELDS is the
    // opposite, so a new node setting is private until someone opts it in.
    const embed = readFileSync("src/routes/api/embed.ts", "utf8");
    expect(embed).toContain("const SAFE_NODE_FIELDS");
    const fn = embed.slice(embed.indexOf("function sanitizeSwarmNodes"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("for (const f of SAFE_NODE_FIELDS)");
    for (const secret of ["systemPrompt", "toolConfigs", "knowledgeBaseIds", "guardrails"]) {
      expect(
        embed.slice(embed.indexOf("const SAFE_NODE_FIELDS"), embed.indexOf("] as const")),
        `${secret} is shipped to anonymous viewers`,
      ).not.toContain(secret);
    }
  });
});
