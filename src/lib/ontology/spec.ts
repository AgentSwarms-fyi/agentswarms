// Enterprise Ontology: the model, as one versioned document.
//
// An ontology describes the business in its own words: the kinds of things it
// deals in (object types: Customer, Order, Shipment), what each one is known
// by (properties), how they relate (link types: an Order is placed by a
// Customer), what is measured about them (metrics), what must always be true
// (rules), and what people and agents may do to them (action types).
//
// Every object type is BOUND to a lakehouse table, so the model is not a
// drawing: an object set is a query, a link is a join, a metric is an
// aggregate and a rule is a check, all compiled from this document and run
// through the governed lakehouse path (src/lib/ontology/compile.ts). Nothing
// is copied out of the lakehouse to make the ontology work.
//
// The whole model is one JSON document so that it can be versioned as a unit
// (a published version is an immutable snapshot), diffed (diff.ts), proposed
// as a change and reviewed, and exchanged as Apache Ossie documents
// (ossie.ts). Names follow two conventions, enforced here, because they are
// how expressions, links and exports refer to things:
//
//   - concepts (object types, value types, interfaces) are PascalCase, the way
//     Ossie names concepts: `Customer`, `EmailAddress`;
//   - members (properties, metrics, links, actions) are snake_case, the way
//     columns are usually named: `customer_id`, `total_revenue`, `placed_by`.
import { z } from "zod";

export const ONTOLOGY_SPEC_VERSION = 1 as const;

/** The scalar types a property can have. Ossie's DataType vocabulary, minus Time and Opaque. */
export const BASE_TYPES = [
  "string",
  "integer",
  "decimal",
  "float",
  "boolean",
  "date",
  "datetime",
  "timestamp",
] as const;
export type BaseType = (typeof BASE_TYPES)[number];

