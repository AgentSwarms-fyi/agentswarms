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

  it("the back-fill path does not read it either, not even to report status", () => {
    // It used to, to label a "Built-in (operator OpenAI key)" option. That
    // option is gone: an install should not need an OpenAI account to search
    // its own documents, so the status check asks the RESOLVER what is
    // actually available rather than inspecting the environment.
    const code = codeOnly(src["back-fill button"]);
    expect(code, "file came back empty").toMatch(/\S/);
    expect(code).not.toContain("process.env.OPENAI_API_KEY");
    expect(code).toMatch(/anyProviderResolvable: Boolean\(await resolveEmbedTarget\(/);
  });

  it("no file on the embedding path reads the key at all", () => {
    // The whole point of the change, asserted across every file at once so a
    // new caller cannot quietly reintroduce the dependency.
    for (const [name, text] of Object.entries(src)) {
      expect(codeOnly(text), `${name} reads OPENAI_API_KEY`).not.toContain(
        "process.env.OPENAI_API_KEY",
      );
    }
    expect(codeOnly(target)).not.toContain("process.env.OPENAI_API_KEY");
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
    // Three entry points: fresh uploads, the back-fill button, and the probe.
    //
    // The probe belongs in this count rather than beside it. It exists to tell
    // the user whether their chosen provider works, so if it resolved anything
    // other than what ingest would resolve, a green result would be a claim
    // about a provider that is not the one about to be used.
    expect(calls).toHaveLength(3);
  });
});

describe("the resolver still prefers OpenRouter", () => {
  it("names OpenRouter as the default, and falls back only to connected providers", () => {
    expect(target).toMatch(/DEFAULT_EMBED_PROVIDER = "openrouter"/);
    const inner = target.slice(target.indexOf("async function resolveEmbedTargetInner"));
    const fallback = inner.slice(inner.indexOf("const preferred ="));
    expect(fallback, "the fallback chain moved").toMatch(/\S/);
    // OpenRouter first, then every other embedding-capable integration. No
    // operator-key step in between any more.
    expect(fallback).toMatch(/DEFAULT_EMBED_PROVIDER, model/);
    expect(fallback).toMatch(/for \(const p of EMBED_CAPABLE\)/);
    expect(fallback).not.toContain("builtinTarget(");
  });

  it("OpenRouter is the default, not a requirement — every compat provider is listed", () => {
    // The point of the list: connect Ollama, vLLM, Gemini or NVIDIA and
    // embeddings come from there, with no OpenAI account anywhere.
    for (const p of ["openrouter", "openai", "gemini", "nvidia", "qwen", "ollama", "vllm"]) {
      expect(target, `${p} missing from EMBED_CAPABLE`).toMatch(new RegExp(`"${p}"`));
    }
  });

  it("maps the legacy stamp onto the SAME vector space, never a different one", () => {
    // Documents embedded before this change say "openai_builtin". The key is
    // gone but the vectors are fine, so the stamp has to resolve — and only to
    // a provider serving text-embedding-3-small. Answering from a different
    // space returns confident nonsense rather than an error.
    expect(target).toMatch(/LEGACY_BUILTIN_EQUIVALENTS = \["openai", "openrouter"\]/);
    expect(target).toMatch(/function sameSpaceModel\(/);
    // openai spells it bare; openrouter prefixes it. One space, two spellings.
    // Plain containment, not a built regex: escaping a pattern that itself
    // contains slashes and template syntax is how a guard ends up matching
    // something else entirely.
    expect(target).toContain('return model.includes("/") ? model : `openai/${model}`;');
    expect(target).toContain('if (provider === "openai") return model.replace(/^openai\\//, "");');
    const inner = target.slice(target.indexOf("async function resolveEmbedTargetInner"));
    expect(inner).toMatch(/requested === BUILTIN_PROVIDER\s*\?\s*legacyBuiltinTarget\(/);
  });

  it("keeps OpenRouter on the same vector space as older collections", () => {
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
