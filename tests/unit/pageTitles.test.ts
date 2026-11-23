// Every signed-in page names its browser tab (R530). Twenty-one pages had no
// title of their own and showed the layout's placeholder, "AgentSwarms — Lab",
// so a row of tabs could not be told apart. A page in the sidebar is named as
// the sidebar names it, so the tab and the menu say the same thing.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALL_NAV_GROUPS } from "@/lib/appNav";

const REPO = path.resolve(__dirname, "../..");
const DIR = path.join(REPO, "src/routes/_authenticated");

/** Every route file under the signed-in layout, however deep. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? routeFiles(path.join(dir, e.name))
      : e.name.endsWith(".tsx")
        ? [path.join(dir, e.name)]
        : [],
  );
}

type Page = { file: string; path: string; title: string | null };

/** The pages: route files that draw something, with the path and title they declare. */
const PAGES: Page[] = routeFiles(DIR).flatMap((file) => {
  const src = readFileSync(file, "utf8");
  const route = src.match(/createFileRoute\("\/_authenticated(\/[^"]*)"\)/);
  if (!route || !/^\s+component: /m.test(src)) return [];
  // `analytics_/observability` is the path /analytics/observability, laid out
  // outside the analytics page.
  const routePath = route[1].replace(/_(?=\/|$)/g, "");
  const title = src.match(/head: \(\) => \(\{\s*meta: \[[\s\S]*?title: ["`]([^"`]+)["`]/);
  return [{ file: path.relative(REPO, file), path: routePath, title: title?.[1] ?? null }];
});

const NAV = new Map(ALL_NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.url, i.title] as const)));

describe("signed-in page titles", () => {
  it("finds the pages", () => {
    expect(PAGES.length).toBeGreaterThan(50);
  });

  it("gives every page a title of its own", () => {
    const untitled = PAGES.filter((p) => !p.title).map((p) => p.file);
    expect(untitled).toEqual([]);
    for (const p of PAGES) expect(p.title, p.file).toMatch(/ — AgentSwarms$/);
  });

  it("names a page in the menu as the menu does", () => {
    let checked = 0;
    for (const p of PAGES) {
      const nav = NAV.get(p.path);
      if (!nav) continue;
      checked++;
      expect(p.title, p.file).toBe(`${nav} — AgentSwarms`);
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("falls back to the product's name, not a placeholder", () => {
    const layout = readFileSync(path.join(REPO, "src/routes/_authenticated.tsx"), "utf8");
    expect(layout).toContain('{ title: "AgentSwarms" }');
    expect(layout).not.toMatch(/Lab"/);
  });
});
