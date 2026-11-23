// The template gallery (R530): one list read from every template registry,
// each entry linking to its own page, which starts it from that link.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CONNECTOR_TEMPLATES } from "@/lib/connectorTemplates";
import { ETL_TEMPLATES } from "@/lib/etlTemplates";
import { MCP_TEMPLATES } from "@/lib/mcpTemplates";
import { readPageIntent, TEMPLATE_ID_RULE } from "@/lib/pageIntent";
import { REAL_TEMPLATES } from "@/lib/realTemplates";
import { SAMPLE_NOTEBOOKS } from "@/lib/sampleNotebooks";
import { SAMPLE_SKILLS } from "@/lib/sampleSkills";
import { SHEETS_SAMPLES } from "@/lib/sheets/samples";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";
import {
  KIND_INFO,
  TEMPLATE_AREAS,
  TEMPLATE_GALLERY,
  TEMPLATE_KINDS,
  kindCounts,
  searchTemplates,
  type TemplateKind,
} from "@/lib/templateGallery";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

function routePaths(): Set<string> {
  const tree = rd("src/routeTree.gen.ts");
  const start = tree.indexOf("export interface FileRoutesByFullPath");
  const body = tree.slice(start, tree.indexOf("}", start));
  return new Set([...body.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]));
}
const PATHS = routePaths();

/** The route file that reads `?new=1&template=` for each page the gallery links to that way. */
const PAGE_FILE: Record<string, string> = {
  "/agents": "src/routes/_authenticated/agents.tsx",
  "/mcp-builder": "src/routes/_authenticated/mcp-builder.tsx",
  "/skills": "src/routes/_authenticated/skills.tsx",
  "/etl": "src/routes/_authenticated/etl.tsx",
  "/integrations": "src/routes/_authenticated/integrations.tsx",
  "/sheets": "src/routes/_authenticated/sheets.tsx",
  "/ontology": "src/routes/_authenticated/ontology.tsx",
};

const of = (k: TemplateKind) => TEMPLATE_GALLERY.filter((t) => t.kind === k);

