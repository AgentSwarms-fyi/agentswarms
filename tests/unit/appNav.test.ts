// The app's left rail: one nav map, read by the sidebar, the command palette
// and the session-restore banner, and mirrored by the docs checker so that
// "Observability → AI Budgets" in a page is a claim something verifies.
//
// The rail itself is pinned as a disclosure per group — thirty-five pages
// rendered flat is a list you scroll to navigate — with the group you are in
// opening itself, and the reader's choices remembered.
//
// A group is a job. What holds that: no group past eight pages, the pages
// only a superadmin can use in Admin and nowhere else, no group named after a
// menu inside a page, and every page reading its own group from this map.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ADMIN_GROUP,
  ALL_NAV_GROUPS,
  MAX_GROUP_ITEMS,
  NAV_GROUPS,
  navGroupForPath,
  navItemForPath,
} from "@/lib/appNav";
import { IAM_TABS, iamTabFrom } from "@/lib/iamTabs";
import { revealDelta } from "@/lib/railScroll";
import { menuButton } from "@/lib/menuButton";

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
    // Monitoring is a superadmin's page, so it is found the same way.
    expect(navItemForPath("/monitoring")).toBeUndefined();
    expect(navItemForPath("/monitoring", ALL_GROUPS)?.title).toBe("Monitoring");
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
    // ...of every group: it names a page the reader was already on, so a
    // superadmin's page is "Monitoring" there and not "/monitoring".
    expect(rd("src/hooks/use-session-restore.ts")).toContain(
      "navItemForPath(href, ALL_NAV_GROUPS)?.title",
    );
    expect(ALL_NAV_GROUPS).toEqual(ALL_GROUPS);
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

describe("the rail the docs checker reads", () => {
  const titlesOf = (label: string) =>
    (NAV_GROUPS.find((g) => g.label === label)?.items ?? []).map((i) => i.title);

  it("orders the data groups as the journey a table takes, not alphabetically", () => {
    // The order is the product's explanation of itself: a reader scanning a
    // group top to bottom should be reading a pipeline. Pinned because it is
    // the kind of thing a later edit reorders without noticing.
    const engineering = titlesOf("Data engineering");
    expect(engineering).toEqual([
      "Data Catalog",
      "ETL Pipelines",
      "Lakehouse",
      "SQL Models",
      // Orchestration comes after the things it orchestrates: a graph is what
      // you draw once the pieces exist.
      "Workflows",
      "Data monitors",
      // What ran, for whom and at what cost: read once the rest is running (R531).
      "Query history",
    ]);
    // A model produces a table, so it sits straight after the Lakehouse.
    expect(engineering.indexOf("SQL Models")).toBe(engineering.indexOf("Lakehouse") + 1);

    expect(titlesOf("Analysis")).toEqual([
      // What the tables mean...
      "Semantic Layer",
      "Metrics",
      // The business model the metrics hang on: objects, links, rules, actions.
      "Enterprise Ontology",
      // ...then the questions. Working a table by hand (Sheets) comes before
      // asking a model about it.
      "Sheets",
      "AI Analyst",
      "BI Workspace",
    ]);

    // A model's whole life in the order it happens, as three named steps
    // (R538, ordered R539).
    expect(titlesOf("Data science")).toEqual([
      "Developer workspace",
      "Feature views",
      "Experiments",
      "ML Models",
      "ML pipelines",
      "Model serving",
      "ML operations",
    ]);

    // And the three read in that order down the rail: shape the table, say
    // what it means and ask it, then train on it.
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels.indexOf("Analysis")).toBe(labels.indexOf("Data engineering") + 1);
    expect(labels.indexOf("Data science")).toBe(labels.indexOf("Analysis") + 1);
  });

  it("gives the docs rail the same reading order as the app rail", () => {
    const shell = rd("src/components/docs/docsNav.ts");
    const order = ["/docs/lakehouse", "/docs/sql-models", "/docs/semantics", "/docs/bi"];
    const at = order.map((u) => shell.indexOf(`to: "${u}"`));
    expect(
      at.every((i) => i > 0),
      "a docs rail entry is missing",
    ).toBe(true);
    expect(at.slice().sort((a, b) => a - b)).toEqual(at);
  });

  it("reads exactly the groups and pages the app renders", async () => {
    // This used to compare the app's rail against a hand-kept copy of it in
    // scripts/check-docs.mjs, and the copy was right — until it would not have
    // been. The checker now READS this file, so what can break is the reader:
    // a regex that stops matching returns an empty rail and approves every
    // "Open X → Y" in both corpora, the wrong answer arriving silently.
    const { readAppNav } = (await import("../../scripts/lib/navPaths.mjs")) as {
      readAppNav: () => Record<string, string[]>;
    };
    const parsed = readAppNav();
    expect(Object.keys(parsed).sort()).toEqual(ALL_GROUPS.map((g) => g.label).sort());
    for (const group of ALL_GROUPS) {
      expect(parsed[group.label], group.label).toEqual(group.items.map((i) => i.title));
    }
  });

  it("keeps the admin group where the reader can find it", () => {
    // The parser takes everything from `export const NAV_GROUPS` to the end of
    // the file, which is how the Admin group — declared separately, because
    // only a superadmin sees it — ends up in the map at all. Declared ABOVE
    // NAV_GROUPS it would vanish from the checker without a word.
    const src = rd("src/lib/appNav.ts");
    expect(src.indexOf("export const ADMIN_GROUP")).toBeGreaterThan(
      src.indexOf("export const NAV_GROUPS"),
    );
  });
});

