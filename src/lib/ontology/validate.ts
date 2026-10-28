// Checking an ontology: everything the schema cannot say.
//
// The zod schema (spec.ts) checks shapes. This checks meaning: that every name
// a link, rule, metric or action uses exists; that a type's key is made of its
// own properties; that inheritance has no cycle; that interfaces are honoured;
// that every expression parses and names only what it may. Errors stop a save
// from publishing; warnings are shown and allowed (an undescribed type is
// unhelpful, not wrong).
//
// Each issue carries a `path` the editor uses to put the message next to the
// field: `objectTypes.Order.properties.amount`, `linkTypes.Order.placed_by`.
import { checkExpr, CORE_KEYWORDS } from "@/lib/ontology/expr";
import {
  allProperties,
  BASE_TYPES,
  findObjectType,
  findValueType,
  ontologySpecSchema,
  supertypes,
  type ObjectType,
  type OntologySpec,
} from "@/lib/ontology/spec";

export type Issue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type ValidationResult = { ok: boolean; issues: Issue[] };

/** Parse an unknown value as a spec, then check it. */
export function parseAndValidate(
  raw: unknown,
): { spec: OntologySpec; result: ValidationResult } | { spec: null; result: ValidationResult } {
  const parsed = ontologySpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.slice(0, 50).map((i) => ({
      level: "error",
      path: i.path.join("."),
      message: i.message,
    }));
    return { spec: null, result: { ok: false, issues } };
  }
  return { spec: parsed.data, result: validateSpec(parsed.data) };
}

