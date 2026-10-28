// What changed between two versions of an ontology, and what it breaks.
//
// Used by the version history ("what did v7 change?"), by a proposal's review
// ("what will merging this do?") and by publish ("you are about to remove a
// property two rules and an action use"). A change is BREAKING when something
// that consumed the old version can stop working: a removed type, property,
// metric or link; a property whose type changed; a key that changed; a link
// that now joins differently; a type that now reads another table. Additions
// and wording are never breaking.
import {
  findObjectType,
  type LinkType,
  type ObjectType,
  type OntologySpec,
} from "@/lib/ontology/spec";

export type ChangeElement =
  | "model"
  | "objectType"
  | "property"
  | "metric"
  | "linkType"
  | "valueType"
  | "interface"
  | "rule"
  | "actionType";

export type Change = {
  kind: "added" | "removed" | "changed";
  element: ChangeElement;
  /** `Order`, `Order.amount`, `Order.placed_by`, `rule:order-amount-positive`. */
  path: string;
  /** Field-level detail for a change: "column: amt → amount". */
  details: string[];
  breaking: boolean;
  /** For a breaking change: what in the NEW version still refers to it. */
  usedBy: string[];
};

export type SpecDiff = {
  changes: Change[];
  added: number;
  removed: number;
  changed: number;
  breaking: number;
};

const k = (s: string) => s.toLowerCase();

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [k(i.name), i]));
}

function fieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  skip: string[] = [],
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (skip.includes(key)) continue;
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(after[key] ?? null);
    if (a === b) continue;
    out.push(`${key}: ${short(before[key])} → ${short(after[key])}`);
  }
  return out;
}

