// A self-hosted install can embed with a local model.
//
// THE GAP. The embed target resolver already knew Ollama and vLLM -- no API
// key needed, endpoint derived from the integration -- and yet an air-gapped
// deployment could not embed at all. `kb_chunks.embedding` is `vector(1536)`
// and every vector was hard-checked to be exactly 1536 wide. Local models do
// not honour the `dimensions` parameter: nomic-embed-text is 768, bge-m3 and
// mxbai-embed-large are 1024. Every one of them was refused with an error
// telling the operator to migrate the column.
//
// THE FIX, AND WHY IT IS EXACT. A shorter vector is zero-padded to the store
// width. For cosine similarity that changes nothing: appended zeros leave
// every dot product and every norm identical, so two 768-d vectors compare
// exactly as they would have at 768. Retrieval already pins a knowledge base
// to the provider and model its chunks were written with, so padded vectors
// are only ever compared with vectors padded the same way. A LONGER vector is
// still refused: truncation is only exact for Matryoshka models, and those
// already honour `dimensions` and never arrive too long.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { padToStoreWidth } from "@/utils/tools/embedding.server";

const EMBED = readFileSync("src/utils/tools/embedding.server.ts", "utf8");

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

describe("padding to the store width", () => {
  it("pads a shorter vector with zeros and leaves a full one alone", () => {
    const short = [0.5, -0.25, 0.75];
    const padded = padToStoreWidth(short);
    expect(padded).toHaveLength(1536);
    expect(padded.slice(0, 3)).toEqual(short);
    expect(padded.slice(3).every((x) => x === 0)).toBe(true);
    const full = Array.from({ length: 1536 }, (_, i) => i / 1536);
    expect(padToStoreWidth(full)).toBe(full);
  });

  it("preserves cosine similarity exactly, which is the whole argument", () => {
    const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 768 }, (_, i) => Math.cos(i / 3));
    const before = cosine(a, b);
    const after = cosine(padToStoreWidth(a), padToStoreWidth(b));
    expect(after).toBeCloseTo(before, 12);
  });

  it("refuses a vector wider than the store rather than truncating it", () => {
    expect(() => padToStoreWidth(new Array(1537).fill(0.1))).toThrow(/wider than the store/);
  });
});

describe("the guard in embedTexts", () => {
  it("pads short vectors and refuses only long ones", () => {
    const c = EMBED.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(c).toContain("out.push(padToStoreWidth(d.embedding))");
    expect(c).toMatch(/d\.embedding\.length > EMBED_DIMS/);
    expect(c).not.toMatch(/d\.embedding\.length !== EMBED_DIMS/);
  });

  it("still asks Matryoshka models for the store width", () => {
    // OpenAI-family models truncate exactly when asked; asking keeps the old
    // collections in the same space they were written in.
    expect(EMBED).toContain("dimensions: EMBED_DIMS");
  });
});
