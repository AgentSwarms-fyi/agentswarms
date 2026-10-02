// The handbook's navigation after the long pages were split: page families
// in the sidebar, the map at the top of a long page, the rail that shows the
// subsections of the section being read, and the guides that became several
// pages. Pure functions are called; the rendered shell is guarded by the
// lines that make the behaviour, since these tests run without a DOM.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docsFamily, docsFamilyFiles } from "./docsPages";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const SHELL = rd("src/components/docs/DocsShell.tsx");
const shell = () => import("@/components/docs/DocsShell");

describe("activeSectionOf — the rail lists the subsections of the section being read", () => {
  const headings = [
    { id: "what", level: 2 },
    { id: "what-a", level: 3 },
    { id: "train", level: 2 },
    { id: "train-a", level: 3 },
    { id: "train-b", level: 3 },
  ];

  it("a subsection belongs to the section above it", async () => {
    const { activeSectionOf } = await shell();
    expect(activeSectionOf(headings, "train-b")).toBe("train");
    expect(activeSectionOf(headings, "train-a")).toBe("train");
    expect(activeSectionOf(headings, "what-a")).toBe("what");
  });

  it("a section is its own section", async () => {
    const { activeSectionOf } = await shell();
    expect(activeSectionOf(headings, "train")).toBe("train");
    expect(activeSectionOf(headings, "what")).toBe("what");
  });

  it("nothing active, or an id the page does not have, is no section", async () => {
    const { activeSectionOf } = await shell();
    expect(activeSectionOf(headings, null)).toBeNull();
    expect(activeSectionOf(headings, "missing")).toBeNull();
    // A subsection before any section (a page that opens with an H3) has none.
    expect(activeSectionOf([{ id: "loose", level: 3 }], "loose")).toBeNull();
  });
});

describe("contentsEntries — the map under the title", () => {
  const h = (id: string, level: number) => ({ id, level, text: id });

  it("lists the sections when the page has enough of them, and only the sections", async () => {
    const { contentsEntries, CONTENTS_FROM_SECTIONS } = await shell();
    const headings = [
      ...Array.from({ length: CONTENTS_FROM_SECTIONS }, (_, i) => h(`s${i}`, 2)),
      h("s0-a", 3),
      h("s0-b", 3),
    ];
    expect(contentsEntries(headings).map((e) => e.id)).toEqual(
      Array.from({ length: CONTENTS_FROM_SECTIONS }, (_, i) => `s${i}`),
    );
  });

  it("on a page one section deep, lists the section and its subsections together", async () => {
    // The Kubernetes page: one section, a walk-through per cloud under it.
    const { contentsEntries } = await shell();
    const headings = [
      h("k8s", 2),
      h("eks", 3),
      h("gke", 3),
      h("aks", 3),
      h("oke", 3),
      h("verify", 3),
    ];
    expect(contentsEntries(headings).map((e) => e.id)).toEqual([
      "k8s",
      "eks",
      "gke",
      "aks",
      "oke",
      "verify",
    ]);
  });

  it("lists nothing on a short page", async () => {
    const { contentsEntries } = await shell();
    expect(contentsEntries([h("a", 2), h("a-1", 3), h("b", 2)])).toEqual([]);
    expect(contentsEntries([])).toEqual([]);
  });

  it("the threshold is what the header renders from", () => {
    expect(SHELL).toContain("const entries = contentsEntries(headings);");
    expect(SHELL).toContain("if (entries.length === 0) return null;");
  });
});