function short(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/** Everything in `spec` that names a type's property: links, rules, actions, metrics, title, key. */
export function usesOfProperty(spec: OntologySpec, type: string, prop: string): string[] {
  const out: string[] = [];
  const t = findObjectType(spec, type);
  if (t) {
    if (t.primaryKey.includes(prop)) out.push(`${t.name} key`);
    if (t.titleProperty === prop) out.push(`${t.name} title`);
    for (const m of t.metrics)
      if (new RegExp(`\\b${prop}\\b`).test(m.expression)) out.push(`metric ${t.name}.${m.name}`);
  }
  for (const l of spec.linkTypes) {
    if (k(l.from) === k(type) && l.join.fromProperties.includes(prop))
      out.push(`link ${l.from}.${l.name}`);
    if (k(l.to) === k(type) && l.join.toProperties.includes(prop))
      out.push(`link ${l.from}.${l.name}`);
  }
  for (const r of spec.rules) {
    if (k(r.objectType) !== k(type)) continue;
    if (r.property === prop || (r.predicate && new RegExp(`\\b${prop}\\b`).test(r.predicate)))
      out.push(`rule ${r.id}`);
  }
  for (const a of spec.actionTypes) {
    if (k(a.objectType) !== k(type)) continue;
    if (
      a.parameters.some((p) => p.property === prop) ||
      (a.criteria && new RegExp(`\\b${prop}\\b`).test(a.criteria))
    )
      out.push(`action ${a.name}`);
  }
  return out;
}

/** Everything in `spec` that names a type. */
export function usesOfType(spec: OntologySpec, type: string): string[] {
  const out: string[] = [];
  for (const t of spec.objectTypes)
    if (t.extends && k(t.extends) === k(type)) out.push(`subtype ${t.name}`);
  for (const l of spec.linkTypes)
    if (k(l.from) === k(type) || k(l.to) === k(type)) out.push(`link ${l.from}.${l.name}`);
  for (const r of spec.rules) if (k(r.objectType) === k(type)) out.push(`rule ${r.id}`);
  for (const a of spec.actionTypes) if (k(a.objectType) === k(type)) out.push(`action ${a.name}`);
  return out;
}

export function usesOfLink(spec: OntologySpec, from: string, name: string): string[] {
  return spec.rules
    .filter((r) => r.kind === "referential" && k(r.objectType) === k(from) && r.link === name)
    .map((r) => `rule ${r.id}`);
}

function linkKey(l: LinkType) {
  return `${k(l.from)}.${l.name}`;
}

export function diffSpecs(before: OntologySpec, after: OntologySpec): SpecDiff {
  const changes: Change[] = [];
  const push = (c: Omit<Change, "usedBy"> & { usedBy?: string[] }) =>
    changes.push({ usedBy: [], ...c });

  // ── The model itself ──
  const modelDetails = fieldDiff(
    {
      name: before.name,
      description: before.description,
      iri: before.iri,
      prefixes: before.prefixes,
    },
    { name: after.name, description: after.description, iri: after.iri, prefixes: after.prefixes },
  );
  if (modelDetails.length)
    push({
      kind: "changed",
      element: "model",
      path: "model",
      details: modelDetails,
      breaking: false,
    });

  // ── Object types, their properties and metrics ──
  const bt = byName(before.objectTypes);
  const at = byName(after.objectTypes);
  for (const [key, a] of at)
    if (!bt.has(key))
      push({ kind: "added", element: "objectType", path: a.name, details: [], breaking: false });
  for (const [key, b] of bt) {
    const a = at.get(key);
    if (!a) {
      push({
        kind: "removed",
        element: "objectType",
        path: b.name,
        details: [],
        breaking: true,
        usedBy: usesOfType(after, b.name),
      });
      continue;
    }
    diffType(after, b, a, push);
  }

  // ── Links ──
  const bl = new Map(before.linkTypes.map((l) => [linkKey(l), l]));
  const al = new Map(after.linkTypes.map((l) => [linkKey(l), l]));
  for (const [key, a] of al)
    if (!bl.has(key))
      push({
        kind: "added",
        element: "linkType",
        path: `${a.from}.${a.name}`,
        details: [],
        breaking: false,
      });
  for (const [key, b] of bl) {
    const a = al.get(key);
    const path = `${b.from}.${b.name}`;
    if (!a) {
      push({
        kind: "removed",
        element: "linkType",
        path,
        details: [],
        breaking: true,
        usedBy: usesOfLink(after, b.from, b.name),
      });
      continue;
    }
    const details = fieldDiff(
      b as unknown as Record<string, unknown>,
      a as unknown as Record<string, unknown>,
    );
    if (details.length) {
      const breaking =
        JSON.stringify(b.join) !== JSON.stringify(a.join) ||
        b.cardinality !== a.cardinality ||
        k(b.to) !== k(a.to) ||
        b.inverseName !== a.inverseName;
      push({ kind: "changed", element: "linkType", path, details, breaking });
    }
  }

  // ── Value types, interfaces, rules, actions ──
  diffNamed(before.valueTypes, after.valueTypes, "valueType", push, (b, a) => b.base !== a.base);
  diffNamed(before.interfaces, after.interfaces, "interface", push, () => true);
  diffNamed(
    before.rules.map((r) => ({ ...r, name: r.id, label: r.name })),
    after.rules.map((r) => ({ ...r, name: r.id, label: r.name })),
    "rule",
    push,
    () => false,
    "rule:",
  );
  diffNamed(
    before.actionTypes,
    after.actionTypes,
    "actionType",
    push,
    (b, a) => b.objectType !== a.objectType || b.kind !== a.kind,
  );

  return {
    changes,
    added: changes.filter((c) => c.kind === "added").length,
    removed: changes.filter((c) => c.kind === "removed").length,
    changed: changes.filter((c) => c.kind === "changed").length,
    breaking: changes.filter((c) => c.breaking).length,
  };
}

function diffType(
  after: OntologySpec,
  b: ObjectType,
  a: ObjectType,
  push: (c: Omit<Change, "usedBy"> & { usedBy?: string[] }) => void,
) {
  const skip = ["properties", "metrics", "position"];
  const details = fieldDiff(
    b as unknown as Record<string, unknown>,
    a as unknown as Record<string, unknown>,
    skip,
  );
  if (details.length) {
    const breaking =
      JSON.stringify(b.primaryKey) !== JSON.stringify(a.primaryKey) ||
      b.source?.table !== a.source?.table ||
      (b.source?.filter ?? "") !== (a.source?.filter ?? "") ||
      (b.extends ?? "") !== (a.extends ?? "");
    push({ kind: "changed", element: "objectType", path: a.name, details, breaking });
  }
  const bp = byName(b.properties);
  const ap = byName(a.properties);
  for (const [key, p] of ap)
    if (!bp.has(key))
      push({
        kind: "added",
        element: "property",
        path: `${a.name}.${p.name}`,
        details: [],
        breaking: false,
      });
  for (const [key, p] of bp) {
    const q = ap.get(key);
    if (!q) {
      push({
        kind: "removed",
        element: "property",
        path: `${a.name}.${p.name}`,
        details: [],
        breaking: true,
        usedBy: usesOfProperty(after, a.name, p.name),
      });
      continue;
    }
    const d = fieldDiff(
      p as unknown as Record<string, unknown>,
      q as unknown as Record<string, unknown>,
    );
    if (d.length) {
      const breaking =
        p.type !== q.type ||
        (p.column ?? "") !== (q.column ?? "") ||
        (p.expression ?? "") !== (q.expression ?? "");
      push({
        kind: "changed",
        element: "property",
        path: `${a.name}.${p.name}`,
        details: d,
        breaking,
      });
    }
  }
  const bm = byName(b.metrics);
  const am = byName(a.metrics);
  for (const [key, m] of am)
    if (!bm.has(key))
      push({
        kind: "added",
        element: "metric",
        path: `${a.name}.${m.name}`,
        details: [],
        breaking: false,
      });
  for (const [key, m] of bm) {
    const n = am.get(key);
    if (!n) {
      push({
        kind: "removed",
        element: "metric",
        path: `${a.name}.${m.name}`,
        details: [],
        breaking: true,
      });
      continue;
    }
    const d = fieldDiff(
      m as unknown as Record<string, unknown>,
      n as unknown as Record<string, unknown>,
    );
    if (d.length)
      push({
        kind: "changed",
        element: "metric",
        path: `${a.name}.${m.name}`,
        details: d,
        breaking: m.expression !== n.expression,
      });
  }
}

function diffNamed<T extends { name: string }>(
  before: T[],
  after: T[],
  element: ChangeElement,
  push: (c: Omit<Change, "usedBy"> & { usedBy?: string[] }) => void,
  breakingChange: (b: T, a: T) => boolean,
  prefix = "",
) {
  const b = byName(before);
  const a = byName(after);
  for (const [key, x] of a)
    if (!b.has(key))
      push({ kind: "added", element, path: `${prefix}${x.name}`, details: [], breaking: false });
  for (const [key, x] of b) {
    const y = a.get(key);
    if (!y) {
      push({
        kind: "removed",
        element,
        path: `${prefix}${x.name}`,
        details: [],
        breaking: element !== "rule",
      });
      continue;
    }
    const d = fieldDiff(
      x as unknown as Record<string, unknown>,
      y as unknown as Record<string, unknown>,
    );
    if (d.length)
      push({
        kind: "changed",
        element,
        path: `${prefix}${x.name}`,
        details: d,
        breaking: breakingChange(x, y),
      });
  }
}
