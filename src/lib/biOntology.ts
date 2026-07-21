// ONTOLOGY visual — a high-level knowledge map of the whole data estate.
//
// Pipeline (user-triggered from the BI builder):
//   1. GATHER  — entities from every selected source: local datasets
//                (incl. prepared ones), each warehouse's tables, knowledge
//                bases (as document entities).
//   2. DETECT  — deterministic relationships: semantic-layer join hints,
//                *_id → target-table key matching (cross-source), and
//                data-prep lineage (prepared dataset ← its source tables).
//   3. ENRICH  — one JSON-mode LLM call classifies every entity (category,
//                business domain, description), labels each detected
//                relation (verb + cardinality) and infers additional
//                conceptual relations — validated, with a heuristic
//                fallback when the AI call fails.
//
// The resulting OntologySpec is stored inside the widget's chart JSON, so
// it snapshots/publishes/exports exactly like any other visual.
import { llmJson } from "@/lib/biAgent";
import type { SemanticEntry } from "@/lib/biAgent";
import type { DatasetMeta } from "@/lib/sqlEngine";
import type { WarehouseTable } from "@/utils/warehouse/types";

// ── Spec model ───────────────────────────────────────────────────────────

export const ONTOLOGY_CATEGORIES = [
  "master",
  "transaction",
  "event",
  "reference",
  "metric",
  "document",
] as const;
export type OntologyCategory = (typeof ONTOLOGY_CATEGORIES)[number];

export type OntologyField = { name: string; type: string; semantic?: string };

export type OntologyEntity = {
  id: string;
  /** Business/display name (semantic-layer business name when present). */
  name: string;
  /** Physical table / dataset / knowledge-base name. */
  table: string;
  /** Human source label: "Local", warehouse connection name, "Prepared", "Knowledge". */
  source: string;
  sourceKind: "local" | "prepared" | "warehouse" | "knowledge";
  category: OntologyCategory;
  domain: string;
  description: string;
  rowCount?: number;
  columnCount: number;
  keyColumns: string[];
  fields: OntologyField[];
};

export type OntologyRelationKind = "join" | "lineage" | "semantic";
export type OntologyCardinality = "1:1" | "1:N" | "N:1" | "N:M";

export type OntologyRelation = {
  from: string;
  to: string;
  /** Short verb phrase, e.g. "places", "belongs to", "derived from". */
  label: string;
  kind: OntologyRelationKind;
  keys?: { from: string; to: string };
  cardinality?: OntologyCardinality;
  confidence: "high" | "medium" | "low";
};

export type OntologySpec = {
  builtAt: string;
  summary: string;
  aiEnriched: boolean;
  domains: string[];
  entities: OntologyEntity[];
  relations: OntologyRelation[];
  notes: string[];
};

// ── Build inputs (assembled by the builder pane) ─────────────────────────

export type OntologySourceInputs = {
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  preparedTables: Set<string>;
  warehouses: { id: string; name: string; tables: WarehouseTable[] }[];
  knowledgeBases: { id: string; name: string; docCount: number }[];
  prepFlows: { name: string; outputTable: string | null; sources: string[] }[];
};

const MAX_ONTOLOGY_ENTITIES = 80;
const MAX_FIELDS_PER_ENTITY = 14;
const MAX_RELATIONS = 160;
const MAX_AI_EXTRA_RELATIONS = 40;

// ── 1. Gather ────────────────────────────────────────────────────────────

const localId = (table: string) => `local:${table}`;

function keyColumnsOf(fields: OntologyField[], primaryKey?: string | null): string[] {
  const keys = fields.filter((f) => /(^id$|_id$)/i.test(f.name)).map((f) => f.name);
  if (primaryKey && !keys.includes(primaryKey)) keys.unshift(primaryKey);
  return keys.slice(0, 4);
}

