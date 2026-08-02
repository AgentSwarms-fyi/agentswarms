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
  "concept",
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
  sourceKind: "local" | "prepared" | "warehouse" | "knowledge" | "concept";
  category: OntologyCategory;
  domain: string;
  description: string;
  rowCount?: number;
  columnCount: number;
  keyColumns: string[];
  fields: OntologyField[];
  /** Concepts only: the knowledge-graph entity type ("person", "org", …). */
  conceptType?: string;
};

export type OntologyRelationKind = "join" | "lineage" | "semantic" | "knowledge";
export type OntologyCardinality = "1:1" | "1:N" | "N:1" | "N:M";

export type OntologyRelation = {
  /** SUBJECT of the triple (an entity id). */
  from: string;
  /** OBJECT of the triple (an entity id). */
  to: string;
  /** Short human verb phrase, e.g. "places", "belongs to", "derived from". */
  label: string;
  /**
   * PREDICATE — the machine-readable snake_case relation type completing the
   * subject–predicate–object triple (e.g. "references", "derived_from",
   * "instance_of"). Every builder path sets it; specs stored before it
   * existed fall back to `label` in the renderer.
   */
  predicate?: string;
  kind: OntologyRelationKind;
  /** Field-level anchors: column names — or a document name on a KB side. */
  keys?: { from: string; to: string };
  cardinality?: OntologyCardinality;
  confidence: "high" | "medium" | "low";
  /** Why the AI believes this relation holds (quoted signal). */
  evidence?: string;
};

/** Normalize any phrase into a snake_case predicate (≤32 chars). */
export function toPredicate(s: string): string {
  const p = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return /^[a-z]/.test(p) ? p : "";
}

/** "derived_from" → "derived from" — human label from a predicate. */
export function predicateLabel(p: string): string {
  return p.replace(/_/g, " ");
}

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
  knowledgeBases: {
    id: string;
    name: string;
    docCount: number;
    docs?: string[];
    /** Content excerpts per document — AI signal for content-level links. */
    docExcerpts?: { name: string; excerpt: string }[];
    /**
     * The KB's knowledge graph (built under Knowledge → Graph), when one
     * exists: its top entities become first-class CONCEPT nodes and its
     * subject–predicate–object triples become typed edges — the ontology's
     * concept layer, not just a document box per KB.
     */
    graph?: {
      entities: { name: string; type: string; description?: string; mentions: number }[];
      triples: { subject: string; predicate: string; object: string }[];
    };
  }[];
  prepFlows: { name: string; outputTable: string | null; sources: string[] }[];
  /** Sample rows by local table name — AI signal for value-level links. */
  tableSamples?: Map<string, Record<string, unknown>[]>;
  /** Result of a user-provided SQL query, sent to the AI as extra signal. */
  customSample?: { sql: string; rows: Record<string, unknown>[] };
};

const MAX_ONTOLOGY_ENTITIES = 80;
const MAX_FIELDS_PER_ENTITY = 24;
const MAX_RELATIONS = 160;
const MAX_AI_EXTRA_RELATIONS = 40;
const MAX_CONCEPTS_PER_KB = 12;
const MAX_KB_TRIPLES_PER_KB = 30;

// ── 1. Gather ────────────────────────────────────────────────────────────

