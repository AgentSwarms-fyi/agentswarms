// Every ready-made starting point in the app, in one list (R530).
//
// The templates themselves stay where they were written, beside the page that
// uses them: swarms, agents, pipelines, MCP servers, API connectors,
// notebooks, workbooks, skills and the ontology sample. This reads each of
// those lists, so a template added to one appears in the gallery without being
// listed twice, and says for each the same three things: what it is for, what
// it needs, and what pressing Use does (opens a draft, or makes something).
//
// Every link starts the template on its own page. Most pages read
// `?new=1&template=<id>` (src/lib/pageIntent.ts); swarms keep the
// `?template=<id>` they always read, and a sample notebook has a page of its own.
import { CONNECTOR_TEMPLATES } from "@/lib/connectorTemplates";
import { ETL_TEMPLATES } from "@/lib/etlTemplates";
import { MCP_TEMPLATES } from "@/lib/mcpTemplates";
import type { ObjectLink } from "@/lib/objectKinds";
import {
  SAMPLE_NAME as ONTOLOGY_SAMPLE_NAME,
  SAMPLE_TEMPLATE_ID as ONTOLOGY_SAMPLE_TEMPLATE,
} from "@/lib/ontology/sample";
import { REAL_TEMPLATES } from "@/lib/realTemplates";
import { SAMPLE_NOTEBOOKS } from "@/lib/sampleNotebooks";
import { SAMPLE_SKILLS } from "@/lib/sampleSkills";
import { SHEETS_SAMPLES, sheetsSampleId } from "@/lib/sheets/samples";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