describe("page families — a long guide is an overview and its sub-pages", () => {
  const subPages = readdirSync(path.join(REPO, "src/routes")).filter((f) =>
    /^docs\.[a-z-]+_\.[a-z-]+\.tsx$/.test(f),
  );

  it("the ML and self-hosting guides were split", () => {
    expect(subPages.filter((f) => f.startsWith("docs.ml_."))).toHaveLength(5);
    expect(subPages.filter((f) => f.startsWith("docs.self-hosting_."))).toHaveLength(3);
  });

  it.each(subPages)(
    "%s is a sidebar item under its parent, on the overview's map, and links back",
    async (f) => {
      const [, parent, sub] = f.match(/^docs\.([a-z-]+)_\.([a-z-]+)\.tsx$/)!;
      const { DOCS_GROUPS } = await shell();
      const items = DOCS_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));
      const item = items.find((i) => i.to === `/docs/${parent}/${sub}`);
      expect(item, `no sidebar item for /docs/${parent}/${sub}`).toBeTruthy();
      expect(item!.parent).toBe(`/docs/${parent}`);
      // The parent sits in the same group, so the family is one block.
      expect(items.find((i) => i.to === `/docs/${parent}`)?.group).toBe(item!.group);
      // The overview's "In this guide" map reaches it.
      expect(rd(`src/routes/docs.${parent}.tsx`)).toContain(`to: "/docs/${parent}/${sub}"`);
      // The sub-page knows where it is.
      const page = rd(`src/routes/${f}`);
      // The route generator writes the route ID, where the `_` escape survives;
      // the URL is /docs/<parent>/<sub>, which is what the nav and NextPrev use.
      expect(page).toContain(`createFileRoute("/docs/${parent}_/${sub}")`);
      expect(page).toContain(`<DocLink to="/docs/${parent}">`);
      expect(page).toContain(`eyebrow="${item!.group}"`);
      expect(page).toContain(`<NextPrev current="/docs/${parent}/${sub}" />`);
    },
  );

  it("each sub-page follows its family in the reading order", async () => {
    const { DOCS_NAV } = await shell();
    for (let i = 0; i < DOCS_NAV.length; i++) {
      const item = DOCS_NAV[i];
      if (!item.parent) continue;
      const prev = DOCS_NAV[i - 1];
      expect(
        prev && (prev.to === item.parent || prev.parent === item.parent),
        `${item.to} does not follow its family in DOCS_NAV`,
      ).toBe(true);
    }
  });

  it("sub-pages are hidden until the reader is in the family, and carry no icon", () => {
    expect(SHELL).toContain("if (item.parent && !inFamily(item.parent)) return null;");
    expect(SHELL).toContain("current === parent || current.startsWith(`${parent}/`)");
    expect(SHELL).toContain("{item.parent ? null : <item.icon");
  });

  it("the old anchor into the ML page's API section follows the section", () => {
    expect(rd("src/routes/docs.api.tsx")).toContain('<DocLink to="/docs/ml/predictions#api">');
    expect(rd("src/routes/docs.ml_.predictions.tsx")).toContain('<H2 id="api">');
  });
});

describe("the docsPages helper reads a guide whole", () => {
  it("overview first, then its sub-pages", () => {
    const files = docsFamilyFiles("ml");
    expect(files[0]).toBe("src/routes/docs.ml.tsx");
    expect(files.slice(1).every((f) => f.startsWith("src/routes/docs.ml_."))).toBe(true);
    expect(docsFamily("ml")).toContain('createFileRoute("/docs/ml_/training")');
  });

  it("a guide that was never split is just its page", () => {
    expect(docsFamilyFiles("bi")).toEqual(["src/routes/docs.bi.tsx"]);
  });

  it("names an unknown guide instead of returning nothing", () => {
    expect(() => docsFamily("no-such-guide")).toThrow(/no in-app guide/);
  });
});

describe("the reading aids", () => {
  it("every section and subsection heading carries its own anchor link", () => {
    expect(SHELL).toContain('aria-label="Link to this section"');
    expect((SHELL.match(/<Anchor id=\{id\} \/>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the layout renders back-to-top and the header renders the map", () => {
    expect(rd("src/routes/docs.tsx")).toContain("<BackToTop />");
    expect(SHELL).toContain("<DocsContents />");
  });

  it("the rail shows subsections of the active section only", () => {
    expect(SHELL).toMatch(/activeSectionOf\(headings, activeId\)/);
  });
});

describe("the AI Analyst section has subsections", () => {
  it("one per topic, in reading order", () => {
    const bi = rd("src/routes/docs.bi.tsx");
    const at = bi.indexOf('<H2 id="ai-analyst">');
    const section = bi.slice(at, bi.indexOf("<H2 ", at + 1));
    expect([...section.matchAll(/<H3 id="([a-z-]+)">/g)].map((m) => m[1])).toEqual([
      "analyst-governed",
      "analyst-predictions",
      "analyst-what-if",
      "analyst-verified",
      "analyst-charts",
      "analyst-runs",
      "analyst-sharing",
      "analyst-provenance",
    ]);
  });
});
