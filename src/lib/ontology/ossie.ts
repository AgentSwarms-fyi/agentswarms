// Exchanging an ontology as Apache Ossie documents.
//
// Ossie 0.2.0.dev0 splits what this app keeps in one document three ways
// (ossieSchema.ts): a SEMANTIC MODEL of datasets, fields, metrics and
// relationships, which is what BI tools and semantic layers read; an
// ONTOLOGY of concepts and the relationships they play the first role in;
// and a MAPPING that says which fields populate which concepts. An export
// writes all three, so a tool that only understands datasets still gets a
// working model, and a tool that reasons over concepts gets those too.
//
// Not everything here has an Ossie home: rules, action types, sensitivity,
// canvas positions, a source filter, a join through a link table. Ossie's
// answer is `custom_extensions` (an opaque JSON string under a vendor name),
// and the rule this file follows is that EACH ELEMENT CARRIES WHAT ITS OWN
// DOCUMENT CANNOT SAY: a field's extension holds the property's sensitivity,
// a dataset's holds the type's icon, the model's holds the rules. So a tool
// that edits a description in Ossie and hands the file back changes that
// description here, and the semantic model on its own (the file people
// actually pass around) re-imports without loss. The ontology and mapping
// documents are written for other tools; when the semantic model carries this
// app's extension it is authoritative and they are not read back.
//
// Import reads anything Ossie-shaped: one semantic model (the common case),
// the flights-style trio, an ontology alone, or the pre-0.2 `semantic_model`
// list. It never throws. What it cannot represent becomes a warning, and an
// expression it cannot run is kept as written with a warning rather than
// guessed at, because a metric silently changed is worse than one that
// visibly needs fixing.
import yaml from "js-yaml";
import { z } from "zod";

import { checkExpr, compileExpr, CORE_KEYWORDS, quoteIdent, sqlString } from "@/lib/ontology/expr";
import {
  OSSIE_PORTABLE_DIALECT,
  OSSIE_VERSION,
  parseOssieDocument,
  parseOssieMapping,
  parseOssieOntology,
  parseOssieSemanticModel,
  type OssieAIContext,
  type OssieConcept,
  type OssieConceptMapping,
  type OssieCustomExtension,
  type OssieDataset,
  type OssieDataType,
  type OssieDocument,
  type OssieExpression,
  type OssieField,
  type OssieKind,
  type OssieLinkMapping,
  type OssieMapping,
  type OssieMetric,
  type OssieObjectMapping,
  type OssieOntology,
  type OssieOntologyRelationship,
  type OssieReferentMapping,
  type OssieRelationship,
  type OssieSemanticModel,
} from "@/lib/ontology/ossieSchema";
import {
  actionTypeSchema,
  allProperties,
  BASE_TYPES,
  baseTypeOf,
  COLUMN_NAME,
  CONCEPT_NAME,
  conceptNameFrom,
  emptySpec,
  findObjectType,
  findValueType,
  interfaceSchema,
  linkTypeSchema,
  MEMBER_NAME,
  memberNameFrom,
  metricSchema,
  objectTypeSchema,
  ontologySpecSchema,
  propertySchema,
  ruleSchema,
  supertypes,
  TABLE_REF,
  valueTypeSchema,
  type BaseType,
  type Cardinality,
  type LinkType,
  type ObjectType,
  type OntologyMetric,
  type OntologyProperty,
  type OntologySpec,
  type ValueType,
} from "@/lib/ontology/spec";
import { validateSpec } from "@/lib/ontology/validate";

/** The `vendor_name` this app's extensions are written under. */
export const AGENTSWARMS_VENDOR = "AGENTSWARMS";

const DATA_TYPE_OF: Record<BaseType, OssieDataType> = {
  string: "String",
  integer: "Integer",
  decimal: "Decimal",
  float: "Float",
  boolean: "Boolean",
  date: "Date",
  datetime: "DateTime",
  timestamp: "DateTimeTz",
};

const BASE_OF_DATA_TYPE: Partial<Record<OssieDataType, BaseType>> = {
  String: "string",
  Integer: "integer",
  Decimal: "decimal",
  Float: "float",
  Boolean: "boolean",
  Date: "date",
  DateTime: "datetime",
  DateTimeTz: "timestamp",
};

/**
 * The built-in ontology concept a base type extends. The ontology has no
 * zoned timestamp, so `timestamp` is a DateTime there (the semantic model's
 * DateTimeTz keeps the difference, and the extension restores it).
 */
const BUILT_IN_OF: Record<BaseType, string> = {
  string: "String",
  integer: "Integer",
  decimal: "Decimal",
  float: "Float",
  boolean: "Boolean",
  date: "Date",
  datetime: "DateTime",
  timestamp: "DateTime",
};

const BASE_OF_BUILT_IN: Record<string, BaseType> = {
  string: "string",
  integer: "integer",
  decimal: "decimal",
  float: "float",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
};

const TEMPORAL = new Set<BaseType>(["date", "datetime", "timestamp"]);
const NUMERIC = new Set<BaseType>(["integer", "decimal", "float"]);

const MULTIPLICITY_OF: Partial<Record<Cardinality, "ManyToOne" | "OneToOne">> = {
  many_to_one: "ManyToOne",
  one_to_one: "OneToOne",
};

/**
 * Dialects an expression is read from, best first. OSSIE_SQL_2026 is the
 * portable form; ANSI is what most producers write; the engine-specific ones
 * are close enough to this app's SQL subset to be worth trying, and whatever
 * they contain still has to pass checkExpr. MDX, DAX, Tableau and the like are
 * not SQL at all and are never tried.
 */
const SQL_DIALECTS = [
  OSSIE_PORTABLE_DIALECT,
  "ANSI_SQL",
  "DUCKDB",
  "POSTGRES",
  "POSTGRESQL",
  "DATABRICKS",
  "SNOWFLAKE",
  "BIGQUERY",
];

/** Words a name must be quoted to be used as one, in anyone's SQL. */
const RESERVED = new Set([
  ...CORE_KEYWORDS,
  "all",
  "any",
  "asc",
  "by",
  "cast",
  "check",
  "column",
  "constraint",
  "create",
  "cross",
  "current",
  "current_time",
  "current_user",
  "default",
  "delete",
  "desc",
  "drop",
  "except",
  "exists",
  "fetch",
  "for",
  "foreign",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "inner",
  "insert",
  "intersect",
  "into",
  "join",
  "key",
  "left",
  "limit",
  "natural",
  "offset",
  "on",
  "order",
  "outer",
  "over",
  "primary",
  "references",
  "right",
  "select",
  "table",
  "to",
  "union",
  "unique",
  "update",
  "user",
  "using",
  "values",
  "window",
  "with",
]);

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// ── This app's extensions ────────────────────────────────────────────────────
//
// Each is `{"agentswarms": 1, "kind": …, …payload}`. The payload schemas are
// cut from spec.ts's own schemas, so a hand-edited extension that would make
// an invalid spec is refused with a warning instead of being trusted.

const specRemainderSchema = z.object({
  name: ontologySpecSchema.shape.name.optional(),
  iri: ontologySpecSchema.shape.iri,
  prefixes: ontologySpecSchema.shape.prefixes,
  valueTypes: z.array(valueTypeSchema).optional(),
  interfaces: z.array(interfaceSchema).optional(),
  rules: z.array(ruleSchema).optional(),
  actionTypes: z.array(actionTypeSchema).optional(),
  /** Types without a table: they have no dataset to ride on. */
  types: z.array(objectTypeSchema).optional(),
  /** Links no Ossie relationship can express (join tables, many-to-many, unbound ends). */
  links: z.array(linkTypeSchema).optional(),
  /** The original order of types and links, which the datasets alone do not keep. */
  order: z.object({ types: z.array(z.string()), links: z.array(z.string()) }).optional(),
});
type SpecRemainder = z.infer<typeof specRemainderSchema>;

const typeRemainderSchema = objectTypeSchema
  .pick({
    label: true,
    pluralLabel: true,
    icon: true,
    color: true,
    status: true,
    domain: true,
    extends: true,
    interfaces: true,
    titleProperty: true,
    iri: true,
    position: true,
  })
  .partial()
  .extend({
    /** Only when the dataset name does not lead back to it. */
    name: objectTypeSchema.shape.name.optional(),
    filter: z.string().min(1).max(2000).optional(),
  });

const propertyRemainderSchema = propertySchema
  .pick({ label: true, type: true, required: true, sensitivity: true, iri: true })
  .partial()
  .extend({
    /** Declared without a column or expression (it reads its supertype's). */
    unmapped: z.literal(true).optional(),
    /** A derived expression that happens to look like a bare column name. */
    derived: z.literal(true).optional(),
    /** Inherited from a supertype: a field of the dataset, not a property of this type. */
    inherited: z.literal(true).optional(),
  });

const metricRemainderSchema = metricSchema
  .pick({ label: true, format: true, certified: true })
  .partial();

const linkRemainderSchema = linkTypeSchema.omit({ join: true });

type ExtensionKind = "spec" | "type" | "property" | "metric" | "link";

function ours(kind: ExtensionKind, payload: Record<string, unknown>): OssieCustomExtension[] {
  const p = prune(payload);
  if (!Object.keys(p).length) return [];
  return [
    { vendor_name: AGENTSWARMS_VENDOR, data: JSON.stringify({ agentswarms: 1, kind, ...p }) },
  ];
}

// ── Export ───────────────────────────────────────────────────────────────────

export type OssieExportOptions = {
  /** The semantic model's `name`; the ontology's name by default. */
  modelName?: string;
  ontologyName?: string;
  /** Prefixed to every table, `lake` → `lake.sales.orders`, for tools that want three parts. */
  catalog?: string;
};

export type OssieExport = {
  semanticModel: OssieSemanticModel;
  ontology: OssieOntology;
  mapping: OssieMapping;
  yaml: { semanticModel: string; ontology: string; mapping: string };
  warnings: string[];
};

/** Thrown when there is nothing Ossie can hold (no type bound to a table). */
export class OssieExportError extends Error {}