describe("a group is a job", () => {
  it("holds no more pages than one job has, and says what the job is", () => {
    // Fourteen pages in one group was three jobs in one list, and a list that
    // long is scrolled, not read. The limit is a constant so that raising it
    // is a decision somebody has to write down.
    expect(MAX_GROUP_ITEMS).toBe(8);
    for (const g of ALL_GROUPS) {
      expect(g.items.length, g.label).toBeLessThanOrEqual(MAX_GROUP_ITEMS);
      expect(g.hint.trim().length, g.label).toBeGreaterThan(10);
      // A hint is read in a tooltip: a phrase, not a paragraph, no full stop.
      expect(g.hint.length, g.label).toBeLessThanOrEqual(60);
      expect(g.hint.endsWith("."), g.label).toBe(false);
    }
    expect(new Set(ALL_GROUPS.map((g) => g.hint)).size).toBe(ALL_GROUPS.length);
  });

  it("is described in the handbook exactly as it is drawn", () => {
    // The table in the docs is a third copy of the rail. It is allowed to
    // exist because this reads it back: a group, its purpose and its pages,
    // in order, word for word.
    const page = flat(rd("src/routes/docs.dashboard.tsx"));
    for (const g of ALL_GROUPS) {
      const pages = g.items.map((i) => i.title).join(", ");
      expect(page, g.label).toContain(`"${g.hint}", "${pages}"`);
      expect(page, g.label).toContain(`"${g.label}`);
    }
    expect(page).toContain('"Admin (superadmins only)",');
  });

  it("keeps the agent work together, ahead of the data work", () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    // Prompts, skills and evaluations are an agent's raw material: straight
    // after Build, not on the far side of every data page.
    expect(labels.slice(0, 4)).toEqual(["Overview", "Build", "Library", "Experiment"]);
    expect(labels.indexOf("Experiment")).toBeLessThan(labels.indexOf("Data engineering"));
  });

  it("puts every page only a superadmin can use in Admin, and nowhere else", () => {
    expect(ADMIN_GROUP.items.map((i) => i.url)).toEqual([
      "/admin/iam",
      "/monitoring",
      "/admin/runtime",
    ]);
    const everyone = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.url));
    for (const item of ADMIN_GROUP.items) expect(everyone, item.title).not.toContain(item.url);
    // The page itself still says who it is for: the link is courtesy.
    expect(rd("src/routes/_authenticated/monitoring.tsx")).toContain(
      "Service monitoring is only available to superadmins.",
    );
  });

  it("tells the models you pick from apart from the models you train", () => {
    // "Model Registry" beside "ML Models" sent people looking for a trained
    // model to the catalogue of hosted ones, and back.
    const titles = ALL_GROUPS.flatMap((g) => g.items.map((i) => i.title));
    expect(titles.filter((t) => /registry/i.test(t))).toEqual([]);
    expect(navItemForPath("/model-registry")?.title).toBe("AI Model Catalog");
    expect(navGroupForPath("/model-registry")?.label).toBe("Integrations");
    expect(navItemForPath("/ml")?.title).toBe("ML Models");
    expect(navGroupForPath("/ml")?.label).toBe("Data science");
    // The page says the name the rail says.
    expect(rd("src/routes/_authenticated/model-registry.tsx")).toContain(
      'title="AI Model Catalog"',
    );
  });

  it("names no group after a menu inside a page", () => {
    // The Sheets editor has a Data menu, and "Data → Sort A to Z" is written
    // in the documents. A group called "Data" would make that a path into the
    // rail: one name for two things, with the reader left to guess.
    const toolbar = rd("src/components/sheets/SheetToolbar.tsx");
    const tabs = [...toolbar.matchAll(/\{ id: "\w+", label: "([^"]+)" \}/g)].map((m) => m[1]);
    expect(tabs).toContain("Data");
    const labels = ALL_GROUPS.map((g) => g.label.toLowerCase());
    for (const tab of tabs) expect(labels, tab).not.toContain(tab.toLowerCase());
  });
});