const localId = (table: string) => `local:${table}`;
const conceptId = (kbId: string, name: string) => `concept:${kbId}:${name.toLowerCase()}`;

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
      // Documents become the KB's drill-in rows (and AI signal for linking).
      fields: (kb.docs ?? [])
        .slice(0, MAX_FIELDS_PER_ENTITY)
        .map((n) => ({ name: n, type: "document" })),
    });

    // The KB's knowledge graph contributes CONCEPT nodes — the real subject
    // matter of the documents (people, systems, products…), not just the
    // container. Top entities by mention count keep the map legible.
    for (const g of (kb.graph?.entities ?? []).slice(0, MAX_CONCEPTS_PER_KB)) {
      entities.push({
        id: conceptId(kb.id, g.name),
        name: g.name,
        table: g.name,
        source: kb.name,
        sourceKind: "concept",
        category: "concept",
        domain: "Knowledge",
        description: g.description ?? "",
        rowCount: g.mentions,
        columnCount: 0,
        keyColumns: [],
        fields: [],
        conceptType: g.type,
      });
    }
  }

  for (const e of entities) {
    if (e.sourceKind !== "knowledge" && e.sourceKind !== "concept") {
      e.category = heuristicCategory(e);
    }
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

function relKey(r: { from: string; to: string; kind: string; predicate?: string }): string {
  // Predicate participates so two DIFFERENT triples between the same pair
  // ("works_at" and "founded") both survive; join/lineage predicates are
  // deterministic per pair, so their dedupe behaviour is unchanged.
  return `${r.from}|${r.to}|${r.kind}|${r.predicate ?? ""}`;
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
        label: "joins with",
        predicate: "joins_with",
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
          predicate: "references",
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
        predicate: "derived_from",
        kind: "lineage",
        confidence: "high",
      });
    }
  }

  // Knowledge-graph triples: subject —predicate→ object between the included
  // concepts, plus every concept anchored to its knowledge base. These are
  // REAL extracted triples (built under Knowledge → Graph), not inferences.
  for (const kb of inputs.knowledgeBases) {
    if (!kb.graph) continue;
    const kbNodeId = `kb:${kb.id}`;
    const included = new Set(
      (kb.graph.entities ?? []).slice(0, MAX_CONCEPTS_PER_KB).map((g) => g.name.toLowerCase()),
    );
    for (const g of (kb.graph.entities ?? []).slice(0, MAX_CONCEPTS_PER_KB)) {
      if (!byId.has(kbNodeId)) break;
      push({
        from: conceptId(kb.id, g.name),
        to: kbNodeId,
        label: "defined in",
        predicate: "defined_in",
        kind: "knowledge",
        confidence: "high",
      });
    }
    let triples = 0;
    for (const t of kb.graph.triples ?? []) {
      if (triples >= MAX_KB_TRIPLES_PER_KB) break;
      if (!included.has(t.subject.toLowerCase()) || !included.has(t.object.toLowerCase())) {
        continue;
      }
      const pred = toPredicate(t.predicate) || "related_to";
      push({
        from: conceptId(kb.id, t.subject),
        to: conceptId(kb.id, t.object),
        label: predicateLabel(pred),
        predicate: pred,
        kind: "knowledge",
        confidence: "high",
        evidence: "extracted triple from the knowledge graph",
      });
      triples++;
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
type AiRelation = {
  from?: string;
  to?: string;
  label?: string;
  predicate?: string;
  cardinality?: string;
  keys?: { from?: string; to?: string };
  evidence?: string;
};
type AiOntologyOut = { summary?: string; entities?: AiEntityPatch[]; relations?: AiRelation[] };

export type OntologyAiContext = {
  /** Entity id → sample rows (values shown truncated in the prompt). */
  samples?: Map<string, Record<string, unknown>[]>;
  /** Entity id (KB) → document content excerpts. */
  docExcerpts?: Map<string, { name: string; excerpt: string }[]>;
  /** Result of a user-provided SQL query, with the query itself. */
  customSample?: { sql: string; rows: Record<string, unknown>[] };
};

const SAMPLE_COLS_IN_PROMPT = 12;
const SAMPLE_VALUE_CHARS = 40;
const DOC_EXCERPT_CHARS = 450;
// Row counts are user-configurable, so the prompt is bounded by characters,
// not rows: narrow tables fit many rows, wide tables get truncated.
const SAMPLE_TABLE_CHAR_BUDGET = 6_000;
const SAMPLE_TOTAL_CHAR_BUDGET = 40_000;
const CUSTOM_SAMPLE_CHAR_BUDGET = 8_000;

/** Serialize as many rows as fit in `budget` chars; note what was cut. */
export function sampleForPrompt(rows: Record<string, unknown>[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    const s = JSON.stringify(
      Object.fromEntries(
        Object.entries(r)
          .slice(0, SAMPLE_COLS_IN_PROMPT)
          .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, SAMPLE_VALUE_CHARS) : v]),
      ),
    );
    if (out.length > 0 && used + s.length > budget) break;
    out.push(s);
    used += s.length;
  }
  const more = rows.length - out.length;
  return `[${out.join(",")}]${more > 0 ? ` …(+${more} more rows)` : ""}`;
}

