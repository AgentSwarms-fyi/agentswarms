// The ontology, as an AI reads it, and the plans an AI may return.
//
// Grounded Q&A works in two steps that never meet in the middle: the model
// reads a compact catalog of the ontology (types, properties, links, metrics,
// the words people use for them, the owner's instructions) and returns a
// PLAN — a JSON object-set query, metric query or object lookup in the
// ontology's own names. The plan is checked against the model here and
// compiled by compile.ts; the model never writes SQL. A question the
// ontology cannot express is REFUSED with the reason, because a plausible
// wrong number is worse than "the model has no Shipment cost" (the dbt
// semantic-layer benchmark's finding: errors, not silent wrong answers).
//
// Properties hidden from the asker (restricted, or masked by their share) are
// left out of the catalog entirely, so the model cannot plan around them.
import { z } from "zod";
import {
  FILTER_OPS,
  isMasked,
  TIME_GRAINS,
  type CompileOpts,
  type MetricQuery,
  type ObjectSetQuery,
} from "@/lib/ontology/compile";
import {
  allProperties,
  baseTypeOf,
  cardinalityWalking,
  findObjectType,
  findValueType,
  linkReading,
  linksOf,
  pluralTitleOf,
  titleOf,
  toOneReach,
  type ObjectType,
  type OntologySpec,
} from "@/lib/ontology/spec";

/** The catalog an AI reads: compact, one line per thing, hidden things left out. */
export function aiCatalog(spec: OntologySpec, opts: CompileOpts): string {
  const lines: string[] = [];
  lines.push(`ONTOLOGY: ${spec.name}${spec.description ? ` — ${spec.description}` : ""}`);
  for (const t of spec.objectTypes) {
    if (!t.source) continue;
    const head = [
      `TYPE ${t.name} ("${titleOf(t)}", plural "${pluralTitleOf(t)}")`,
      t.description ? `— ${t.description}` : "",
      t.synonyms?.length ? `[also called: ${t.synonyms.join(", ")}]` : "",
      t.extends ? `[a kind of ${t.extends}]` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(head);
    if (t.aiInstructions) lines.push(`  NOTE: ${t.aiInstructions}`);
    lines.push(
      `  key: ${t.primaryKey.join(", ") || "(none)"}${t.titleProperty ? `; name shown: ${t.titleProperty}` : ""}`,
    );
    for (const p of allProperties(spec, t)) {
      if (isMasked(spec, t, p.name, opts)) continue;
      const vt = findValueType(spec, p.type);
      const bits = [
        `  - ${p.name}: ${vt ? `${vt.name} (${vt.base})` : p.type}`,
        p.description ? `— ${p.description}` : "",
        vt?.enum ? `values: ${vt.enum.slice(0, 30).join(" | ")}` : "",
        vt?.unit ? `unit: ${vt.unit}` : "",
        p.synonyms?.length ? `[also: ${p.synonyms.join(", ")}]` : "",
      ];
      lines.push(bits.filter(Boolean).join(" "));
    }
    for (const m of t.metrics) {
      lines.push(
        `  * metric ${m.name} = ${m.expression}${m.certified ? " (CERTIFIED: prefer this)" : ""}${m.label ? ` "${m.label}"` : ""}${m.synonyms?.length ? ` [also: ${m.synonyms.join(", ")}]` : ""}`,
      );
    }
    for (const { link, direction, other } of linksOf(spec, t.name)) {
      const card = cardinalityWalking(link, direction);
      const one = card === "many_to_one" || card === "one_to_one";
      lines.push(
        `  > link ${linkReading(link, direction)} (${direction}) → ${other}, each ${t.name} has ${one ? "at most one" : "many"}${link.verbalization ? `: "${link.verbalization}"` : ""}`,
      );
    }
    // The groupings a metric of this type can use, spelled out with the exact
    // path to copy: deciding which walks are safe is the compiler's job, not
    // the model's (it once refused "revenue by customer segment" as a fan-out).
    if (t.metrics.length) {
      const own = groupable(spec, t, opts);
      if (own) lines.push(`  GROUP ${t.name} METRICS BY its own: ${own}`);
      for (const r of toOneReach(spec, t.name)) {
        const there = findObjectType(spec, r.type);
        const props = there ? groupable(spec, there, opts) : "";
        if (props)
          lines.push(
            `  GROUP ${t.name} METRICS BY path ${JSON.stringify(r.path)} (${r.via}): ${props}`,
          );
      }
    }
  }
  return lines.join("\n");
}

/** A type's properties a grouping may use, dates marked: the asker's hidden ones left out. */
function groupable(spec: OntologySpec, t: ObjectType, opts: CompileOpts): string {
  return allProperties(spec, t)
    .filter((p) => !isMasked(spec, t, p.name, opts))
    .map((p) =>
      ["date", "datetime", "timestamp"].includes(baseTypeOf(spec, p.type) ?? "")
        ? `${p.name} (date: give a grain)`
        : p.name,
    )
    .join(", ");
}

// ── Plans ────────────────────────────────────────────────────────────────────

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const filter = z.object({
  property: z.string().max(64),
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(200), z.null()]).optional(),
});
const step = z.object({ link: z.string().max(64), direction: z.enum(["forward", "inverse"]) });

