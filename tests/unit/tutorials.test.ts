// Tutorials (R529): the list itself, the links it sends people to, the run
// table it measures from, and the handbook's copy of it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHECKED_TUTORIALS } from "@/lib/tutorialChecks";
import {
  activeTutorialRun,
  linkIsHere,
  nextStepIndex,
  TUTORIAL_AREAS,
  TUTORIAL_IDS,
  TUTORIALS,
  tutorialById,
  type TutorialRun,
} from "@/lib/tutorials";
import { WHATS_NEW, unseenCount } from "@/lib/whatsNew";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

/** Every page path the router knows, from the generated tree. */
function routePaths(): Set<string> {
  const tree = rd("src/routeTree.gen.ts");
  const start = tree.indexOf("export interface FileRoutesByFullPath");
  const body = tree.slice(start, tree.indexOf("}", start));
  return new Set([...body.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]));
}
const PATHS = routePaths();

/** The id rule in the migration's CHECK, read back so the two cannot drift. */
const MIGRATION = rd("supabase/migrations/20261126000000_tutorial_runs.sql");
const ID_RULE = new RegExp(MIGRATION.match(/tutorial_id ~ '([^']+)'/)![1]);

describe("the tutorials", () => {
  it("are the listed ids, each once, each with a check", () => {
    expect(TUTORIALS.map((t) => t.id)).toEqual([...TUTORIAL_IDS]);
    expect(Object.keys(CHECKED_TUTORIALS).sort()).toEqual([...TUTORIAL_IDS].sort());
    for (const id of TUTORIAL_IDS) expect(ID_RULE.test(id), id).toBe(true);
  });

  it("each say what you end with, how long, and what they need", () => {
    for (const t of TUTORIALS) {
      expect(TUTORIAL_AREAS).toContain(t.area);
      expect(t.minutes, t.id).toBeGreaterThan(0);
      expect(t.minutes, t.id).toBeLessThanOrEqual(20);
      expect(t.outcome.endsWith("."), t.id).toBe(true);
      expect(t.title.length, t.id).toBeLessThanOrEqual(42);
      for (const n of t.needs) expect(["model", "lakehouse"]).toContain(n);
    }
  });

  it("have three steps each, with distinct ids and words to act on", () => {
    for (const t of TUTORIALS) {
      expect(t.steps.length, t.id).toBe(3);
      expect(new Set(t.steps.map((s) => s.id)).size, t.id).toBe(t.steps.length);
      for (const s of t.steps) {
        expect(s.title.length, `${t.id}.${s.id}`).toBeLessThanOrEqual(60);
        expect(s.how.length, `${t.id}.${s.id}`).toBeLessThanOrEqual(260);
        expect(s.cta.length, `${t.id}.${s.id}`).toBeLessThanOrEqual(24);
      }
    }
  });

  it("send people only to pages that exist", () => {
    expect(PATHS.has("/learn")).toBe(true);
    for (const t of TUTORIALS) {
      for (const s of t.steps)
        expect(PATHS.has(s.link.to), `${t.id}.${s.id}: ${s.link.to}`).toBe(true);
    }
  });

  it("open the tab or template they name, which those pages read", () => {
    const integrations = rd("src/routes/_authenticated/integrations.tsx");
    const swarms = rd("src/routes/_authenticated/swarms.tsx");
    const templates = rd("src/lib/swarmTemplates.ts");
    for (const t of TUTORIALS) {
      for (const s of t.steps) {
        const q = s.link.search ?? {};
        if (s.link.to === "/integrations" && q.tab) {
          expect(integrations).toMatch(new RegExp(`INTEGRATION_TABS = \\[[^\\]]*"${q.tab}"`));
        }
        if (s.link.to === "/swarms" && q.template) {
          expect(swarms).toContain("out.template = s.template");
          expect(templates).toContain(`id: "${q.template}"`);
        }
      }
    }
  });

  it("are described in the handbook as they are listed", () => {
    const doc = rd("src/routes/docs.dashboard.tsx");
    for (const t of TUTORIALS) expect(doc, t.id).toContain(`"${t.title}"`);
    expect(doc).toContain("20261126000000");
  });
});