describe("the gallery", () => {
  it("holds every template of every registry, once", () => {
    expect(of("swarm").map((t) => t.id)).toEqual(SWARM_TEMPLATES.map((t) => t.id));
    expect(of("agent").map((t) => t.id)).toEqual(REAL_TEMPLATES.map((t) => t.id));
    expect(of("mcp_server").map((t) => t.id)).toEqual(MCP_TEMPLATES.map((t) => t.id));
    expect(of("skill").map((t) => t.id)).toEqual(SAMPLE_SKILLS.map((t) => t.id));
    expect(of("pipeline").map((t) => t.id)).toEqual(ETL_TEMPLATES.map((t) => t.id));
    expect(of("connector").map((t) => t.id)).toEqual(CONNECTOR_TEMPLATES.map((t) => t.id));
    expect(of("workbook")).toHaveLength(SHEETS_SAMPLES.length);
    expect(of("notebook").map((t) => t.id)).toEqual(SAMPLE_NOTEBOOKS.map((n) => n.slug));
    expect(of("ontology")).toHaveLength(1);
    const keys = TEMPLATE_GALLERY.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says what each kind is for, where it sits, and what Use does", () => {
    for (const k of TEMPLATE_KINDS) {
      const info = KIND_INFO[k];
      expect(TEMPLATE_AREAS, k).toContain(info.area);
      expect(info.use.endsWith("."), k).toBe(true);
      expect(of(k).length, k).toBeGreaterThan(0);
    }
    for (const t of TEMPLATE_GALLERY) {
      expect(t.title.trim(), t.key).not.toBe("");
      expect(t.summary.trim(), t.key).not.toBe("");
    }
  });

  it("calls a kind 'makes' only where its page asks before making anything", () => {
    const makes = TEMPLATE_KINDS.filter((k) => KIND_INFO[k].effect === "makes");
    expect(makes.sort()).toEqual(["agent", "ontology"]);
    expect(rd(PAGE_FILE["/agents"])).toMatch(/startFromTemplate[\s\S]*confirmAsk\(/);
    expect(rd(PAGE_FILE["/ontology"])).toMatch(/onNew: \(from\)[\s\S]*confirmAsk\(/);
  });

  it("names what each template needs", () => {
    const needs = (key: string) => TEMPLATE_GALLERY.find((t) => t.key === key)?.needs;
    expect(needs("connector:github_repo")).toEqual([]);
    expect(needs("connector:pipedrive")).toEqual(["key"]);
    expect(needs("ontology:northwind")).toEqual(["lakehouse"]);
    expect(needs("agent:claude-long-context")).toEqual(["anthropic"]);
    expect(needs("agent:support-kb-agent")).toEqual(["model"]);
    // Every swarm sample has a step that calls a model.
    for (const t of of("swarm")) expect(t.needs, t.key).toEqual(["model"]);
  });
});

describe("Use", () => {
  it("goes only to pages that exist", () => {
    for (const t of TEMPLATE_GALLERY) {
      const to = t.kind === "notebook" ? "/notebooks/sample/$sampleSlug" : t.link.to;
      expect(PATHS.has(to), `${t.key}: ${to}`).toBe(true);
    }
    expect(PATHS.has("/templates")).toBe(true);
  });

  it("asks the page to start that template, in words the page reads", () => {
    for (const t of TEMPLATE_GALLERY) {
      if (t.kind === "notebook") {
        expect(t.link.to).toBe(`/notebooks/sample/${t.id}`);
        continue;
      }
      if (t.kind === "swarm") {
        expect(t.link.search).toEqual({ template: t.id });
        continue;
      }
      // What the page's validateSearch makes of the link: the id survives.
      expect(TEMPLATE_ID_RULE.test(t.id), t.key).toBe(true);
      expect(readPageIntent(t.link.search ?? {}), t.key).toEqual({ new: 1, template: t.id });
    }
  });

  it("is acted on by each page it goes to", () => {
    const pages = new Set(
      TEMPLATE_GALLERY.filter((t) => t.kind !== "notebook" && t.kind !== "swarm").map(
        (t) => t.link.to,
      ),
    );
    for (const to of pages) {
      const file = PAGE_FILE[to];
      expect(file, to).toBeDefined();
      const src = rd(file);
      expect(src, to).toContain("readPageIntent(");
      expect(src, to).toMatch(/onNew: \(from\)/);
    }
    expect(rd("src/routes/_authenticated/swarms.tsx")).toContain("out.template = s.template");
  });
});

describe("searching", () => {
  it("matches every word, across title, summary, kind and tags", () => {
    const all = searchTemplates(TEMPLATE_GALLERY, "");
    expect(all).toHaveLength(TEMPLATE_GALLERY.length);
    expect(searchTemplates(TEMPLATE_GALLERY, "github").map((t) => t.key)).toContain(
      "connector:github_repo",
    );
    const two = searchTemplates(TEMPLATE_GALLERY, "notebook langgraph");
    expect(two.length).toBeGreaterThan(0);
    expect(two.every((t) => t.kind === "notebook")).toBe(true);
    expect(searchTemplates(TEMPLATE_GALLERY, "zzz-nothing")).toEqual([]);
  });

  it("narrows to one kind, and counts each kind", () => {
    expect(searchTemplates(TEMPLATE_GALLERY, "", "pipeline")).toHaveLength(ETL_TEMPLATES.length);
    const counts = kindCounts(TEMPLATE_GALLERY);
    expect(counts.map(([k]) => k)).toEqual([...TEMPLATE_KINDS]);
    expect(counts.reduce((n, [, c]) => n + c, 0)).toBe(TEMPLATE_GALLERY.length);
  });
});