describe("screens that hold part of one thing say where the rest is", () => {
  it("budgets: yours, your groups' and a key's, each pointing at the others", () => {
    const mine = flat(rd("src/routes/_authenticated/budgets.tsx"));
    expect(mine).toContain("Up to three budgets apply to a call, and the strictest wins");
    // A link for the people who can open it, the path in words for the rest.
    expect(mine).toContain('to="/admin/iam" search={{ tab: "budgets" }}');
    expect(mine).toContain('"Admin → IAM → Budgets"');
    expect(mine).toContain("{isSuperadmin ? (");
    const groups = flat(rd("src/components/admin/GroupBudgetsTab.tsx"));
    expect(groups).toContain('<Link to="/budgets"');
    expect(groups).toContain("Observability → AI Budgets");
    // The path those words name is a real one.
    expect(navGroupForPath("/budgets")?.label).toBe("Observability");
    expect(navItemForPath("/budgets")?.title).toBe("AI Budgets");
  });

  it("the IAM page's tab is in the address, so it can be linked to", () => {
    const iam = flat(rd("src/routes/_authenticated/admin.iam.tsx"));
    expect(iam).toContain("const tab = iamTabFrom(Route.useSearch().tab);");
    expect(iam).toContain("value={tab}");
    expect(iam).not.toContain('<Tabs defaultValue="users">');
    // Every tab the page draws is one the address may name, and the reverse.
    const drawn = [...iam.matchAll(/<TabsTrigger value="(\w+)"/g)].map((m) => m[1]);
    expect(drawn).toEqual([...IAM_TABS]);
    expect(iamTabFrom("budgets")).toBe("budgets");
    expect(iamTabFrom("settings")).toBe("settings");
    // A tab that does not exist selected nothing: the header over an empty
    // page. Anything the page does not know opens its first tab.
    expect(iamTabFrom("nonsense")).toBe("users");
    expect(iamTabFrom("Budgets")).toBe("users");
    expect(iamTabFrom(undefined)).toBe("users");
    expect(iamTabFrom(3)).toBe("users");
  });

  it("keys: the Secrets page points at the list of every key", () => {
    const secrets = flat(rd("src/routes/_authenticated/secrets.tsx"));
    expect(secrets).toContain('to="/settings" search={{ tab: "api-keys" }}');
    expect(secrets).toContain("Settings → API keys");
    // And that tab exists, under that name.
    const settings = rd("src/routes/_authenticated/settings.tsx");
    expect(settings).toContain('id: "api-keys"');
    expect(settings).toContain('label: "API keys"');
  });
});