describe("the run table", () => {
  it("lets each person read and change only their own rows", () => {
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(MIGRATION, op).toMatch(
        new RegExp(`FOR ${op}\\s+(USING|WITH CHECK) \\(auth\\.uid\\(\\) = user_id\\)`),
      );
    }
    // An update may not hand a row to someone else.
    expect(MIGRATION).toMatch(
      /FOR UPDATE\s+USING \(auth\.uid\(\) = user_id\)\s+WITH CHECK \(auth\.uid\(\) = user_id\)/,
    );
  });

  it("is the newest migration, so it cannot be skipped by an older timestamp", () => {
    const names = readdirSync(path.join(REPO, "supabase/migrations")).filter((n) =>
      n.endsWith(".sql"),
    );
    const stamps = names.map((n) => n.slice(0, 14));
    expect(new Set(stamps).size, "duplicate migration timestamp").toBe(stamps.length);
    expect(stamps.filter((s) => s === "20261126000000")).toHaveLength(1);
  });
});

describe("the guide", () => {
  const run = (
    id: string,
    started: string,
    hidden = false,
    finished: string | null = null,
  ): TutorialRun => ({
    tutorial_id: id,
    started_at: started,
    hidden,
    finished_at: finished,
  });

  it("follows the tutorial started last that is still showing", () => {
    expect(activeTutorialRun([])).toBeNull();
    expect(
      activeTutorialRun([
        run("dashboard", "2026-11-23T10:00:00Z"),
        run("forecast", "2026-11-23T11:00:00Z"),
      ])?.tutorial_id,
    ).toBe("forecast");
    expect(
      activeTutorialRun([
        run("dashboard", "2026-11-23T10:00:00Z"),
        run("forecast", "2026-11-23T11:00:00Z", true),
      ])?.tutorial_id,
    ).toBe("dashboard");
  });

  it("keeps a finished tutorial until it is put away, and ignores ones it does not know", () => {
    expect(
      activeTutorialRun([run("dashboard", "2026-11-23T10:00:00Z", false, "2026-11-23T10:30:00Z")])
        ?.tutorial_id,
    ).toBe("dashboard");
    expect(activeTutorialRun([run("retired_one", "2026-11-23T12:00:00Z")])).toBeNull();
  });

  it("points at the first step not done", () => {
    expect(nextStepIndex([false, false, false])).toBe(0);
    expect(nextStepIndex([true, false, true])).toBe(1);
    expect(nextStepIndex([true, true, true])).toBe(-1);
  });

  it("offers no button to the page already open", () => {
    const apps = { to: "/integrations", search: { tab: "apps" } };
    expect(linkIsHere(apps, "/integrations", { tab: "apps" })).toBe(true);
    expect(linkIsHere(apps, "/integrations/", { tab: "apps", q: "x" })).toBe(true);
    expect(linkIsHere(apps, "/integrations", { tab: "secrets" })).toBe(false);
    expect(linkIsHere(apps, "/integrations", {})).toBe(false);
    expect(linkIsHere({ to: "/bi", search: { new: 1 } }, "/bi", { new: 1 })).toBe(true);
    // Once the page has taken ?new=1 away, the button to start one is back.
    expect(linkIsHere({ to: "/bi", search: { new: 1 } }, "/bi", {})).toBe(false);
    expect(linkIsHere({ to: "/bi" }, "/bi/d1", {})).toBe(false);
  });

  it("finds a tutorial by id", () => {
    expect(tutorialById("forecast")?.title).toBe("Forecast next quarter's orders");
    expect(tutorialById("nope")).toBeUndefined();
  });
});

describe("What's new", () => {
  it("is newest first, dated, and has each entry once", () => {
    const ids = WHATS_NEW.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of WHATS_NEW) {
      expect(e.date, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.date)), e.id).toBe(false);
    }
    const dates = WHATS_NEW.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("links to real pages and known tutorials", () => {
    for (const e of WHATS_NEW) {
      expect(PATHS.has(e.link.to), `${e.id}: ${e.link.to}`).toBe(true);
      if (e.tutorial) expect(TUTORIAL_IDS, e.id).toContain(e.tutorial);
    }
  });

  it("is written for the people using the app", () => {
    for (const e of WHATS_NEW) {
      const text = `${e.title} ${e.body}`;
      // Round numbers and migrations are for whoever runs the server.
      expect(text, e.id).not.toMatch(/\bR\d{3}\b|migration|\.sql\b/i);
      expect(e.body.length, e.id).toBeLessThanOrEqual(220);
      expect(e.title.length, e.id).toBeLessThanOrEqual(60);
      expect(e.body.endsWith("."), e.id).toBe(true);
    }
  });

  it("counts what this browser has not seen", () => {
    expect(unseenCount(WHATS_NEW, null)).toBe(WHATS_NEW.length);
    expect(unseenCount(WHATS_NEW, WHATS_NEW[0].id)).toBe(0);
    expect(unseenCount(WHATS_NEW, WHATS_NEW[2].id)).toBe(2);
    expect(unseenCount(WHATS_NEW, "an-entry-since-removed")).toBe(WHATS_NEW.length);
  });
});
