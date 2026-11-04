// The words of a memory item or a prompt, as long-term memory recall matches
// them: lowercase, letters and digits, four characters or more, without a
// small stop-word list. Kept apart from recall so the sealing module can use
// it without importing recall (which imports the sealing module).

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
  "about",
  "into",
  "your",
  "their",
  "they",
  "them",
  "our",
  "out",
  "not",
  "but",
  "any",
  "all",
  "you",
  "user",
  "users",
  "agent",
  "agents",
  "some",
  "one",
  "two",
  "three",
  "what",
  "how",
  "why",
  "when",
  "who",
  "which",
  "does",
  "did",
  "been",
  "being",
]);

export function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const toks = cleaned.split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t));
  return Array.from(new Set(toks));
}