export function validateSpec(spec: OntologySpec): ValidationResult {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  // ── One namespace for concepts, as in Ossie ──
  const concepts = new Map<string, string>();
  const claim = (name: string, what: string, path: string) => {
    const k = name.toLowerCase();
    const had = concepts.get(k);
    if (had) err(path, `\`${name}\` is already the name of ${had}`);
    else concepts.set(k, what);
  };
  for (const b of BASE_TYPES) concepts.set(b.toLowerCase(), "a built-in type");
  for (const v of spec.valueTypes) claim(v.name, `a value type`, `valueTypes.${v.name}`);
  for (const i of spec.interfaces) claim(i.name, `an interface`, `interfaces.${i.name}`);
  for (const t of spec.objectTypes) claim(t.name, `an object type`, `objectTypes.${t.name}`);

  const typeKnown = (type: string) =>
    (BASE_TYPES as readonly string[]).includes(type) || !!findValueType(spec, type);

  // ── Value types ──
  for (const v of spec.valueTypes) {
    const path = `valueTypes.${v.name}`;
    if (v.pattern && !compiles(v.pattern))
      err(path, "The pattern is not a valid regular expression");
    if (v.min !== undefined && v.max !== undefined && v.min > v.max)
      err(path, "The minimum is greater than the maximum");
    if ((v.min !== undefined || v.max !== undefined) && !numeric(v.base))
      err(path, "A range needs a numeric base type");
  }

  // ── Interfaces ──
  for (const i of spec.interfaces) {
    const seen = new Set<string>();
    for (const p of i.properties) {
      if (seen.has(p.name)) err(`interfaces.${i.name}.${p.name}`, `\`${p.name}\` is listed twice`);
      seen.add(p.name);
      if (!typeKnown(p.type)) err(`interfaces.${i.name}.${p.name}`, `Unknown type \`${p.type}\``);
    }
  }

  // ── Object types ──
  for (const t of spec.objectTypes) checkType(spec, t, err, warn, typeKnown);

  // ── Links ──
  const linkNames = new Set<string>();
  for (const l of spec.linkTypes) {
    const path = `linkTypes.${l.from}.${l.name}`;
    const from = findObjectType(spec, l.from);
    const to = findObjectType(spec, l.to);
    if (!from) err(path, `Unknown object type \`${l.from}\``);
    if (!to) err(path, `Unknown object type \`${l.to}\``);
    const key = `${l.from.toLowerCase()}.${l.name}`;
    if (linkNames.has(key)) err(path, `${l.from} already has a link called \`${l.name}\``);
    linkNames.add(key);
    if (from && allProperties(spec, from).some((p) => p.name === l.name))
      err(path, `${l.from} has a property called \`${l.name}\`; a link needs a different name`);
    if (to && l.inverseName) {
      const ikey = `${l.to.toLowerCase()}.${l.inverseName}`;
      if (linkNames.has(ikey) || allProperties(spec, to).some((p) => p.name === l.inverseName))
        err(path, `${l.to} already uses the name \`${l.inverseName}\``);
      linkNames.add(ikey);
    }
    if (!from || !to) continue;
    const j = l.join;
    if (j.fromProperties.length !== j.toProperties.length)
      err(path, "Both sides of the join need the same number of properties");
    for (const p of j.fromProperties)
      if (!allProperties(spec, from).some((x) => x.name === p))
        err(path, `${from.name} has no property \`${p}\``);
    for (const p of j.toProperties)
      if (!allProperties(spec, to).some((x) => x.name === p))
        err(path, `${to.name} has no property \`${p}\``);
    if (j.kind === "join_table") {
      if (
        j.fromColumns.length !== j.fromProperties.length ||
        j.toColumns.length !== j.toProperties.length
      )
        err(path, "Each join-table column needs one property to match");
      if (l.cardinality !== "many_to_many") warn(path, "A join table usually means many-to-many");
    } else if (l.cardinality === "many_to_many") {
      err(path, "Many-to-many needs a join table");
    }
    if (!from.source || !to.source)
      warn(path, "Both ends need a table before the link can be followed");
    if (l.verbalization) {
      for (const m of l.verbalization.matchAll(/\{([A-Za-z][A-Za-z0-9]*)(?::[a-z_]+)?\}/g)) {
        if (!findObjectType(spec, m[1]))
          warn(path, `The sentence names \`{${m[1]}}\`, which is not an object type`);
      }
    }
  }

  // ── Rules ──
  const ruleIds = new Set<string>();
  for (const r of spec.rules) {
    const path = `rules.${r.id}`;
    if (ruleIds.has(r.id)) err(path, `Two rules have the id \`${r.id}\``);
    ruleIds.add(r.id);
    const t = findObjectType(spec, r.objectType);
    if (!t) {
      err(path, `Unknown object type \`${r.objectType}\``);
      continue;
    }
    const props = allProperties(spec, t).map((p) => p.name);
    const needsProperty = ["required", "unique", "pattern", "range", "allowed_values"].includes(
      r.kind,
    );
    if (needsProperty) {
      if (!r.property) err(path, "Pick the property this rule checks");
      else if (!props.includes(r.property))
        err(path, `${t.name} has no property \`${r.property}\``);
    }
    if (r.kind === "pattern") {
      if (!r.pattern) err(path, "A pattern rule needs a pattern");
      else if (!compiles(r.pattern)) err(path, "The pattern is not a valid regular expression");
    }
    if (r.kind === "range") {
      if (r.min === undefined && r.max === undefined)
        err(path, "Give a minimum, a maximum or both");
      if (r.min !== undefined && r.max !== undefined && r.min > r.max)
        err(path, "The minimum is greater than the maximum");
    }
    if (r.kind === "allowed_values" && !r.values?.length) err(path, "List the allowed values");
    if (r.kind === "referential") {
      const link = spec.linkTypes.find(
        (l) => l.name === r.link && l.from.toLowerCase() === t.name.toLowerCase(),
      );
      if (!r.link) err(path, "Pick the link whose target must exist");
      else if (!link) err(path, `${t.name} has no link \`${r.link}\``);
      else if (link.join.kind !== "foreign_key")
        err(path, "Only a link through a key on this type can be checked for a missing target");
    }
    if (r.kind === "predicate") {
      if (!r.predicate) err(path, "Write the condition every object must meet");
      else {
        const c = checkExpr(r.predicate, "predicate", props);
        if (!c.ok) err(path, c.error ?? "The condition does not parse");
      }
    }
    if (!t.source) warn(path, `${t.name} has no table, so the rule cannot run yet`);
  }

  // ── Actions ──
  const actionNames = new Set<string>();
  for (const a of spec.actionTypes) {
    const path = `actionTypes.${a.name}`;
    if (actionNames.has(a.name)) err(path, `Two actions are called \`${a.name}\``);
    actionNames.add(a.name);
    const t = findObjectType(spec, a.objectType);
    if (!t) {
      err(path, `Unknown object type \`${a.objectType}\``);
      continue;
    }
    const all = allProperties(spec, t);
    const props = all.map((p) => p.name);
    const params = new Set<string>();
    for (const p of a.parameters) {
      if (params.has(p.name)) err(path, `The parameter \`${p.name}\` is listed twice`);
      params.add(p.name);
      const prop = all.find((x) => x.name === p.property);
      if (!prop) err(path, `${t.name} has no property \`${p.property}\``);
      else if (prop.expression)
        err(path, `\`${p.property}\` is derived, so an action cannot set it`);
    }
    if (a.kind === "create") {
      for (const k of t.primaryKey)
        if (!a.parameters.some((p) => p.property === k))
          err(path, `Creating a ${t.name} needs its key \`${k}\` as a parameter`);
    }
    if (a.kind === "modify" && !a.parameters.length)
      err(path, "A change needs at least one parameter");
    if (a.kind === "modify")
      for (const p of a.parameters)
        if (t.primaryKey.includes(p.property))
          err(path, `\`${p.property}\` identifies the object; changing it is not a modify`);
    if (a.criteria) {
      const c = checkExpr(a.criteria, "predicate", props);
      if (!c.ok) err(path, c.error ?? "The criteria do not parse");
    }
    if (!t.source) err(path, `${t.name} has no table to change`);
    else if (t.source.filter && a.kind === "create")
      warn(
        path,
        `${t.name} is a filtered view of its table; a created row must meet the filter to appear`,
      );
    if (a.agentMode === "execute" && a.requiresApproval)
      warn(path, "Agents are allowed to execute, but every run still waits for approval");
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

function checkType(
  spec: OntologySpec,
  t: ObjectType,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
  typeKnown: (type: string) => boolean,
) {
  const path = `objectTypes.${t.name}`;
  if (t.extends) {
    const sup = findObjectType(spec, t.extends);
    if (!sup) err(path, `Unknown supertype \`${t.extends}\``);
    else if (supertypes(spec, t).some((s) => s.name === t.name) || cyclic(spec, t))
      err(path, "The supertypes form a cycle");
  }
  const own = new Set<string>();
  for (const p of t.properties) {
    const ppath = `${path}.properties.${p.name}`;
    if (own.has(p.name)) err(ppath, `\`${p.name}\` is declared twice`);
    own.add(p.name);
    if (CORE_KEYWORDS.has(p.name)) err(ppath, `\`${p.name}\` is a SQL word; choose another name`);
    if (!typeKnown(p.type)) err(ppath, `Unknown type \`${p.type}\``);
    if (p.column && p.expression)
      err(ppath, "A property reads a column or derives a value, not both");
    if (t.source && !p.column && !p.expression && !inheritsColumn(spec, t, p.name))
      warn(ppath, "Map it to a column or give it an expression, or it reads as empty");
    if (p.expression) {
      const c = checkExpr(p.expression, "scalar", null);
      if (!c.ok) err(ppath, c.error ?? "The expression does not parse");
    }
    if (t.primaryKey.includes(p.name) && p.sensitivity === "restricted")
      err(ppath, "A key cannot be restricted: it is how objects are found and linked");
  }
  const props = allProperties(spec, t);
  const names = props.map((p) => p.name);
  if (t.source && !t.primaryKey.length)
    err(path, "Choose the property (or properties) that identify one object");
  for (const k of t.primaryKey)
    if (!names.includes(k)) err(path, `The key names \`${k}\`, which is not a property`);
  if (t.titleProperty && !names.includes(t.titleProperty))
    err(path, `The title property \`${t.titleProperty}\` does not exist`);
  if (t.source?.filter) {
    const c = checkExpr(t.source.filter, "predicate", null);
    if (!c.ok) err(path, `Source filter: ${c.error}`);
  }
  for (const iname of t.interfaces ?? []) {
    const i = spec.interfaces.find((x) => x.name.toLowerCase() === iname.toLowerCase());
    if (!i) {
      err(path, `Unknown interface \`${iname}\``);
      continue;
    }
    for (const ip of i.properties) {
      const p = props.find((x) => x.name === ip.name);
      if (!p) err(path, `${iname} needs a property \`${ip.name}\``);
      else if (p.type !== ip.type)
        err(path, `${iname}.${ip.name} is ${ip.type}, here it is ${p.type}`);
    }
  }
  const metricNames = new Set<string>();
  for (const m of t.metrics) {
    const mpath = `${path}.metrics.${m.name}`;
    if (metricNames.has(m.name)) err(mpath, `\`${m.name}\` is declared twice`);
    metricNames.add(m.name);
    if (names.includes(m.name)) err(mpath, `\`${m.name}\` is also a property`);
    const c = checkExpr(m.expression, "aggregate", names);
    if (!c.ok) err(mpath, c.error ?? "The expression does not parse");
  }
  if (!t.description?.trim())
    warn(path, "Describe it: people and agents read this to know what it means");
  if (t.status === "deprecated") {
    const users = spec.linkTypes.filter(
      (l) =>
        l.from.toLowerCase() === t.name.toLowerCase() ||
        l.to.toLowerCase() === t.name.toLowerCase(),
    );
    if (users.length) warn(path, `Deprecated, but ${users.length} link(s) still use it`);
  }
}

function inheritsColumn(spec: OntologySpec, t: ObjectType, name: string): boolean {
  return supertypes(spec, t).some((s) =>
    s.properties.some((p) => p.name === name && (p.column || p.expression)),
  );
}

function cyclic(spec: OntologySpec, t: ObjectType): boolean {
  const seen = new Set<string>([t.name.toLowerCase()]);
  let cur = t.extends ? findObjectType(spec, t.extends) : undefined;
  while (cur) {
    if (seen.has(cur.name.toLowerCase())) return true;
    seen.add(cur.name.toLowerCase());
    cur = cur.extends ? findObjectType(spec, cur.extends) : undefined;
  }
  return false;
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function numeric(base: string): boolean {
  return base === "integer" || base === "decimal" || base === "float";
}

/**
 * How complete the model is, 0–100, from things a reviewer would check:
 * described types and properties, bound types, keys, links, certified metrics.
 * Shown on the gallery card and the overview, so a team can see a model fill in.
 */
export function modelCompleteness(spec: OntologySpec): {
  score: number;
  parts: { label: string; done: number; of: number }[];
} {
  const types = spec.objectTypes;
  const props = types.flatMap((t) => t.properties);
  const metrics = types.flatMap((t) => t.metrics);
  const parts = [
    {
      label: "Types described",
      done: types.filter((t) => t.description?.trim()).length,
      of: types.length,
    },
    {
      label: "Types bound to a table",
      done: types.filter((t) => t.source).length,
      of: types.length,
    },
    {
      label: "Properties described",
      done: props.filter((p) => p.description?.trim()).length,
      of: props.length,
    },
    {
      label: "Types linked to another",
      done: types.filter((t) =>
        spec.linkTypes.some(
          (l) =>
            l.from.toLowerCase() === t.name.toLowerCase() ||
            l.to.toLowerCase() === t.name.toLowerCase(),
        ),
      ).length,
      of: types.length,
    },
    {
      label: "Metrics certified",
      done: metrics.filter((m) => m.certified).length,
      of: metrics.length,
    },
  ];
  const counted = parts.filter((p) => p.of > 0);
  const score = counted.length
    ? Math.round((counted.reduce((s, p) => s + p.done / p.of, 0) / counted.length) * 100)
    : 0;
  return { score, parts };
}
