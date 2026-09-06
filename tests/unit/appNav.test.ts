// The app's left rail: one nav map, read by the sidebar, the command palette
// and the session-restore banner, and mirrored by the docs checker so that
// "Observability → AI Budgets" in a page is a claim something verifies.
//
// The rail itself is pinned as a disclosure per group — thirty-five pages
// rendered flat is a list you scroll to navigate — with the group you are in
// opening itself, and the reader's choices remembered.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ADMIN_GROUP, NAV_GROUPS, navItemForPath } from "@/lib/appNav";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const ALL_GROUPS = [...NAV_GROUPS, ADMIN_GROUP];

describe("the nav map", () => {
  it("names every group once, every page once, and gives each an icon", () => {
    const labels = ALL_GROUPS.map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
    const urls = ALL_GROUPS.flatMap((g) => g.items.map((i) => i.url));
    expect(new Set(urls).size).toBe(urls.length);
    for (const g of ALL_GROUPS) {
      expect(g.items.length, g.label).toBeGreaterThan(0);
      for (const i of g.items) {
        expect(i.title.trim(), i.url).not.toBe("");
        expect(i.url.startsWith("/"), i.url).toBe(true);
        expect(typeof i.icon, `${g.label} → ${i.title}`).not.toBe("undefined");
      }
    }
  });

  it("finds the page a path is in by the longest matching url", () => {
    // A detail route belongs to its list page: /ml/<id> is still ML Models.
    expect(navItemForPath("/ml/2316d0f3-0000-4000-8000-000000000000")?.title).toBe("ML Models");
    expect(navItemForPath("/lakehouse")?.title).toBe("Lakehouse");
    // /analytics is a prefix of /analytics/observability, and the longer one
    // is the honest answer — the shorter one used to win by declaration order.
    expect(navItemForPath("/analytics/observability")?.title).toBe("Swarm Traces");
    expect(navItemForPath("/analytics")?.title).toBe("Analytics");
    // A query string or a hash names the same page.
    expect(navItemForPath("/agents?new=1")?.title).toBe("Agent Builder");
    expect(navItemForPath("/bi#tiles")?.title).toBe("BI Workspace");
    // Admin pages are only found when the admin group is passed in, which is
    // what the sidebar does for a superadmin.
    expect(navItemForPath("/admin/iam")).toBeUndefined();
    expect(navItemForPath("/admin/iam", ALL_GROUPS)?.title).toBe("IAM");
    expect(navItemForPath("/nowhere")).toBeUndefined();
    // A near miss is not a match: /metrics-foo is not /metrics.
    expect(navItemForPath("/metrics-foo")).toBeUndefined();
  });
});