export function exportOssie(spec: OntologySpec, opts: OssieExportOptions = {}): OssieExport {
  const warnings: string[] = [];
  const errors = validateSpec(spec).issues.filter((i) => i.level === "error");
  if (errors.length) {
    warnings.push(
      `The model has ${errors.length} validation error(s), the first at ${errors[0].path}: ${errors[0].message}. Other tools may reject what it exports.`,
    );
  }
  const bound = spec.objectTypes.filter((t) => t.source);
  if (!bound.length) {
    throw new OssieExportError(
      "An Ossie semantic model needs at least one dataset: bind an object type to a table first",
    );
  }
  const modelName = opts.modelName?.trim() || spec.name;
  const ontologyName = opts.ontologyName?.trim() || spec.name;
  let catalog = opts.catalog?.trim() || undefined;
  if (catalog && !PLAIN_IDENT.test(catalog)) {
    warnings.push(
      `The catalog \`${catalog}\` is not a plain name, so tables are written without it`,
    );
    catalog = undefined;
  }

  // Datasets are named the way tables are (snake_case), which is also what
  // conceptNameFrom turns back into the type's name on the way in.
  const datasetOf = new Map<string, string>();
  const takenDatasets = new Set<string>();
  for (const t of bound) {
    datasetOf.set(key(t.name), uniqueName(memberNameFrom(t.name), takenDatasets, "_"));
  }
  const ds = (typeName: string) => datasetOf.get(key(typeName)) as string;

  const datasets = bound.map((t) => exportDataset(spec, t, ds(t.name), catalog, warnings));

  const relationships: OssieRelationship[] = [];
  const leftoverLinks: LinkType[] = [];
  const relNames = new Set<string>();
  for (const link of spec.linkTypes) {
    const why = relationshipBlocker(spec, link);
    if (why) {
      leftoverLinks.push(link);
      warnings.push(
        `${link.from}.${link.name} ${why}, so other tools will not see it (it is kept in the ${AGENTSWARMS_VENDOR} extension)`,
      );
      continue;
    }
    const j = link.join as Extract<LinkType["join"], { kind: "foreign_key" }>;
    // Ossie's `from` is the many side. A one-to-many link is the same join
    // read the other way, so it is written from its `to` end.
    const swap = link.cardinality === "one_to_many";
    const { join: _join, ...rest } = link;
    relationships.push({
      name: uniqueName(`${ds(link.from)}_${link.name}`, relNames, "_"),
      from: ds(swap ? link.to : link.from),
      to: ds(swap ? link.from : link.to),
      from_columns: [...(swap ? j.toProperties : j.fromProperties)],
      to_columns: [...(swap ? j.fromProperties : j.toProperties)],
      ...nonEmpty("custom_extensions", ours("link", rest)),
    });
  }

  const unbound = spec.objectTypes.filter((t) => !t.source);
  if (unbound.length) {
    warnings.push(
      `${list(unbound.map((t) => t.name))} ${unbound.length === 1 ? "has" : "have"} no table, so ${unbound.length === 1 ? "it is" : "they are"} a concept in the ontology but not a dataset`,
    );
  }
  const restricted = spec.objectTypes.flatMap((t) =>
    t.properties.filter((p) => p.sensitivity === "restricted").map((p) => `${t.name}.${p.name}`),
  );
  if (restricted.length) {
    warnings.push(
      `Ossie has no sensitivity: ${list(restricted)} ${restricted.length === 1 ? "is" : "are"} restricted here, and other tools will not mask ${restricted.length === 1 ? "it" : "them"}`,
    );
  }
  if (spec.rules.length || spec.actionTypes.length) {
    warnings.push(
      `Rules and action types have no Ossie equivalent; ${spec.rules.length} rule(s) and ${spec.actionTypes.length} action type(s) travel in the ${AGENTSWARMS_VENDOR} extension only`,
    );
  }
  for (const iri of allIris(spec)) {
    const prefix = undeclaredPrefix(iri, spec.prefixes ?? {});
    if (prefix)
      warnings.push(`The IRI \`${iri}\` uses the prefix \`${prefix}\`, which is not declared`);
  }

  const semanticModel: OssieSemanticModel = prune({
    version: OSSIE_VERSION,
    name: modelName,
    description: spec.description,
    datasets,
    relationships: relationships.length ? relationships : undefined,
    custom_extensions: orUndefined([
      ...(spec.extensions ?? [])
        .filter((e) => e.vendor !== AGENTSWARMS_VENDOR)
        .map((e) => ({ vendor_name: e.vendor, data: e.data })),
      ...ours("spec", {
        name: modelName !== spec.name ? spec.name : undefined,
        iri: spec.iri,
        prefixes: spec.prefixes,
        valueTypes: orUndefined(spec.valueTypes),
        interfaces: orUndefined(spec.interfaces),
        rules: orUndefined(spec.rules),
        actionTypes: orUndefined(spec.actionTypes),
        types: orUndefined(unbound),
        links: orUndefined(leftoverLinks),
        order: { types: spec.objectTypes.map((t) => t.name), links: spec.linkTypes.map(linkKey) },
      }),
    ]),
  });

  const ontology = exportOntology(spec, ontologyName);
  const mapping = exportMapping(spec, bound, ds, modelName, ontologyName, warnings);

  // What this writes must be what Ossie's schemas accept. A failure here is a
  // bug in this file, not in the user's model, so it is loud.
  for (const [what, r] of [
    ["semantic model", parseOssieSemanticModel(semanticModel)],
    ["ontology", parseOssieOntology(ontology)],
    ["mapping", parseOssieMapping(mapping)],
  ] as const) {
    if (!r.ok) {
      throw new OssieExportError(
        `The exported ${what} does not match Ossie ${OSSIE_VERSION}: ${r.issues
          .slice(0, 3)
          .map((i) => `${i.path}: ${i.message}`)
          .join("; ")}`,
      );
    }
  }

  const dump = (doc: unknown) => yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return {
    semanticModel,
    ontology,
    mapping,
    yaml: { semanticModel: dump(semanticModel), ontology: dump(ontology), mapping: dump(mapping) },
    warnings,
  };
}

function exportDataset(
  spec: OntologySpec,
  t: ObjectType,
  name: string,
  catalog: string | undefined,
  warnings: string[],
): OssieDataset {
  const own = new Set(t.properties.map((p) => p.name));
  const fields = allProperties(spec, t).map((p) => exportField(spec, t, p, own.has(p.name)));
  const source = t.source as NonNullable<ObjectType["source"]>;
  if (source.filter) {
    warnings.push(
      `${t.name} reads only the rows where \`${source.filter}\`; Ossie has no dataset filter, so other tools will see every row of ${source.table}`,
    );
  }
  // A single-property `unique` rule is a unique key, which Ossie can say. The
  // rule itself (severity, statement) still travels in the extension.
  const uniqueKeys = spec.rules
    .filter((r) => r.kind === "unique" && r.enabled && r.property && same(r.objectType, t.name))
    .map((r) => [r.property as string])
    .filter((k, i, all) => all.findIndex((x) => x[0] === k[0]) === i);
  return prune({
    name,
    source: catalog ? `${catalog}.${source.table}` : source.table,
    primary_key: t.primaryKey.length ? [...t.primaryKey] : undefined,
    unique_keys: uniqueKeys.length ? uniqueKeys : undefined,
    description: t.description,
    ai_context: aiContext(t.aiInstructions, t.synonyms),
    fields: fields.length ? fields : undefined,
    metrics: t.metrics.length ? t.metrics.map(exportMetric) : undefined,
    custom_extensions: orUndefined(
      ours("type", {
        name: conceptNameFrom(name) !== t.name ? t.name : undefined,
        label: t.label,
        pluralLabel: t.pluralLabel,
        icon: t.icon,
        color: t.color,
        status: t.status,
        domain: t.domain,
        extends: t.extends,
        interfaces: t.interfaces,
        titleProperty: t.titleProperty,
        iri: t.iri,
        position: t.position,
        filter: source.filter,
      }),
    ),
  });
}

function exportField(
  spec: OntologySpec,
  t: ObjectType,
  p: OntologyProperty,
  isOwn: boolean,
): OssieField {
  // The field always says where the value comes from, even when this type's
  // declaration inherits it: Ossie has no inheritance, a field is a field.
  const m = mappingOf(spec, t, p);
  const sql = m.expression ?? (m.column ? sqlIdent(m.column) : "NULL");
  const base = baseTypeOf(spec, p.type);
  return prune({
    name: p.name,
    expression: { sql },
    dimension: base && TEMPORAL.has(base) ? { is_time: true } : undefined,
    description: p.description,
    datatype: base ? DATA_TYPE_OF[base] : undefined,
    ai_context: aiContext(undefined, p.synonyms),
    custom_extensions: orUndefined(
      isOwn
        ? ours("property", {
            label: p.label,
            type: base === p.type ? undefined : p.type,
            required: p.required,
            sensitivity: p.sensitivity,
            iri: p.iri,
            unmapped: !p.column && !p.expression ? true : undefined,
            derived: p.expression && readIdent(p.expression) !== null ? true : undefined,
          })
        : ours("property", { inherited: true }),
    ),
  });
}

function exportMetric(m: OntologyMetric): OssieMetric {
  // Metric expressions already name properties, unqualified: exactly Ossie's
  // rule for a dataset-scoped metric.
  return prune({
    name: m.name,
    expression: { sql: m.expression },
    description: m.description,
    ai_context: aiContext(undefined, m.synonyms),
    custom_extensions: orUndefined(
      ours("metric", { label: m.label, format: m.format, certified: m.certified }),
    ),
  });
}

/** Why a link cannot be an Ossie relationship, or null when it can. */
function relationshipBlocker(spec: OntologySpec, link: LinkType): string | null {
  if (link.join.kind === "join_table")
    return `goes through the join table ${link.join.table}, which an Ossie relationship cannot express`;
  if (link.cardinality === "many_to_many")
    return "is many-to-many, and an Ossie relationship is many-to-one or one-to-one";
  if (!findObjectType(spec, link.from)?.source || !findObjectType(spec, link.to)?.source)
    return "joins a type that has no table";
  return null;
}

