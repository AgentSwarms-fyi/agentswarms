// The handbook search the assistant answers "how do I…" from: run on the
// real generated handbook text, so a question people ask lands on the
// section that answers it.
import { describe, expect, it } from "vitest";

import { DOCS_INDEX } from "@/components/docs/docsIndex";
import { buildDocsIndex, docWords, excerptOf, searchDocs, stem } from "@/lib/docsSearch";
import { DOCS_TEXT } from "@/utils/assistant/docsText.server";

// Built as the assistant's tool builds it: each page's description counts
// for the sections under it.
const index = buildDocsIndex(
  DOCS_TEXT,
  Object.fromEntries(DOCS_INDEX.map((p) => [p.route, p.description])),
);
const top = (q: string, n = 3) => searchDocs(index, q, n).map((h) => h.link);

describe("the handbook text", () => {
  it("covers every docs page, cut at its headings", () => {
    const pages = new Set(DOCS_TEXT.map((s) => s.route));
    expect(pages.size).toBeGreaterThan(40);
    expect(DOCS_TEXT.length).toBeGreaterThan(500);
    // Every section links somewhere a reader can open.
    for (const s of DOCS_TEXT) expect(s.route).toMatch(/^\/docs(\/|$)/);
  });

  it("holds what a reader sees, not the markup", () => {
    for (const s of DOCS_TEXT) {
      // A component's name in prose ("<AgentChat> is…") is what the reader
      // sees; an attribute, a JSX spacer or an undecoded entity never is.
      expect(s.text, `${s.route}#${s.id}`).not.toMatch(/className=|\{" "\}|&[a-z]+;|&#\d+;/);
      expect(s.heading, `${s.route}#${s.id}`).not.toMatch(/&[a-z]+;/);
      expect(s.text, `${s.route}#${s.id}`).not.toMatch(/\.\.\s[A-Z]/);
    }
  });

  it("prints a value the page reads from the code as the value", () => {
    const trash = DOCS_TEXT.find((s) => s.route === "/docs/dashboard" && s.id === "trash");
    expect(trash?.text).toContain("restores it for 30 days");
    expect(trash?.text).not.toContain("TRASH_RETENTION_DAYS");
  });
});

describe("finding the section that answers a question", () => {
  it.each([
    ["how do I email a dashboard every Monday", "/docs/bi#dashboard-schedule"],
    ["restore something I deleted", "/docs/dashboard#trash"],
    ["send a report on a schedule", "/docs/bi#report-schedule"],
  ])("%s → %s", (q, want) => {
    expect(top(q)).toContain(want);
  });

  it("puts a heading match above a passing mention", () => {
    const [first] = searchDocs(index, "trash", 1);
    expect(first.link).toBe("/docs/dashboard#trash");
  });

  it("names the page and the heading, and links the heading", () => {
    const [hit] = searchDocs(index, "restore from trash", 1);
    expect(hit.title).toBe("Dashboard › Trash");
    expect(hit.link).toBe("/docs/dashboard#trash");
    expect(hit.excerpt.toLowerCase()).toContain("restor");
  });

  it("finds nothing for a question of only filler words", () => {
    expect(searchDocs(index, "how do I do this?")).toEqual([]);
    expect(searchDocs(index, "   ")).toEqual([]);
  });

  it("finds nothing for words the handbook does not use", () => {
    expect(searchDocs(index, "zzqx frobnicate")).toEqual([]);
  });
});

describe("the pieces", () => {
  it("makes one word of a word's forms, and leaves words that only look like them", () => {
    const same = (...ws: string[]) => expect(new Set(ws.map(stem)).size, ws.join(" ")).toBe(1);
    same("share", "shared", "shares", "sharing");
    same("schedule", "scheduled", "schedules", "scheduling");
    same("week", "weekly", "weeks");
    same("policy", "policies");
    same("box", "boxes");
    expect(stem("class")).toBe("class");
    expect(stem("access")).toBe("access");
    expect(stem("use")).toBe("use");
  });

  it("finds the handbook's words for the asker's", () => {
    // "email … every week" is said "sending … on a schedule" in the handbook.
    expect(top("email a dashboard every week")).toContain("/docs/bi#dashboard-schedule");
    expect(top("how do I connect a database", 2)).toContain("/docs/data#choosing");
  });

  it("drops words that cannot tell sections apart", () => {
    expect(docWords("How do I make a dashboard?")).toEqual(["dashboard"]);
  });

  it("cuts an excerpt at words, around the question's first match", () => {
    const text = `${"Alpha beta gamma. ".repeat(60)}The schedule sends a PDF. ${"Delta epsilon. ".repeat(60)}`;
    const ex = excerptOf(text, ["schedule"], 200);
    expect(ex).toContain("The schedule sends a PDF.");
    expect(ex.length).toBeLessThanOrEqual(210);
    expect(ex.startsWith("… ")).toBe(true);
    expect(ex.endsWith(" …")).toBe(true);
  });

  it("returns a short text whole", () => {
    expect(excerptOf("Short.", ["x"])).toBe("Short.");
  });
});