describe("the sidebar", () => {
  const ui = rd("src/components/AppSidebar.tsx");

  it("renders every group as a disclosure, and never a flat list again", () => {
    const one = flat(ui);
    expect(one).toContain("{groups.map(renderGroup)}");
    expect(one).toContain("<Collapsible");
    expect(one).toContain("<CollapsibleTrigger");
    expect(one).toContain("<CollapsibleContent");
    // The label row is the trigger, so the whole row is the target.
    expect(one).toContain("<SidebarGroupLabel asChild>");
    // Closed groups say how much is folded away.
    expect(one).toContain("{group.items.length}");
  });

  it("remembers what was open, reading storage after mount so SSR still matches", () => {
    expect(ui).toContain('const STORAGE_KEY = "agentswarms:nav-groups.v1";');
    expect(ui).toContain("window.localStorage.getItem(STORAGE_KEY)");
    expect(ui).toContain("window.localStorage.setItem(STORAGE_KEY, JSON.stringify(openGroups))");
    // Never a useState initialiser: that renders differently than the server.
    expect(ui).not.toMatch(/useState\([^)]*localStorage/);
    // Every read and write is guarded — private mode throws on both.
    expect((ui.match(/} catch {/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // A group added later arrives closed rather than inheriting a stale true.
    expect(ui).toContain("openGroups[label] ?? DEFAULT_OPEN.has(label)");
  });

  it("opens the group holding the page you are on, without disarming its chevron", () => {
    const one = flat(ui);
    expect(one).toContain("navItemForPath(location.pathname, groups)?.url");
    expect(one).toContain(
      "setOpenGroups((prev) => (prev[activeGroup] ? prev : { ...prev, [activeGroup]: true }));",
    );
    // Written into state, not forced at render: collapsing the current group
    // has to stay collapsed until you navigate into it again.
    expect(one).not.toContain("holdsActive || open");
    expect(one).toContain("isActive={item.url === activeUrl}");
  });

  it("shares one Admin group with the palette instead of a second copy", () => {
    expect(ui).toContain("ADMIN_GROUP");
    const palette = flat(rd("src/components/CommandPalette.tsx"));
    expect(palette).toContain("isSuperadmin ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS");
    expect(palette).not.toContain('title: "IAM"');
    // And the restore banner asks the map the same question the rail asks.
    expect(rd("src/hooks/use-session-restore.ts")).toContain("navItemForPath(href)?.title");
  });

  it("animates the disclosure to a height only the browser knows, and stops for reduced motion", () => {
    const css = rd("src/styles.css");
    expect(css).toContain("@keyframes nav-group-open");
    expect(css).toContain("var(--radix-collapsible-content-height)");
    expect(css).toContain('.nav-group-content[data-state="open"]');
    const reduced = css.slice(css.indexOf("@keyframes nav-group-open"));
    expect(reduced).toContain("prefers-reduced-motion: reduce");
    expect(ui).toContain('className="nav-group-content overflow-hidden"');
  });
});

describe("the docs checker's copy of the rail", () => {
  /** APP_NAV in scripts/check-docs.mjs, as { group: items[] }. */
  function checkerNav(): Record<string, string[]> {
    const src = rd("scripts/check-docs.mjs");
    const start = src.indexOf("const APP_NAV = {");
    expect(start, "APP_NAV not found in scripts/check-docs.mjs").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n};", start));
    const out: Record<string, string[]> = {};
    for (const m of block.matchAll(/(?:"([^"]+)"|([A-Za-z_][\w]*))\s*:\s*\[([^\]]*)\]/g)) {
      const label = m[1] ?? m[2];
      const items = [...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      out[label] = items;
    }
    return out;
  }

  it("orders Data & BI as the journey a table takes, not alphabetically", () => {
    // The order is the product's explanation of itself: a reader scanning the
    // rail top to bottom should be reading a pipeline. Pinned because it is
    // the kind of thing a later edit reorders without noticing.
    const items = (NAV_GROUPS.find((g) => g.label === "Data & BI")?.items ?? []).map(
      (i) => i.title,
    );
    expect(items).toEqual([
      "Data Catalog",
      "ETL Pipelines",
      "Lakehouse",
      "SQL Models",
      "Semantic Layer",
      "Metrics",
      "AI Analyst",
      "BI Workspace",
      "ML Models",
      "Data monitors",
      "Developer workspace",
    ]);
    // The two that matter most for reading the product correctly: a model
    // produces a table, so it sits with the Lakehouse; the Semantic Layer
    // describes one, so it comes straight after.
    expect(items.indexOf("SQL Models")).toBe(items.indexOf("Lakehouse") + 1);
    expect(items.indexOf("Semantic Layer")).toBe(items.indexOf("SQL Models") + 1);
  });

  it("gives the docs rail the same reading order as the app rail", () => {
    const shell = rd("src/components/docs/DocsShell.tsx");
    const order = ["/docs/lakehouse", "/docs/sql-models", "/docs/semantics", "/docs/bi"];
    const at = order.map((u) => shell.indexOf(`to: "${u}"`));
    expect(
      at.every((i) => i > 0),
      "a docs rail entry is missing",
    ).toBe(true);
    expect(at.slice().sort((a, b) => a - b)).toEqual(at);
  });

  it("lists exactly the groups and pages the app renders", () => {
    const checker = checkerNav();
    expect(Object.keys(checker).sort()).toEqual(ALL_GROUPS.map((g) => g.label).sort());
    for (const group of ALL_GROUPS) {
      expect(checker[group.label].slice().sort(), group.label).toEqual(
        group.items.map((i) => i.title).sort(),
      );
    }
  });
});