function exportOntology(spec: OntologySpec, name: string): OssieOntology {
  const concepts: OssieConcept[] = [];
  for (const v of spec.valueTypes) {
    concepts.push(
      prune({
        concept: v.name,
        type: "ValueType" as const,
        description: v.description,
        extends: [BUILT_IN_OF[v.base]],
        requires: orUndefined(valueTypeRequires(v)),
        iri: v.iri,
      }),
    );
  }
  // An interface is a concept other concepts extend: Ossie has multiple
  // supertypes, which is what an interface is here.
  for (const i of spec.interfaces) {
    concepts.push(
      prune({
        concept: i.name,
        type: "EntityType" as const,
        description: i.description,
        relationships: orUndefined(
          i.properties.map((p) => propertyRelationship(spec, i.name, p, false)),
        ),
      }),
    );
  }
  for (const t of spec.objectTypes) {
    const relationships = [
      ...t.properties.map((p) =>
        propertyRelationship(
          spec,
          t.name,
          p,
          t.primaryKey.length === 1 && t.primaryKey[0] === p.name,
        ),
      ),
      ...spec.linkTypes.filter((l) => same(l.from, t.name)).map(linkRelationship),
    ];
    concepts.push(
      prune({
        concept: t.name,
        type: "EntityType" as const,
        description: t.description,
        extends: orUndefined([...(t.extends ? [t.extends] : []), ...(t.interfaces ?? [])]),
        identify_by: orUndefined([...t.primaryKey]),
        // "Every Airport has a latitude" is written `Airport.latitude` in the
        // spec's examples: mandatory participation in the relationship.
        requires: orUndefined(
          t.properties.filter((p) => p.required).map((p) => `${t.name}.${p.name}`),
        ),
        relationships: orUndefined(relationships),
        iri: t.iri,
      }),
    );
  }
  return prune({
    version: OSSIE_VERSION,
    name,
    description: spec.description,
    ontology: concepts,
    prefixes: spec.prefixes && Object.keys(spec.prefixes).length ? { ...spec.prefixes } : undefined,
  });
}

/**
 * A value type's constraints in the style of the spec's own examples
 * (`CancelationCode == 'A' OR …`, `DegreesLatitude <= 90`). importOssie reads
 * exactly these forms back.
 */
function valueTypeRequires(v: ValueType): string[] {
  const out: string[] = [];
  const literal = (x: string) => (NUMERIC.has(v.base) && NUMBER.test(x) ? x : sqlString(x));
  if (v.enum?.length) out.push(v.enum.map((x) => `${v.name} == ${literal(x)}`).join(" OR "));
  if (v.pattern) out.push(`REGEXP_LIKE(${v.name}, ${sqlString(v.pattern)})`);
  if (v.min !== undefined) out.push(`${v.name} >= ${v.min}`);
  if (v.max !== undefined) out.push(`${v.name} <= ${v.max}`);
  return out;
}

function propertyRelationship(
  spec: OntologySpec,
  concept: string,
  p: { name: string; type: string; description?: string; iri?: string },
  soleKey: boolean,
): OssieOntologyRelationship {
  const role = roleConceptOf(spec, p.type);
  return prune({
    name: p.name,
    description: p.description,
    roles: [{ concept: role, name: p.name }],
    // A property that is the whole key identifies the object: one-to-one, as
    // the spec's `Person.nr` is.
    multiplicity: soleKey ? ("OneToOne" as const) : ("ManyToOne" as const),
    verbalizes: [`{${concept}} has {${role}:${p.name}}`],
    iri: p.iri,
  });
}

function linkRelationship(link: LinkType): OssieOntologyRelationship {
  // When a concept plays both roles, Ossie needs the second one named.
  const self = same(link.from, link.to);
  const target = self ? `${link.to}:${link.name}` : link.to;
  const verbalizes = [
    link.verbalization ?? `{${link.from}} ${link.label ?? words(link.name)} {${target}}`,
  ];
  if (link.inverseName) {
    verbalizes.push(`{${target}} ${link.inverseLabel ?? words(link.inverseName)} {${link.from}}`);
  }
  return prune({
    name: link.name,
    description: link.description,
    roles: [self ? { concept: link.to, name: link.name } : { concept: link.to }],
    multiplicity: MULTIPLICITY_OF[link.cardinality],
    verbalizes,
    iri: link.iri,
  });
}

function exportMapping(
  spec: OntologySpec,
  bound: ObjectType[],
  ds: (typeName: string) => string,
  modelName: string,
  ontologyName: string,
  warnings: string[],
): OssieMapping {
  const ref = (dataset: string, field: string) => `${sqlIdent(dataset)}.${sqlIdent(field)}`;
  const conceptMappings: OssieConceptMapping[] = [];
  for (const t of bound) {
    if (!t.primaryKey.length) {
      warnings.push(`${t.name} has no key, so the mapping cannot say which object a row is`);
      continue;
    }
    const D = ds(t.name);
    const identity: OssieObjectMapping = {
      referent_mappings: t.primaryKey.map((k) => ({ relationship: k, expression: ref(D, k) })),
    };
    const children: OssieLinkMapping[] = allProperties(spec, t)
      .filter((p) => !t.primaryKey.includes(p.name))
      .map((p) => ({
        relationship: p.name,
        object_mapping: { concept: roleConceptOf(spec, p.type), expression: ref(D, p.name) },
      }));
    const otherTops: OssieLinkMapping[] = [];
    for (const link of spec.linkTypes) {
      if (!same(link.from, t.name) || link.join.kind !== "foreign_key") continue;
      const u = findObjectType(spec, link.to);
      if (!u?.source || !u.primaryKey.length) continue;
      const j = link.join;
      if (sameSet(j.toProperties, u.primaryKey)) {
        // The key of the target is in this type's row: (this, target) tuples
        // come from this dataset.
        children.push({
          relationship: link.name,
          object_mapping: {
            concept: u.name,
            referent_mappings: u.primaryKey.map((k) => ({
              relationship: k,
              expression: ref(D, j.fromProperties[j.toProperties.indexOf(k)]),
            })),
          },
        });
      } else if (sameSet(j.fromProperties, t.primaryKey)) {
        // This type's key is in the target's rows (one-to-many): the tuples
        // come from the target's dataset.
        const U = ds(u.name);
        otherTops.push({
          object_mapping: {
            referent_mappings: t.primaryKey.map((k) => ({
              relationship: k,
              expression: ref(U, j.toProperties[j.fromProperties.indexOf(k)]),
            })),
          },
          children: [
            {
              relationship: link.name,
              object_mapping: {
                concept: u.name,
                referent_mappings: u.primaryKey.map((k) => ({
                  relationship: k,
                  expression: ref(U, k),
                })),
              },
            },
          ],
        });
      } else {
        warnings.push(
          `${t.name}.${link.name} joins on properties that identify neither end, so the mapping document leaves it out`,
        );
      }
    }
    conceptMappings.push(
      prune({
        concept: t.name,
        object_mappings: [identity],
        link_mappings: orUndefined([
          ...(children.length ? [{ object_mapping: identity, children }] : []),
          ...otherTops,
        ]),
      }),
    );
  }
  return {
    version: OSSIE_VERSION,
    name: `${spec.name} mapping`,
    description: `Maps the ${ontologyName} ontology onto the ${modelName} semantic model`,
    ontology_ref: { name: ontologyName },
    semantic_model_ref: { name: modelName },
    concept_mappings: conceptMappings,
  };
}

/** Where a property's value comes from: its own mapping or the nearest supertype's (compile.ts). */
function mappingOf(spec: OntologySpec, t: ObjectType, p: OntologyProperty): OntologyProperty {
  if (p.column || p.expression) return p;
  for (const s of supertypes(spec, t)) {
    const q = s.properties.find((x) => x.name === p.name);
    if (q && (q.column || q.expression)) return q;
  }
  return p;
}

/** The concept that plays a property's value role: its value type, or the built-in for its base. */
function roleConceptOf(spec: OntologySpec, type: string): string {
  const vt = findValueType(spec, type);
  if (vt) return vt.name;
  const base = baseTypeOf(spec, type);
  return base ? BUILT_IN_OF[base] : "String";
}

function aiContext(instructions?: string, synonyms?: string[]): OssieAIContext | undefined {
  if (instructions === undefined && synonyms === undefined) return undefined;
  return prune({ instructions, synonyms: synonyms ? [...synonyms] : undefined });
}

function allIris(spec: OntologySpec): string[] {
  return [
    ...(spec.iri ? [spec.iri] : []),
    ...spec.valueTypes.flatMap((v) => (v.iri ? [v.iri] : [])),
    ...spec.objectTypes.flatMap((t) => [
      ...(t.iri ? [t.iri] : []),
      ...t.properties.flatMap((p) => (p.iri ? [p.iri] : [])),
    ]),
    ...spec.linkTypes.flatMap((l) => (l.iri ? [l.iri] : [])),
  ];
}

const URI_SCHEMES = new Set(
  "http https urn mailto tel file ftp data did doi geo ldap news sms tag".split(" "),
);

/** The prefix of a `prefix:local` IRI that `prefixes` does not declare (Ossie's own reading). */
export function undeclaredPrefix(iri: string, prefixes: Record<string, string>): string | null {
  const at = iri.indexOf(":");
  if (at < 0) return null;
  const prefix = iri.slice(0, at);
  const local = iri.slice(at + 1);
  if (local.startsWith("//") || local.includes(":") || URI_SCHEMES.has(prefix.toLowerCase()))
    return null;
  return prefix in prefixes ? null : prefix;
}

// ── Import ───────────────────────────────────────────────────────────────────

export type OssieImport = { spec: OntologySpec; warnings: string[] };

/**
 * Read Ossie documents (YAML or JSON, any mix of the three kinds) into one
 * ontology. Never throws: a document that cannot be read is skipped with a
 * warning, and so is anything inside one that this model cannot hold.
 */
