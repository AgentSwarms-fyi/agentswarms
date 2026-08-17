// The prompt library's search box, and the tag form it publishes.
//
// MEASURED in the live page: each card renders its tags as `#{t}`, so the
// screen shows "#security". Typing that returned 0 of 23 prompts; typing
// "security" returned 1. The page published an identifier its own search could
// not find — the same class as the metric whose qualified name was displayed
// but not searched (module 11).
import { describe, expect, it } from "vitest";

import { matchesPromptQuery, normalisePromptQuery } from "@/lib/promptSearch";
import { BUILT_IN_PROMPTS } from "@/lib/promptLibrary";

const prompt = {
  title: "Senior Code Reviewer",
  description: "Reviews PRs for correctness, security, performance, and clarity.",
  tags: ["code-review", "security", "best-practices"],
  category: "engineering",
};

describe("normalisePromptQuery", () => {
  it("lowercases and trims", () => {
    expect(normalisePromptQuery("  ReViewer  ")).toBe("reviewer");
  });

  it("strips a leading hash — the form the cards display", () => {
    expect(normalisePromptQuery("#security")).toBe("security");
  });

  it("strips the hash after trimming, so a pasted tag works", () => {
    // Copying a tag off the page tends to bring whitespace with it.
    expect(normalisePromptQuery("  #security ")).toBe("security");
  });

  it("only strips the FIRST hash, and only at the front", () => {
    // "C#" is a real thing to search for; the hash there is part of the term.
    expect(normalisePromptQuery("c#")).toBe("c#");
    expect(normalisePromptQuery("##double")).toBe("#double");
  });

  it("turns a bare hash into an empty query rather than a literal", () => {
    expect(normalisePromptQuery("#")).toBe("");
  });
});

describe("matchesPromptQuery", () => {
  describe("the tag a card displays", () => {
    it("matches with the hash, as shown on screen", () => {
      // The assertion the defect failed: this was false.
      expect(matchesPromptQuery(prompt, "#security", "all")).toBe(true);
    });

    it("still matches without the hash", () => {
      expect(matchesPromptQuery(prompt, "security", "all")).toBe(true);
    });

    it("gives the same answer either way, for every tag on a real prompt", () => {
      // The property, rather than one example: what the page prints and what
      // the page stores must be interchangeable in the search box.
      for (const p of BUILT_IN_PROMPTS) {
        for (const tag of p.tags) {
          expect(matchesPromptQuery(p, `#${tag}`, "all")).toBe(matchesPromptQuery(p, tag, "all"));
          expect(matchesPromptQuery(p, `#${tag}`, "all")).toBe(true);
        }
      }
    });
  });

  describe("what it searches", () => {
    it("matches the title", () => {
      expect(matchesPromptQuery(prompt, "reviewer", "all")).toBe(true);
    });

    it("matches the description", () => {
      expect(matchesPromptQuery(prompt, "correctness", "all")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(matchesPromptQuery(prompt, "REVIEWER", "all")).toBe(true);
    });

    it("ignores surrounding whitespace", () => {
      expect(matchesPromptQuery(prompt, "   reviewer   ", "all")).toBe(true);
    });

    it("does not match text that is absent", () => {
      expect(matchesPromptQuery(prompt, "snowflake", "all")).toBe(false);
    });

    it("does NOT search the prompt body — as the placeholder says", () => {
      // The box reads "Search by title, description, or tag…". Not searching
      // the body is a documented limit, so this test pins the promise rather
      // than the omission.
      const withBody = { ...prompt, content: "a long body mentioning kubernetes" };
      expect(matchesPromptQuery(withBody, "kubernetes", "all")).toBe(false);
    });
  });

  describe("an empty box is not a filter", () => {
    it("keeps everything when the query is blank", () => {
      expect(matchesPromptQuery(prompt, "", "all")).toBe(true);
      expect(matchesPromptQuery(prompt, "   ", "all")).toBe(true);
    });

    it("keeps everything when the query is a bare hash", () => {
      expect(matchesPromptQuery(prompt, "#", "all")).toBe(true);
    });
  });

  describe("the category filter", () => {
    it("excludes a prompt from another category", () => {
      expect(matchesPromptQuery(prompt, "", "customer-support")).toBe(false);
    });

    it("keeps a prompt in the selected category", () => {
      expect(matchesPromptQuery(prompt, "", "engineering")).toBe(true);
    });

    it("applies BOTH filters — category wins over a matching search", () => {
      // A title match must not smuggle a prompt past the category filter.
      expect(matchesPromptQuery(prompt, "reviewer", "customer-support")).toBe(false);
    });

    it("requires the search to match too, inside the right category", () => {
      expect(matchesPromptQuery(prompt, "snowflake", "engineering")).toBe(false);
    });
  });

  describe("a saved prompt with no description", () => {
    it("does not throw, and still matches on title and tags", () => {
      // Saved prompts allow a null description; the built-ins never have one,
      // which is exactly why the two duplicated filters had drifted in type.
      const saved = { title: "My prompt", description: null, tags: ["mine"], category: "other" };
      expect(matchesPromptQuery(saved, "my", "all")).toBe(true);
      expect(matchesPromptQuery(saved, "#mine", "all")).toBe(true);
      expect(matchesPromptQuery(saved, "absent", "all")).toBe(false);
    });
  });
});
