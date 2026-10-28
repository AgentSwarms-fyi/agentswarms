// Edits that must keep the model consistent.
//
// A type's name is used by links, rules, actions, subtypes and the canvas; a
// property's by keys, titles, links, rules, actions and metric expressions.
// Renaming one in place and leaving the rest pointing at the old name is how
// a model quietly breaks, so renames and removals go through here and carry
// every reference along (or, for a removal, take the things that only made
// sense with it: a link to a removed type goes too).
import { compileExpr, tokenize } from "@/lib/ontology/expr";
import { emptySpec, type LinkType, type ObjectType, type OntologySpec } from "@/lib/ontology/spec";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Rewrite the names an expression uses; leaves an unparseable one as it was. */
export function renameInExpr(src: string, from: string, to: string): string {
  try {
    tokenize(src);
  } catch {
    return src;
  }
  if (!new RegExp(`\\b${from.replace(/[^a-z0-9_]/gi, "")}\\b`, "i").test(src)) return src;
  return compileExpr(src, (name) => (same(name, from) ? to : name)).replace(/"/g, "");
}

export function renameType(spec: OntologySpec, from: string, to: string): OntologySpec {
  if (same(from, to)) {
    return {
      ...spec,
      objectTypes: spec.objectTypes.map((t) => (t.name === from ? { ...t, name: to } : t)),
    };
  }
  return {
    ...spec,
    objectTypes: spec.objectTypes.map((t) => ({
      ...t,
      name: same(t.name, from) ? to : t.name,
      ...(t.extends ? { extends: same(t.extends, from) ? to : t.extends } : {}),
    })),
    linkTypes: spec.linkTypes.map((l) => ({
      ...l,
      from: same(l.from, from) ? to : l.from,
      to: same(l.to, from) ? to : l.to,
      ...(l.verbalization
        ? {
            verbalization: l.verbalization.replace(
              new RegExp(`\\{${from}(:[a-z_]+)?\\}`, "g"),
              `{${to}$1}`,
            ),
          }
        : {}),
    })),
    rules: spec.rules.map((r) => (same(r.objectType, from) ? { ...r, objectType: to } : r)),
    actionTypes: spec.actionTypes.map((a) =>
      same(a.objectType, from) ? { ...a, objectType: to } : a,
    ),
  };
}

export function removeType(spec: OntologySpec, name: string): OntologySpec {
  const links = spec.linkTypes.filter((l) => !same(l.from, name) && !same(l.to, name));
  const gone = new Set(
    spec.linkTypes
      .filter((l) => !links.includes(l))
      .map((l) => `${l.from.toLowerCase()}.${l.name}`),
  );
  return {
    ...spec,
    objectTypes: spec.objectTypes
      .filter((t) => !same(t.name, name))
      .map((t) => (t.extends && same(t.extends, name) ? { ...t, extends: undefined } : t)),
    linkTypes: links,
    rules: spec.rules.filter(
      (r) =>
        !same(r.objectType, name) &&
        !(r.kind === "referential" && gone.has(`${r.objectType.toLowerCase()}.${r.link}`)),
    ),
    actionTypes: spec.actionTypes.filter((a) => !same(a.objectType, name)),
  };
}

/** Rename a property of `type` (and of subtypes that inherit it), everywhere it is used. */
export function renameProperty(
  spec: OntologySpec,
  type: string,
  from: string,
  to: string,
): OntologySpec {
  // The types whose property this is: the type and every type that extends it.
  const family = new Set<string>([type.toLowerCase()]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of spec.objectTypes)
      if (t.extends && family.has(t.extends.toLowerCase()) && !family.has(t.name.toLowerCase())) {
        family.add(t.name.toLowerCase());
        grew = true;
      }
  }
  const inFamily = (n: string) => family.has(n.toLowerCase());
  const swap = (n: string) => (n === from ? to : n);
  const swapAll = (xs: string[]) => xs.map(swap);
  return {
    ...spec,
    objectTypes: spec.objectTypes.map((t) => {
      if (!inFamily(t.name)) return t;
      return {
        ...t,
        primaryKey: swapAll(t.primaryKey),
        ...(t.titleProperty ? { titleProperty: swap(t.titleProperty) } : {}),
        properties: t.properties.map((p) =>
          p.name === from && same(t.name, type) ? { ...p, name: to } : p,
        ),
        metrics: t.metrics.map((m) => ({ ...m, expression: renameInExpr(m.expression, from, to) })),
      };
    }),
    linkTypes: spec.linkTypes.map((l) => {
      const j = l.join;
      const fromSide = inFamily(l.from);
      const toSide = inFamily(l.to);
      if (!fromSide && !toSide) return l;
      return {
        ...l,
        join: {
          ...j,
          fromProperties: fromSide ? swapAll(j.fromProperties) : j.fromProperties,
          toProperties: toSide ? swapAll(j.toProperties) : j.toProperties,
        } as LinkType["join"],
      };
    }),
    rules: spec.rules.map((r) =>
      inFamily(r.objectType)
        ? {
            ...r,
            ...(r.property ? { property: swap(r.property) } : {}),
            ...(r.predicate ? { predicate: renameInExpr(r.predicate, from, to) } : {}),
          }
        : r,
    ),
    actionTypes: spec.actionTypes.map((a) =>
      inFamily(a.objectType)
        ? {
            ...a,
            parameters: a.parameters.map((p) => ({ ...p, property: swap(p.property) })),
            ...(a.criteria ? { criteria: renameInExpr(a.criteria, from, to) } : {}),
          }
        : a,
    ),
  };
}

/** A name not yet taken, from a base: `Thing`, `Thing2`, … */
export function freshConceptName(spec: OntologySpec, base = "NewType"): string {
  const taken = new Set([
    ...spec.objectTypes.map((t) => t.name.toLowerCase()),
    ...spec.valueTypes.map((v) => v.name.toLowerCase()),
    ...spec.interfaces.map((i) => i.name.toLowerCase()),
  ]);
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`;
  return name;
}

export function freshMemberName(taken: string[], base = "new_property"): string {
  const set = new Set(taken.map((t) => t.toLowerCase()));
  let name = base;
  for (let i = 2; set.has(name); i++) name = `${base}_${i}`;
  return name;
}

export function newObjectType(spec: OntologySpec, name?: string): ObjectType {
  return {
    name: name ?? freshConceptName(spec),
    source: null,
    primaryKey: [],
    properties: [],
    metrics: [{ name: "count", label: "Count", expression: "COUNT(*)", format: "integer" }],
  };
}

/** A copy of the spec with nothing but its name: used to start a proposal from scratch. */
export function blankLike(spec: OntologySpec): OntologySpec {
  return emptySpec(spec.name, spec.description);
}
