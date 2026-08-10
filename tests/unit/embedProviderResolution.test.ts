// Every ingestion path must resolve its embedding provider, not reach for
// OPENAI_API_KEY.
//
// embedTarget.server.ts exists precisely so "ingest and retrieval cannot
// disagree", and it prefers OpenRouter for a stated reason: embedding shares
// the OpenAI quota with chat, doc generation and retrieval, so exhausting it
// takes knowledge-base search down too.
//
// Four callers skipped it and read process.env.OPENAI_API_KEY directly — the
// URL and GitHub ingest routes, the connector sync engine, and template
// provisioning. So the ONLY path honouring the preference was the manual
// Back-fill button; every automatic one went straight at the OpenAI quota.
//
// That is not theoretical. Measured on this instance:
//
//   before — add GitHub source github/gitignore
//            kb_sources.status = "embedding_failed"
//            error = 'embeddings 429: … "code": "credit_balance_exhausted"'
//   after  — same repo, same button
//            kb_sources.status = "ok", error = null
//            documents stamped { embedding_provider: "openrouter" }
//
// OpenRouter was connected the whole time.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PATHS = {
  "ingest-github": "src/routes/api/kb/ingest-github.ts",
  "ingest-url": "src/routes/api/kb/ingest-url.ts",
  "connector sync": "src/utils/kb/sync.server.ts",
  "template provisioning": "src/routes/api/templates.provision.ts",
  "back-fill button": "src/utils/tools/kbEmbed.functions.ts",
};
const src = Object.fromEntries(
  Object.entries(PATHS).map(([k, p]) => [k, readFileSync(resolve(p), "utf8")]),
);
const target = readFileSync(resolve("src/utils/tools/embedTarget.server.ts"), "utf8");

/** Comments quote the old code to explain it; only the code should be matched. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const INGESTION = ["ingest-github", "ingest-url", "connector sync", "template provisioning"];

describe("no ingestion path hardcodes the operator's OpenAI key", () => {
  for (const name of INGESTION) {
    it(`${name} does not read OPENAI_API_KEY`, () => {
      const code = codeOnly(src[name]);
      // Guard on the guard: prove codeOnly kept the code being asserted about.
      expect(code, `${PATHS[name as keyof typeof PATHS]} came back empty`).toMatch(/\S/);
      expect(code).not.toContain("process.env.OPENAI_API_KEY");
    });
  }

  it("the back-fill path reads it only to report whether it is configured", () => {
    // kbEmbedStatus tells the RAG settings UI whether to label the built-in
    // option as available. That is a capability check, not an embedding key —
    // so the assertion is about how it is used, not that it is absent.
    const code = codeOnly(src["back-fill button"]);
    const uses = code.match(/process\.env\.OPENAI_API_KEY/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(code).toMatch(/builtinConfigured: Boolean\(process\.env\.OPENAI_API_KEY\)/);
    // Never handed to the embedder.
    expect(code).not.toMatch(/openaiKey:\s*process\.env\.OPENAI_API_KEY/);
  });

  for (const name of INGESTION) {
    it(`${name} resolves the provider instead`, () => {
      expect(src[name]).toMatch(/resolveEmbedArgs\(/);
      expect(src[name]).toMatch(
        /import \{ resolveEmbedArgs \} from "@\/utils\/tools\/embedTarget\.server"/,
      );
    });
  }

  it("the back-fill button still forwards the user's explicit provider choice", () => {
    // That path has a provider picker, so it must pass the choice through
    // rather than switching to the no-argument helper.
    //
    // Asserted on the ARGUMENTS, not the call. A mutation that wrapped them —
    // `resolveEmbedTarget(userId, {} as never || { provider… })` — left the
    // call text intact and survived a match on the opening paren alone.
    const calls =
      src["back-fill button"].match(
        /resolveEmbedTarget\(userId, \{\s*provider: data\.provider,\s*model: data\.model,\s*\}\)/g,
      ) ?? [];
    // Both entry points: fresh uploads and the back-fill button.
    expect(calls).toHaveLength(2);
  });
});

describe("the resolver still prefers OpenRouter", () => {
  it("names OpenRouter as the default, ahead of the built-in key", () => {
    expect(target).toMatch(/DEFAULT_EMBED_PROVIDER = "openrouter"/);
    // Anchor on the FALLBACK chain, after the explicit-provider branch —
    // that branch legitimately calls builtinTarget first, which made a naive
    // whole-function index comparison fail on correct code.
    const inner = target.slice(target.indexOf("async function resolveEmbedTargetInner"));
    const fallback = inner.slice(inner.indexOf("const preferred ="));
    expect(fallback, "the fallback chain moved").toMatch(/\S/);
    const preferredAt = fallback.indexOf("DEFAULT_EMBED_PROVIDER, model");
    const builtinAt = fallback.indexOf("builtinTarget(model)");
    expect(preferredAt).toBeGreaterThan(-1);
    expect(builtinAt).toBeGreaterThan(preferredAt);
  });

  it("keeps OpenRouter on the same vector space as the built-in key", () => {
    // openai/text-embedding-3-small, so moving a collection off an exhausted
    // OpenAI quota does not invalidate chunks already embedded.
    expect(target).toMatch(/openrouter: "openai\/text-embedding-3-small"/);
    expect(target).toMatch(/\[BUILTIN_PROVIDER\]: "text-embedding-3-small"/);
  });

  it("hands callers the key under embedAndStoreDocuments' own parameter name", () => {
    // Returning `apiKey` would typecheck nowhere and silently drop the key if
    // the call site spread it into a loosely-typed object.
    expect(target).toMatch(/openaiKey: target\.apiKey/);
  });

  it("returns null rather than falling back to a hardcoded key", () => {
    const fn = target.slice(target.indexOf("export async function resolveEmbedArgs"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/if \(!target\) return null;/);
  });
});
