// Chunk splitting — pure string work, no server dependency.
//
// This lives in lib/ rather than in embedding.server.ts because both the
// indexing pipeline (server) and src/lib/kbRag.ts (reached from the knowledge
// route, so bundled for the browser) need it. TanStack's import protection
// denies any client-reachable import of `**/*.server.*` by PATH, regardless of
// what the module actually contains — so keeping these here was a build
// failure waiting for someone to run `npm run build`.

export const CHARS_PER_TOKEN = 4;
const DEFAULT_CHUNK_TOKENS = 256; // ~1024 chars
const DEFAULT_OVERLAP_TOKENS = 40; // ~160 chars

export type ChunkStrategy = "fixed" | "sentence" | "paragraph" | "semantic" | "recursive";

export type ChunkOptions = {
  strategy?: ChunkStrategy;
  chunkSize?: number; // tokens
  chunkOverlap?: number; // tokens
};

function resolveCharBudget(opts: ChunkOptions): { target: number; overlap: number } {
  const tokens = Math.max(64, Math.min(opts.chunkSize ?? DEFAULT_CHUNK_TOKENS, 2048));
  // Clamp overlap to <=50% of chunk size so prevTail can't dominate the next chunk.
  const overlapCap = Math.floor(tokens / 2);
  const overlapTokens = Math.max(
    0,
    Math.min(opts.chunkOverlap ?? DEFAULT_OVERLAP_TOKENS, overlapCap),
  );
  return { target: tokens * CHARS_PER_TOKEN, overlap: overlapTokens * CHARS_PER_TOKEN };
}

function splitFixed(text: string, target: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += target) out.push(text.slice(i, i + target));
  return out;
}

function splitBySentences(text: string, target: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > target) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      chunks.push(...splitFixed(s, target));
      continue;
    }
    if ((buf + " " + s).length > target) {
      chunks.push(buf.trim());
      buf = s;
    } else buf = buf ? buf + " " + s : s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function splitByParagraphs(text: string, target: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (p.length > target) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      chunks.push(...splitBySentences(p, target));
      continue;
    }
    if ((buf + "\n\n" + p).length > target) {
      chunks.push(buf.trim());
      buf = p;
    } else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Recursive: paragraphs → sentences → fixed, falling through when a unit
// still exceeds the budget. "Semantic" is approximated as recursive here
// (true semantic chunking requires extra embedding calls per boundary,
// which is not worth the cost for this stack — recursive gives most of
// the benefit at zero extra cost).
function splitRecursive(text: string, target: number): string[] {
  return splitByParagraphs(text, target);
}

export function chunkText(raw: string, opts: ChunkOptions = {}): string[] {
  const cleaned = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const { target, overlap } = resolveCharBudget(opts);
  if (cleaned.length <= target) return [cleaned];

  const strategy: ChunkStrategy = opts.strategy ?? "recursive";
  let chunks: string[];
  switch (strategy) {
    case "fixed":
      chunks = splitFixed(cleaned, target);
      break;
    case "sentence":
      chunks = splitBySentences(cleaned, target);
      break;
    case "paragraph":
      chunks = splitByParagraphs(cleaned, target);
      break;
    case "semantic":
    case "recursive":
    default:
      chunks = splitRecursive(cleaned, target);
      break;
  }

  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-overlap);
      chunks[i] = `${prevTail} ${chunks[i]}`;
    }
  }
  return chunks.filter((c) => c.trim().length > 0);
}