export const TEMPLATE_KINDS = [
  "swarm",
  "agent",
  "mcp_server",
  "skill",
  "pipeline",
  "connector",
  "workbook",
  "ontology",
  "notebook",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** The sections of the gallery, named as the sidebar names them. */
export const TEMPLATE_AREAS = ["Agents", "Data engineering", "Analysis", "Data science"] as const;
export type TemplateArea = (typeof TEMPLATE_AREAS)[number];

/**
 * What a template needs before it does anything useful. A model and the
 * lakehouse can be checked for the person looking; the code sandbox and an
 * API key are said, not checked.
 */
export type TemplateNeed = "model" | "anthropic" | "lakehouse" | "sandbox" | "key";

export const NEED_LABEL: Record<TemplateNeed, string> = {
  model: "Uses a model",
  anthropic: "Uses an Anthropic key",
  lakehouse: "Uses the lakehouse",
  sandbox: "Runs code in the sandbox",
  key: "Needs the API's key",
};

/**
 * What pressing Use does. `draft` opens something you still have to save or
 * confirm; `makes` creates it in your workspace, after the page asks.
 */
export type TemplateEffect = "draft" | "makes";

export type KindInfo = {
  label: string;
  plural: string;
  area: TemplateArea;
  effect: TemplateEffect;
  /** One sentence: what Use does, in the words of the page it opens. */
  use: string;
};

export const KIND_INFO: Record<TemplateKind, KindInfo> = {
  swarm: {
    label: "Swarm",
    plural: "Swarms",
    area: "Agents",
    effect: "draft",
    use: "Opens on the canvas. Nothing is saved until you save it.",
  },
  agent: {
    label: "Agent",
    plural: "Agents",
    area: "Agents",
    effect: "makes",
    use: "Makes the agent, and its knowledge base where it has one, then opens it to chat with.",
  },
  mcp_server: {
    label: "MCP server",
    plural: "MCP servers",
    area: "Agents",
    effect: "draft",
    use: "Opens New MCP server with it chosen. The server is made when you press Create.",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    area: "Agents",
    effect: "draft",
    use: "Shows its skill.md. Duplicate it to have a copy of your own to change.",
  },
  pipeline: {
    label: "Pipeline",
    plural: "Pipelines",
    area: "Data engineering",
    effect: "draft",
    use: "Opens New pipeline with it chosen. The pipeline is made when you press Create.",
  },
  connector: {
    label: "API connector",
    plural: "API connectors",
    area: "Data engineering",
    effect: "draft",
    use: "Opens Any REST API with it chosen. Nothing is saved until you connect.",
  },
  workbook: {
    label: "Workbook",
    plural: "Workbooks",
    area: "Analysis",
    effect: "draft",
    use: "Opens the import. The workbook is made when you import it.",
  },
  ontology: {
    label: "Ontology",
    plural: "Ontologies",
    area: "Analysis",
    effect: "makes",
    use: "Makes six tables in your lakehouse and an ontology bound to them.",
  },
  notebook: {
    label: "Notebook",
    plural: "Notebooks",
    area: "Data science",
    effect: "draft",
    use: "Opens to read. Fork it to have a copy of your own to run and change.",
  },
};

export type GalleryTemplate = {
  /** `<kind>:<id in its own registry>`, unique across the gallery. */
  key: string;
  kind: TemplateKind;
  /** The id its own page knows it by. */
  id: string;
  title: string;
  summary: string;
  /** Words to search by beyond the title and summary. */
  tags: string[];
  needs: TemplateNeed[];
  link: ObjectLink;
};

const startNew = (to: string, id: string, extra: Record<string, string> = {}): ObjectLink => ({
  to,
  search: { ...extra, new: 1, template: id },
});

/** Steps of a swarm that call a model. */
const MODEL_STEPS = new Set(["agent", "router", "evaluate", "extract", "retrieve"]);

function swarmNeedsModel(nodes: unknown): boolean {
  return (Array.isArray(nodes) ? nodes : []).some((n) => {
    const kind = (n as { data?: { kind?: unknown } })?.data?.kind;
    return typeof kind === "string" && MODEL_STEPS.has(kind);
  });
}

function build(): GalleryTemplate[] {
  const out: GalleryTemplate[] = [];
  const add = (t: Omit<GalleryTemplate, "key">) => out.push({ ...t, key: `${t.kind}:${t.id}` });

  for (const t of SWARM_TEMPLATES) {
    add({
      kind: "swarm",
      id: t.id,
      title: t.title,
      summary: t.tagline,
      tags: [t.category],
      needs: swarmNeedsModel(t.nodes) ? ["model"] : [],
      link: { to: "/swarms", search: { template: t.id } },
    });
  }
  for (const t of REAL_TEMPLATES) {
    add({
      kind: "agent",
      id: t.id,
      title: t.title,
      summary: t.tagline,
      tags: [t.category],
      needs: t.requiresProvider === "anthropic" ? ["anthropic"] : ["model"],
      link: startNew("/agents", t.id),
    });
  }
  for (const t of MCP_TEMPLATES) {
    add({
      kind: "mcp_server",
      id: t.id,
      title: t.title,
      summary: t.tagline,
      tags: ["MCP", "Python"],
      needs: ["sandbox"],
      link: startNew("/mcp-builder", t.id),
    });
  }
  for (const t of SAMPLE_SKILLS) {
    add({
      kind: "skill",
      id: t.id,
      title: t.name,
      summary: t.description,
      tags: t.tags,
      needs: [],
      link: startNew("/skills", t.id),
    });
  }
  for (const t of ETL_TEMPLATES) {
    add({
      kind: "pipeline",
      id: t.id,
      title: t.name,
      summary: t.description,
      tags: [t.mode === "visual" ? "Visual" : "Python"],
      needs: ["sandbox"],
      link: startNew("/etl", t.id),
    });
  }
  for (const t of CONNECTOR_TEMPLATES) {
    add({
      kind: "connector",
      id: t.id,
      title: t.label,
      summary: t.description,
      tags: ["REST", t.checked === "live" ? "Run live" : "From its API reference"],
      needs: /^optional\b/i.test(t.credential.trim()) ? [] : ["key"],
      link: startNew("/integrations", t.id, { tab: "apps" }),
    });
  }
  for (const s of SHEETS_SAMPLES) {
    add({
      kind: "workbook",
      id: sheetsSampleId(s),
      title: s.title,
      summary: s.detail,
      tags: ["Excel", "Sheets"],
      needs: [],
      link: startNew("/sheets", sheetsSampleId(s)),
    });
  }
  add({
    kind: "ontology",
    id: ONTOLOGY_SAMPLE_TEMPLATE,
    title: ONTOLOGY_SAMPLE_NAME,
    summary:
      "A sample business: customers, orders and their lines, products, suppliers and shipments, with the ontology that names them. A few rows are wrong on purpose, so its first rule run finds something.",
    tags: ["Sample", "Retail"],
    needs: ["lakehouse"],
    link: startNew("/ontology", ONTOLOGY_SAMPLE_TEMPLATE),
  });
  for (const n of SAMPLE_NOTEBOOKS) {
    add({
      kind: "notebook",
      id: n.slug,
      title: n.title,
      summary: n.description,
      tags: [n.framework, n.tag],
      needs: ["sandbox"],
      link: { to: `/notebooks/sample/${n.slug}` },
    });
  }
  return out;
}

export const TEMPLATE_GALLERY: GalleryTemplate[] = build();

/** Templates whose title, summary, kind or tags hold every word of `query`. */
export function searchTemplates(
  items: readonly GalleryTemplate[],
  query: string,
  kind?: TemplateKind | null,
): GalleryTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((t) => {
    if (kind && t.kind !== kind) return false;
    if (!words.length) return true;
    const hay = [t.title, t.summary, KIND_INFO[t.kind].label, ...t.tags].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How many templates each kind has, in gallery order. */
export function kindCounts(items: readonly GalleryTemplate[]): [TemplateKind, number][] {
  return TEMPLATE_KINDS.map((k) => [k, items.filter((t) => t.kind === k).length]);
}
