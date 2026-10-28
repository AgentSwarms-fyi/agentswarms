// The ontology as OWL 2, in Turtle: a one-way bridge to knowledge-graph tools
// (Protégé, TopBraid, Stardog, GraphDB) that read RDF rather than Ossie.
//
// What maps cleanly is exported; what OWL has no word for (a table binding, a
// metric, an action) is left out rather than invented:
//
//   object type  → owl:Class, rdfs:subClassOf its supertype
//   property     → owl:DatatypeProperty, domain the type, range its xsd type
//   value type   → rdfs:Datatype restricting its base (pattern, min/max, enum)
//   link         → owl:ObjectProperty, owl:inverseOf the inverse reading,
//                  owl:FunctionalProperty when an object has at most one
//   key          → owl:hasKey
//   description  → rdfs:comment; label → rdfs:label; synonyms → skos:altLabel
import {
  findValueType,
  splitCamel,
  titleOf,
  type BaseType,
  type OntologySpec,
} from "@/lib/ontology/spec";

const XSD: Record<BaseType, string> = {
  string: "xsd:string",
  integer: "xsd:integer",
  decimal: "xsd:decimal",
  float: "xsd:double",
  boolean: "xsd:boolean",
  date: "xsd:date",
  datetime: "xsd:dateTime",
  timestamp: "xsd:dateTimeStamp",
};

function lit(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "ontology"
  );
}

export function baseIri(spec: OntologySpec): string {
  if (spec.iri && /^[a-z][a-z0-9+.-]*:/i.test(spec.iri)) {
    return /[#/]$/.test(spec.iri) ? spec.iri : `${spec.iri}#`;
  }
  return `urn:agentswarms:ontology:${slug(spec.name)}#`;
}

export function toTurtle(spec: OntologySpec): string {
  const lines: string[] = [];
  const base = baseIri(spec);
  lines.push(`@prefix : <${base}> .`);
  lines.push("@prefix owl: <http://www.w3.org/2002/07/owl#> .");
  lines.push("@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .");
  lines.push("@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .");
  lines.push("@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .");
  lines.push("@prefix skos: <http://www.w3.org/2004/02/skos/core#> .");
  for (const [p, iri] of Object.entries(spec.prefixes ?? {})) {
    if (!["owl", "rdf", "rdfs", "xsd", "skos", ""].includes(p))
      lines.push(`@prefix ${p}: <${iri}> .`);
  }
  lines.push("");
  lines.push(`<${base.replace(/#$/, "")}> a owl:Ontology ;`);
  lines.push(`  rdfs:label ${lit(spec.name)}${spec.description ? " ;" : " ."}`);
  if (spec.description) lines.push(`  rdfs:comment ${lit(spec.description)} .`);
  lines.push("");

  const rangeOf = (type: string): string => {
    const vt = findValueType(spec, type);
    if (vt) return `:${vt.name}`;
    return XSD[type as BaseType] ?? "xsd:string";
  };

  for (const v of spec.valueTypes) {
    const facets: string[] = [];
    if (v.pattern) facets.push(`[ xsd:pattern ${lit(v.pattern)} ]`);
    if (v.min !== undefined) facets.push(`[ xsd:minInclusive ${v.min} ]`);
    if (v.max !== undefined) facets.push(`[ xsd:maxInclusive ${v.max} ]`);
    lines.push(`:${v.name} a rdfs:Datatype ;`);
    lines.push(`  rdfs:label ${lit(splitCamel(v.name))} ;`);
    if (v.description) lines.push(`  rdfs:comment ${lit(v.description)} ;`);
    if (v.enum) {
      lines.push(
        `  owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( ${v.enum.map(lit).join(" ")} ) ] .`,
      );
    } else if (facets.length) {
      lines.push(
        `  owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype ${XSD[v.base]} ; owl:withRestrictions ( ${facets.join(" ")} ) ] .`,
      );
    } else {
      lines.push(`  owl:equivalentClass ${XSD[v.base]} .`);
    }
    lines.push("");
  }

  for (const t of spec.objectTypes) {
    const stmts: string[] = [`a owl:Class`, `rdfs:label ${lit(titleOf(t))}`];
    if (t.description) stmts.push(`rdfs:comment ${lit(t.description)}`);
    if (t.extends) stmts.push(`rdfs:subClassOf :${t.extends}`);
    for (const s of t.synonyms ?? []) stmts.push(`skos:altLabel ${lit(s)}`);
    if (t.primaryKey.length)
      stmts.push(`owl:hasKey ( ${t.primaryKey.map((k) => `:${t.name}_${k}`).join(" ")} )`);
    // The type's global identifier (e.g. schema:Person) names the same class.
    if (t.iri)
      stmts.push(`owl:equivalentClass <${t.iri.includes("//") ? t.iri : expand(spec, t.iri)}>`);
    lines.push(`:${t.name} ${stmts.join(" ;\n  ")} .`);
    lines.push("");
    for (const p of t.properties) {
      const ps: string[] = [
        "a owl:DatatypeProperty",
        `rdfs:label ${lit(p.label ?? p.name.replace(/_/g, " "))}`,
        `rdfs:domain :${t.name}`,
        `rdfs:range ${rangeOf(p.type)}`,
      ];
      if (p.description) ps.push(`rdfs:comment ${lit(p.description)}`);
      for (const s of p.synonyms ?? []) ps.push(`skos:altLabel ${lit(s)}`);
      lines.push(`:${t.name}_${p.name} ${ps.join(" ;\n  ")} .`);
    }
    if (t.properties.length) lines.push("");
  }

  for (const l of spec.linkTypes) {
    const id = `:${l.from}_${l.name}`;
    const ls: string[] = [
      "a owl:ObjectProperty",
      `rdfs:label ${lit(l.label ?? l.name.replace(/_/g, " "))}`,
      `rdfs:domain :${l.from}`,
      `rdfs:range :${l.to}`,
    ];
    if (l.cardinality === "many_to_one" || l.cardinality === "one_to_one")
      ls.push("a owl:FunctionalProperty");
    if (l.cardinality === "one_to_one") ls.push("a owl:InverseFunctionalProperty");
    if (l.description) ls.push(`rdfs:comment ${lit(l.description)}`);
    if (l.verbalization) ls.push(`skos:definition ${lit(l.verbalization)}`);
    lines.push(`${id} ${ls.join(" ;\n  ")} .`);
    if (l.inverseName) {
      lines.push(
        `:${l.to}_${l.inverseName} a owl:ObjectProperty ;\n  rdfs:label ${lit(l.inverseLabel ?? l.inverseName.replace(/_/g, " "))} ;\n  owl:inverseOf ${id} .`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function expand(spec: OntologySpec, qname: string): string {
  const [p, local] = qname.split(":", 2);
  const ns = spec.prefixes?.[p];
  return ns ? `${ns}${local}` : qname;
}
