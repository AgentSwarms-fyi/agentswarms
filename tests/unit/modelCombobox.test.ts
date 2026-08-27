// The selection logic behind ModelCombobox.
//
// These cover the list-building rules rather than the rendering: which ids end
// up in the list, in what order, and what happens to a typed id that matches
// nothing. Those are the parts that decide whether a saved model silently
// disappears, which is the failure that actually costs a user their config.
//
// Mirrors the useMemo in ModelCombobox.tsx. Kept as a pure function here so it
// can be exercised without mounting React; the component's copy is the same
// three steps in the same order.
import { describe, expect, it } from "vitest";

type Entry = { id: string; free?: boolean };

function buildEntries(opts: {
  live: Entry[] | null;
  fallback: string[];
  value: string;
  isAllowed?: (id: string) => boolean;
}): Entry[] {
  const fromLive: Entry[] = (opts.live ?? []).map((m) => ({ id: m.id, free: m.free }));
  const seen = new Set(fromLive.map((m) => m.id));
  const merged = [...fromLive];
  for (const id of opts.fallback) {
    if (!seen.has(id)) {
      merged.push({ id });
      seen.add(id);
    }
  }
  if (opts.value && !seen.has(opts.value)) merged.unshift({ id: opts.value });
  return opts.isAllowed ? merged.filter((m) => opts.isAllowed!(m.id)) : merged;
}

function filterEntries(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((m) => m.id.toLowerCase().includes(q));
}

function customIdFor(entries: Entry[], query: string): string | null {
  const t = query.trim();
  if (!t) return null;
  return entries.some((m) => m.id.toLowerCase() === t.toLowerCase()) ? null : t;
}

const LIVE: Entry[] = [
  { id: "openai/gpt-4o", free: false },
  { id: "openai/gpt-4o-mini", free: false },
  { id: "anthropic/claude-sonnet-4", free: false },
  { id: "meta-llama/llama-3.3-70b:free", free: true },
];

describe("ModelCombobox — which models are offered", () => {
  it("offers the provider's whole live catalogue, not just the bundled list", () => {
    const entries = buildEntries({ live: LIVE, fallback: ["openai/gpt-4o"], value: "" });
    // The point of the change: all four live ids are reachable, where the old
    // Select only ever showed what MODEL_SUGGESTIONS happened to contain.
    expect(entries.map((e) => e.id)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
      "meta-llama/llama-3.3-70b:free",
    ]);
  });

  it("keeps bundled suggestions the live catalogue does not list", () => {
    const entries = buildEntries({
      live: LIVE,
      fallback: ["openai/gpt-4o", "some/curated-id"],
      value: "",
    });
    expect(entries.map((e) => e.id)).toContain("some/curated-id");
    // No duplicate for the id present in both.
    expect(entries.filter((e) => e.id === "openai/gpt-4o")).toHaveLength(1);
  });

  it("keeps the saved model reachable even when the provider dropped it", () => {
    // Otherwise the field renders as if nothing were selected and the next
    // save quietly clears a model the user deliberately chose.
    const entries = buildEntries({ live: LIVE, fallback: [], value: "retired/old-model" });
    expect(entries[0].id).toBe("retired/old-model");
  });

  it("does not duplicate the saved model when it is already listed", () => {
    const entries = buildEntries({ live: LIVE, fallback: [], value: "openai/gpt-4o" });
    expect(entries.filter((e) => e.id === "openai/gpt-4o")).toHaveLength(1);
  });

  it("falls back to the bundled list before the first fetch lands", () => {
    // `live: null` is "still loading", which must not look like "no models".
    const entries = buildEntries({ live: null, fallback: ["openai/gpt-5"], value: "" });
    expect(entries.map((e) => e.id)).toEqual(["openai/gpt-5"]);
  });

  it("hides models an IAM rule forbids", () => {
    const entries = buildEntries({
      live: LIVE,
      fallback: [],
      value: "",
      isAllowed: (id) => !id.startsWith("anthropic/"),
    });
    expect(entries.map((e) => e.id)).not.toContain("anthropic/claude-sonnet-4");
    expect(entries.map((e) => e.id)).toContain("openai/gpt-4o");
  });

  it("carries the free flag through so the badge can render", () => {
    const entries = buildEntries({ live: LIVE, fallback: [], value: "" });
    expect(entries.find((e) => e.id === "meta-llama/llama-3.3-70b:free")?.free).toBe(true);
  });
});

describe("ModelCombobox — searching", () => {
  const entries = buildEntries({ live: LIVE, fallback: [], value: "" });

  it("matches anywhere in the id, not just the start", () => {
    // Ids are namespaced, so a user typing "sonnet" means the model name and
    // should not have to know the vendor prefix.
    expect(filterEntries(entries, "sonnet").map((e) => e.id)).toEqual([
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(filterEntries(entries, "  GPT-4O-MINI ").map((e) => e.id)).toEqual([
      "openai/gpt-4o-mini",
    ]);
  });

  it("keeps original order for a shared prefix rather than reranking", () => {
    // cmdk's fuzzy scorer would reorder these; ids that differ by a suffix are
    // far easier to scan in their listed order.
    expect(filterEntries(entries, "gpt-4o").map((e) => e.id)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
  });

  it("returns everything when the query is empty", () => {
    expect(filterEntries(entries, "   ")).toHaveLength(entries.length);
  });
});

describe("ModelCombobox — ids the catalogue does not have", () => {
  const entries = buildEntries({ live: LIVE, fallback: [], value: "" });

  it("offers an unmatched query as a usable id", () => {
    // A private deployment or a same-day release will never be in the list;
    // dropping what the user typed would make those unreachable.
    expect(customIdFor(entries, "my-org/private-model")).toBe("my-org/private-model");
  });

  it("does not offer a custom row for an id already listed", () => {
    expect(customIdFor(entries, "openai/gpt-4o")).toBeNull();
    expect(customIdFor(entries, "OpenAI/GPT-4O")).toBeNull();
  });

  it("offers nothing for an empty query", () => {
    expect(customIdFor(entries, "  ")).toBeNull();
  });
});

describe("ModelCombobox — the custom row must not hijack a search", () => {
  const entries = buildEntries({ live: LIVE, fallback: [], value: "" });

  /** Mirrors the tightened rule in the component. */
  function customIdWhenNoMatches(list: Entry[], query: string): string | null {
    const t = query.trim();
    if (!t) return null;
    if (filterEntries(list, t).length > 0) return null;
    return list.some((m) => m.id.toLowerCase() === t.toLowerCase()) ? null : t;
  }

  it("offers nothing custom while real models still match", () => {
    // Caught in the browser, not here: "sonnet" matches three real ids, yet
    // the custom row rendered FIRST, so Enter selected the literal "sonnet".
    expect(filterEntries(entries, "sonnet").length).toBeGreaterThan(0);
    expect(customIdWhenNoMatches(entries, "sonnet")).toBeNull();
  });

  it("still offers a genuinely unknown id", () => {
    expect(customIdWhenNoMatches(entries, "my-org/private-model")).toBe("my-org/private-model");
  });
});