export const askPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("objects"),
    explanation: z.string().max(500),
    query: z.object({
      objectType: z.string().max(64),
      filters: z.array(filter).max(10).optional(),
      search: z.string().max(200).optional(),
      path: z.array(step).max(3).optional(),
      targetFilters: z.array(filter).max(10).optional(),
      properties: z.array(z.string().max(64)).max(30).optional(),
      orderBy: z
        .object({ property: z.string().max(64), direction: z.enum(["asc", "desc"]) })
        .optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  }),
  z.object({
    kind: z.literal("metric"),
    explanation: z.string().max(500),
    query: z.object({
      objectType: z.string().max(64),
      metric: z.string().max(64),
      groupBy: z
        .array(
          z.object({
            property: z.string().max(64),
            path: z.array(step).max(3).optional(),
            grain: z.enum(TIME_GRAINS).optional(),
          }),
        )
        .max(3)
        .optional(),
      filters: z.array(filter).max(10).optional(),
      order: z.enum(["metric_desc", "metric_asc", "group_asc"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
  }),
  z.object({
    kind: z.literal("refuse"),
    reason: z.string().max(500),
  }),
]);
export type AskPlan = z.infer<typeof askPlanSchema>;

export function askSystemPrompt(catalog: string, today: string): string {
  return [
    "You answer business questions by planning a query over an ENTERPRISE ONTOLOGY.",
    "You never write SQL. You return ONE JSON object, nothing else, in one of these shapes:",
    '1. {"kind":"metric","explanation":"…","query":{"objectType":T,"metric":M,"groupBy":[{"property":P,"path":[{"link":L,"direction":"forward"|"inverse"}],"grain":"day|week|month|quarter|year"}],"filters":[{"property":P,"op":OP,"value":V}],"order":"metric_desc|metric_asc|group_asc","limit":N}}',
    '2. {"kind":"objects","explanation":"…","query":{"objectType":T,"filters":[…],"search":"text","path":[steps],"targetFilters":[…],"properties":[P…],"orderBy":{"property":P,"direction":"asc|desc"},"limit":N}}',
    '3. {"kind":"refuse","reason":"…"} — when the ontology has no type, property, link or metric that answers it.',
    `Filter ops: ${FILTER_OPS.join(", ")}. "in"/"not_in" take a list; "between" takes [low, high]; is_null/not_null take no value.`,
    "RULES:",
    "- Use ONLY names in the catalog, exactly as written. Never invent a property, metric or link.",
    "- To count or sum, use a METRIC of the type being measured. Prefer CERTIFIED metrics.",
    "- groupBy: use ONLY a grouping listed under 'GROUP <Type> METRICS BY' for the type being measured, copying its path exactly (no path for its own properties). Every listed grouping is safe: each step is at most one. A grouping that is not listed would double count totals: then refuse and say why.",
    "- A 'path' on an objects query walks from the filtered start set to linked objects (e.g. the customers of these orders).",
    "- Dates are ISO (YYYY-MM-DD). Today is " +
      today +
      ". 'Last month' etc. become explicit between filters.",
    "- Filter values for properties with listed values must be one of those values.",
    "- If the question is ambiguous between two reasonable plans, pick the more common business reading and say so in explanation.",
    "- explanation: one sentence, in business words, of exactly what the plan computes.",
    "",
    catalog,
  ].join("\n");
}

/**
 * Mend what a plan gets wrong in form only, never in meaning: a time grain on
 * a grouping that is not a date (a model adds "month" to a customer segment)
 * has no other reading, so it is dropped. Everything else is left for the
 * compiler to accept or refuse, including a property that does not exist.
 */
export function tidyPlan(spec: OntologySpec, plan: AskPlan): AskPlan {
  if (plan.kind !== "metric" || !plan.query.groupBy?.length) return plan;
  const groupBy = plan.query.groupBy.map((g) => {
    if (!g.grain) return g;
    const at = typeAtEnd(spec, plan.query.objectType, g.path ?? []);
    const p = at ? allProperties(spec, at).find((x) => x.name === g.property) : undefined;
    if (!p || ["date", "datetime", "timestamp"].includes(baseTypeOf(spec, p.type) ?? "")) return g;
    const rest = { ...g };
    delete rest.grain;
    return rest;
  });
  return { ...plan, query: { ...plan.query, groupBy } };
}

/** The type a path of link steps ends at, or undefined when a step does not exist. */
function typeAtEnd(
  spec: OntologySpec,
  start: string,
  path: { link: string; direction: "forward" | "inverse" }[],
): ObjectType | undefined {
  let at = findObjectType(spec, start);
  for (const step of path) {
    if (!at) return undefined;
    const hit = linksOf(spec, at.name).find(
      ({ link, direction }) =>
        direction === step.direction && linkReading(link, direction) === step.link,
    );
    at = hit ? findObjectType(spec, hit.other) : undefined;
  }
  return at;
}

/** Plans for an object-set or metric query, after the zod check. */
export function planQuery(plan: AskPlan): { objects?: ObjectSetQuery; metric?: MetricQuery } {
  if (plan.kind === "objects") return { objects: plan.query };
  if (plan.kind === "metric") return { metric: plan.query };
  return {};
}

/** Normalise a question for matching against verified questions. */
export function normaliseQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(
      /\b(the|a|an|of|for|in|by|what|is|are|was|were|show|me|please|our|we|how|many|much)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-overlap similarity of two normalised questions, 0–1 (Jaccard). */
export function questionSimilarity(a: string, b: string): number {
  const A = new Set(normaliseQuestion(a).split(" ").filter(Boolean));
  const B = new Set(normaliseQuestion(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