function describeForPrompt(
  entities: OntologyEntity[],
  relations: OntologyRelation[],
  aiCtx?: OntologyAiContext,
): string {
  const entityLines = entities.map((e) => {
    if (e.sourceKind === "concept") {
      const desc = e.description ? ` -- ${e.description.slice(0, 90)}` : "";
      return `- ${e.id} | CONCEPT "${e.name}" (${e.conceptType ?? "entity"}) from KB "${e.source}"${desc}`;
    }
    const cols = e.fields
      .slice(0, 24)
      .map((f) => `${f.name}:${f.type}${f.semantic ? `/${f.semantic}` : ""}`)
      .join(", ");
    const rows = e.rowCount !== undefined ? ` rows=${e.rowCount}` : "";
    const desc = e.description ? ` -- ${e.description.slice(0, 90)}` : "";
    return `- ${e.id} | ${e.table} | source=${e.source}${rows} | ${cols || "(documents)"}${desc}`;
  });

  const sampleLines: string[] = [];
  let sampleCharsUsed = 0;
  for (const e of entities) {
    const rows = aiCtx?.samples?.get(e.id);
    if (!rows || rows.length === 0) continue;
    const budget = Math.min(SAMPLE_TABLE_CHAR_BUDGET, SAMPLE_TOTAL_CHAR_BUDGET - sampleCharsUsed);
    if (budget <= 0) break;
    const s = sampleForPrompt(rows, budget);
    sampleCharsUsed += s.length;
    sampleLines.push(`- ${e.id}: ${s}`);
  }

  const excerptLines: string[] = [];
  for (const e of entities) {
    for (const d of aiCtx?.docExcerpts?.get(e.id) ?? []) {
      const excerpt = d.excerpt.replace(/\s+/g, " ").trim().slice(0, DOC_EXCERPT_CHARS);
      if (excerpt) excerptLines.push(`- ${e.id} document "${d.name}": ${excerpt}`);
    }
  }

  const customLines: string[] = [];
  if (aiCtx?.customSample && aiCtx.customSample.rows.length > 0) {
    customLines.push(
      `SQL: ${aiCtx.customSample.sql.replace(/\s+/g, " ").trim().slice(0, 500)}`,
      `ROWS: ${sampleForPrompt(aiCtx.customSample.rows, CUSTOM_SAMPLE_CHAR_BUDGET)}`,
    );
  }

  const relLines = relations.map(
    (r) =>
      `- ${r.from} -[${r.predicate ?? r.kind}]-> ${r.to} (${r.kind}${r.keys ? `, ${r.keys.from}=${r.keys.to}` : ""})`,
  );
  return [
    "ENTITIES:",
    ...entityLines,
    sampleLines.length ? "\nSAMPLE ROWS (real values, truncated):" : "",
    ...sampleLines,
    excerptLines.length ? "\nDOCUMENT EXCERPTS (real content, truncated):" : "",
    ...excerptLines,
    customLines.length
      ? "\nCUSTOM SQL SAMPLE (the user ran this query to expose relationships):"
      : "",
    ...customLines,
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

/** Validate a field-level anchor pair against real fields (drop when bogus). */
function validKeys(
  byId: Map<string, OntologyEntity>,
  from: string,
  to: string,
  keys?: { from?: string; to?: string },
): { from: string; to: string } | undefined {
  if (!keys?.from || !keys?.to) return undefined;
  const hasField = (id: string, name: string) =>
    byId.get(id)?.fields.some((f) => f.name.toLowerCase() === name.toLowerCase());
  return hasField(from, keys.from) && hasField(to, keys.to)
    ? { from: keys.from, to: keys.to }
    : undefined;
}

/** Pure merge of the AI's output into the detected structure (testable). */
export function applyEnrichment(
  baseEntities: OntologyEntity[],
  baseRelations: OntologyRelation[],
  out: AiOntologyOut,
): { summary: string; entities: OntologyEntity[]; relations: OntologyRelation[] } {
  const ids = new Set(baseEntities.map((e) => e.id));
  const byId = new Map(baseEntities.map((e) => [e.id, e]));
  const patchById = new Map<string, AiEntityPatch>();
  for (const p of out.entities ?? []) {
    if (p.id && ids.has(p.id)) patchById.set(p.id, p);
  }
  const entities = baseEntities.map((e) => {
    const p = patchById.get(e.id);
    // Concept nodes come from the knowledge graph and STAY concepts — the AI
    // may rename/describe them but not turn a person into a "transaction".
    const category =
      e.sourceKind === "concept"
        ? e.category
        : ONTOLOGY_CATEGORIES.includes(p?.category as OntologyCategory)
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
    (r): r is AiRelation & { from: string; to: string } =>
      typeof r.from === "string" && typeof r.to === "string" && ids.has(r.from) && ids.has(r.to),
  );
  const findAi = (from: string, to: string) =>
    aiRels.find((r) => r.from === from && r.to === to) ??
    aiRels.find((r) => r.from === to && r.to === from);

  const relations: OntologyRelation[] = baseRelations.map((r) => {
    const ai = findAi(r.from, r.to);
    if (!ai) return r;
    const reversed = ai.from === r.to;
    const card = CARDINALITIES.has(ai.cardinality ?? "")
      ? (ai.cardinality as OntologyCardinality)
      : undefined;
    const label = (ai.label ?? "").trim().slice(0, 40) || r.label;
    return {
      ...r,
      label,
      // Keep the triple typed even when the AI omits the predicate field.
      predicate: toPredicate(ai.predicate ?? "") || r.predicate || toPredicate(label),
      cardinality: (reversed ? flipCardinality(card) : card) ?? r.cardinality,
      evidence: (ai.evidence ?? "").trim().slice(0, 160) || undefined,
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
    const label = (ai.label ?? "").trim().slice(0, 40) || "relates to";
    const rel: OntologyRelation = {
      from: ai.from,
      to: ai.to,
      label,
      predicate: toPredicate(ai.predicate ?? "") || toPredicate(label) || "related_to",
      kind: "semantic",
      keys: validKeys(byId, ai.from, ai.to, ai.keys),
      cardinality: CARDINALITIES.has(ai.cardinality ?? "")
        ? (ai.cardinality as OntologyCardinality)
        : undefined,
      confidence: "medium",
      evidence: (ai.evidence ?? "").trim().slice(0, 160) || undefined,
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

export async function enrichOntology(args: {
  entities: OntologyEntity[];
  relations: OntologyRelation[];
  aiCtx?: OntologyAiContext;
  model?: string;
}): Promise<{ summary: string; entities: OntologyEntity[]; relations: OntologyRelation[] }> {
  const out = await llmJson<AiOntologyOut>({
    model: args.model,
    systemPrompt:
      "You are an ontology engineer building a knowledge graph of an organisation's data estate. " +
      "Every relation is a TRIPLE: subject (from), predicate, object (to). Output JSON only. " +
      "Rules: use ONLY the entity ids given; every entity gets a category from " +
      `[${ONTOLOGY_CATEGORIES.join(", ")}], a short business domain ("Sales", "Customers", ` +
      '"Operations"…), a business name and a description of at most 18 words. ' +
      'Every relation MUST carry a snake_case "predicate" (the typed relation: references, ' +
      "belongs_to, describes, mentions, instance_of, works_at, located_in, part_of, produces…) " +
      'AND a human "label" verb phrase of at most 4 words, plus a cardinality where meaningful. ' +
      "Entities marked CONCEPT come from knowledge-graph extraction over the documents — link " +
      "them to the tables whose rows they describe or appear in (predicates like describes, " +
      "instance_of, mentioned_in, about) and to other concepts when the excerpts support it. " +
      "Never change a CONCEPT's category. " +
      "Study the SAMPLE ROWS and DOCUMENT EXCERPTS carefully — they are real data. Add NEW " +
      "relations between listed entities whenever the schema, sample values or document content " +
      "supports them (a document that explains, defines or references a table's subject matter " +
      "IS a relation). When the evidence points at a specific column or document, set " +
      '"keys": { "from": "<column or document name on the from-side>", "to": "<column or ' +
      'document name on the to-side>" } using EXACT names from the entity definitions. ' +
      'Give every relation a short "evidence" phrase (max 20 words) quoting the signal you ' +
      "used. Be honest: no speculative links, and never invent evidence. " +
      "Group related entities under the same domain.",
    userPrompt:
      `${describeForPrompt(args.entities, args.relations, args.aiCtx)}\n\n` +
      'Return JSON: { "summary": "2-3 sentence executive overview of this data estate", ' +
      '"entities": [{ "id", "businessName", "category", "domain", "description" }], ' +
      '"relations": [{ "from", "to", "predicate", "label", "cardinality": "1:1|1:N|N:1|N:M", ' +
      '"keys": { "from", "to" }?, "evidence" }] } — relations must include a typed entry ' +
      "for every detected relation, plus every new one the data supports.",
  });
  return applyEnrichment(args.entities, args.relations, out);
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

  // Real-data signal for the AI: sample rows keyed by entity id, and
  // document excerpts keyed by the knowledge base's entity id.
  const samples = new Map<string, Record<string, unknown>[]>();
  for (const [table, rows] of args.inputs.tableSamples ?? []) {
    if (rows.length > 0) samples.set(localId(table), rows);
  }
  const docExcerpts = new Map<string, { name: string; excerpt: string }[]>();
  for (const kb of args.inputs.knowledgeBases) {
    if (kb.docExcerpts?.length) docExcerpts.set(`kb:${kb.id}`, kb.docExcerpts);
  }

  let summary = "";
  let aiEnriched = false;
  try {
    args.onProgress?.("enriching");
    const enriched = await enrichOntology({
      entities,
      relations,
      aiCtx: { samples, docExcerpts, customSample: args.inputs.customSample },
      model: args.model,
    });
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
/**
 * Is this a spec the graph renderer can actually draw?
 *
 * Checks every field computeLayout dereferences, not just the two it used to.
 * The previous version tested `entities` and `relations` only — and
 * computeLayout also reads `spec.domains.length`, so a spec without `domains`
 * passed the guard and then threw inside render.
 *
 * That matters more than it looks: a spec lives inside a widget's chart JSON,
 * and `chart` is one of the fields sanitizePublicWidgets passes through to
 * ANONYMOUS viewers. A throw during render is caught by the router's
 * CatchBoundary (router.tsx sets defaultErrorComponent), so it does not blank
 * the browser — but the boundary is per ROUTE, not per widget: one malformed
 * spec replaces the ENTIRE dashboard with a full-screen error card, for
 * everyone holding the share link. Anything this rejects gets a "cannot be
 * displayed" panel in place of the single widget instead.
 *
 * Deliberately shallow on the ELEMENTS: entities and relations are drawn
 * defensively (a missing field renders as an empty label), so validating each
 * one here would reject specs that draw fine.
 */
export function isOntologySpec(v: unknown): v is OntologySpec {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<OntologySpec>;
  return Array.isArray(s.entities) && Array.isArray(s.relations) && Array.isArray(s.domains);
}