export function importOssie(texts: string[]): OssieImport {
  const ctx = new ImportContext();
  const models: OssieSemanticModel[] = [];
  const ontologies: OssieOntology[] = [];
  const mappings: OssieMapping[] = [];
  texts.forEach((text, i) => {
    for (const d of loadDocuments(text, `Document ${i + 1}`, ctx)) {
      if (d.kind === "semantic_model") models.push(d.doc);
      else if (d.kind === "ontology") ontologies.push(d.doc);
      else mappings.push(d.doc);
    }
  });
  // The deprecated embedded form (ontology_mappings) is a model plus a
  // mapping in disguise; reading it that way keeps one code path.
  for (const o of ontologies) {
    for (const m of o.ontology_mappings ?? []) {
      ctx.warn(
        `The ontology ${o.name} embeds its mapping (ontology_mappings), which Ossie has deprecated; it was read as a separate model and mapping`,
      );
      if (!models.some((x) => x.name === m.semantic_model.name)) models.push(m.semantic_model);
      mappings.push({
        version: OSSIE_VERSION,
        name: m.name ?? `${o.name} mapping`,
        ontology_ref: { name: o.name },
        semantic_model_ref: { name: m.semantic_model.name },
        concept_mappings: m.concept_mappings,
      });
    }
  }
  for (const m of mappings) {
    if (ontologies.length && !ontologies.some((o) => o.name === m.ontology_ref.name))
      ctx.warn(
        `The mapping ${m.name} refers to the ontology "${m.ontology_ref.name}", which was not among the documents`,
      );
    if (models.length && !models.some((x) => x.name === m.semantic_model_ref.name))
      ctx.warn(
        `The mapping ${m.name} refers to the semantic model "${m.semantic_model_ref.name}", which was not among the documents`,
      );
  }

  let remainder: SpecRemainder | undefined;
  let carrier: OssieSemanticModel | undefined;
  for (const m of models) {
    const r = readOurs(
      m.custom_extensions,
      "spec",
      specRemainderSchema,
      ctx,
      `The model ${m.name}`,
    );
    if (!r) continue;
    if (remainder)
      ctx.warn(
        `More than one model carries this app's model extension; ${carrier?.name}'s is used`,
      );
    else {
      remainder = r;
      carrier = m;
    }
  }

  const spec = emptySpec(
    clip(
      remainder?.name ?? carrier?.name ?? ontologies[0]?.name ?? models[0]?.name ?? "",
      200,
      "the ontology's name",
      ctx,
    ).trim() || "Imported ontology",
  );
  const description = carrier?.description ?? models[0]?.description ?? ontologies[0]?.description;
  if (description) spec.description = clip(description, 8000, "the description", ctx);

  const extensions: { vendor: string; data: string }[] = [];
  const keepForeign = (
    exts: OssieCustomExtension[] | undefined,
    where: string,
    atRoot: boolean,
  ) => {
    for (const e of exts ?? []) {
      if (e.vendor_name === AGENTSWARMS_VENDOR) continue;
      if (e.data.length > 100_000 || e.vendor_name.length > 100) {
        ctx.warn(`${where}: the ${e.vendor_name.slice(0, 100)} extension is too large to keep`);
        continue;
      }
      extensions.push({ vendor: e.vendor_name, data: e.data });
      if (!atRoot)
        ctx.warn(
          `${where}: the ${e.vendor_name} extension is kept at the model level, where this app keeps extensions`,
        );
    }
  };

  const bound: Bound[] = [];
  for (const m of models) bound.push(...importModel(m, spec, ctx, keepForeign, !!remainder));
  for (const m of mappings) keepForeign(m.custom_extensions, `The mapping ${m.name}`, true);

  if (remainder) applySpecRemainder(spec, remainder, ctx);
  else mergeOntologies(spec, ontologies, mappings, bound, ctx);

  if (!remainder) {
    for (const b of bound) {
      if (b.type.primaryKey.length) continue;
      const id = b.fields.get("id");
      if (id) {
        b.type.primaryKey = [id];
        ctx.warn(`${b.type.name} declares no key; \`${id}\` was taken as its key`);
      } else {
        ctx.warn(
          `${b.type.name} declares no key; choose the properties that identify one before publishing`,
        );
      }
    }
  }

  const unique = extensions.filter(
    (e, i) => extensions.findIndex((x) => x.vendor === e.vendor && x.data === e.data) === i,
  );
  if (unique.length > 100)
    ctx.warn(`Only the first 100 of ${unique.length} vendor extensions were kept`);
  if (unique.length) spec.extensions = unique.slice(0, 100);

  const parsed = ontologySpecSchema.safeParse(spec);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 5))
      ctx.warn(`The imported model is not valid at ${i.path.join(".")}: ${i.message}`);
  }
  return { spec: parsed.success ? parsed.data : spec, warnings: ctx.finish() };
}

class ImportContext {
  private readonly out: string[] = [];
  private readonly seen = new Set<string>();
  private readonly notes = new Map<string, number>();

  warn(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.out.push(message);
  }

  /** Something there is no place for: counted, and reported once at the end. */
  note(what: string, n = 1): void {
    this.notes.set(what, (this.notes.get(what) ?? 0) + n);
  }

  finish(): string[] {
    if (this.notes.size) {
      this.out.push(
        `Not imported, having no place in this model: ${[...this.notes]
          .map(([what, n]) => (n > 1 ? `${what} (${n})` : what))
          .join("; ")}`,
      );
    }
    return this.out;
  }
}

const KIND_LABEL: Record<OssieKind, string> = {
  semantic_model: "semantic model",
  ontology: "ontology",
  mapping: "mapping",
};

function loadDocuments(text: string, label: string, ctx: ImportContext): OssieDocument[] {
  let raw: unknown;
  try {
    // CORE_SCHEMA: no YAML timestamps or merge keys, so an unquoted date in a
    // description stays the text it was written as.
    raw = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    try {
      raw = JSON.parse(text);
    } catch {
      ctx.warn(`${label} is neither YAML nor JSON: ${String((e as Error).message).split("\n")[0]}`);
      return [];
    }
  }
  const out: OssieDocument[] = [];
  for (const doc of migrateLegacy(raw, label, ctx)) {
    const r = parseOssieDocument(doc);
    const named = isObject(doc) && typeof doc.name === "string" ? `${label} (${doc.name})` : label;
    if (r.ok) {
      out.push(r.value);
      continue;
    }
    const shown = r.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`);
    if (r.issues.length > 5) shown.push(`and ${r.issues.length - 5} more`);
    ctx.warn(
      `${named} ${r.kind ? `is not a valid Ossie ${OSSIE_VERSION} ${KIND_LABEL[r.kind]}` : "is not an Ossie document"} and was skipped: ${shown.join("; ")}`,
    );
  }
  return out;
}

/**
 * Bring an older document to the 0.2.0.dev0 shape: the pre-0.2 `semantic_model`
 * list becomes one document per model (never just the first, as the spec's
 * migration notes insist), and another version is read as this one, with a
 * warning, since the schema accepts exactly one.
 */
function migrateLegacy(raw: unknown, label: string, ctx: ImportContext): unknown[] {
  if (!isObject(raw)) return [raw];
  if (!("datasets" in raw) && !("ontology" in raw) && "semantic_model" in raw) {
    const sm = raw.semantic_model;
    const list = Array.isArray(sm) ? sm : isObject(sm) ? [sm] : [];
    if (!list.length) {
      ctx.warn(`${label} has an empty semantic_model list, which holds no model`);
      return [];
    }
    ctx.warn(
      `${label} is in the pre-0.2 shape (a semantic_model list); its ${list.length} model(s) were read as ${OSSIE_VERSION} documents`,
    );
    return list.map((m) => (isObject(m) ? { ...m, version: OSSIE_VERSION } : m));
  }
  if (
    raw.version !== OSSIE_VERSION &&
    ("datasets" in raw || "ontology" in raw || "concept_mappings" in raw)
  ) {
    ctx.warn(
      `${label} declares Ossie version ${raw.version === undefined ? "(none)" : String(raw.version)}; it was read as ${OSSIE_VERSION}`,
    );
    return [{ ...raw, version: OSSIE_VERSION }];
  }
  return [raw];
}

/** A dataset as it became a type, with the field → property names it was read with. */
type Bound = {
  type: ObjectType;
  datasetName: string;
  /** Lower-cased field name → property name (inherited fields map to the supertype's property). */
  fields: Map<string, string>;
  /** Lower-cased field name → the datatype the semantic model declared. */
  datatypes: Map<string, OssieDataType | undefined>;
};

type KeepForeign = (
  exts: OssieCustomExtension[] | undefined,
  where: string,
  atRoot: boolean,
) => void;

function importModel(
  model: OssieSemanticModel,
  spec: OntologySpec,
  ctx: ImportContext,
  keepForeign: KeepForeign,
  own: boolean,
): Bound[] {
  keepForeign(model.custom_extensions, `The model ${model.name}`, true);
  if (model.ai_context !== undefined) ctx.note("the model's ai_context");
  const local = new Map<string, Bound>();
  for (const d of model.datasets) {
    const where = `Dataset ${d.name}`;
    const rem = readOurs(d.custom_extensions, "type", typeRemainderSchema, ctx, where);
    keepForeign(d.custom_extensions, where, false);
    const name = uniqueConcept(spec, rem?.name ?? conceptNameFrom(d.name));
    if (rem?.name === undefined && name !== conceptNameFrom(d.name))
      ctx.warn(`${where} became the type ${name}, its usual name being taken`);
    const table = tableOf(d.source, where, ctx);
    if (rem?.filter && !table)
      ctx.warn(`${where}: its row filter was dropped along with the table`);
    const ai = readAI(d.ai_context, "type", ctx);
    const { name: _n, filter, ...typeRest } = rem ?? ({} as NonNullable<typeof rem>);
    const t: ObjectType = prune({
      name,
      description:
        d.description === undefined ? undefined : clip(d.description, 4000, "descriptions", ctx),
      ...ai,
      ...typeRest,
      source: table ? prune({ table, filter }) : null,
      primaryKey: [] as string[],
      properties: [] as OntologyProperty[],
      metrics: [] as OntologyMetric[],
    });
    spec.objectTypes.push(t);
    const b: Bound = { type: t, datasetName: d.name, fields: new Map(), datatypes: new Map() };
    local.set(key(d.name), b);

    const memberNames = new Set<string>();
    for (const f of d.fields ?? [])
      importField(f, b, memberNames, ctx, keepForeign, `${d.name}.${f.name}`);

    for (const k of d.primary_key ?? []) {
      const p = b.fields.get(key(k));
      if (!p) ctx.warn(`${where}: its key names \`${k}\`, which is not one of its fields`);
      else if (!t.primaryKey.includes(p)) t.primaryKey.push(p);
    }
    if (t.primaryKey.length > 8) {
      ctx.warn(`${where}: a key has at most 8 properties here; the first 8 were kept`);
      t.primaryKey = t.primaryKey.slice(0, 8);
    }
    if (d.unique_keys?.length && !own) ctx.note("unique_keys", d.unique_keys.length);
    for (const m of d.metrics ?? []) {
      importMetric(
        m,
        b,
        (text) => rewriteQualified(text, (q, f) => (same(q, d.name) ? fieldOf(b, f) : null)).text,
        ctx,
        keepForeign,
      );
    }
  }
  for (const m of model.metrics ?? []) attachModelMetric(m, local, ctx, keepForeign);
  for (const r of model.relationships ?? []) importRelationship(r, local, spec, ctx, keepForeign);
  return [...local.values()];
}