export function gatherEntities(inputs: OntologySourceInputs): OntologyEntity[] {
  const entities: OntologyEntity[] = [];

  for (const d of inputs.datasets) {
    const sem = inputs.semantics.get(d.id);
    const fields: OntologyField[] = d.columns.slice(0, MAX_FIELDS_PER_ENTITY).map((c) => ({
      name: c.name,
      type: c.type,
      semantic: sem?.column_meta?.[c.name]?.semantic_type,
    }));
    const prepared = inputs.preparedTables.has(d.name);
    entities.push({
      id: localId(d.name),
      name: sem?.business_name || d.name,
      table: d.name,
      source: prepared ? "Prepared" : "Local",
      sourceKind: prepared ? "prepared" : "local",
      category: "reference", // provisional — classified below
      domain: "General",
      description: sem?.table_description ?? "",
      rowCount: d.row_count,
      columnCount: d.columns.length,
      keyColumns: keyColumnsOf(fields, sem?.primary_key),
      fields,
    });
  }

  for (const wh of inputs.warehouses) {
    for (const t of wh.tables) {
      const table = `${t.schema}.${t.name}`;
      const fields: OntologyField[] = t.columns
        .slice(0, MAX_FIELDS_PER_ENTITY)
        .map((c) => ({ name: c.name, type: c.type }));
      entities.push({
        id: `wh:${wh.id}:${table}`,
        name: t.name,
        table,
        source: wh.name,
        sourceKind: "warehouse",
        category: "reference",
        domain: "General",
        description: "",
        columnCount: t.columns.length,
        keyColumns: keyColumnsOf(fields),
        fields,
      });
    }
  }

  for (const kb of inputs.knowledgeBases) {
    entities.push({
      id: `kb:${kb.id}`,
      name: kb.name,
      table: kb.name,
      source: "Knowledge",
      sourceKind: "knowledge",
      category: "document",
      domain: "General",
      description: `Knowledge base with ${kb.docCount} document${kb.docCount === 1 ? "" : "s"}`,
      rowCount: kb.docCount,
      columnCount: 0,
      keyColumns: [],
      fields: [],
    });
  }

  for (const e of entities) {
    if (e.sourceKind !== "knowledge") e.category = heuristicCategory(e);
  }
  return entities;
}

/** Name/column-based classification used pre-enrichment and as AI fallback. */
export function heuristicCategory(e: OntologyEntity): OntologyCategory {
  // Classify on the bare table name — schema prefixes would defeat ^dim_ etc.
  const n = (e.table.split(".").pop() ?? e.table).toLowerCase();
  if (/(^|_)(log|event|click|visit|session)s?($|_)/.test(n)) return "event";
  if (/(metric|kpi|summary|agg)/.test(n)) return "metric";
  if (/(fact|txn|transaction|order|sale|invoice|payment|shipment)/.test(n)) return "transaction";
  if (/(^dim_|lookup|_type$|status|country|region|category|calendar)/.test(n)) return "reference";
  if (/(customer|user|product|account|employee|vendor|supplier|store|patient)/.test(n)) {
    return "master";
  }
  if (e.sourceKind === "prepared") return "metric";
  const hasDate = e.fields.some((f) => f.type === "date" || /date|time/i.test(f.type));
  const numeric = e.fields.filter((f) => f.type === "number" || /int|num|dec|float/i.test(f.type));
  if (hasDate && numeric.length >= 1) return "transaction";
  return "master";
}

// ── 2. Detect relationships ──────────────────────────────────────────────

/** "public.dim_customers" → "customer"-style base for *_id matching. */
function tableBase(table: string): string {
  const last = table.split(".").pop() ?? table;
  return last
    .toLowerCase()
    .replace(/^(dim_|fact_|stg_|raw_)/, "")
    .replace(/ies$/, "y")
    .replace(/(?<![su])s$/, "");
}

function relKey(r: { from: string; to: string; kind: string }): string {
  return `${r.from}|${r.to}|${r.kind}`;
}

