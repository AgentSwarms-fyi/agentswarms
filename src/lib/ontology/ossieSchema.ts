// Apache Ossie 0.2.0.dev0, as zod schemas.
//
// Ossie (formerly Open Semantic Interchange) exchanges a model as up to three
// documents: a SEMANTIC MODEL (datasets, fields, metrics, relationships:
// core-spec/ossie-schema.json), an ONTOLOGY (concepts and the relationships
// they play the first role in: ontology/ontology.json) and a MAPPING that ties
// one of each together (ontology/mapping.json). These schemas mirror those
// three JSON Schemas at apache/ossie commit 89e2e17, key for key, so that what
// ossie.ts writes is what the reference validator accepts and what it reads
// has the shape it expects. tests/unit/ontologyOssie.test.ts compares the
// enums, the const version and every `required` list against the vendored
// JSON Schemas, so a drift in either direction fails a test, not an import.
//
// The JSON Schemas say `additionalProperties: false` on every object except
// the object form of `ai_context`, so every object here is `.strict()` except
// that one: an unknown key is an error, which is what keeps a misspelt
// `primary_keys` from being dropped without a word. Two things the JSON Schema
// cannot say (names that must resolve, arrays that must be the same length)
// are not checked here either; they belong to the importer and to the
// Ossie-style checks in the test.
import { z } from "zod";

/** The only version every Ossie 0.2.0.dev0 schema accepts (a `const`, not a range). */
export const OSSIE_VERSION = "0.2.0.dev0" as const;

export const OSSIE_DATA_TYPES = [
  "String",
  "Integer",
  "Decimal",
  "Float",
  "Boolean",
  "Date",
  "Time",
  "DateTime",
  "DateTimeTz",
  "Opaque",
] as const;
export type OssieDataType = (typeof OSSIE_DATA_TYPES)[number];

export const OSSIE_CONCEPT_TYPES = ["EntityType", "ValueType"] as const;
export type OssieConceptType = (typeof OSSIE_CONCEPT_TYPES)[number];

export const OSSIE_MULTIPLICITIES = ["ManyToOne", "OneToOne"] as const;
export type OssieMultiplicity = (typeof OSSIE_MULTIPLICITIES)[number];

/** Concepts every ontology has without declaring them (ontology.md, "Built-in concepts"). */
export const OSSIE_BUILT_IN_CONCEPTS = [
  "Any",
  "Boolean",
  "Date",
  "DateTime",
  "Decimal",
  "Float",
  "Integer",
  "String",
] as const;

/** The one expression language Ossie defines; every other dialect is opaque to it. */
export const OSSIE_PORTABLE_DIALECT = "OSSIE_SQL_2026";

const nonEmpty = z.string().min(1);

// ── Core: the semantic model ─────────────────────────────────────────────────

/** A string, or an object whose three known keys are typed and whose others are free. */
export const ossieAIContextSchema = z.union([
  z.string(),
  z.looseObject({
    instructions: z.string().optional(),
    synonyms: z.array(z.string()).optional(),
    examples: z.array(z.string()).optional(),
  }),
]);
export type OssieAIContext = z.infer<typeof ossieAIContextSchema>;

export const ossieCustomExtensionSchema = z
  .object({
    vendor_name: nonEmpty,
    // Opaque to Ossie. A string, not an object: by convention it holds JSON.
    data: z.string(),
  })
  .strict();
export type OssieCustomExtension = z.infer<typeof ossieCustomExtensionSchema>;

export const ossieDialectExpressionSchema = z
  .object({ dialect: nonEmpty, expression: nonEmpty })
  .strict();

export const ossieExpressionSchema = z
  .object({
    sql: nonEmpty.optional(),
    dialects: z.array(ossieDialectExpressionSchema).min(1).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.sql === undefined && e.dialects === undefined)
      ctx.addIssue({ code: "custom", message: "An expression needs `sql`, `dialects` or both" });
  });
export type OssieExpression = z.infer<typeof ossieExpressionSchema>;

export const ossieDimensionSchema = z.object({ is_time: z.boolean().optional() }).strict();

const customExtensions = z.array(ossieCustomExtensionSchema);