describe("the group a page says it is in", () => {
  const ROUTES = "src/routes/_authenticated";
  const pages = readdirSync(path.join(REPO, ROUTES)).filter((f) => f.endsWith(".tsx"));
  /** admin.iam.tsx → /admin/iam, analytics_.observability.$runId.tsx → /analytics/observability/x */
  const urlOf = (file: string) =>
    "/" +
    file
      .replace(/\.tsx$/, "")
      .replace(/_\./g, ".")
      .split(".")
      .map((part) => (part.startsWith("$") ? "x" : part))
      .join("/");

  it("is asked of the nav map, by path", () => {
    expect(navGroupForPath("/lakehouse")?.label).toBe("Data engineering");
    expect(navGroupForPath("/sheets/7c1d")?.label).toBe("Analysis");
    expect(navGroupForPath("/notebooks?new=1")?.label).toBe("Data science");
    // The page that started this: it said "Data & BI" for as long as it had
    // been under Build, because its label was written on the page.
    expect(navGroupForPath("/knowledge")?.label).toBe("Build");
    expect(navGroupForPath("/analytics/observability/run-1")?.label).toBe("Observability");
    expect(navGroupForPath("/monitoring")?.label).toBe("Admin");
    // Not in the rail: nothing to say, so the page says its own words.
    expect(navGroupForPath("/settings")).toBeUndefined();
    expect(navGroupForPath("/account")).toBeUndefined();
  });

  it("is never written on a page again", () => {
    const eyebrow = flat(rd("src/components/PageEyebrow.tsx"));
    expect(eyebrow).toContain("navGroupForPath(pathname)?.label ?? fallback");
    // Its own route, not the address bar: the address changes while the page
    // being left is still on screen, and that page then named the wrong group.
    expect(eyebrow).toContain("useMatch({ strict: false, select: (match) => match.pathname })");
    expect(eyebrow).not.toContain("useLocation");
    // The two styles the label used to be written in, with a name after them.
    const written = /uppercase tracking-(\[0\.14em\]|widest) text-primary">/;
    let using = 0;
    for (const file of pages) {
      const src = rd(`${ROUTES}/${file}`);
      expect(written.test(src), file).toBe(false);
      const uses = [...src.matchAll(/<PageEyebrow\b([^>]*)\/>/g)];
      // PageHeader draws the same label, with `eyebrow` as its fallback.
      const header = src.includes("<PageHeader");
      if (uses.length === 0 && !header) continue;
      using++;
      const listed = navGroupForPath(urlOf(file)) !== undefined;
      for (const use of uses) {
        // A page the rail lists takes its label from it. A page it does not
        // list has to bring its own words, or it would print nothing.
        expect(use[1].includes("fallback="), `${file} (${urlOf(file)})`).toBe(!listed);
      }
      // A listed page never writes its own label into its header either.
      if (header && listed) expect(/\beyebrow=/.test(src), `${file} (${urlOf(file)})`).toBe(false);
    }
    // Twenty-eight pages carried a written label when this was introduced.
    expect(using).toBeGreaterThanOrEqual(28);
  });
});