function importField(
  f: OssieField,
  b: Bound,
  memberNames: Set<string>,
  ctx: ImportContext,
  keepForeign: KeepForeign,
  where: string,
): void {
  const rem = readOurs(
    f.custom_extensions,
    "property",
    propertyRemainderSchema,
    ctx,
    `Field ${where}`,
  );
  keepForeign(f.custom_extensions, `Field ${where}`, false);
  b.datatypes.set(key(f.name), f.datatype);
  if (rem?.inherited) {
    // The property belongs to the supertype; the field only mirrors it so
    // Ossie consumers, which have no inheritance, see it.
    b.fields.set(key(f.name), f.name);
    return;
  }
  const name = uniqueName(safeMember(f.name), memberNames, "_");
  // Only a real rename is worth saying: names are compared case-insensitively.
  if (key(name) !== key(f.name)) ctx.warn(`Field ${where} became the property \`${name}\``);
  b.fields.set(key(f.name), name);

  const base = f.datatype ? BASE_OF_DATA_TYPE[f.datatype] : "string";
  if (!base) ctx.note(`${f.datatype} fields (read as strings)`);
  const p: OntologyProperty = { name, type: rem?.type ?? base ?? "string" };
  if (!rem?.unmapped) {
    const read = readFieldExpression(f.expression, `Field ${where}`, !!rem?.derived, ctx);
    if (read?.column !== undefined) p.column = read.column;
    else if (read?.expression !== undefined) p.expression = read.expression;
  }
  if (f.description !== undefined) p.description = clip(f.description, 4000, "descriptions", ctx);
  const ai = readAI(f.ai_context, "member", ctx);
  if (ai.synonyms) p.synonyms = ai.synonyms;
  if (f.label !== undefined) ctx.note("field labels (Ossie's categorization label)");
  if (f.dimension?.is_time !== undefined && base && f.dimension.is_time !== TEMPORAL.has(base))
    ctx.note("time-dimension roles that differ from the field's type");
  Object.assign(
    p,
    prune({
      label: rem?.label,
      required: rem?.required,
      sensitivity: rem?.sensitivity,
      iri: rem?.iri,
    }),
  );
  b.type.properties.push(p);
}

/** A member name that is not a SQL word (validate.ts refuses those). */
function safeMember(raw: string): string {
  const n = MEMBER_NAME.test(raw) ? raw : memberNameFrom(raw);
  return CORE_KEYWORDS.has(n) ? `${n}_value`.slice(0, 64) : n;
}

function fieldOf(b: Bound, field: string): string | null {
  return b.fields.get(key(field)) ?? null;
}

function readFieldExpression(
  expr: OssieExpression,
  where: string,
  derived: boolean,
  ctx: ImportContext,
): { column?: string; expression?: string } | null {
  const candidates = expressionCandidates(expr);
  if (!candidates.length) {
    ctx.warn(
      `${where} is written only in ${dialectsOf(expr)}, which cannot run here; it reads nothing`,
    );
    return null;
  }
  for (const c of candidates) {
    const column = derived ? null : readIdent(c.text);
    if (column !== null && COLUMN_NAME.test(column)) {
      noteDialect(c.dialect, ctx);
      return { column };
    }
    if (c.text.length <= 2000 && checkExpr(c.text, "scalar", null).ok) {
      noteDialect(c.dialect, ctx);
      return { expression: c.text };
    }
  }
  // Kept as written, like a metric that does not check: validateSpec then
  // points at it, which is more use than a property that silently reads NULL.
  const first = candidates[0].text;
  if (first.length > 2000) {
    ctx.warn(`${where} is longer than 2000 characters, so it reads nothing`);
    return null;
  }
  const why = checkExpr(first, "scalar", null).error;
  ctx.warn(
    `${where}: \`${short(first)}\` does not check here (${why}); it was kept as written, so fix it before publishing`,
  );
  return { expression: first };
}

function importMetric(
  m: OssieMetric,
  b: Bound,
  unqualify: (text: string) => string,
  ctx: ImportContext,
  keepForeign: KeepForeign,
): void {
  const where = `Metric ${b.datasetName}.${m.name}`;
  const rem = readOurs(m.custom_extensions, "metric", metricRemainderSchema, ctx, where);
  keepForeign(m.custom_extensions, where, false);
  const candidates = expressionCandidates(m.expression);
  if (!candidates.length) {
    ctx.warn(
      `${where} is written only in ${dialectsOf(m.expression)}, which cannot run here; skipped`,
    );
    return;
  }
  addMetric(
    b,
    m,
    candidates.map((c) => ({ ...c, text: renameFields(unqualify(c.text), b) })),
    rem,
    ctx,
  );
}

function addMetric(
  b: Bound,
  m: OssieMetric,
  candidates: { text: string; dialect: string }[],
  rem: z.infer<typeof metricRemainderSchema> | undefined,
  ctx: ImportContext,
): void {
  const t = b.type;
  const known = [...new Set(b.fields.values())];
  const taken = new Set([...known, ...t.metrics.map((x) => x.name)]);
  const name = uniqueName(safeMember(m.name), taken, "_");
  let chosen = candidates.find((c) => checkExpr(c.text, "aggregate", known).ok);
  if (!chosen) {
    chosen = candidates[0];
    const why = checkExpr(chosen.text, "aggregate", known).error;
    ctx.warn(
      `Metric ${t.name}.${name}: \`${short(chosen.text)}\` does not check here (${why}); it was kept as written, so fix it before publishing`,
    );
  } else noteDialect(chosen.dialect, ctx);
  if (chosen.text.length > 2000) {
    ctx.warn(`Metric ${t.name}.${name} is longer than 2000 characters; skipped`);
    return;
  }
  const ai = readAI(m.ai_context, "member", ctx);
  if (m.datatype !== undefined && !rem) ctx.note("metric datatypes");
  t.metrics.push(
    prune({
      name,
      expression: chosen.text,
      description:
        m.description === undefined ? undefined : clip(m.description, 4000, "descriptions", ctx),
      synonyms: ai.synonyms,
      label: rem?.label,
      format: rem?.format,
      certified: rem?.certified,
    }),
  );
}

/**
 * A model-scoped metric spans datasets in Ossie; here a metric belongs to one
 * type. One that names a single dataset is that dataset's metric with the
 * qualifiers dropped; one that spans several has no home, and saying so beats
 * pinning it to whichever came first and computing something else.
 */
function attachModelMetric(
  m: OssieMetric,
  local: Map<string, Bound>,
  ctx: ImportContext,
  keepForeign: KeepForeign,
): void {
  const where = `The model metric ${m.name}`;
  const rem = readOurs(m.custom_extensions, "metric", metricRemainderSchema, ctx, where);
  keepForeign(m.custom_extensions, where, false);
  const candidates = expressionCandidates(m.expression);
  if (!candidates.length) {
    ctx.warn(
      `${where} is written only in ${dialectsOf(m.expression)}, which cannot run here; skipped`,
    );
    return;
  }
  const datasets: string[] = [];
  for (const c of candidates) {
    rewriteQualified(c.text, (q) => {
      if (!datasets.includes(key(q))) datasets.push(key(q));
      return null;
    });
  }
  if (!datasets.length) {
    ctx.warn(
      `${where} names no dataset (a model-level metric writes dataset.field), so it is not attached to a type`,
    );
    return;
  }
  if (datasets.length > 1) {
    ctx.warn(
      `${where} spans ${list(datasets)}; a metric here belongs to one type, so it was not imported`,
    );
    return;
  }
  const b = local.get(datasets[0]);
  if (!b) {
    ctx.warn(`${where} names the dataset ${datasets[0]}, which the model does not declare`);
    return;
  }
  const unresolved: string[] = [];
  const rewritten = candidates.map((c) => ({
    ...c,
    text: rewriteQualified(c.text, (_q, f) => {
      const p = fieldOf(b, f);
      if (!p) unresolved.push(f);
      return p;
    }).text,
  }));
  if (unresolved.length)
    ctx.warn(`${where} names ${list(unresolved)}, which ${b.datasetName} does not declare`);
  addMetric(b, m, rewritten, rem, ctx);
}

function importRelationship(
  r: OssieRelationship,
  local: Map<string, Bound>,
  spec: OntologySpec,
  ctx: ImportContext,
  keepForeign: KeepForeign,
): void {
  const where = `Relationship ${r.name}`;
  const rem = readOurs(r.custom_extensions, "link", linkRemainderSchema, ctx, where);
  keepForeign(r.custom_extensions, where, false);
  const a = local.get(key(r.from));
  const b = local.get(key(r.to));
  if (!a || !b) {
    ctx.warn(`${where} joins ${!a ? r.from : r.to}, which the model does not declare; skipped`);
    return;
  }
  if (r.from_columns.length !== r.to_columns.length) {
    ctx.warn(
      `${where} pairs ${r.from_columns.length} field(s) with ${r.to_columns.length}; skipped`,
    );
    return;
  }
  const fromProps = r.from_columns.map((c) => fieldOf(a, c));
  const toProps = r.to_columns.map((c) => fieldOf(b, c));
  if (fromProps.includes(null) || toProps.includes(null)) {
    ctx.warn(`${where} joins on a field its datasets do not declare; skipped`);
    return;
  }
  const join = {
    kind: "foreign_key" as const,
    fromProperties: fromProps as string[],
    toProperties: toProps as string[],
  };
  if (rem) {
    // Exported one-to-many links were written from their `to` end.
    const swap = rem.cardinality === "one_to_many";
    spec.linkTypes.push({
      ...rem,
      join: swap
        ? { ...join, fromProperties: join.toProperties, toProperties: join.fromProperties }
        : join,
    });
    return;
  }
  if (r.ai_context !== undefined) ctx.note("relationship ai_context");
  const name = uniqueName(safeMember(r.to), namesOn(spec, a.type), "_");
  const inverseName = uniqueName(plural(memberNameFrom(a.type.name)), namesOn(spec, b.type), "_");
  spec.linkTypes.push({
    name,
    from: a.type.name,
    to: b.type.name,
    inverseName,
    cardinality: "many_to_one",
    join,
  });
}

function applySpecRemainder(spec: OntologySpec, rem: SpecRemainder, ctx: ImportContext): void {
  if (rem.iri) spec.iri = rem.iri;
  if (rem.prefixes) spec.prefixes = rem.prefixes;
  spec.valueTypes = rem.valueTypes ?? [];
  spec.interfaces = rem.interfaces ?? [];
  spec.rules = rem.rules ?? [];
  spec.actionTypes = rem.actionTypes ?? [];
  for (const t of rem.types ?? []) {
    if (findObjectType(spec, t.name))
      ctx.warn(`The type ${t.name} is declared twice; the dataset's is used`);
    else spec.objectTypes.push(t);
  }
  spec.linkTypes.push(...(rem.links ?? []));
  if (rem.order) {
    spec.objectTypes = reorder(spec.objectTypes, (t) => t.name, rem.order.types);
    spec.linkTypes = reorder(spec.linkTypes, linkKey, rem.order.links);
  }
}

// ── Reading an ontology (and its mappings) from another tool ─────────────────

type Leaf = { path: string; dataset: string; field: string };

