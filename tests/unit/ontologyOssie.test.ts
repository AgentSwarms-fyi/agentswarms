// Apache Ossie import and export (src/lib/ontology/ossie.ts, ossieSchema.ts).
//
// Three kinds of evidence, each against something this repo did not write:
//
//   - the zod mirrors against Ossie's own JSON Schemas, vendored unmodified in
//     tests/fixtures/ossie: the same enums, the same const version, the same
//     required keys and the same strictness, so a drift on either side fails
//     here rather than as a file another tool refuses;
//   - the importer against Ossie's own examples (TPC-DS, and the flights
//     semantic model + ontology + mapping trio), which must become a model
//     validateSpec accepts;
//   - the exporter against Ossie's own semantic checks (the ones
//     validation/validate.py runs beyond the schema), re-implemented below
//     independently of ossie.ts, and against itself: what it writes must
//     read back as the model it was given.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { checkExpr } from "@/lib/ontology/expr";
import {
  AGENTSWARMS_VENDOR,
  exportOssie,
  importOssie,
  OssieExportError,
} from "@/lib/ontology/ossie";
import {
  detectOssieKind,
  OSSIE_BUILT_IN_CONCEPTS,
  OSSIE_CONCEPT_TYPES,
  OSSIE_DATA_TYPES,
  OSSIE_MULTIPLICITIES,
  OSSIE_VERSION,
  ossieAIContextSchema,
  ossieConceptMappingSchema,
  ossieConceptSchema,
  ossieCustomExtensionSchema,
  ossieDatasetSchema,
  ossieDialectExpressionSchema,
  ossieDimensionSchema,
  ossieDocumentReferenceSchema,
  ossieExpressionSchema,
  ossieFieldSchema,
  ossieLinkMappingObject,
  ossieMappingSchema,
  ossieMetricSchema,
  ossieObjectMappingObject,
  ossieOntologyMapSchema,
  ossieOntologyRelationshipSchema,
  ossieOntologySchema,
  ossieReferentMappingObject,
  ossieRelationshipSchema,
  ossieRoleSchema,
  ossieSemanticModelSchema,
  parseOssieMapping,
  parseOssieOntology,
  parseOssieSemanticModel,
  type OssieMapping,
  type OssieOntology,
  type OssieReferentMapping,
  type OssieSemanticModel,
} from "@/lib/ontology/ossieSchema";
import {
  findObjectType,
  findValueType,
  ontologySpecSchema,
  type OntologySpec,
} from "@/lib/ontology/spec";
import { validateSpec } from "@/lib/ontology/validate";

const FIXTURES = "tests/fixtures/ossie";
const text = (file: string) => readFileSync(`${FIXTURES}/${file}`, "utf8");
const load = (file: string) => yaml.load(text(file), { schema: yaml.CORE_SCHEMA });