export const CARDINALITIES = ["many_to_one", "one_to_one", "one_to_many", "many_to_many"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

export const TYPE_STATUSES = ["draft", "certified", "deprecated"] as const;
export type TypeStatus = (typeof TYPE_STATUSES)[number];

/**
 * How sensitive a property is. `restricted` values are masked for everyone but
 * the ontology's owner, in every surface that reads objects (explorer, object
 * view, graph, agent tools, exports of sample data).
 */
export const SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const RULE_KINDS = [
  "required",
  "unique",
  "pattern",
  "range",
  "allowed_values",
  "referential",
  "predicate",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ACTION_KINDS = ["modify", "create", "delete"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** What an agent may do with an action type: nothing, ask a person, or do it. */
export const AGENT_MODES = ["none", "propose", "execute"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const METRIC_FORMATS = ["number", "integer", "currency", "percent"] as const;
export type MetricFormat = (typeof METRIC_FORMATS)[number];

/** Icons an object type can wear on the canvas; keys of ONTOLOGY_ICONS in the UI. */
export const TYPE_ICONS = [
  "box",
  "user",
  "users",
  "building",
  "shopping-cart",
  "package",
  "truck",
  "file-text",
  "credit-card",
  "map-pin",
  "calendar",
  "tag",
  "factory",
  "briefcase",
  "heart-pulse",
  "plane",
  "server",
  "globe",
] as const;
export type TypeIcon = (typeof TYPE_ICONS)[number];

/** Colours, as palette slots the UI maps to theme-aware tokens. */
export const TYPE_COLORS = [
  "teal",
  "indigo",
  "amber",
  "rose",
  "violet",
  "emerald",
  "sky",
  "slate",
] as const;
export type TypeColor = (typeof TYPE_COLORS)[number];

export const CONCEPT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
export const MEMBER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A lakehouse table, `schema.table`, unquoted identifiers. */
export const TABLE_REF = /^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,126}$/;
/** A physical column name: anything printable without a double quote. */
// Control characters are what this excludes, so the class has to name them.
// eslint-disable-next-line no-control-regex
export const COLUMN_NAME = /^[^"\u0000-\u001f]{1,128}$/;

const text = (max: number) => z.string().max(max);
const conceptName = z.string().regex(CONCEPT_NAME, "PascalCase, starting with a capital letter");
const memberName = z.string().regex(MEMBER_NAME, "snake_case, starting with a lowercase letter");
const iri = z.string().min(1).max(500);
const synonyms = z.array(z.string().min(1).max(100)).max(50);

export const valueTypeSchema = z.object({
  name: conceptName,
  base: z.enum(BASE_TYPES),
  description: text(4000).optional(),
  /** Allowed values, compared as strings. */
  enum: z.array(z.string().max(200)).min(1).max(500).optional(),
  /** A regular expression every value must match in full. */
  pattern: z.string().min(1).max(500).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Unit of measure, shown next to values: "USD", "minutes", "kg". */
  unit: z.string().min(1).max(40).optional(),
  iri: iri.optional(),
});
export type ValueType = z.infer<typeof valueTypeSchema>;

export const propertySchema = z.object({
  name: memberName,
  label: text(120).optional(),
  description: text(4000).optional(),
  /** A base type, or the name of one of this ontology's value types. */
  type: z.string().min(1).max(64),
  /** The column of the bound table this property reads. */
  column: z.string().regex(COLUMN_NAME).optional(),
  /** Or a derived value: a scalar SQL expression over the table's columns. */
  expression: z.string().min(1).max(2000).optional(),
  required: z.boolean().optional(),
  sensitivity: z.enum(SENSITIVITIES).optional(),
  synonyms: synonyms.optional(),
  iri: iri.optional(),
});
export type OntologyProperty = z.infer<typeof propertySchema>;

export const metricSchema = z.object({
  name: memberName,
  label: text(120).optional(),
  description: text(4000).optional(),
  /** An aggregate over this type's property names: `SUM(amount)`, `COUNT(*)`. */
  expression: z.string().min(1).max(2000),
  format: z.enum(METRIC_FORMATS).optional(),
  synonyms: synonyms.optional(),
  certified: z.boolean().optional(),
});
export type OntologyMetric = z.infer<typeof metricSchema>;

export const objectTypeSchema = z.object({
  name: conceptName,
  label: text(120).optional(),
  pluralLabel: text(120).optional(),
  description: text(4000).optional(),
  synonyms: synonyms.optional(),
  /** Told to the model that answers questions about this type. */
  aiInstructions: text(4000).optional(),
  icon: z.enum(TYPE_ICONS).optional(),
  color: z.enum(TYPE_COLORS).optional(),
  status: z.enum(TYPE_STATUSES).optional(),
  domain: z.string().min(1).max(80).optional(),
  /** A supertype whose properties this one inherits. */
  extends: conceptName.optional(),
  interfaces: z.array(conceptName).max(20).optional(),
  /** Where the objects come from. Null for an abstract type nothing is bound to. */
  source: z
    .object({
      table: z.string().regex(TABLE_REF, "schema.table"),
      /** Only the rows that are this type: a SQL predicate over the table's columns. */
      filter: z.string().min(1).max(2000).optional(),
    })
    .nullable(),
  /** The properties that identify one object. */
  primaryKey: z.array(memberName).max(8),
  /** The property shown as an object's name. */
  titleProperty: memberName.optional(),
  properties: z.array(propertySchema).max(500),
  metrics: z.array(metricSchema).max(200),
  iri: iri.optional(),
  /** Where the type sits on the model canvas. */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type ObjectType = z.infer<typeof objectTypeSchema>;

export const linkJoinSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("foreign_key"),
    /** Properties of the `from` type… */
    fromProperties: z.array(memberName).min(1).max(8),
    /** …equal, position by position, to these of the `to` type. */
    toProperties: z.array(memberName).min(1).max(8),
  }),
  z.object({
    kind: z.literal("join_table"),
    table: z.string().regex(TABLE_REF, "schema.table"),
    /** Join-table columns that hold the `from` object's key… */
    fromColumns: z.array(z.string().regex(COLUMN_NAME)).min(1).max(8),
    /** …which equal these properties of the `from` type. */
    fromProperties: z.array(memberName).min(1).max(8),
    toColumns: z.array(z.string().regex(COLUMN_NAME)).min(1).max(8),
    toProperties: z.array(memberName).min(1).max(8),
  }),
]);
export type LinkJoin = z.infer<typeof linkJoinSchema>;

export const linkTypeSchema = z.object({
  /** How the `from` side reads it: an Order is `placed_by` a Customer. */
  name: memberName,
  from: conceptName,
  to: conceptName,
  label: text(120).optional(),
  /** How the `to` side reads it: a Customer's `orders`. */
  inverseName: memberName.optional(),
  inverseLabel: text(120).optional(),
  cardinality: z.enum(CARDINALITIES),
  description: text(4000).optional(),
  /** A sentence with placeholders: "{Order} is placed by {Customer}". */
  verbalization: text(300).optional(),
  join: linkJoinSchema,
  iri: iri.optional(),
});
export type LinkType = z.infer<typeof linkTypeSchema>;

export const interfaceSchema = z.object({
  name: conceptName,
  description: text(4000).optional(),
  properties: z
    .array(
      z.object({
        name: memberName,
        type: z.string().min(1).max(64),
        description: text(1000).optional(),
      }),
    )
    .max(100),
});
export type OntologyInterface = z.infer<typeof interfaceSchema>;

export const ruleSchema = z.object({
  id: z.string().regex(RULE_ID),
  name: text(200).min(1),
  /** The rule in words: what people read and what agents are told. */
  statement: text(1000).min(1),
  objectType: conceptName,
  kind: z.enum(RULE_KINDS),
  property: memberName.optional(),
  link: memberName.optional(),
  /** For `predicate`: SQL over property names that must hold for every object. */
  predicate: z.string().min(1).max(2000).optional(),
  pattern: z.string().min(1).max(500).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(z.string().max(200)).min(1).max(500).optional(),
  severity: z.enum(SEVERITIES),
  enabled: z.boolean(),
});
export type OntologyRule = z.infer<typeof ruleSchema>;

export const actionTypeSchema = z.object({
  name: memberName,
  label: text(120).optional(),
  description: text(2000).optional(),
  objectType: conceptName,
  kind: z.enum(ACTION_KINDS),
  /** Each parameter sets one property of the object. */
  parameters: z
    .array(
      z.object({
        name: memberName,
        property: memberName,
        label: text(120).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(50),
  /** Submission criteria: SQL over the object's property names that must hold before it runs. */
  criteria: z.string().min(1).max(2000).optional(),
  requiresApproval: z.boolean(),
  agentMode: z.enum(AGENT_MODES),
});
export type ActionType = z.infer<typeof actionTypeSchema>;

export const ontologySpecSchema = z.object({
  specVersion: z.literal(ONTOLOGY_SPEC_VERSION),
  name: z.string().trim().min(1).max(200),
  description: text(8000).optional(),
  iri: iri.optional(),
  prefixes: z
    .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/), z.string().max(500))
    .optional(),
  valueTypes: z.array(valueTypeSchema).max(500),
  interfaces: z.array(interfaceSchema).max(200),
  objectTypes: z.array(objectTypeSchema).max(1000),
  linkTypes: z.array(linkTypeSchema).max(3000),
  rules: z.array(ruleSchema).max(2000),
  actionTypes: z.array(actionTypeSchema).max(500),
  /** Ossie custom_extensions carried through import and export untouched. */
  extensions: z
    .array(z.object({ vendor: z.string().min(1).max(100), data: z.string().max(100_000) }))
    .max(100)
    .optional(),
});
export type OntologySpec = z.infer<typeof ontologySpecSchema>;

export function emptySpec(name: string, description?: string): OntologySpec {
  return {
    specVersion: ONTOLOGY_SPEC_VERSION,
    name,
    ...(description ? { description } : {}),
    valueTypes: [],
    interfaces: [],
    objectTypes: [],
    linkTypes: [],
    rules: [],
    actionTypes: [],
  };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function findObjectType(spec: OntologySpec, name: string): ObjectType | undefined {
  return spec.objectTypes.find((t) => same(t.name, name));
}

export function findValueType(spec: OntologySpec, name: string): ValueType | undefined {
  return spec.valueTypes.find((v) => same(v.name, name));
}

export function findLink(spec: OntologySpec, name: string, from?: string): LinkType | undefined {
  return spec.linkTypes.find((l) => same(l.name, name) && (!from || same(l.from, from)));
}

/** The base type a property's declared type resolves to (a value type's base, or itself). */
export function baseTypeOf(spec: OntologySpec, type: string): BaseType | undefined {
  if ((BASE_TYPES as readonly string[]).includes(type)) return type as BaseType;
  return findValueType(spec, type)?.base;
}

/** The chain of supertypes, nearest first, stopping at a cycle. */
export function supertypes(spec: OntologySpec, type: ObjectType): ObjectType[] {
  const out: ObjectType[] = [];
  const seen = new Set([type.name.toLowerCase()]);
  let cur = type.extends ? findObjectType(spec, type.extends) : undefined;
  while (cur && !seen.has(cur.name.toLowerCase())) {
    out.push(cur);
    seen.add(cur.name.toLowerCase());
    cur = cur.extends ? findObjectType(spec, cur.extends) : undefined;
  }
  return out;
}

/**
 * Every property an object of this type has: its own, then each supertype's
 * that it does not redeclare. A subtype bound to its own table maps inherited
 * properties onto its own columns by redeclaring them; one that is not
 * redeclared reads the supertype's column of the same name.
 */
export function allProperties(spec: OntologySpec, type: ObjectType): OntologyProperty[] {
  const out = [...type.properties];
  const have = new Set(out.map((p) => p.name));
  for (const sup of supertypes(spec, type)) {
    for (const p of sup.properties) {
      if (!have.has(p.name)) {
        out.push(p);
        have.add(p.name);
      }
    }
  }
  return out;
}

export function findProperty(
  spec: OntologySpec,
  type: ObjectType,
  name: string,
): OntologyProperty | undefined {
  return allProperties(spec, type).find((p) => same(p.name, name));
}

/** Links that touch a type, with the direction they are read in from it. */
export function linksOf(
  spec: OntologySpec,
  typeName: string,
): { link: LinkType; direction: "forward" | "inverse"; other: string }[] {
  const out: { link: LinkType; direction: "forward" | "inverse"; other: string }[] = [];
  for (const link of spec.linkTypes) {
    if (same(link.from, typeName)) out.push({ link, direction: "forward", other: link.to });
    if (same(link.to, typeName)) out.push({ link, direction: "inverse", other: link.from });
  }
  return out;
}

/** The name a link is read by from one side: its own name forward, its inverse name back. */
export function linkReading(link: LinkType, direction: "forward" | "inverse"): string {
  return direction === "forward" ? link.name : (link.inverseName ?? `${link.name}_of`);
}

/** Cardinality as seen walking the link in a direction. */
export function cardinalityWalking(link: LinkType, direction: "forward" | "inverse"): Cardinality {
  if (direction === "forward") return link.cardinality;
  switch (link.cardinality) {
    case "many_to_one":
      return "one_to_many";
    case "one_to_many":
      return "many_to_one";
    default:
      return link.cardinality;
  }
}

/** True when walking the link reaches at most one object: safe to aggregate through. */
export function walksToOne(link: LinkType, direction: "forward" | "inverse"): boolean {
  const c = cardinalityWalking(link, direction);
  return c === "many_to_one" || c === "one_to_one";
}

export type ReachStep = { link: string; direction: "forward" | "inverse" };

/**
 * Every bound type reachable from `typeName` by to-one steps (each object has
 * at most one at every step), up to `depth` steps, in walking order. These
 * are the groupings a metric of `typeName` can use without double counting.
 * A step straight back over the link just taken (Order → Shipment → Order)
 * only returns to what was already reachable, so it is not taken.
 */
export function toOneReach(
  spec: OntologySpec,
  typeName: string,
  depth = 2,
): { path: ReachStep[]; type: string; via: string }[] {
  const out: { path: ReachStep[]; type: string; via: string }[] = [];
  const visit = (
    at: string,
    path: ReachStep[],
    via: string,
    d: number,
    came?: { link: string; direction: "forward" | "inverse" },
  ) => {
    if (d > 0) out.push({ path, type: at, via });
    if (d >= depth) return;
    for (const { link, direction, other } of linksOf(spec, at)) {
      if (!walksToOne(link, direction)) continue;
      if (came && came.link === link.name && came.direction !== direction) continue;
      if (!findObjectType(spec, other)?.source) continue;
      visit(
        other,
        [...path, { link: linkReading(link, direction), direction }],
        `${via} → ${other}`,
        d + 1,
        { link: link.name, direction },
      );
    }
  };
  visit(typeName, [], typeName, 0);
  return out;
}

export function titleOf(type: ObjectType): string {
  return type.label?.trim() || splitCamel(type.name);
}

export function pluralTitleOf(type: ObjectType): string {
  if (type.pluralLabel?.trim()) return type.pluralLabel.trim();
  const t = titleOf(type);
  if (/[^aeiou]y$/i.test(t)) return t.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(t)) return t + "es";
  return t + "s";
}

export function propertyTitle(p: { name: string; label?: string }): string {
  return p.label?.trim() || p.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function splitCamel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** PascalCase from any table or phrase: `sales_orders` → `SalesOrder` (singular). */
export function conceptNameFrom(raw: string): string {
  const words = raw
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "Thing";
  const last = singular(words[words.length - 1]);
  const all = [...words.slice(0, -1), last]
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  const name = /^[A-Z]/.test(all) ? all : `T${all}`;
  return name.slice(0, 64);
}

/** snake_case from any column name: `Customer ID` → `customer_id`. */
export function memberNameFrom(raw: string): string {
  const s = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const name = /^[a-z]/.test(s) ? s : `c_${s || "value"}`;
  return name.slice(0, 64);
}

export function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(xes|ches|shes|sses)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/** The SQL type a base type is cast to when a value is written. */
export function sqlTypeOf(base: BaseType): string {
  switch (base) {
    case "string":
      return "VARCHAR";
    case "integer":
      return "BIGINT";
    case "decimal":
      return "DECIMAL(38, 9)";
    case "float":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "datetime":
      return "TIMESTAMP";
    case "timestamp":
      return "TIMESTAMPTZ";
  }
}

/** The base type a lakehouse column type reads as. */
export function baseTypeFromSql(sqlType: string): BaseType {
  const t = sqlType.toUpperCase();
  if (
    /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|INT\d)/.test(
      t,
    )
  )
    return "integer";
  if (/^(DECIMAL|NUMERIC)/.test(t)) return "decimal";
  if (/^(DOUBLE|FLOAT|REAL)/.test(t)) return "float";
  if (/^BOOL/.test(t)) return "boolean";
  if (/^DATE$/.test(t)) return "date";
  if (/^TIMESTAMP( WITH TIME ZONE|TZ)/.test(t)) return "timestamp";
  if (/^(TIMESTAMP|DATETIME)/.test(t)) return "datetime";
  return "string";
}