export function detectRelations(
  entities: OntologyEntity[],
  inputs: OntologySourceInputs,
): OntologyRelation[] {
  const relations: OntologyRelation[] = [];
  const seen = new Set<string>();
  const push = (r: OntologyRelation) => {
    if (r.from === r.to) return;
    const k = relKey(r);
    const flipped = relKey({ from: r.to, to: r.from, kind: r.kind });
    if (seen.has(k) || seen.has(flipped)) return;
    seen.add(k);
    relations.push(r);
  };

  const byId = new Map(entities.map((e) => [e.id, e]));
  const localByTable = new Map(
    entities.filter((e) => e.id.startsWith("local:")).map((e) => [e.table.toLowerCase(), e]),
  );
  const byBase = new Map<string, OntologyEntity[]>();
  for (const e of entities) {
    if (e.sourceKind === "knowledge") continue;
    const b = tableBase(e.table);
    byBase.set(b, [...(byBase.get(b) ?? []), e]);
  }

  // Semantic-layer join hints (owner-curated → highest confidence).
  for (const sem of inputs.semantics.values()) {
    for (const h of sem.join_hints ?? []) {
      const from = localByTable.get(h.from.toLowerCase());
      const to = localByTable.get(h.to.toLowerCase());
      if (!from || !to) continue;
      const m = /([\w`"]+)\.([\w`"]+)\s*=\s*([\w`"]+)\.([\w`"]+)/.exec(h.on);
      push({
        from: from.id,
        to: to.id,
        label: "joins",
        kind: "join",
        keys: m ? { from: m[2].replace(/[`"]/g, ""), to: m[4].replace(/[`"]/g, "") } : undefined,
        confidence: "high",
      });
    }
  }

  // *_id → target-table matching, across every structured source.
  for (const e of entities) {
    if (e.sourceKind === "knowledge") continue;
    for (const f of e.fields) {
      const m = /^(.*?)_?id$/i.exec(f.name);
      if (!m || !m[1]) continue; // skip bare "id" (that's the entity's own key)
      const base = m[1].toLowerCase().replace(/_$/, "");
      const targets = byBase.get(base) ?? [];
      for (const t of targets) {
        if (t.id === e.id) continue;
        const toKey = t.fields.find((tf) => tf.name.toLowerCase() === f.name.toLowerCase())
          ? f.name
          : (t.fields.find((tf) => /^id$/i.test(tf.name))?.name ?? f.name);
        push({
          from: e.id,
          to: t.id,
          label: "references",
          kind: "join",
          keys: { from: f.name, to: toKey },
          cardinality: "N:1",
          confidence: "high",
        });
      }
    }
  }

  // Data-prep lineage: prepared output ← each source table.
  for (const flow of inputs.prepFlows) {
    if (!flow.outputTable) continue;
    const out = localByTable.get(flow.outputTable.toLowerCase());
    if (!out) continue;
    for (const src of flow.sources) {
      const s = localByTable.get(src.toLowerCase());
      if (!s) continue;
      push({
        from: out.id,
        to: s.id,
        label: "derived from",
        kind: "lineage",
        confidence: "high",
      });
    }
  }

  return relations.filter((r) => byId.has(r.from) && byId.has(r.to)).slice(0, MAX_RELATIONS);
}

// ── 3. AI enrichment ─────────────────────────────────────────────────────

type AiEntityPatch = {
  id?: string;
  businessName?: string;
  category?: string;
  domain?: string;
  description?: string;
};
type AiRelation = { from?: string; to?: string; label?: string; cardinality?: string };
type AiOntologyOut = { summary?: string; entities?: AiEntityPatch[]; relations?: AiRelation[] };