export const ossieFieldSchema = z
  .object({
    name: nonEmpty,
    expression: ossieExpressionSchema,
    dimension: ossieDimensionSchema.optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    datatype: z.enum(OSSIE_DATA_TYPES).optional(),
    ai_context: ossieAIContextSchema.optional(),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieField = z.infer<typeof ossieFieldSchema>;

export const ossieMetricSchema = z
  .object({
    name: nonEmpty,
    expression: ossieExpressionSchema,
    description: z.string().optional(),
    datatype: z.enum(OSSIE_DATA_TYPES).optional(),
    ai_context: ossieAIContextSchema.optional(),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieMetric = z.infer<typeof ossieMetricSchema>;

export const ossieDatasetSchema = z
  .object({
    name: nonEmpty,
    source: nonEmpty,
    // Field names, not source columns, and without a minLength on the items:
    // the schema leaves "" to the semantic checks.
    primary_key: z.array(z.string()).min(1).optional(),
    unique_keys: z.array(z.array(z.string()).min(1)).min(1).optional(),
    description: z.string().optional(),
    ai_context: ossieAIContextSchema.optional(),
    fields: z.array(ossieFieldSchema).optional(),
    metrics: z.array(ossieMetricSchema).optional(),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieDataset = z.infer<typeof ossieDatasetSchema>;

export const ossieRelationshipSchema = z
  .object({
    name: nonEmpty,
    /** The many side. */
    from: nonEmpty,
    /** The one side. */
    to: nonEmpty,
    from_columns: z.array(z.string()).min(1),
    to_columns: z.array(z.string()).min(1),
    ai_context: ossieAIContextSchema.optional(),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieRelationship = z.infer<typeof ossieRelationshipSchema>;

/** One semantic model per document, flat at the root (no `semantic_model` wrapper since 0.2). */
export const ossieSemanticModelSchema = z
  .object({
    version: z.literal(OSSIE_VERSION),
    name: nonEmpty,
    description: z.string().optional(),
    ai_context: ossieAIContextSchema.optional(),
    datasets: z.array(ossieDatasetSchema).min(1),
    relationships: z.array(ossieRelationshipSchema).optional(),
    metrics: z.array(ossieMetricSchema).optional(),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieSemanticModel = z.infer<typeof ossieSemanticModelSchema>;

// ── Ontology ─────────────────────────────────────────────────────────────────

/**
 * The schema calls these "ANSI SQL expression", but the spec's own examples use
 * a richer, unspecified syntax (`COUNT[Airport] > 0`, `Flight.route(Route)`),
 * so they are carried as opaque strings.
 */
const ontologyExpression = z.string();

export const ossieRoleSchema = z
  .object({ concept: z.string(), name: z.string().optional() })
  .strict();

export const ossieOntologyRelationshipSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    /** Roles after the first, which the declaring concept plays. */
    roles: z.array(ossieRoleSchema).optional(),
    multiplicity: z.enum(OSSIE_MULTIPLICITIES).optional(),
    derived_by: z.array(ontologyExpression).optional(),
    requires: z.array(ontologyExpression).optional(),
    verbalizes: z.array(z.string()),
    iri: z.string().optional(),
  })
  .strict();
export type OssieOntologyRelationship = z.infer<typeof ossieOntologyRelationshipSchema>;

export const ossieConceptSchema = z
  .object({
    concept: z.string(),
    type: z.enum(OSSIE_CONCEPT_TYPES),
    description: z.string().optional(),
    extends: z.array(z.string()).optional(),
    derived_by: z.array(ontologyExpression).optional(),
    identify_by: z.array(z.string()).optional(),
    requires: z.array(ontologyExpression).optional(),
    relationships: z.array(ossieOntologyRelationshipSchema).optional(),
    iri: z.string().optional(),
  })
  .strict();
export type OssieConcept = z.infer<typeof ossieConceptSchema>;

export type OssieReferentMapping = {
  relationship: string;
  expression?: string;
  referent_mappings?: OssieReferentMapping[];
};

// The recursive objects are declared with getters (zod 4's way to recurse
// without z.lazy), which keeps them ZodObjects: the test reads their `shape`
// to compare the required keys with the JSON Schema's.
export const ossieReferentMappingObject = z
  .object({
    relationship: z.string(),
    expression: ontologyExpression.optional(),
    get referent_mappings(): z.ZodOptional<z.ZodArray<z.ZodType<OssieReferentMapping>>> {
      return z.array(ossieReferentMappingSchema).min(1).optional();
    },
  })
  .strict();
export const ossieReferentMappingSchema: z.ZodType<OssieReferentMapping> =
  ossieReferentMappingObject.superRefine((r, ctx) => eitherOr(r, ctx));

export const ossieObjectMappingObject = z
  .object({
    concept: z.string().optional(),
    referent_mappings: z.array(ossieReferentMappingSchema).min(1).optional(),
    expression: ontologyExpression.optional(),
  })
  .strict();
export const ossieObjectMappingSchema = ossieObjectMappingObject.superRefine((o, ctx) =>
  eitherOr(o, ctx),
);
export type OssieObjectMapping = z.infer<typeof ossieObjectMappingSchema>;

export type OssieLinkMapping = {
  relationship?: string;
  object_mapping: OssieObjectMapping;
  children?: OssieLinkMapping[];
};

export const ossieLinkMappingObject = z
  .object({
    relationship: z.string().optional(),
    object_mapping: ossieObjectMappingSchema,
    get children(): z.ZodOptional<z.ZodArray<z.ZodType<OssieLinkMapping>>> {
      return z.array(ossieLinkMappingSchema).optional();
    },
  })
  .strict();
export const ossieLinkMappingSchema: z.ZodType<OssieLinkMapping> = ossieLinkMappingObject;

export const ossieConceptMappingSchema = z
  .object({
    concept: z.string(),
    object_mappings: z.array(ossieObjectMappingSchema).min(1).optional(),
    link_mappings: z.array(ossieLinkMappingSchema).min(1).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.object_mappings === undefined && c.link_mappings === undefined)
      ctx.addIssue({
        code: "custom",
        message: "A concept mapping needs `object_mappings`, `link_mappings` or both",
      });
  });
export type OssieConceptMapping = z.infer<typeof ossieConceptMappingSchema>;

/** Deprecated by Ossie in favour of mapping documents; read so older files still import. */
export const ossieOntologyMapSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    semantic_model: ossieSemanticModelSchema,
    concept_mappings: z.array(ossieConceptMappingSchema),
  })
  .strict();

export const ossieOntologySchema = z
  .object({
    version: z.literal(OSSIE_VERSION),
    name: z.string(),
    description: z.string().optional(),
    ai_context: ossieAIContextSchema.optional(),
    requires: z.array(ontologyExpression).optional(),
    ontology: z.array(ossieConceptSchema).min(1),
    ontology_mappings: z.array(ossieOntologyMapSchema).optional(),
    prefixes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type OssieOntology = z.infer<typeof ossieOntologySchema>;

// ── Mapping ──────────────────────────────────────────────────────────────────

export const ossieDocumentReferenceSchema = z
  .object({
    /** Must equal the referenced document's own `name`: that is the reference's identity. */
    name: nonEmpty,
    /** Where to fetch it from, relative to the mapping document or absolute. */
    iri: nonEmpty.optional(),
  })
  .strict();

export const ossieMappingSchema = z
  .object({
    version: z.literal(OSSIE_VERSION),
    name: nonEmpty,
    description: z.string().optional(),
    ontology_ref: ossieDocumentReferenceSchema,
    semantic_model_ref: ossieDocumentReferenceSchema,
    concept_mappings: z.array(ossieConceptMappingSchema),
    custom_extensions: customExtensions.optional(),
  })
  .strict();
export type OssieMapping = z.infer<typeof ossieMappingSchema>;

function eitherOr(
  o: { expression?: string; referent_mappings?: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (o.expression === undefined && o.referent_mappings === undefined)
    ctx.addIssue({ code: "custom", message: "Needs `expression`, `referent_mappings` or both" });
}

// ── Recognising and parsing a document ───────────────────────────────────────

export type OssieKind = "semantic_model" | "ontology" | "mapping";

/**
 * Which kind of Ossie document this is. Ossie has no field that says so: a
 * mapping is recognised by `concept_mappings` + `ontology_ref` +
 * `semantic_model_ref` together (ontology.md, "Mapping documents"), an ontology
 * by its `ontology` list and a semantic model by its `datasets`. The keys do
 * not overlap, so the order of the checks only matters for a malformed hybrid.
 */
export function detectOssieKind(doc: unknown): OssieKind | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(doc, k);
  if (has("concept_mappings") && has("ontology_ref") && has("semantic_model_ref")) return "mapping";
  if (has("ontology")) return "ontology";
  if (has("datasets")) return "semantic_model";
  return null;
}

export type OssieIssue = { path: string; message: string };

export type OssieParse<T> = { ok: true; data: T } | { ok: false; issues: OssieIssue[] };

/** `datasets[2].fields[0].expression`: the path the way a person reads a document. */
export function formatOssiePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || "(root)";
}

function parseWith<T>(schema: z.ZodType<T>, doc: unknown): OssieParse<T> {
  const r = schema.safeParse(doc);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: formatOssiePath(i.path), message: i.message })),
  };
}

export const parseOssieSemanticModel = (doc: unknown) => parseWith(ossieSemanticModelSchema, doc);
export const parseOssieOntology = (doc: unknown) => parseWith(ossieOntologySchema, doc);
export const parseOssieMapping = (doc: unknown) => parseWith(ossieMappingSchema, doc);

export type OssieDocument =
  | { kind: "semantic_model"; doc: OssieSemanticModel }
  | { kind: "ontology"; doc: OssieOntology }
  | { kind: "mapping"; doc: OssieMapping };

/** Recognise and parse any of the three kinds; issues name the kind that was assumed. */
export function parseOssieDocument(
  doc: unknown,
):
  { ok: true; value: OssieDocument } | { ok: false; kind: OssieKind | null; issues: OssieIssue[] } {
  const kind = detectOssieKind(doc);
  if (!kind) {
    return {
      ok: false,
      kind: null,
      issues: [
        {
          path: "(root)",
          message:
            "Not an Ossie document: expected `datasets` (semantic model), `ontology` (ontology) or `concept_mappings` with `ontology_ref` and `semantic_model_ref` (mapping)",
        },
      ],
    };
  }
  if (kind === "semantic_model") {
    const r = parseOssieSemanticModel(doc);
    return r.ok
      ? { ok: true, value: { kind, doc: r.data } }
      : { ok: false, kind, issues: r.issues };
  }
  if (kind === "ontology") {
    const r = parseOssieOntology(doc);
    return r.ok
      ? { ok: true, value: { kind, doc: r.data } }
      : { ok: false, kind, issues: r.issues };
  }
  const r = parseOssieMapping(doc);
  return r.ok ? { ok: true, value: { kind, doc: r.data } } : { ok: false, kind, issues: r.issues };
}
