// The list of object kinds is what search and the "New" menu are built from,
// so a kind whose link goes nowhere is a dead search result or a dead menu
// entry. These tests hold every link to a page that exists AND that acts on
// what the link asks.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_GROUP, NAV_GROUPS } from "@/lib/appNav";
import {
  CREATE_SECTIONS,
  createActions,
  isObjectKindId,
  linkToObject,
  OBJECT_KINDS,
  objectKind,
} from "@/lib/objectKinds";

const REPO = path.resolve(__dirname, "../..");
const ROUTES = path.join(REPO, "src/routes/_authenticated");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

/** The route file for a list page: /data-sql → data-sql.tsx. */
const pageFile = (url: string) => path.join(ROUTES, `${url.replace(/^\//, "")}.tsx`);

/** Detail routes, by the first segment and how many follow. */
const DETAIL_ROUTES: Record<string, string> = {
  "/bi/": "bi_.$dashboardId.tsx",
  "/bi/report/": "bi_.report.$reportId.tsx",
  "/ml/": "ml_.$modelId.tsx",
  "/mcp-builder/": "mcp-builder_.$appId.tsx",
  "/notebooks/py/": "notebooks.py.$pyNotebookId.tsx",
  "/ontology/": "ontology_.$ontologyId.tsx",
  "/sheets/": "sheets_.$workbookId.tsx",
};

/**
 * Where a page reads the link's request. Most read it in the route file; two
 * hand it to the component that owns the list.
 */
function handlesIntent(url: string): string {
  return rd(`src/routes/_authenticated/${url.replace(/^\//, "")}.tsx`);
}

describe("the object kinds", () => {
  it("are named once each, and each belongs to a page in the navigation", () => {
    const ids = OBJECT_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    const navUrls = new Set([...NAV_GROUPS, ADMIN_GROUP].flatMap((g) => g.items.map((i) => i.url)));
    for (const k of OBJECT_KINDS) {
      expect(navUrls.has(k.page), `${k.id} → ${k.page}`).toBe(true);
      expect(k.label.trim() && k.plural.trim(), k.id).toBeTruthy();
      expect(objectKind(k.id)).toBe(k);
    }
    expect(isObjectKindId("dashboard")).toBe(true);
    expect(isObjectKindId("constructor")).toBe(false);
    expect(isObjectKindId(undefined)).toBe(false);
  });

  it("open at a page that exists, and that acts on the link", () => {
    for (const k of OBJECT_KINDS) {
      const link = linkToObject({ kind: k.id, id: "ID", name: "n", parentId: "PARENT" });
      if (link.to === k.page || link.to === "/ai-analyst") {
        // Opened from its list page: the page must read the request.
        expect(existsSync(pageFile(link.to)), `${k.id}: ${link.to}`).toBe(true);
        const src = handlesIntent(link.to);
        if (k.id === "swarm") {
          // Swarms had their own link before the shared one: ?swarm=<id>.
          expect(link.search).toEqual({ swarm: "ID", view: "canvas" });
          expect(src).toContain("swarm");
        } else {
          expect(link.search?.open ?? link.search?.thread, k.id).toBeTruthy();
          expect(src, `${k.id}: ${link.to} must act on ?open=`).toMatch(
            /usePageIntent|readPageIntent/,
          );
        }
      } else {
        // Its own page per object.
        const prefix = link.to.slice(0, link.to.lastIndexOf("/") + 1);
        expect(DETAIL_ROUTES[prefix], `${k.id}: ${link.to}`).toBeTruthy();
        expect(existsSync(path.join(ROUTES, DETAIL_ROUTES[prefix])), link.to).toBe(true);
        expect(link.to.endsWith("/ID")).toBe(true);
      }
    }
  });

  it("carries both ids for an analysis, which opens inside its analyst", () => {
    expect(linkToObject({ kind: "analysis", id: "T", name: "n", parentId: "A" })).toEqual({
      to: "/ai-analyst",
      search: { open: "A", thread: "T" },
    });
    expect(handlesIntent("/ai-analyst")).toContain("thread");
  });
});

describe("everything that can be started", () => {
  const actions = createActions();

  it("is offered once, in a section, with a hint", () => {
    expect(new Set(actions.map((a) => a.kind)).size).toBe(actions.length);
    for (const a of actions) {
      expect(CREATE_SECTIONS).toContain(a.section);
      expect(a.title.trim() && a.hint.trim(), a.kind).toBeTruthy();
    }
    // Every section the menu lays out has something in it.
    for (const s of CREATE_SECTIONS) {
      expect(
        actions.some((a) => a.section === s),
        s,
      ).toBe(true);
    }
    // Sections come out in menu order.
    const order = actions.map((a) => CREATE_SECTIONS.indexOf(a.section));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("links to a page that starts one when asked", () => {
    for (const a of actions) {
      if (a.link.to === "/ml/new") {
        expect(existsSync(path.join(ROUTES, "ml_.new.tsx"))).toBe(true);
        continue;
      }
      expect(existsSync(pageFile(a.link.to)), `${a.kind}: ${a.link.to}`).toBe(true);
      // Every "new" link is spelled the same way, so one rule reads them all.
      expect(a.link.search?.new, a.kind).toBe(1);
      expect(handlesIntent(a.link.to), `${a.kind}: ${a.link.to} must act on ?new=1`).toMatch(
        /usePageIntent|readPageIntent/,
      );
    }
  });

  it("is the one list both the header menu and the palette draw from", () => {
    const menu = rd("src/components/GlobalCreateMenu.tsx");
    const palette = rd("src/lib/paletteSearch.ts");
    expect(menu).toContain("createActions()");
    expect(palette).toContain("createActions()");
    // No second, hand-written list of things to create.
    expect(rd("src/components/CommandPalette.tsx")).not.toContain("CREATE_ACTIONS");
  });
});