function describeForPrompt(entities: OntologyEntity[], relations: OntologyRelation[]): string {
  const entityLines = entities.map((e) => {
    const cols = e.fields
      .slice(0, 12)
      .map((f) => `${f.name}:${f.type}${f.semantic ? `/${f.semantic}` : ""}`)
      .join(", ");
    const rows = e.rowCount !== undefined ? ` rows=${e.rowCount}` : "";
    const desc = e.description ? ` -- ${e.description.slice(0, 90)}` : "";
    return `- ${e.id} | ${e.table} | source=${e.source}${rows} | ${cols || "(documents)"}${desc}`;
  });
  const relLines = relations.map(
    (r) => `- ${r.from} -> ${r.to} (${r.kind}${r.keys ? `, ${r.keys.from}=${r.keys.to}` : ""})`,
  );
  return [
    "ENTITIES:",
    ...entityLines,
    relLines.length ? "\nDETECTED RELATIONS (from keys, join hints and prep lineage):" : "",
    ...relLines,
  ]
    .filter(Boolean)
    .join("\n");
}

const CARDINALITIES = new Set<string>(["1:1", "1:N", "N:1", "N:M"]);

function flipCardinality(c?: OntologyCardinality): OntologyCardinality | undefined {
  return c === "1:N" ? "N:1" : c === "N:1" ? "1:N" : c;
}