describe("the rail keeps the page you are on in view", () => {
  const rail = { top: 100, bottom: 500 };

  it("moves nothing when the row is already in view", () => {
    expect(revealDelta(rail, { top: 200, bottom: 232 })).toBe(0);
    // Touching the margin is in view; a rail that re-centres on every click
    // jumps under the pointer.
    expect(revealDelta(rail, { top: 108, bottom: 140 })).toBe(0);
    expect(revealDelta(rail, { top: 460, bottom: 492 })).toBe(0);
  });

  it("scrolls down just far enough for a row under the bottom edge", () => {
    // 60 px past the edge, plus the 8 px it should sit clear of it.
    expect(revealDelta(rail, { top: 528, bottom: 560 })).toBe(68);
    // Half hidden counts as hidden.
    expect(revealDelta(rail, { top: 480, bottom: 512 })).toBe(20);
    expect(revealDelta(rail, { top: 480, bottom: 512 }, 0)).toBe(12);
  });

  it("scrolls up, not down, for a row above the top edge", () => {
    expect(revealDelta(rail, { top: 40, bottom: 72 })).toBe(-68);
    expect(revealDelta(rail, { top: 90, bottom: 122 })).toBe(-18);
  });

  it("is used by the sidebar on its own scroll only, once the group has opened", () => {
    const ui = flat(rd("src/components/AppSidebar.tsx"));
    expect(ui).toContain(
      "rail.scrollTop += revealDelta(rail.getBoundingClientRect(), row.getBoundingClientRect());",
    );
    // scrollIntoView moves every scrolling ancestor, the page included.
    expect(ui).not.toContain("scrollIntoView");
    // Held in state: on a phone the rail mounts a render after its sheet is
    // opened, and a ref read then found nothing and never looked again.
    expect(ui).toContain("<SidebarContent ref={setRail}");
    expect(ui).toContain("}, [activeUrl, hydrated, router, rail]);");
    // The row is followed while groups change height, not scrolled to once:
    // one scroll after a fixed wait fired before the groups had opened on a
    // slow load and left the row under the edge.
    expect(ui).toContain("new ResizeObserver(() => { if (following) reveal(); })");
    expect(ui).toContain("for (const group of Array.from(rail.children)) watcher.observe(group);");
    // For longer than a group takes to open, and not for ever...
    const follows = Number(/const FOLLOW_MS = (\d+);/.exec(ui)?.[1]);
    const opens = Number(/animation: nav-group-open (\d+)ms/.exec(rd("src/styles.css"))?.[1]);
    expect(opens).toBeGreaterThan(0);
    expect(follows).toBeGreaterThan(opens * 5);
    expect(follows).toBeLessThanOrEqual(5000);
    expect(ui).toContain("}, FOLLOW_MS);");
    // The router puts scroll positions back once the new page has rendered,
    // which undid the reveal; it is done again after that.
    expect(ui).toContain('router.subscribe("onRendered", reveal)');
    // ...and never once the reader has touched the rail themselves.
    expect(ui).toContain(
      'const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;',
    );
    expect(ui).toContain("rail.addEventListener(type, touched, { passive: true })");
    expect(ui).toContain("if (theirs) return;");
    // And a closed group says what it is for when pointed at.
    expect(ui).toContain("title={group.hint}");
  });
});

describe("what the menu button says about itself", () => {
  it("speaks of the rail on a wide screen", () => {
    expect(menuButton({ isMobile: false, openMobile: false, railExpanded: true })).toEqual({
      expanded: true,
      label: "Collapse sidebar",
    });
    expect(menuButton({ isMobile: false, openMobile: false, railExpanded: false })).toEqual({
      expanded: false,
      label: "Expand sidebar",
    });
  });

  it("speaks of the sheet on a phone, whatever the rail behind it is set to", () => {
    // It read "Collapse sidebar, expanded" over a closed menu: the rail's
    // state stays "expanded" on a phone, where the menu is a sheet.
    expect(menuButton({ isMobile: true, openMobile: false, railExpanded: true })).toEqual({
      expanded: false,
      label: "Open menu",
    });
    expect(menuButton({ isMobile: true, openMobile: true, railExpanded: false })).toEqual({
      expanded: true,
      label: "Close menu",
    });
  });

  it("is what the button is given", () => {
    const ui = flat(rd("src/components/ui/sidebar.tsx"));
    expect(ui).toContain("const { expanded, label } = menuButton({");
    expect(ui).toContain("aria-expanded={expanded} aria-label={label}");
    expect(ui).not.toContain('aria-label={expanded ? "Collapse sidebar"');
  });
});
