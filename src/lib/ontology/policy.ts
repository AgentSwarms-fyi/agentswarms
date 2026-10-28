// An ontology share's restrictions, in ontology terms.
//
// An IAM grant of type `ontology` can carry a row filter and a column mask,
// exactly like a dashboard or semantic-model grant, and they are merged by the
// same code (semanticPolicy.policyFromGrants: a grant with no filter makes the
// grantee unrestricted, masks intersect). Here the merged policy is read as
// the ontology reads it:
//
//   - a filter column `Customer.region` limits Customers (and subtypes) to
//     those values; a bare `region` limits every type that has a `region`;
//   - a mask `Customer.email` hides that property; a bare `email` hides it on
//     every type.
//
// compile.ts enforces the result in every query a grantee runs.
import type { OntologyPolicy } from "@/lib/ontology/compile";
import type { SemanticAccessPolicy } from "@/lib/semanticPolicy";

export function ontologyPolicyFrom(p: SemanticAccessPolicy): OntologyPolicy {
  return {
    maskedProperties: p.maskedFields.map((f) => f.trim()).filter(Boolean),
    rowFilters: (p.rowFilters ?? []).map((f) => {
      const column = f.column.trim();
      const dot = column.indexOf(".");
      return dot > 0
        ? { objectType: column.slice(0, dot), property: column.slice(dot + 1), values: f.values }
        : { objectType: "*", property: column, values: f.values };
    }),
  };
}

/** Words for the banner a grantee sees: what their share hides and limits. */
export function describeOntologyPolicy(p: OntologyPolicy): string[] {
  const out: string[] = [];
  for (const f of p.rowFilters ?? []) {
    const where = f.objectType === "*" ? f.property : `${f.objectType}.${f.property}`;
    out.push(
      `Only ${where} in ${f.values.slice(0, 5).join(", ")}${f.values.length > 5 ? ", …" : ""}`,
    );
  }
  if (p.maskedProperties?.length) out.push(`Hidden: ${p.maskedProperties.join(", ")}`);
  return out;
}