function mergeOntologies(
  spec: OntologySpec,
  ontologies: OssieOntology[],
  mappings: OssieMapping[],
  bound: Bound[],
  ctx: ImportContext,
): void {
  const concepts = new Map<string, OssieConcept>();
  for (const o of ontologies) {
    for (const c of o.ontology) {
      if (concepts.has(key(c.concept)))
        ctx.warn(`The concept ${c.concept} is declared twice; the first is used`);
      else concepts.set(key(c.concept), c);
    }
    for (const [prefix, iri] of Object.entries(o.prefixes ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(prefix) || iri.length > 500) {
        ctx.warn(
          `The prefix \`${prefix}\` cannot be kept (a prefix is a short name, its IRI at most 500 characters)`,
        );
        continue;
      }
      spec.prefixes = { ...(spec.prefixes ?? {}), [prefix]: iri };
    }
    if (o.requires?.length) ctx.note("constraints on the whole ontology", o.requires.length);
    if (o.ai_context !== undefined) ctx.note("the ontology's ai_context");
  }
  const byConcept = new Map<string, OssieConceptMapping[]>();
  for (const m of mappings) {
    for (const cm of m.concept_mappings)
      byConcept.set(key(cm.concept), [...(byConcept.get(key(cm.concept)) ?? []), cm]);
  }
  const boundByDataset = new Map(bound.map((b) => [key(b.datasetName), b]));
  const boundOf = (t: ObjectType) => bound.find((b) => b.type === t);

  // ── Value types: a datatype with a meaning, based on a built-in ──
  const valueTypeOf = new Map<string, string>();
  const baseOf = (name: string, seen: Set<string>): BaseType | undefined => {
    const builtIn = BASE_OF_BUILT_IN[key(name)];
    if (builtIn) return builtIn;
    const c = concepts.get(key(name));
    if (!c || c.type !== "ValueType" || seen.has(key(name))) return undefined;
    seen.add(key(name));
    for (const s of c.extends ?? []) {
      const b = baseOf(s, seen);
      if (b) return b;
    }
    return undefined;
  };
  for (const c of concepts.values()) {
    if (c.type !== "ValueType") continue;
    let base = baseOf(c.concept, new Set());
    if (!base) {
      ctx.warn(
        `The value type ${c.concept} does not extend a built-in type; it was read as a string`,
      );
      base = "string";
    }
    const name = conceptOk(c.concept);
    if (claimed(spec, name)) {
      ctx.warn(`The value type ${c.concept} has the name of another type; skipped`);
      continue;
    }
    const v: ValueType = prune({
      name,
      base,
      description:
        c.description === undefined ? undefined : clip(c.description, 4000, "descriptions", ctx),
      iri: c.iri === undefined ? undefined : clip(c.iri, 500, "IRIs", ctx),
    });
    readValueConstraints(v, c, ctx);
    if ((c.extends ?? []).some((s) => !BASE_OF_BUILT_IN[key(s)]))
      ctx.note("value types extending value types (each now extends its built-in base)");
    if (c.derived_by?.length) ctx.note("derived value types");
    spec.valueTypes.push(v);
    valueTypeOf.set(key(c.concept), name);
  }
  const roleType = (concept: string): string | undefined =>
    valueTypeOf.get(key(concept)) ?? BASE_OF_BUILT_IN[key(concept)];
  const isValue = (concept: string) => roleType(concept) !== undefined;

  // ── Entity concepts: the dataset each one is, else a type without a table ──
  const entityNames = [
    ...[...concepts.values()].filter((c) => c.type === "EntityType").map((c) => c.concept),
    ...[...byConcept.values()]
      .map((cms) => cms[0].concept)
      .filter((n) => !concepts.has(key(n)) && !isValue(n)),
  ].filter((n) => key(n) !== "any");
  const typeOf = new Map<string, ObjectType>();
  const claimedTypes = new Set<ObjectType>();
  for (const n of entityNames) {
    const t = findObjectType(spec, n) ?? findObjectType(spec, conceptNameFrom(n));
    if (t && boundOf(t) && !claimedTypes.has(t)) {
      typeOf.set(key(n), t);
      claimedTypes.add(t);
    }
  }
  const identity = (conceptKey: string): Leaf[] | null => {
    const om = (byConcept.get(conceptKey) ?? []).flatMap((cm) => cm.object_mappings ?? [])[0];
    return om ? identifierLeaves(om) : null;
  };
  for (const n of entityNames) {
    if (typeOf.has(key(n))) continue;
    // A concept whose identity is read from exactly one dataset that no other
    // concept is named after is that dataset, under the ontology's name.
    const leaves = identity(key(n));
    const sets = new Set((leaves ?? []).map((l) => key(l.dataset)));
    const b = sets.size === 1 ? boundByDataset.get([...sets][0]) : undefined;
    if (b && !claimedTypes.has(b.type) && CONCEPT_NAME.test(n) && !claimed(spec, n)) {
      renameType(spec, b.type, n);
      typeOf.set(key(n), b.type);
      claimedTypes.add(b.type);
    }
  }
  for (const n of entityNames) {
    if (typeOf.has(key(n))) continue;
    const name = conceptOk(n);
    if (claimed(spec, name)) {
      ctx.warn(`The concept ${n} has the name of another type; skipped`);
      continue;
    }
    const t: ObjectType = { name, source: null, primaryKey: [], properties: [], metrics: [] };
    spec.objectTypes.push(t);
    typeOf.set(key(n), t);
  }

  const relOf = (
    conceptKey: string,
    rel: string,
    seen = new Set<string>(),
  ): OssieOntologyRelationship | undefined => {
    const c = concepts.get(conceptKey);
    if (!c || seen.has(conceptKey)) return undefined;
    seen.add(conceptKey);
    const own = (c.relationships ?? []).find((r) => same(r.name, rel));
    if (own) return own;
    for (const s of c.extends ?? []) {
      const r = relOf(key(s), rel, seen);
      if (r) return r;
    }
    return undefined;
  };

  /** The field of this concept's dataset a value relationship reads, by the mapping or by name. */
  const fieldForRel = (conceptKey: string, b: Bound, rel: string): string | undefined => {
    const inOwn = (expr: string | undefined) => {
      const ref = expr === undefined ? null : parseFieldRef(expr);
      return ref && same(ref.dataset, b.datasetName) && b.fields.has(key(ref.field))
        ? key(ref.field)
        : undefined;
    };
    for (const cm of byConcept.get(conceptKey) ?? []) {
      for (const om of cm.object_mappings ?? []) {
        for (const r of om.referent_mappings ?? []) {
          if (same(lastSegment(r.relationship), rel)) {
            const f = inOwn(r.expression);
            if (f) return f;
          }
        }
      }
      const walk = (nodes: OssieLinkMapping[]): string | undefined => {
        for (const n of nodes) {
          if (n.relationship && same(lastSegment(n.relationship), rel)) {
            const f = inOwn(n.object_mapping.expression);
            if (f) return f;
          }
          const deeper = walk(n.children ?? []);
          if (deeper) return deeper;
        }
        return undefined;
      };
      const found = walk(cm.link_mappings ?? []);
      if (found) return found;
    }
    if (b.fields.has(key(rel))) return key(rel);
    const member = memberNameFrom(rel);
    return [...b.fields.entries()].find(([, p]) => p === member)?.[0];
  };

  // ── Keys, properties, mandatory properties ──
  for (const [ck, t] of typeOf) {
    const c = concepts.get(ck);
    if (c) {
      if (!t.description && c.description)
        t.description = clip(c.description, 4000, "descriptions", ctx);
      if (!t.iri && c.iri) t.iri = clip(c.iri, 500, "IRIs", ctx);
      if (c.derived_by?.length) ctx.note("derived concepts");
    }
    const b = boundOf(t);
    const propOfRel = new Map<string, string>();
    if (b) {
      if (!t.primaryKey.length) {
        const leaves = identity(ck);
        const props = leaves?.every((l) => same(l.dataset, b.datasetName))
          ? leaves.map((l) => fieldOf(b, l.field))
          : null;
        if (props?.length && !props.includes(null))
          t.primaryKey = unique(props as string[]).slice(0, 8);
      }
      const unmatched: string[] = [];
      for (const rel of c?.relationships ?? []) {
        const roles = rel.roles ?? [];
        if (roles.length !== 1 || !isValue(roles[0].concept)) continue;
        const f = fieldForRel(ck, b, rel.name);
        const p = f ? t.properties.find((x) => x.name === b.fields.get(f)) : undefined;
        if (!f || !p) {
          unmatched.push(rel.name);
          continue;
        }
        propOfRel.set(key(rel.name), p.name);
        const type = roleType(roles[0].concept) as string;
        const declared = b.datatypes.get(f);
        const declaredBase = declared ? BASE_OF_DATA_TYPE[declared] : undefined;
        const newBase = baseTypeOf(spec, type);
        if (declaredBase && newBase && declaredBase !== newBase)
          ctx.warn(
            `${t.name}.${p.name} is ${declared} in the semantic model and ${roles[0].concept} in the ontology; the ontology's type is used`,
          );
        p.type = type;
        if (!p.description && rel.description)
          p.description = clip(rel.description, 4000, "descriptions", ctx);
        if (!p.iri && rel.iri) p.iri = clip(rel.iri, 500, "IRIs", ctx);
      }
      if (unmatched.length)
        ctx.warn(
          `${t.name}: the ontology's ${list(unmatched)} ${unmatched.length === 1 ? "has" : "have"} no field in the semantic model and ${unmatched.length === 1 ? "was" : "were"} not imported`,
        );
      if (!t.primaryKey.length && c?.identify_by?.length) {
        const props = c.identify_by.map((r) => propOfRel.get(key(r)) ?? null);
        if (!props.includes(null)) t.primaryKey = unique(props as string[]).slice(0, 8);
      }
    } else if (c) {
      const names = new Set<string>();
      for (const rel of c.relationships ?? []) {
        const roles = rel.roles ?? [];
        if (roles.length !== 1 || !isValue(roles[0].concept)) continue;
        const p: OntologyProperty = prune({
          name: uniqueName(safeMember(rel.name), names, "_"),
          type: roleType(roles[0].concept) as string,
          description:
            rel.description === undefined
              ? undefined
              : clip(rel.description, 4000, "descriptions", ctx),
          iri: rel.iri === undefined ? undefined : clip(rel.iri, 500, "IRIs", ctx),
        });
        t.properties.push(p);
        propOfRel.set(key(rel.name), p.name);
      }
      const ids = c.identify_by ?? [];
      t.primaryKey = unique(
        ids.flatMap((r) => (propOfRel.has(key(r)) ? [propOfRel.get(key(r)) as string] : [])),
      ).slice(0, 8);
      if (t.primaryKey.length < ids.length)
        ctx.warn(
          `${t.name} is identified by ${list(ids)}; only the properties among them became its key`,
        );
    }
    for (const r of c?.requires ?? []) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(r);
      const p =
        m && same(m[1], c?.concept ?? "")
          ? t.properties.find((x) => x.name === propOfRel.get(key(m[2])))
          : undefined;
      if (p) p.required = true;
      else ctx.note("constraints on concepts");
    }
    for (const rel of c?.relationships ?? []) {
      const n = (rel.roles ?? []).length;
      if (n === 0) ctx.note("unary relationships");
      else if (n > 1) ctx.note("relationships of three or more roles");
      if (rel.derived_by?.length || rel.requires?.length)
        ctx.note("derivations and constraints on relationships");
    }
  }

  // ── Supertypes ──
  for (const [ck, t] of typeOf) {
    const supers = (concepts.get(ck)?.extends ?? []).filter((s) => typeOf.has(key(s)));
    if (!supers.length || t.extends) continue;
    const s = typeOf.get(key(supers[0])) as ObjectType;
    if (s !== t && !supertypes(spec, s).includes(t)) t.extends = s.name;
    if (supers.length > 1) ctx.note("second and later supertypes");
  }

  // ── Links: an entity relationship whose mapping names a key of both ends ──
  const noTable: string[] = [];
  for (const [ck, t] of typeOf) {
    const b = boundOf(t);
    const c = concepts.get(ck);
    if (!b) {
      for (const rel of c?.relationships ?? []) {
        if ((rel.roles ?? []).length === 1 && !isValue((rel.roles ?? [])[0].concept))
          noTable.push(`${t.name}.${rel.name}`);
      }
      continue;
    }
    const candidates: { rel: string; target?: string; leaves: Leaf[] }[] = [];
    const cms = byConcept.get(ck) ?? [];
    const om0 = cms.flatMap((cm) => cm.object_mappings ?? [])[0];
    for (const r of om0?.referent_mappings ?? []) {
      // An identifier that passes through another entity (a Runway is known
      // by its Airport's code) is also a link to it.
      if (!r.referent_mappings) continue;
      const lv = leavesOf(r.referent_mappings, "");
      if (lv) candidates.push({ rel: lastSegment(r.relationship), leaves: lv });
    }
    for (const cm of cms) {
      for (const top of cm.link_mappings ?? []) {
        if (top.relationship) continue;
        const topLeaves = identifierLeaves(top.object_mapping);
        const fromOwn =
          !!topLeaves?.length && topLeaves.every((l) => same(l.dataset, b.datasetName));
        for (const child of top.children ?? []) {
          if (!child.relationship) continue;
          const player =
            child.object_mapping.concept ?? relOf(ck, child.relationship)?.roles?.[0]?.concept;
          if (!player || isValue(player)) continue;
          const lv = identifierLeaves(child.object_mapping);
          if (!fromOwn || !lv) {
            ctx.note("link mappings this model cannot read as a join");
            continue;
          }
          candidates.push({ rel: lastSegment(child.relationship), target: player, leaves: lv });
          if (child.children?.length) ctx.note("link mappings more than two levels deep");
        }
      }
    }
    const handled = new Set<string>();
    for (const cand of candidates) {
      const rel = relOf(ck, cand.rel);
      const targetName = cand.target ?? rel?.roles?.[0]?.concept;
      handled.add(key(cand.rel));
      const u = targetName ? typeOf.get(key(targetName)) : undefined;
      const ub = u ? boundOf(u) : undefined;
      if (!u || !ub) {
        noTable.push(`${t.name}.${cand.rel}`);
        continue;
      }
      const targetLeaves = identity(key(targetName as string));
      const pairs = cand.leaves.map((s) => {
        const tl = targetLeaves?.find((l) => l.path === s.path && same(l.dataset, ub.datasetName));
        const from = same(s.dataset, b.datasetName) ? fieldOf(b, s.field) : null;
        const to = tl
          ? fieldOf(ub, tl.field)
          : cand.leaves.length === 1 && u.primaryKey.length === 1
            ? u.primaryKey[0]
            : null;
        return { from, to };
      });
      if (pairs.some((p) => !p.from || !p.to)) {
        ctx.warn(
          `${t.name}.${cand.rel}: the mapping does not pair its fields with ${u.name}'s key, so it was not imported as a link`,
        );
        continue;
      }
      const fromProperties = pairs.map((p) => p.from as string);
      const toProperties = pairs.map((p) => p.to as string);
      const existing = spec.linkTypes.find(
        (l) =>
          l.from === t.name &&
          l.to === u.name &&
          l.join.kind === "foreign_key" &&
          sameList(l.join.fromProperties, fromProperties),
      );
      if (existing) {
        enrichLink(existing, rel, ctx);
        continue;
      }
      const name = uniqueName(safeMember(cand.rel), namesOn(spec, t), "_");
      if (name !== safeMember(cand.rel))
        ctx.warn(
          `${t.name}.${cand.rel} became the link \`${name}\`, its name being taken by a property`,
        );
      const link: LinkType = {
        name,
        from: t.name,
        to: u.name,
        cardinality: rel?.multiplicity === "OneToOne" ? "one_to_one" : "many_to_one",
        join: { kind: "foreign_key", fromProperties, toProperties },
      };
      enrichLink(link, rel, ctx);
      spec.linkTypes.push(link);
    }
    // Entity relationships the mapping says nothing about: if the semantic
    // model already joins the same two types one way, that join is this one.
    for (const rel of c?.relationships ?? []) {
      const roles = rel.roles ?? [];
      if (roles.length !== 1 || isValue(roles[0].concept) || handled.has(key(rel.name))) continue;
      const u = typeOf.get(key(roles[0].concept));
      const joins = u ? spec.linkTypes.filter((l) => l.from === t.name && l.to === u.name) : [];
      if (joins.length === 1) enrichLink(joins[0], rel, ctx);
      else if (u && !boundOf(u)) noTable.push(`${t.name}.${rel.name}`);
      else ctx.note("relationships between types with no join in the mapping");
    }
  }
  if (noTable.length)
    ctx.warn(
      `${noTable.length} relationship(s) lead to or from a concept with no table, so they cannot be joined and were not imported: ${list(noTable)}`,
    );
}