type JsonSchema = {
  properties?: Record<string, { const?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  $defs?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
};
const jsonSchema = (file: string) => JSON.parse(text(file)) as JsonSchema;
const CORE = jsonSchema("ossie-schema.json");
const ONTOLOGY = jsonSchema("ontology.json");
const MAPPING = jsonSchema("mapping.json");

const EXAMPLES = {
  tpcds: "tpcds_semantic_model.yaml",
  flightsModel: "flights.semantic_model.yaml",
  flightsOntology: "flights.ontology.yaml",
  flightsMapping: "flights.mapping.yaml",
};
const FLIGHTS = [EXAMPLES.flightsModel, EXAMPLES.flightsOntology, EXAMPLES.flightsMapping];

function errorsOf(spec: OntologySpec) {
  return validateSpec(spec).issues.filter((i) => i.level === "error");
}

// ── The mirrors against Ossie's JSON Schemas ─────────────────────────────────

type Shaped = { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> };
type Internals = { _zod: { def: { catchall?: { _zod: { def: { type: string } } } } } };

/** The keys a mirror declares, and which of them it requires (undefined is refused). */
function keysOf(schema: unknown) {
  const shape = (schema as Shaped).shape;
  const keys = Object.keys(shape).sort();
  const required = keys.filter((k) => !shape[k].safeParse(undefined).success).sort();
  return { keys, required };
}

function strict(schema: unknown): boolean {
  return (schema as Internals)._zod.def.catchall?._zod.def.type === "never";
}

/** Each mirrored object and the JSON Schema object it mirrors. */
const PAIRS: [string, JsonSchema, unknown][] = [
  ["core root", CORE, ossieSemanticModelSchema],
  ["core CustomExtension", CORE.$defs!.CustomExtension, ossieCustomExtensionSchema],
  ["core DialectExpression", CORE.$defs!.DialectExpression, ossieDialectExpressionSchema],
  ["core Expression", CORE.$defs!.Expression, ossieExpressionSchema],
  ["core Dimension", CORE.$defs!.Dimension, ossieDimensionSchema],
  ["core Field", CORE.$defs!.Field, ossieFieldSchema],
  ["core Dataset", CORE.$defs!.Dataset, ossieDatasetSchema],
  ["core Relationship", CORE.$defs!.Relationship, ossieRelationshipSchema],
  ["core Metric", CORE.$defs!.Metric, ossieMetricSchema],
  ["ontology root", ONTOLOGY, ossieOntologySchema],
  ["ontology OntologyComponent", ONTOLOGY.$defs!.OntologyComponent, ossieConceptSchema],
  ["ontology Relationship", ONTOLOGY.$defs!.Relationship, ossieOntologyRelationshipSchema],
  ["ontology Role", ONTOLOGY.$defs!.Role, ossieRoleSchema],
  ["ontology ConceptMapping", ONTOLOGY.$defs!.ConceptMapping, ossieConceptMappingSchema],
  ["ontology ObjectMapping", ONTOLOGY.$defs!.ObjectMapping, ossieObjectMappingObject],
  ["ontology ReferentMapping", ONTOLOGY.$defs!.ReferentMapping, ossieReferentMappingObject],
  ["ontology LinkMapping", ONTOLOGY.$defs!.LinkMapping, ossieLinkMappingObject],
  ["ontology OntologyMap", ONTOLOGY.$defs!.OntologyMap, ossieOntologyMapSchema],
  ["mapping root", MAPPING, ossieMappingSchema],
  ["mapping DocumentReference", MAPPING.$defs!.DocumentReference, ossieDocumentReferenceSchema],
];

describe("the zod mirrors match Ossie's JSON Schemas", () => {
  it("has the same enums and the same const version", () => {
    expect([...OSSIE_DATA_TYPES]).toEqual(CORE.$defs!.DataType.enum);
    expect([...OSSIE_CONCEPT_TYPES]).toEqual(ONTOLOGY.$defs!.ConceptType.enum);
    expect([...OSSIE_MULTIPLICITIES]).toEqual(ONTOLOGY.$defs!.Multiplicity.enum);
    for (const s of [CORE, ONTOLOGY, MAPPING])
      expect(s.properties!.version.const).toBe(OSSIE_VERSION);
    // …and the schemas really use those lists, not copies that could drift.
    expect(ossieFieldSchema.shape.datatype.unwrap().options).toEqual([...OSSIE_DATA_TYPES]);
    expect(ossieConceptSchema.shape.type.options).toEqual([...OSSIE_CONCEPT_TYPES]);
    expect(ossieOntologyRelationshipSchema.shape.multiplicity.unwrap().options).toEqual([
      ...OSSIE_MULTIPLICITIES,
    ]);
  });

  it.each(PAIRS)("%s: same keys, same required keys, same strictness", (_name, json, mirror) => {
    const { keys, required } = keysOf(mirror);
    expect(keys).toEqual(Object.keys(json.properties ?? {}).sort());
    expect(required).toEqual([...(json.required ?? [])].sort());
    expect(strict(mirror)).toBe(json.additionalProperties === false);
  });

  it("leaves the object form of ai_context open, as the schema does", () => {
    const objectForm = CORE.$defs!.AIContext.oneOf!.find((s) => s.properties);
    expect(objectForm?.additionalProperties).toBe(true);
    expect(ossieAIContextSchema.safeParse({ synonyms: ["a"], vendor_hint: { x: 1 } }).success).toBe(
      true,
    );
    expect(ossieAIContextSchema.safeParse("orders, purchases").success).toBe(true);
    expect(ossieAIContextSchema.safeParse({ synonyms: "not a list" }).success).toBe(false);
  });

  it("knows Ossie's built-in concepts", () => {
    // The ontology spec lists them in prose only; this pins the list it was read from.
    expect([...OSSIE_BUILT_IN_CONCEPTS].sort()).toEqual(
      ["Any", "Boolean", "Date", "DateTime", "Decimal", "Float", "Integer", "String"].sort(),
    );
  });
});

describe("the mirrors accept Ossie's examples and refuse what Ossie refuses", () => {
  it("parses every official example as the kind it is", () => {
    expect(detectOssieKind(load(EXAMPLES.tpcds))).toBe("semantic_model");
    expect(detectOssieKind(load(EXAMPLES.flightsModel))).toBe("semantic_model");
    expect(detectOssieKind(load(EXAMPLES.flightsOntology))).toBe("ontology");
    expect(detectOssieKind(load(EXAMPLES.flightsMapping))).toBe("mapping");
    expect(parseOssieSemanticModel(load(EXAMPLES.tpcds))).toMatchObject({ ok: true });
    expect(parseOssieSemanticModel(load(EXAMPLES.flightsModel))).toMatchObject({ ok: true });
    expect(parseOssieOntology(load(EXAMPLES.flightsOntology))).toMatchObject({ ok: true });
    expect(parseOssieMapping(load(EXAMPLES.flightsMapping))).toMatchObject({ ok: true });
  });

  it("refuses an unknown key, with the path to it", () => {
    const doc = load(EXAMPLES.tpcds) as OssieSemanticModel;
    const bad = structuredClone(doc) as unknown as {
      datasets: { fields: Record<string, unknown>[] }[];
    };
    bad.datasets[1].fields[0].primary_keys = ["x"];
    const r = parseOssieSemanticModel(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe("datasets[1].fields[0]");
  });

  it("refuses the pre-0.2 wrapper, another version, and an expression with nothing in it", () => {
    const doc = load(EXAMPLES.flightsModel) as OssieSemanticModel;
    const { version: _v, ...model } = doc;
    expect(detectOssieKind({ semantic_model: [model] })).toBeNull();
    expect(parseOssieSemanticModel({ ...doc, version: "0.1.1" }).ok).toBe(false);
    expect(ossieExpressionSchema.safeParse({}).success).toBe(false);
    expect(ossieExpressionSchema.safeParse({ sql: "amount" }).success).toBe(true);
    expect(ossieConceptMappingSchema.safeParse({ concept: "X" }).success).toBe(false);
  });
});

// ── Importing Ossie's examples ───────────────────────────────────────────────

describe("importing the TPC-DS example", () => {
  const { spec, warnings } = importOssie([text(EXAMPLES.tpcds)]);

  it("becomes a valid model", () => {
    expect(ontologySpecSchema.safeParse(spec).success).toBe(true);
    expect(errorsOf(spec)).toEqual([]);
  });

  it("has a type per dataset, a link per relationship, and the metrics one dataset can hold", () => {
    expect(spec.name).toBe("tpcds_retail_model");
    expect(spec.objectTypes.map((t) => t.name)).toEqual([
      "StoreSale",
      "DateDim",
      "Customer",
      "Item",
      "Store",
    ]);
    expect(spec.objectTypes.map((t) => t.source?.table)).toEqual([
      "public.store_sales",
      "public.date_dim",
      "public.customer",
      "public.item",
      "public.store",
    ]);
    const doc = load(EXAMPLES.tpcds) as OssieSemanticModel;
    spec.objectTypes.forEach((t, i) =>
      expect(t.properties.map((p) => p.name)).toEqual(doc.datasets[i].fields!.map((f) => f.name)),
    );
    expect(spec.linkTypes.map((l) => `${l.from}.${l.name} -> ${l.to}`)).toEqual([
      "StoreSale.date_dim -> DateDim",
      "StoreSale.customer -> Customer",
      "StoreSale.item -> Item",
      "StoreSale.store -> Store",
    ]);
    expect(spec.linkTypes.every((l) => l.inverseName === "store_sales")).toBe(true);
    // One dataset-scoped metric, and the three model-level ones that name only store_sales.
    const sale = findObjectType(spec, "StoreSale")!;
    expect(sale.metrics.map((m) => [m.name, m.expression])).toEqual([
      ["total_quantity", "SUM(ss_quantity)"],
      ["total_sales", "SUM(ss_ext_sales_price)"],
      ["total_profit", "SUM(ss_net_profit)"],
      ["sales_by_brand", "SUM(ss_ext_sales_price)"],
    ]);
    expect(spec.objectTypes.reduce((n, t) => n + t.metrics.length, 0)).toBe(4);
  });

  it("reads types, keys, derived fields and synonyms", () => {
    const customer = findObjectType(spec, "Customer")!;
    expect(customer.primaryKey).toEqual(["c_customer_sk"]);
    const full = customer.properties.find((p) => p.name === "customer_full_name")!;
    expect(full).toMatchObject({
      type: "string",
      expression: "c_first_name || ' ' || c_last_name",
    });
    expect(full.column).toBeUndefined();
    expect(findObjectType(spec, "DateDim")!.properties.find((p) => p.name === "d_date")?.type).toBe(
      "date",
    );
    expect(findObjectType(spec, "StoreSale")!.synonyms).toContain("POS data");
    expect(spec.objectTypes[0].aiInstructions).toBeUndefined();
  });

  it("says which model-level metrics span datasets instead of guessing a home", () => {
    for (const m of [
      "customer_lifetime_value",
      "store_productivity",
      "cumulative_sales",
      "brand_rank_in_store",
      "monthly_sales_change",
    ]) {
      expect(warnings.some((w) => w.includes(m) && w.includes("spans"))).toBe(true);
    }
  });

  it("keeps the other vendors' extensions, byte for byte", () => {
    const doc = load(EXAMPLES.tpcds) as OssieSemanticModel;
    expect(spec.extensions).toEqual(
      doc.custom_extensions!.map((e) => ({ vendor: e.vendor_name, data: e.data })),
    );
  });
});

describe("importing the flights semantic model, ontology and mapping", () => {
  const { spec, warnings } = importOssie(FLIGHTS.map(text));
  const ontology = load(EXAMPLES.flightsOntology) as OssieOntology;

  it("becomes a valid model", () => {
    expect(ontologySpecSchema.safeParse(spec).success).toBe(true);
    expect(errorsOf(spec)).toEqual([]);
    expect(spec.name).toBe("Flights");
  });

  it("binds each dataset to its concept, keyed the way the mapping identifies it", () => {
    const keys = Object.fromEntries(
      spec.objectTypes.filter((t) => t.source).map((t) => [t.name, t.primaryKey]),
    );
    expect(keys).toEqual({
      Runway: ["designator", "airport_code"],
      Aircraft: ["tail_nr"],
      Airport: ["code"],
      Flight: ["id"],
      Carrier: ["code"],
      Route: ["id"],
    });
    // Concepts with no dataset of their own are types without a table.
    expect(
      spec.objectTypes
        .filter((t) => !t.source)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["CancelationReason", "City", "Manufacturer", "Market", "Model", "State"].sort());
  });

  it("reads every value type, with its base and its constraints", () => {
    const valueConcepts = ontology.ontology.filter((c) => c.type === "ValueType");
    expect(spec.valueTypes.map((v) => v.name)).toEqual(valueConcepts.map((c) => c.concept));
    expect(findValueType(spec, "Capacity")?.base).toBe("integer"); // Capacity → NrPounds → Integer
    expect(findValueType(spec, "Delay")?.base).toBe("decimal");
    expect(findValueType(spec, "CancelationCode")).toMatchObject({
      base: "string",
      enum: ["A", "B", "C", "D"],
    });
    expect(findValueType(spec, "DegreesLatitude")).toMatchObject({ min: -90, max: 90 });
    expect(findValueType(spec, "DistanceGroup")).toMatchObject({
      base: "integer",
      min: 1,
      max: 10,
    });
  });

  it("types each field by the relationship the mapping reads it for", () => {
    const prop = (type: string, name: string) =>
      findObjectType(spec, type)!.properties.find((p) => p.name === name);
    expect(prop("Runway", "length")?.type).toBe("RunwayLength");
    expect(prop("Aircraft", "serial_nr")?.type).toBe("SerialNr"); // relationship serial_number
    expect(prop("Aircraft", "nr_seats")?.type).toBe("integer"); // played by the built-in Integer
    expect(prop("Flight", "departure")?.type).toBe("datetime"); // departs_at
    expect(prop("Flight", "date")?.type).toBe("date");
    expect(prop("Airport", "latitude")).toMatchObject({ type: "DegreesLatitude", required: true });
    expect(prop("Airport", "longitude")?.required).toBe(true);
  });

  it("joins the concepts whose keys the mapping pairs, and says why the rest are not links", () => {
    expect(spec.linkTypes.map((l) => `${l.from}.${l.name} -> ${l.to}`).sort()).toEqual(
      [
        "Runway.airport -> Airport",
        "Aircraft.carrier -> Carrier",
        "Flight.route -> Route",
        "Flight.aircraft -> Aircraft",
        "Flight.operated_by -> Carrier",
        "Route.destination -> Airport",
        "Route.departure -> Airport",
      ].sort(),
    );
    const departure = spec.linkTypes.find((l) => l.from === "Route" && l.name === "departure")!;
    expect(departure).toMatchObject({
      cardinality: "many_to_one",
      verbalization: "{Route} connects to departure- {Airport}",
      join: { kind: "foreign_key", fromProperties: ["orig_airport_code"], toProperties: ["code"] },
    });
    expect(warnings.some((w) => w.includes("Aircraft.model") && w.includes("no table"))).toBe(true);
  });

  it("reads the deprecated single-file form the same way", () => {
    const model = load(EXAMPLES.flightsModel) as OssieSemanticModel;
    const mapping = load(EXAMPLES.flightsMapping) as OssieMapping;
    const embedded = {
      ...ontology,
      ontology_mappings: [
        { name: mapping.name, semantic_model: model, concept_mappings: mapping.concept_mappings },
      ],
    };
    const r = importOssie([JSON.stringify(embedded)]);
    expect(r.spec).toEqual(spec);
    expect(r.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  it("still imports the semantic model alone, saying which types need a key", () => {
    const r = importOssie([text(EXAMPLES.flightsModel)]);
    expect(r.spec.objectTypes).toHaveLength(6);
    expect(r.warnings.some((w) => w.includes("Runway declares no key"))).toBe(true);
    expect(findObjectType(r.spec, "Flight")!.primaryKey).toEqual(["id"]);
  });
});

describe("importing something that is not quite Ossie", () => {
  it("never throws, and says what it skipped", () => {
    const r = importOssie(["{ not: [valid", "just text", "name: x\nfoo: 1\n"]);
    expect(r.spec.objectTypes).toEqual([]);
    expect(r.warnings).toHaveLength(3);
  });

  it("reads the pre-0.2 semantic_model list as one document per model", () => {
    const doc = load(EXAMPLES.tpcds) as OssieSemanticModel;
    const { version: _v, ...model } = doc;
    const r = importOssie([yaml.dump({ semantic_model: [model] })]);
    expect(r.spec.objectTypes).toHaveLength(5);
    expect(r.warnings.some((w) => w.includes("pre-0.2"))).toBe(true);
  });

  it("keeps an expression it cannot run as written, and says so, rather than guess", () => {
    const model = {
      version: OSSIE_VERSION,
      name: "people",
      datasets: [
        {
          name: "people",
          source: "hr.public.people",
          primary_key: ["id"],
          fields: [
            { name: "id", expression: { sql: "id" } },
            { name: "First Name", expression: { sql: "SPLIT_PART(full_name, ' ', 1)" } },
            // Only a vendor's own language: nothing here can read DAX.
            {
              name: "badge",
              expression: { dialects: [{ dialect: "DAX", expression: "[Badge]" }] },
            },
            {
              name: "email",
              expression: {
                dialects: [
                  { dialect: "MDX", expression: "[Email]" },
                  { dialect: "ANSI_SQL", expression: '"E-mail"' },
                ],
              },
            },
          ],
          metrics: [{ name: "headcount", expression: { sql: "COUNT(DISTINCT people.id)" } }],
        },
      ],
    };
    const r = importOssie([JSON.stringify(model)]);
    const t = r.spec.objectTypes[0];
    expect(t.source).toEqual({ table: "public.people" });
    const prop = (n: string) => t.properties.find((p) => p.name === n);
    expect(prop("first_name")?.expression).toBe("SPLIT_PART(full_name, ' ', 1)");
    expect(prop("badge")).toEqual({ name: "badge", type: "string" });
    expect(prop("email")?.column).toBe("E-mail");
    // A dataset-scoped metric that qualifies its own dataset reads the same unqualified.
    expect(t.metrics[0].expression).toBe("COUNT(DISTINCT id)");
    const w = r.warnings.join("\n");
    expect(w).toMatch(/First Name.*kept as written/);
    expect(w).toMatch(/badge is written only in DAX/);
    expect(w).toMatch(/became the property `first_name`/);
    // The kept expression is an error validateSpec shows, not a silent NULL.
    expect(errorsOf(r.spec).map((e) => e.path)).toEqual([
      "objectTypes.People.properties.first_name",
    ]);
  });
});

// ── Exporting, and reading back what was exported ────────────────────────────

/** A model that uses every part of the spec: each part has to survive the trip. */
function richSpec(): OntologySpec {
  return {
    specVersion: 1,
    name: "Sales",
    description: "Orders, the customers who place them and the people who sell to them.",
    iri: "https://example.com/ontology/sales",
    prefixes: { ex: "https://example.com/ns#" },
    valueTypes: [
      {
        name: "Money",
        base: "decimal",
        description: "An amount of money.",
        min: 0,
        unit: "USD",
        iri: "ex:Money",
      },
      { name: "OrderStatus", base: "string", enum: ["open", "shipped", "it's complicated"] },
      { name: "Sku", base: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
      { name: "Percent", base: "float", min: 0, max: 100 },
      {
        name: "EventTime",
        base: "timestamp",
        description: "When something happened, with its zone.",
      },
    ],
    interfaces: [
      {
        name: "Auditable",
        description: "Knows when it was created.",
        properties: [{ name: "created_at", type: "datetime" }],
      },
    ],
    objectTypes: [
      {
        name: "Party",
        description: "Anyone the business deals with.",
        interfaces: ["Auditable"],
        source: null,
        primaryKey: ["party_id"],
        properties: [
          { name: "party_id", type: "string", column: "party_id" },
          { name: "name", type: "string", column: "name", required: true },
          { name: "created_at", type: "datetime", column: "created_at" },
        ],
        metrics: [],
      },
      {
        name: "Customer",
        label: "Customer",
        pluralLabel: "Customers",
        description: "A party that buys.",
        synonyms: ["client", "buyer"],
        aiInstructions: "A customer is found by its party id.",
        icon: "user",
        color: "teal",
        status: "certified",
        domain: "Sales",
        extends: "Party",
        source: { table: "sales.customers" },
        primaryKey: ["party_id"],
        titleProperty: "name",
        properties: [
          { name: "name", type: "string", column: "customer_name", description: "Trading name" },
          { name: "segment", type: "string", column: "segment", synonyms: ["tier"] },
          {
            name: "email",
            type: "string",
            column: "email",
            sensitivity: "restricted",
            iri: "ex:email",
          },
          { name: "created_at", type: "datetime", description: "Inherits Party's column." },
          { name: "account_manager_id", type: "integer", column: "account_manager_id" },
        ],
        metrics: [
          { name: "customer_count", expression: "COUNT(*)", format: "integer", certified: true },
        ],
        iri: "ex:Customer",
        position: { x: 120, y: 80 },
      },
      {
        name: "Order",
        description: "A request to buy.",
        source: { table: "sales.orders", filter: "status <> 'void'" },
        primaryKey: ["order_id"],
        properties: [
          { name: "order_id", type: "string", column: "order_id" },
          { name: "customer_id", type: "string", column: "customer_id", required: true },
          { name: "status", type: "OrderStatus", column: "status" },
          { name: "amount", type: "Money", column: "amount", label: "Amount" },
          { name: "amount_with_tax", type: "decimal", expression: "amount * 1.2" },
          { name: "placed_at", type: "EventTime", column: "placed at" },
          { name: "notes", type: "string", column: "notes", sensitivity: "restricted" },
          // Derived, though it reads like a column: it must not come back as one.
          { name: "channel", type: "string", expression: "source_channel" },
        ],
        metrics: [
          {
            name: "total_amount",
            label: "Total amount",
            description: "Sum of order amounts.",
            expression: "SUM(amount)",
            format: "currency",
            synonyms: ["revenue"],
            certified: true,
          },
          { name: "order_count", expression: "COUNT(*)", format: "integer" },
        ],
      },
      {
        name: "OrderLine",
        description: "One product on an order.",
        source: { table: "sales.order_lines" },
        primaryKey: ["order_id", "line_no"],
        properties: [
          { name: "order_id", type: "string", column: "order_id" },
          { name: "line_no", type: "integer", column: "line_no" },
          { name: "sku", type: "Sku", column: "sku" },
          { name: "quantity", type: "integer", column: "quantity", required: true },
          { name: "unit_price", type: "Money", column: "unit_price" },
          { name: "discount_pct", type: "Percent", column: "discount" },
        ],
        metrics: [],
      },
      {
        name: "Product",
        description: "Something sold.",
        source: { table: "sales.products" },
        primaryKey: ["sku"],
        properties: [
          { name: "sku", type: "Sku", column: "sku" },
          { name: "title", type: "string", column: "title" },
          { name: "launched_on", type: "date", column: "launched_on" },
          { name: "active", type: "boolean", column: "active" },
          { name: "weight", type: "float", column: "weight_kg" },
        ],
        metrics: [],
      },
      {
        name: "Employee",
        description: "Someone who works here.",
        source: { table: "hr.employees" },
        primaryKey: ["employee_id"],
        properties: [
          { name: "employee_id", type: "integer", column: "employee_id" },
          { name: "manager_id", type: "integer", column: "manager_id" },
          { name: "sort_order", type: "integer", column: "order" },
        ],
        metrics: [],
      },
    ],
    linkTypes: [
      {
        name: "placed_by",
        from: "Order",
        to: "Customer",
        label: "is placed by",
        inverseName: "orders",
        inverseLabel: "placed",
        cardinality: "many_to_one",
        description: "Who placed the order.",
        verbalization: "{Order} is placed by {Customer}",
        join: { kind: "foreign_key", fromProperties: ["customer_id"], toProperties: ["party_id"] },
        iri: "ex:placedBy",
      },
      {
        // One-to-many with different names on each side, so reading the
        // relationship back the wrong way round cannot go unnoticed.
        name: "purchases",
        from: "Customer",
        to: "Order",
        cardinality: "one_to_many",
        join: { kind: "foreign_key", fromProperties: ["party_id"], toProperties: ["customer_id"] },
      },
      {
        name: "lines",
        from: "Order",
        to: "OrderLine",
        inverseName: "order",
        cardinality: "one_to_many",
        join: { kind: "foreign_key", fromProperties: ["order_id"], toProperties: ["order_id"] },
      },
      {
        name: "product",
        from: "OrderLine",
        to: "Product",
        inverseName: "order_lines",
        cardinality: "many_to_one",
        join: { kind: "foreign_key", fromProperties: ["sku"], toProperties: ["sku"] },
      },
      {
        name: "products",
        from: "Order",
        to: "Product",
        cardinality: "many_to_many",
        join: {
          kind: "join_table",
          table: "sales.order_lines",
          fromColumns: ["order_id"],
          fromProperties: ["order_id"],
          toColumns: ["sku"],
          toProperties: ["sku"],
        },
      },
      {
        name: "manager",
        from: "Employee",
        to: "Employee",
        inverseName: "reports",
        cardinality: "many_to_one",
        join: {
          kind: "foreign_key",
          fromProperties: ["manager_id"],
          toProperties: ["employee_id"],
        },
      },
      {
        name: "account_manager",
        from: "Customer",
        to: "Employee",
        cardinality: "one_to_one",
        join: {
          kind: "foreign_key",
          fromProperties: ["account_manager_id"],
          toProperties: ["employee_id"],
        },
      },
    ],
    rules: [
      {
        id: "order-amount-positive",
        name: "Amounts are not negative",
        statement: "An order's amount is zero or more.",
        objectType: "Order",
        kind: "predicate",
        predicate: "amount >= 0",
        severity: "critical",
        enabled: true,
      },
      {
        id: "customer-email-unique",
        name: "One customer per email",
        statement: "No two customers share an email address.",
        objectType: "Customer",
        kind: "unique",
        property: "email",
        severity: "warning",
        enabled: true,
      },
      {
        id: "sku-format",
        name: "SKU format",
        statement: "A SKU is three letters, a dash and four digits.",
        objectType: "Product",
        kind: "pattern",
        property: "sku",
        pattern: "^[A-Z]{3}-\\d{4}$",
        severity: "warning",
        enabled: false,
      },
      {
        id: "quantity-range",
        name: "Sensible quantities",
        statement: "A line orders between 1 and 1000 units.",
        objectType: "OrderLine",
        kind: "range",
        property: "quantity",
        min: 1,
        max: 1000,
        severity: "info",
        enabled: true,
      },
      {
        id: "order-has-customer",
        name: "Orders have customers",
        statement: "Every order's customer exists.",
        objectType: "Order",
        kind: "referential",
        link: "placed_by",
        severity: "critical",
        enabled: true,
      },
    ],
    actionTypes: [
      {
        name: "create_order",
        label: "Create order",
        objectType: "Order",
        kind: "create",
        parameters: [
          { name: "order_id", property: "order_id", required: true },
          { name: "customer", property: "customer_id", required: true },
          { name: "amount", property: "amount" },
        ],
        criteria: "amount > 0",
        requiresApproval: true,
        agentMode: "propose",
      },
      {
        name: "mark_shipped",
        objectType: "Order",
        kind: "modify",
        parameters: [{ name: "status", property: "status" }],
        requiresApproval: false,
        agentMode: "execute",
      },
    ],
    extensions: [{ vendor: "DBT", data: '{"project_name":"sales"}' }],
  };
}

// Ossie's own semantic checks (validation/validate.py at 89e2e17: §2.10 and
// §3.8 of the reference), written from that description, not from ossie.ts.

const lower = (s: string) => s.toLowerCase();
const dupes = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i);

function coreProblems(doc: OssieSemanticModel): string[] {
  const out: string[] = [];
  const fieldsOf = new Map(
    doc.datasets.map((d) => [d.name, new Set((d.fields ?? []).map((f) => lower(f.name)))]),
  );
  out.push(...dupes(doc.datasets.map((d) => d.name)).map((n) => `duplicate dataset ${n}`));
  for (const d of doc.datasets) {
    const fields = (d.fields ?? []).map((f) => f.name);
    const metrics = (d.metrics ?? []).map((m) => m.name);
    out.push(...dupes(fields).map((n) => `duplicate field ${d.name}.${n}`));
    out.push(...dupes(metrics).map((n) => `duplicate metric ${d.name}.${n}`));
    out.push(
      ...fields.filter((f) => metrics.includes(f)).map((n) => `field and metric ${d.name}.${n}`),
    );
    const declared = fieldsOf.get(d.name)!;
    for (const k of [...(d.primary_key ?? []), ...(d.unique_keys ?? []).flat()])
      if (!declared.has(lower(k))) out.push(`${d.name} key names undeclared field ${k}`);
    // Dataset scope: only this dataset's declared fields, unqualified. The
    // tokenizer refuses a dot, so a qualified reference fails here too.
    for (const m of d.metrics ?? []) {
      for (const e of [
        m.expression.sql,
        ...(m.expression.dialects ?? []).map((x) => x.expression),
      ]) {
        if (e === undefined) continue;
        const c = checkExpr(e, "aggregate", [...declared]);
        if (!c.ok) out.push(`metric ${d.name}.${m.name}: ${c.error}`);
      }
    }
  }
  out.push(
    ...dupes((doc.metrics ?? []).map((m) => m.name)).map((n) => `duplicate model metric ${n}`),
  );
  out.push(
    ...dupes((doc.relationships ?? []).map((r) => r.name)).map(
      (n) => `duplicate relationship ${n}`,
    ),
  );
  for (const r of doc.relationships ?? []) {
    const from = fieldsOf.get(r.from);
    const to = fieldsOf.get(r.to);
    if (!from || !to) {
      out.push(`relationship ${r.name} joins an unknown dataset`);
      continue;
    }
    if (r.from_columns.length !== r.to_columns.length) out.push(`relationship ${r.name} arity`);
    for (const c of r.from_columns)
      if (!from.has(lower(c))) out.push(`${r.name} from_columns ${c}`);
    for (const c of r.to_columns) if (!to.has(lower(c))) out.push(`${r.name} to_columns ${c}`);
  }
  return out;
}

const BUILT_INS = new Set<string>(OSSIE_BUILT_IN_CONCEPTS);

function ontologyProblems(o: OssieOntology): string[] {
  const out: string[] = [];
  const names = o.ontology.map((c) => c.concept);
  out.push(...dupes(names).map((n) => `duplicate concept ${n}`));
  const byName = new Map(o.ontology.map((c) => [c.concept, c]));
  const known = (n: string) => byName.has(n) || BUILT_INS.has(n);
  const relsOf = (n: string, seen = new Set<string>()): string[] => {
    const c = byName.get(n);
    if (!c || seen.has(n)) return [];
    seen.add(n);
    return [
      ...(c.relationships ?? []).map((r) => r.name),
      ...(c.extends ?? []).flatMap((s) => relsOf(s, seen)),
    ];
  };
  const qname = (iri?: string) => {
    if (!iri || !iri.includes(":")) return;
    const [prefix, local] = [iri.slice(0, iri.indexOf(":")), iri.slice(iri.indexOf(":") + 1)];
    if (local.startsWith("//") || local.includes(":") || ["http", "https", "urn"].includes(prefix))
      return;
    if (!(prefix in (o.prefixes ?? {}))) out.push(`undeclared prefix ${prefix}`);
  };
  for (const c of o.ontology) {
    out.push(
      ...dupes((c.relationships ?? []).map((r) => r.name)).map(
        (n) => `${c.concept}: duplicate ${n}`,
      ),
    );
    for (const s of c.extends ?? []) if (!known(s)) out.push(`${c.concept} extends unknown ${s}`);
    for (const id of c.identify_by ?? [])
      if (!relsOf(c.concept).includes(id)) out.push(`${c.concept} identify_by unknown ${id}`);
    qname(c.iri);
    for (const r of c.relationships ?? []) {
      for (const role of r.roles ?? [])
        if (!known(role.concept)) out.push(`${c.concept}.${r.name} role unknown ${role.concept}`);
      qname(r.iri);
    }
  }
  // No concept extends itself, however indirectly.
  const visit = (n: string, path: string[]): void => {
    if (path.includes(n)) {
      out.push(`cycle ${[...path, n].join(" -> ")}`);
      return;
    }
    for (const s of byName.get(n)?.extends ?? []) visit(s, [...path, n]);
  };
  for (const n of names) visit(n, []);
  return out;
}

/** What a mapping names must exist: the documents, concepts, relationships, datasets and fields. */
function mappingProblems(m: OssieMapping, model: OssieSemanticModel, o: OssieOntology): string[] {
  const out: string[] = [];
  if (m.ontology_ref.name !== o.name) out.push("ontology_ref does not name the ontology");
  if (m.semantic_model_ref.name !== model.name)
    out.push("semantic_model_ref does not name the model");
  const concepts = new Map(o.ontology.map((c) => [c.concept, c]));
  const rel = (
    concept: string,
    name: string,
    seen = new Set<string>(),
  ): { roles?: { concept: string }[] } | undefined => {
    const c = concepts.get(concept);
    if (!c || seen.has(concept)) return undefined;
    seen.add(concept);
    return (
      (c.relationships ?? []).find((r) => r.name === name) ??
      (c.extends ?? []).map((s) => rel(s, name, seen)).find(Boolean)
    );
  };
  const fields = new Map(
    model.datasets.map((d) => [d.name, new Set((d.fields ?? []).map((f) => f.name))]),
  );
  const fieldRef = (e: string) => {
    const part = String.raw`("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`;
    const x = new RegExp(`^${part}\\.${part}$`).exec(e);
    const unq = (s: string) => s.replace(/^"|"$/g, "");
    if (!x || !fields.get(unq(x[1]))?.has(unq(x[2])))
      out.push(`expression ${e} is not a declared dataset.field`);
  };
  const referents = (concept: string, refs: OssieReferentMapping[]) => {
    for (const r of refs) {
      const found = rel(concept, r.relationship);
      if (!found) out.push(`${concept} has no relationship ${r.relationship}`);
      if (r.expression !== undefined) fieldRef(r.expression);
      if (r.referent_mappings) referents(found?.roles?.[0]?.concept ?? "?", r.referent_mappings);
    }
  };
  for (const cm of m.concept_mappings) {
    if (!concepts.has(cm.concept)) out.push(`unknown concept ${cm.concept}`);
    for (const om of cm.object_mappings ?? []) referents(cm.concept, om.referent_mappings ?? []);
    for (const top of cm.link_mappings ?? []) {
      referents(cm.concept, top.object_mapping.referent_mappings ?? []);
      for (const child of top.children ?? []) {
        if (!child.relationship || !rel(cm.concept, child.relationship))
          out.push(`${cm.concept} link mapping names unknown relationship ${child.relationship}`);
        const target = child.object_mapping.concept ?? "?";
        if (child.object_mapping.expression !== undefined)
          fieldRef(child.object_mapping.expression);
        referents(target, child.object_mapping.referent_mappings ?? []);
      }
    }
  }
  return out;
}

describe("exporting a model that uses everything", () => {
  const spec = richSpec();
  const exported = exportOssie(spec, { catalog: "lake" });

  it("starts from a valid model", () => {
    expect(ontologySpecSchema.safeParse(spec).success).toBe(true);
    expect(errorsOf(spec)).toEqual([]);
  });

  it("writes three documents Ossie's schemas accept, as objects and as YAML", () => {
    expect(parseOssieSemanticModel(exported.semanticModel)).toMatchObject({ ok: true });
    expect(parseOssieOntology(exported.ontology)).toMatchObject({ ok: true });
    expect(parseOssieMapping(exported.mapping)).toMatchObject({ ok: true });
    const fromYaml = (s: string) => yaml.load(s, { schema: yaml.CORE_SCHEMA });
    expect(fromYaml(exported.yaml.semanticModel)).toEqual(exported.semanticModel);
    expect(fromYaml(exported.yaml.ontology)).toEqual(exported.ontology);
    expect(fromYaml(exported.yaml.mapping)).toEqual(exported.mapping);
    expect(detectOssieKind(exported.mapping)).toBe("mapping");
  });

  it("passes Ossie's own semantic checks", () => {
    expect(coreProblems(exported.semanticModel)).toEqual([]);
    expect(ontologyProblems(exported.ontology)).toEqual([]);
    expect(mappingProblems(exported.mapping, exported.semanticModel, exported.ontology)).toEqual(
      [],
    );
  });

  it("and so do the official examples, which keeps the checks honest", () => {
    const model = load(EXAMPLES.flightsModel) as OssieSemanticModel;
    const ontology = load(EXAMPLES.flightsOntology) as OssieOntology;
    expect(coreProblems(load(EXAMPLES.tpcds) as OssieSemanticModel)).toEqual([]);
    expect(ontologyProblems(ontology)).toEqual([]);
    // The flights mapping uses `FLIGHT.id WHERE (…)` for its unary links,
    // which is not a plain field: exactly those two, and nothing else.
    expect(mappingProblems(load(EXAMPLES.flightsMapping) as OssieMapping, model, ontology)).toEqual(
      [
        "expression FLIGHT.id WHERE ( FLIGHT.diverted == TRUE ) is not a declared dataset.field",
        "expression FLIGHT.id WHERE ( FLIGHT.cancelled == TRUE ) is not a declared dataset.field",
      ],
    );
  });

  it("says natively what Ossie can say", () => {
    const sm = exported.semanticModel;
    expect(sm.datasets.map((d) => [d.name, d.source])).toEqual([
      ["customer", "lake.sales.customers"],
      ["order", "lake.sales.orders"],
      ["order_line", "lake.sales.order_lines"],
      ["product", "lake.sales.products"],
      ["employee", "lake.hr.employees"],
    ]);
    const order = sm.datasets[1];
    const field = (name: string) => order.fields!.find((f) => f.name === name)!;
    expect(field("placed_at")).toMatchObject({
      expression: { sql: '"placed at"' },
      datatype: "DateTimeTz",
      dimension: { is_time: true },
    });
    expect(field("amount_with_tax").expression).toEqual({ sql: "amount * 1.2" });
    expect(field("amount").datatype).toBe("Decimal");
    expect(order.metrics!.map((m) => m.expression.sql)).toEqual(["SUM(amount)", "COUNT(*)"]);
    // The supertype's key is a field of the subtype's dataset: Ossie has no inheritance.
    const customer = sm.datasets[0];
    expect(customer.primary_key).toEqual(["party_id"]);
    expect(customer.fields!.map((f) => f.name)).toContain("party_id");
    expect(customer.unique_keys).toEqual([["email"]]);
    expect(customer.ai_context).toEqual({
      instructions: "A customer is found by its party id.",
      synonyms: ["client", "buyer"],
    });
    // A one-to-many link is the same join written from its many side.
    expect(sm.relationships!.find((r) => r.name === "order_lines")).toMatchObject({
      from: "order_line",
      to: "order",
      from_columns: ["order_id"],
      to_columns: ["order_id"],
    });
    expect(sm.relationships!.some((r) => r.name.includes("products"))).toBe(false);
    expect(sm.custom_extensions!.find((e) => e.vendor_name === "DBT")?.data).toBe(
      '{"project_name":"sales"}',
    );

    const concept = (n: string) => exported.ontology.ontology.find((c) => c.concept === n)!;
    expect(concept("OrderStatus").requires).toEqual([
      "OrderStatus == 'open' OR OrderStatus == 'shipped' OR OrderStatus == 'it''s complicated'",
    ]);
    expect(concept("Sku").requires).toEqual(["REGEXP_LIKE(Sku, '^[A-Z]{3}-\\d{4}$')"]);
    expect(concept("Percent").requires).toEqual(["Percent >= 0", "Percent <= 100"]);
    expect(concept("EventTime").extends).toEqual(["DateTime"]);
    expect(concept("Customer").extends).toEqual(["Party"]);
    expect(concept("Party").extends).toEqual(["Auditable"]);
    expect(concept("Order").requires).toEqual(["Order.customer_id"]);
    const placedBy = concept("Order").relationships!.find((r) => r.name === "placed_by")!;
    expect(placedBy).toMatchObject({
      roles: [{ concept: "Customer" }],
      multiplicity: "ManyToOne",
      verbalizes: ["{Order} is placed by {Customer}", "{Customer} placed {Order}"],
    });
    expect(concept("Order").relationships!.find((r) => r.name === "amount")).toMatchObject({
      roles: [{ concept: "Money", name: "amount" }],
      verbalizes: ["{Order} has {Money:amount}"],
    });
    expect(concept("Employee").relationships!.find((r) => r.name === "manager")!.roles).toEqual([
      { concept: "Employee", name: "manager" },
    ]);
    expect(
      concept("Order").relationships!.find((r) => r.name === "lines")!.multiplicity,
    ).toBeUndefined();
  });

  it("warns about each thing other tools will not see", () => {
    const w = exported.warnings.join("\n");
    expect(w).toMatch(/Order\.products goes through the join table/);
    expect(w).toMatch(/Party has no table/);
    expect(w).toMatch(/Customer\.email, Order\.notes are restricted/);
    expect(w).toMatch(/Order reads only the rows where/);
    expect(w).toMatch(/5 rule\(s\) and 2 action type\(s\)/);
  });

  it("reads back as the model it was given, from the three documents", () => {
    const back = importOssie([
      exported.yaml.semanticModel,
      exported.yaml.ontology,
      exported.yaml.mapping,
    ]);
    expect(back.spec).toEqual(spec);
  });

  it("reads back from the semantic model alone, as YAML or JSON", () => {
    expect(importOssie([exported.yaml.semanticModel]).spec).toEqual(spec);
    expect(importOssie([JSON.stringify(exported.semanticModel)]).spec).toEqual(spec);
  });

  it("keeps the model's own name when the semantic model is given another", () => {
    const named = exportOssie(spec, { modelName: "Sales model", ontologyName: "Sales ontology" });
    expect(named.semanticModel.name).toBe("Sales model");
    expect(named.mapping.semantic_model_ref.name).toBe("Sales model");
    expect(named.mapping.ontology_ref.name).toBe("Sales ontology");
    expect(importOssie([named.yaml.semanticModel]).spec).toEqual(spec);
  });

  it("writes value-type constraints another tool's ontology import can read back", () => {
    // Read as a foreign ontology: no semantic model, so no extension to lean on.
    const back = importOssie([exported.yaml.ontology]).spec;
    const vt = (n: string) => findValueType(back, n);
    expect(vt("OrderStatus")?.enum).toEqual(["open", "shipped", "it's complicated"]);
    expect(vt("Sku")?.pattern).toBe("^[A-Z]{3}-\\d{4}$");
    expect(vt("Percent")).toMatchObject({ base: "float", min: 0, max: 100 });
    expect(vt("Money")).toMatchObject({ base: "decimal", min: 0 });
    // Documented normalisations: the ontology has no zoned timestamp and no units.
    expect(vt("EventTime")?.base).toBe("datetime");
    expect(vt("Money")?.unit).toBeUndefined();
  });

  it("refuses a model with nothing bound to a table, since Ossie needs a dataset", () => {
    const empty = {
      ...spec,
      objectTypes: spec.objectTypes.filter((t) => !t.source),
      linkTypes: [],
    };
    expect(() => exportOssie(empty)).toThrow(OssieExportError);
  });
});

describe("a model imported from another tool survives a trip through this app", () => {
  it("keeps the TPC-DS vendors' extensions and reads back identically", () => {
    const first = importOssie([text(EXAMPLES.tpcds)]).spec;
    const out = exportOssie(first);
    const doc = load(EXAMPLES.tpcds) as OssieSemanticModel;
    for (const e of doc.custom_extensions!)
      expect(out.semanticModel.custom_extensions).toContainEqual(e);
    expect(
      out.semanticModel.custom_extensions!.filter((e) => e.vendor_name === AGENTSWARMS_VENDOR),
    ).toHaveLength(1);
    expect(importOssie([out.yaml.semanticModel]).spec).toEqual(first);
  });

  it("does the same for the flights trio", () => {
    const first = importOssie(FLIGHTS.map(text)).spec;
    const out = exportOssie(first);
    expect(coreProblems(out.semanticModel)).toEqual([]);
    expect(ontologyProblems(out.ontology)).toEqual([]);
    expect(mappingProblems(out.mapping, out.semanticModel, out.ontology)).toEqual([]);
    expect(importOssie([out.yaml.semanticModel]).spec).toEqual(first);
  });
});