export async function enrichOntology(args: {
  entities: OntologyEntity[];
  relations: OntologyRelation[];
  model?: string;
}): Promise<{ summary: string; entities: OntologyEntity[]; relations: OntologyRelation[] }> {
  const out = await llmJson<AiOntologyOut>({
    model: args.model,
    systemPrompt:
      "You are a data architect building a business ontology of an organisation's data estate. " +
      "Classify entities, name their business domains and label relationships. Output JSON only. " +
      "Rules: use ONLY the entity ids given; every entity gets a category from " +
      `[${ONTOLOGY_CATEGORIES.join(", ")}], a short business domain ("Sales", "Customers", ` +
      '"Operations"…), a business name and a description of at most 18 words. ' +
      "Label EVERY detected relation with a verb phrase of at most 4 words plus a cardinality. " +
      "You may add NEW relations between listed entities (including knowledge bases that " +
      "document a subject area) ONLY when the names/columns clearly support them — never " +
      "invent speculative links. Group related entities under the same domain.",
    userPrompt:
      `${describeForPrompt(args.entities, args.relations)}\n\n` +
      'Return JSON: { "summary": "2-3 sentence executive overview of this data estate", ' +
      '"entities": [{ "id", "businessName", "category", "domain", "description" }], ' +
      '"relations": [{ "from", "to", "label", "cardinality": "1:1|1:N|N:1|N:M" }] } — ' +
      "relations must include a labelled entry for every detected relation, plus any new ones.",
  });

  const ids = new Set(args.entities.map((e) => e.id));
  const patchById = new Map<string, AiEntityPatch>();
  for (const p of out.entities ?? []) {
    if (p.id && ids.has(p.id)) patchById.set(p.id, p);
  }
  const entities = args.entities.map((e) => {
    const p = patchById.get(e.id);
    const category = ONTOLOGY_CATEGORIES.includes(p?.category as OntologyCategory)
      ? (p!.category as OntologyCategory)
      : e.category;
    return {
      ...e,
      name: (p?.businessName ?? "").trim().slice(0, 40) || e.name,
      category,
      domain: (p?.domain ?? "").trim().slice(0, 24) || e.domain,
      description: (p?.description ?? "").trim().slice(0, 160) || e.description,
    };
  });

  const aiRels = (out.relations ?? []).filter(
    (r): r is Required<AiRelation> =>
      typeof r.from === "string" && typeof r.to === "string" && ids.has(r.from) && ids.has(r.to),
  );
  const findAi = (from: string, to: string) =>
    aiRels.find((r) => r.from === from && r.to === to) ??
    aiRels.find((r) => r.from === to && r.to === from);

  const relations: OntologyRelation[] = args.relations.map((r) => {
    const ai = findAi(r.from, r.to);
    if (!ai) return r;
    const reversed = ai.from === r.to;
    const card = CARDINALITIES.has(ai.cardinality ?? "")
      ? (ai.cardinality as OntologyCardinality)
      : undefined;
    return {
      ...r,
      label: (ai.label ?? "").trim().slice(0, 40) || r.label,
      cardinality: (reversed ? flipCardinality(card) : card) ?? r.cardinality,
    };
  });

  const covered = new Set(relations.flatMap((r) => [relKey(r), `${r.to}|${r.from}|${r.kind}`]));
  let extras = 0;
  for (const ai of aiRels) {
    if (extras >= MAX_AI_EXTRA_RELATIONS) break;
    if (ai.from === ai.to) continue;
    const dupe = ["join", "lineage", "semantic"].some(
      (k) =>
        covered.has(relKey({ from: ai.from, to: ai.to, kind: k })) ||
        covered.has(relKey({ from: ai.to, to: ai.from, kind: k })),
    );
    if (dupe) continue;
    const rel: OntologyRelation = {
      from: ai.from,
      to: ai.to,
      label: (ai.label ?? "").trim().slice(0, 40) || "relates to",
      kind: "semantic",
      cardinality: CARDINALITIES.has(ai.cardinality ?? "")
        ? (ai.cardinality as OntologyCardinality)
        : undefined,
      confidence: "medium",
    };
    covered.add(relKey(rel));
    relations.push(rel);
    extras++;
  }

  return {
    summary: (out.summary ?? "").trim().slice(0, 600),
    entities,
    relations: relations.slice(0, MAX_RELATIONS),
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export type OntologyBuildStage = "scanning" | "detecting" | "enriching";

function fallbackSummary(entities: OntologyEntity[], relations: OntologyRelation[]): string {
  const sources = new Set(entities.map((e) => e.source));
  return (
    `${entities.length} entities across ${sources.size} source${sources.size === 1 ? "" : "s"} ` +
    `with ${relations.length} detected relationship${relations.length === 1 ? "" : "s"} ` +
    "from join keys, semantic hints and data-prep lineage."
  );
}

export async function buildOntology(args: {
  inputs: OntologySourceInputs;
  model?: string;
  onProgress?: (stage: OntologyBuildStage) => void;
}): Promise<OntologySpec> {
  args.onProgress?.("scanning");
  let entities = gatherEntities(args.inputs);
  if (entities.length === 0) {
    throw new Error("No data sources found — connect data or select at least one source.");
  }

  args.onProgress?.("detecting");
  let relations = detectRelations(entities, args.inputs);
  const notes: string[] = [];

  if (entities.length > MAX_ONTOLOGY_ENTITIES) {
    // Keep the most connected entities so the map stays legible.
    const degree = new Map<string, number>();
    for (const r of relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
      degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
    }
    const total = entities.length;
    entities = [...entities]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, MAX_ONTOLOGY_ENTITIES);
    const kept = new Set(entities.map((e) => e.id));
    relations = relations.filter((r) => kept.has(r.from) && kept.has(r.to));
    notes.push(`Showing the ${MAX_ONTOLOGY_ENTITIES} most connected of ${total} entities.`);
  }

  let summary = "";
  let aiEnriched = false;
  try {
    args.onProgress?.("enriching");
    const enriched = await enrichOntology({ entities, relations, model: args.model });
    entities = enriched.entities;
    relations = enriched.relations;
    summary = enriched.summary;
    aiEnriched = true;
  } catch (e) {
    notes.push(
      `AI enrichment unavailable (${(e as Error).message}) — showing the detected structure with heuristic labels.`,
    );
  }
  if (!summary) summary = fallbackSummary(entities, relations);

  const domainCounts = new Map<string, number>();
  for (const e of entities) domainCounts.set(e.domain, (domainCounts.get(e.domain) ?? 0) + 1);
  const domains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);

  return {
    builtAt: new Date().toISOString(),
    summary,
    aiEnriched,
    domains,
    entities,
    relations,
    notes,
  };
}

/** Runtime guard for specs loaded from stored widget JSON. */
export function isOntologySpec(v: unknown): v is OntologySpec {
  const s = v as OntologySpec | null;
  return Boolean(s && Array.isArray(s.entities) && Array.isArray(s.relations));
}