function enrichLink(
  link: LinkType,
  rel: OssieOntologyRelationship | undefined,
  ctx: ImportContext,
): void {
  if (!rel) return;
  if (!link.verbalization && rel.verbalizes[0])
    link.verbalization = clip(rel.verbalizes[0], 300, "verbalizations", ctx);
  if (!link.description && rel.description)
    link.description = clip(rel.description, 4000, "descriptions", ctx);
  if (!link.iri && rel.iri) link.iri = clip(rel.iri, 500, "IRIs", ctx);
}

/**
 * Value-type constraints, in the forms the spec's examples use and
 * exportOssie writes: `X == 'a' OR X == 'b'` (or `X IN ('a', 'b')`),
 * `X >= 1`, `1 <= X`, `REGEXP_LIKE(X, '…')`. Anything else is reported.
 */
function readValueConstraints(v: ValueType, c: OssieConcept, ctx: ImportContext): void {
  const n = c.concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lit = String.raw`'(?:[^']|'')*'|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
  const literal = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
  for (const raw of c.requires ?? []) {
    const s = raw.trim();
    const parts = splitOr(s);
    const eq = new RegExp(`^(?:${n}\\s*={1,2}\\s*(${lit})|(${lit})\\s*={1,2}\\s*${n})$`, "i");
    const inList = new RegExp(`^${n}\\s+IN\\s*\\((.*)\\)$`, "i").exec(s);
    let values: string[] | null = null;
    if (parts.every((p) => eq.test(p))) {
      values = parts.map((p) => {
        const m = eq.exec(p) as RegExpExecArray;
        return literal(m[1] ?? m[2]);
      });
    } else if (inList) {
      const items = [...inList[1].matchAll(new RegExp(`\\s*(${lit})\\s*(?:,|$)`, "g"))].map((m) =>
        literal(m[1]),
      );
      if (items.length) values = items;
    }
    if (values) {
      if (v.enum || values.length > 500 || values.some((x) => x.length > 200))
        ctx.note("value-type constraints");
      else v.enum = values;
      continue;
    }
    const pattern = new RegExp(
      `^REGEXP_LIKE\\(\\s*${n}\\s*,\\s*'((?:[^']|'')*)'\\s*\\)$`,
      "i",
    ).exec(s);
    if (pattern && pattern[1].length <= 500) {
      v.pattern = pattern[1].replace(/''/g, "'");
      continue;
    }
    const range =
      new RegExp(`^${n}\\s*(>=|<=|>|<)\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)$`, "i").exec(s) ??
      new RegExp(`^(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*(>=|<=|>|<)\\s*${n}$`, "i").exec(s);
    if (range && NUMERIC.has(v.base)) {
      const nameFirst = /^[A-Za-z_]/.test(s);
      const op = nameFirst ? range[1] : flip(range[2]);
      const num = Number(nameFirst ? range[2] : range[1]);
      if (op === ">=") v.min = num;
      else if (op === "<=") v.max = num;
      else ctx.note("strict bounds (> and <) on value types");
      continue;
    }
    ctx.note("value-type constraints");
  }
}

function flip(op: string): string {
  return { ">=": "<=", "<=": ">=", ">": "<", "<": ">" }[op] ?? op;
}

