// "Has an embeddings API" is not the same as "works with this store".
//
// THE GAP THESE WERE WRITTEN FOR. `kb_chunks.embedding` is `vector(1536)` and
// embedTexts hard-rejects any other width, so a provider is usable here only if
// it returns 1536 dimensions — natively, or by honouring the OpenAI
// `dimensions` parameter. Several models the picker offers are natively 768,
// 1024, 2560 or 4096. Whether a given one honours `dimensions` cannot be read
// off its id, and a hardcoded allow-list rots: this repo already carried two
// nvidia/* entries that turned out to 404 on the live endpoint.
//
// Measured against the live endpoints while writing this, through OpenRouter:
//
//   openai/text-embedding-3-small   native 1536   with dimensions=1536 -> 1536
//   openai/text-embedding-3-large   native 3072   with dimensions=1536 -> 1536
//   google/gemini-embedding-001     native 3072   with dimensions=1536 -> 1536
//   qwen/qwen3-embedding-8b         native 4096   with dimensions=1536 -> 1536
//   qwen/qwen3-embedding-4b         native 2560   with dimensions=1536 -> 1536
//
// So the parameter is what makes them fit, not the model's native width — and
// a provider that ignores it fails at INGEST, after the documents are already
// saved, leaving retrieval quietly keyword-only. The probe moves that answer to
// selection time.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const fn = readFileSync("src/utils/tools/kbEmbed.functions.ts", "utf8");
const ui = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");
const embed = readFileSync("src/utils/tools/embedding.server.ts", "utf8");

describe("the store's width is a hard constraint, not a preference", () => {
  it("still rejects a wrong-width vector before it reaches Postgres", () => {
    // If this guard ever softened, the probe would be measuring something the
    // ingest path no longer enforces.
    expect(embed).toContain("const EMBED_DIMS = 1536");
    // Narrower vectors are padded (exact for cosine); only wider ones are refused.
    expect(embed).toContain("d.embedding.length > EMBED_DIMS");
  });

  it("asks for 1536 explicitly, which is what makes wider models fit", () => {
    expect(embed).toContain("dimensions: EMBED_DIMS");
  });
});

describe("kbEmbedProbe", () => {
  it("exists and requires a signed-in caller", () => {
    expect(fn).toContain("export const kbEmbedProbe");
    const block = fn.slice(fn.indexOf("export const kbEmbedProbe"));
    expect(block).toContain("requireSupabaseAuth");
  });

  it("measures what INGEST would do, via the same resolver", () => {
    // Probing a different provider than ingest would pick makes the answer
    // worthless — the whole point is that the two agree.
    const block = fn.slice(fn.indexOf("export const kbEmbedProbe"));
    expect(block).toContain("resolveEmbedTarget(userId, {");
    expect(block).toContain("provider: data.provider");
    expect(block).toContain("model: data.model");
    expect(block).toContain("embedTexts(");
  });

  it("reports the dimension it actually got back", () => {
    const block = fn.slice(fn.indexOf("export const kbEmbedProbe"));
    expect(block).toContain("dims: vector?.length");
  });

  it("says what to do when nothing is connected", () => {
    const block = fn.slice(fn.indexOf("export const kbEmbedProbe"));
    expect(block).toMatch(/not connected/i);
    expect(block).toMatch(/Integrations/);
  });

  it("strips the API key out of a provider error", () => {
    // Provider errors quote the failing request back, and this one travels to a
    // browser. Same class of leak the lakehouse had.
    const block = fn.slice(fn.indexOf("export const kbEmbedProbe"));
    expect(block).toContain("target.apiKey.length >= 6");
    expect(block).toContain('.split(target.apiKey).join("[redacted]")');
  });
});

describe("the settings dialog surfaces the measurement", () => {
  it("has a Test control bound to the probe", () => {
    expect(ui).toContain("kbEmbedProbe");
    expect(ui).toContain("useServerFn(kbEmbedProbe)");
    expect(ui).toContain("Test embedding");
  });

  it("shows the dimension on success and the reason on failure", () => {
    expect(ui).toContain("Works — {probe.dims} dimensions");
    expect(ui).toContain("{probe.message}");
  });

  it("clears a previous result when the provider changes", () => {
    // A stale green tick beside a provider that was never tested is worse than
    // no tick: it is a claim the app has not checked.
    const onChange = ui.slice(ui.indexOf("setEmbedProviderTouched(true);"));
    expect(onChange.slice(0, 200)).toContain("setProbe(null)");
  });
});
