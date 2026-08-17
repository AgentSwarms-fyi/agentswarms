// Matching a prompt against the library's search box and category filter.
//
// One copy, used by both tabs. There were two, identical apart from
// `description` being optional on a saved prompt, which is exactly the shape
// that drifts: fix the search on the built-ins tab and the saved tab keeps the
// old behaviour, with nothing to notice it.
//
// MEASURED: the cards render each tag as `#{t}` — the page shows you
// "#security" — while the tag is stored and matched as "security". Typing what
// the page displays returned 0 of 23 prompts; dropping the hash returned 1.
// A page must not publish an identifier its own search cannot find, so a
// leading "#" is now understood as "this is a tag" rather than taken literally.

export type SearchablePrompt = {
  title: string;
  description?: string | null;
  tags: string[];
  category: string;
};

/**
 * Normalise what the user typed.
 *
 * Lowercased and trimmed — both were already true of the original and both are
 * relied on. The hash is stripped ONLY from the front, so a query that happens
 * to contain "#" inside it (a title like "C#") still matches literally.
 */
export function normalisePromptQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

/** Does this prompt survive the current search box and category filter? */
export function matchesPromptQuery(
  prompt: SearchablePrompt,
  rawQuery: string,
  category: string | "all",
): boolean {
  if (category !== "all" && prompt.category !== category) return false;

  const q = normalisePromptQuery(rawQuery);
  // An empty box is not a filter — everything in the category survives.
  if (!q) return true;

  return (
    prompt.title.toLowerCase().includes(q) ||
    (prompt.description ?? "").toLowerCase().includes(q) ||
    prompt.tags.some((t) => t.toLowerCase().includes(q))
  );
}