/** Split on top-level ` OR `, outside string literals. */
function splitOr(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") quoted = !quoted;
    const or = !quoted && /^\s+OR\s+/i.exec(s.slice(i));
    if (or) {
      out.push(cur.trim());
      cur = "";
      i += or[0].length - 1;
      continue;
    }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function identifierLeaves(om: OssieObjectMapping): Leaf[] | null {
  if (om.referent_mappings) return leavesOf(om.referent_mappings, "");
  const ref = om.expression === undefined ? null : parseFieldRef(om.expression);
  return ref ? [{ path: "", ...ref }] : null;
}

/** The plain `dataset.field` leaves of a referent tree, with the relationship path to each. */
function leavesOf(refs: OssieReferentMapping[], prefix: string): Leaf[] | null {
  const out: Leaf[] = [];
  for (const r of refs) {
    const path = `${prefix}${key(lastSegment(r.relationship))}`;
    if (r.expression !== undefined) {
      const ref = parseFieldRef(r.expression);
      if (!ref) return null;
      out.push({ path, ...ref });
    } else if (r.referent_mappings) {
      const sub = leavesOf(r.referent_mappings, `${path}.`);
      if (!sub) return null;
      out.push(...sub);
    }
  }
  return out;
}

/** Relationship names are written both `nr` and `CustOrder.nr` in the spec; the last part is the name. */
function lastSegment(rel: string): string {
  const parts = rel.split(".");
  return parts[parts.length - 1];
}

function renameType(spec: OntologySpec, t: ObjectType, name: string): void {
  const old = t.name;
  t.name = name;
  for (const l of spec.linkTypes) {
    if (same(l.from, old)) l.from = name;
    if (same(l.to, old)) l.to = name;
  }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function readOurs<T>(
  exts: OssieCustomExtension[] | undefined,
  kind: ExtensionKind,
  schema: z.ZodType<T>,
  ctx: ImportContext,
  where: string,
): T | undefined {
  for (const e of exts ?? []) {
    if (e.vendor_name !== AGENTSWARMS_VENDOR) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(e.data);
    } catch {
      ctx.warn(`${where}: its ${AGENTSWARMS_VENDOR} extension is not JSON and was ignored`);
      continue;
    }
    if (!isObject(payload) || payload.agentswarms !== 1 || payload.kind !== kind) continue;
    const r = schema.safeParse(payload);
    if (r.success) return r.data;
    const i = r.error.issues[0];
    ctx.warn(
      `${where}: its ${AGENTSWARMS_VENDOR} extension is not valid (${i.path.join(".")}: ${i.message}) and was ignored`,
    );
  }
  return undefined;
}

function readAI(
  ai: OssieAIContext | undefined,
  kind: "type" | "member",
  ctx: ImportContext,
): { aiInstructions?: string; synonyms?: string[] } {
  if (ai === undefined) return {};
  if (typeof ai === "string") {
    if (kind === "type") return { aiInstructions: clip(ai, 4000, "AI instructions", ctx) };
    // A string on a field reads like the spec's own example, "orders, purchases, sales".
    const parts = ai
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length && parts.length <= 50 && parts.every((p) => p.length <= 100))
      return { synonyms: parts };
    ctx.note("free-text ai_context on fields and metrics");
    return {};
  }
  const out: { aiInstructions?: string; synonyms?: string[] } = {};
  if (ai.synonyms) {
    const ok = ai.synonyms.filter((s) => s.length >= 1 && s.length <= 100);
    if (ok.length < ai.synonyms.length || ok.length > 50)
      ctx.note("synonyms (empty, over 100 characters, or past the 50th)");
    out.synonyms = ok.slice(0, 50);
  }
  if (ai.instructions !== undefined) {
    if (kind === "type") out.aiInstructions = clip(ai.instructions, 4000, "AI instructions", ctx);
    else ctx.note("ai_context instructions on fields and metrics");
  }
  if (ai.examples?.length) ctx.note("ai_context examples", ai.examples.length);
  if (Object.keys(ai).some((k) => !["instructions", "synonyms", "examples"].includes(k)))
    ctx.note("other ai_context keys");
  return out;
}

function expressionCandidates(expr: OssieExpression): { text: string; dialect: string }[] {
  const out: { text: string; dialect: string }[] = [];
  if (expr.sql !== undefined) out.push({ text: expr.sql, dialect: OSSIE_PORTABLE_DIALECT });
  const ranked = (expr.dialects ?? [])
    .filter((d) => SQL_DIALECTS.includes(d.dialect.toUpperCase()))
    .sort(
      (a, b) =>
        SQL_DIALECTS.indexOf(a.dialect.toUpperCase()) -
        SQL_DIALECTS.indexOf(b.dialect.toUpperCase()),
    );
  for (const d of ranked) out.push({ text: d.expression, dialect: d.dialect.toUpperCase() });
  return out;
}

function dialectsOf(expr: OssieExpression): string {
  return list((expr.dialects ?? []).map((d) => d.dialect)) || "no dialect";
}

function noteDialect(dialect: string, ctx: ImportContext): void {
  if (dialect !== OSSIE_PORTABLE_DIALECT && dialect !== "ANSI_SQL")
    ctx.warn(
      `Some expressions were read from the ${dialect} dialect; check them against this lakehouse's SQL`,
    );
}

/** A column name written as a bare identifier or a double-quoted one; null for anything else. */
function readIdent(text: string): string | null {
  const s = text.trim();
  if (PLAIN_IDENT.test(s)) return CORE_KEYWORDS.has(s.toLowerCase()) ? null : s;
  const q = /^"([^"]+)"$/.exec(s);
  return q ? q[1] : null;
}

function sqlIdent(name: string): string {
  return PLAIN_IDENT.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(name);
}

/** `DATASET.field`, either part optionally double-quoted. */
function parseFieldRef(expr: string): { dataset: string; field: string } | null {
  const part = String.raw`("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;
  const m = new RegExp(`^\\s*${part}\\s*\\.\\s*${part}\\s*$`).exec(expr);
  if (!m) return null;
  const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s);
  return { dataset: unq(m[1]), field: unq(m[2]) };
}

/**
 * Replace each `qualifier.name` outside string literals with what `resolve`
 * returns (null keeps it). expr.ts refuses dots, so Ossie's model-level
 * `store_sales.amount` has to become `amount` before anything else reads it.
 */
function rewriteQualified(
  text: string,
  resolve: (qualifier: string, name: string) => string | null,
): { text: string } {
  const ident = /^(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'"))
        j += text[j] === "'" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\d/.test(ch)) {
      const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i)) as RegExpExecArray;
      out += num[0];
      i += num[0].length;
      continue;
    }
    const first = ident.exec(text.slice(i));
    if (!first) {
      out += ch;
      i++;
      continue;
    }
    const after = /^\s*\.\s*/.exec(text.slice(i + first[0].length));
    const second = after ? ident.exec(text.slice(i + first[0].length + after[0].length)) : null;
    if (after && second) {
      const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s);
      const r = resolve(unq(first[0]), unq(second[0]));
      const whole = first[0] + after[0] + second[0];
      out += r === null ? whole : sqlIdent(r);
      i += whole.length;
      continue;
    }
    out += first[0];
    i += first[0].length;
  }
  return { text: out };
}

/** Rename field references to property names, when reading changed any. */
function renameFields(text: string, b: Bound): string {
  const renamed = [...b.fields].some(([f, p]) => f !== key(p));
  if (!renamed) return text;
  try {
    return compileExpr(text, (n) => b.fields.get(key(n)) ?? n);
  } catch {
    return text;
  }
}

/** The `schema.table` of `db.schema.table` (or `schema.table`); null for a query or a bare name. */
function tableOf(source: string, where: string, ctx: ImportContext): string | null {
  const part = String.raw`(?:"[^"]+"|[A-Za-z0-9_$]+)`;
  const ok = new RegExp(`^\\s*${part}(?:\\s*\\.\\s*${part})*\\s*$`).test(source);
  const parts = ok
    ? (source.match(new RegExp(part, "g")) ?? []).map((p) =>
        p.startsWith('"') ? p.slice(1, -1) : p,
      )
    : [];
  const table = parts.slice(-2).join(".");
  if (parts.length < 2 || !TABLE_REF.test(table)) {
    ctx.warn(
      `${where} reads \`${short(source)}\`, which is not a schema.table name; the type was left without a table`,
    );
    return null;
  }
  return table;
}

function claimed(spec: OntologySpec, name: string): boolean {
  return (
    (BASE_TYPES as readonly string[]).includes(key(name)) ||
    !!findObjectType(spec, name) ||
    !!findValueType(spec, name) ||
    spec.interfaces.some((i) => same(i.name, name))
  );
}

function conceptOk(raw: string): string {
  return CONCEPT_NAME.test(raw) ? raw : conceptNameFrom(raw);
}

function uniqueConcept(spec: OntologySpec, base: string): string {
  const b = conceptOk(base);
  if (!claimed(spec, b)) return b;
  for (let i = 2; ; i++) {
    const n = `${b.slice(0, 64 - String(i).length)}${i}`;
    if (!claimed(spec, n)) return n;
  }
}

/** Names already used on a type: its properties, its links, and links' inverse names into it. */
function namesOn(spec: OntologySpec, t: ObjectType): Set<string> {
  return new Set([
    ...allProperties(spec, t).map((p) => p.name),
    ...spec.linkTypes.filter((l) => same(l.from, t.name)).map((l) => l.name),
    ...spec.linkTypes
      .filter((l) => same(l.to, t.name) && l.inverseName)
      .map((l) => l.inverseName as string),
  ]);
}

/** `base`, else `base_2`, `base_3`…, recorded in `taken` (compared case-insensitively). */
function uniqueName(base: string, taken: Set<string>, sep: string): string {
  const lower = new Set([...taken].map(key));
  let name = base.slice(0, 64);
  for (let i = 2; lower.has(key(name)); i++) {
    const suffix = `${sep}${i}`;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

function plural(member: string): string {
  if (/[^aeiou]y$/.test(member)) return `${member.slice(0, -1)}ies`.slice(0, 64);
  if (/(s|x|z|ch|sh)$/.test(member)) return `${member}es`.slice(0, 64);
  return `${member}s`.slice(0, 64);
}

function reorder<T>(items: T[], keyOf: (x: T) => string, order: string[]): T[] {
  const at = new Map(order.map((k, i) => [key(k), i]));
  return items
    .map((x, i) => ({ x, i, o: at.get(key(keyOf(x))) ?? order.length + i }))
    .sort((a, b) => a.o - b.o)
    .map((e) => e.x);
}

function linkKey(l: LinkType): string {
  return `${l.from}.${l.name}`;
}

function clip(s: string, max: number, what: string, ctx: ImportContext): string {
  if (s.length <= max) return s;
  ctx.note(`the end of ${what} longer than ${max} characters`);
  return s.slice(0, max);
}

function short(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function words(member: string): string {
  return member.replace(/_/g, " ");
}

function list(items: string[]): string {
  return items.join(", ");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function key(s: string): string {
  return s.toLowerCase();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function orUndefined<T>(items: T[]): T[] | undefined {
  return items.length ? items : undefined;
}

function nonEmpty<K extends string, T>(k: K, items: T[]): Partial<Record<K, T[]>> {
  return (items.length ? { [k]: items } : {}) as Partial<Record<K, T[]>>;
}

/** Drop `undefined` keys, recursively, so a document holds only what was said. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => prune(v)) as T;
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = prune(v);
    return out as T;
  }
  return value;
}
