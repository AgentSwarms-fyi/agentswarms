// Field-level diff between two semantic model definitions.
//
// The version trigger stores WHAT the model said before; this renders the
// answer to "revenue changed on the 14th — from what?" as named changes, not
// a JSON blob a human has to eyeball. Pure over the stored jsonb shape.
import type { Json } from "@/integrations/supabase/types";

type NamedItem = { name?: unknown } & Record<string, unknown>;

export type FieldChange = {
  name: string;
  /** Which properties differ, each with its before/after rendering. */
  changes: Array<{ field: string; before: string; after: string }>;
};

export type ItemDiff = {
  added: string[];
  removed: string[];
  changed: FieldChange[];
};

export type SemanticDefinitionDiff = {
  dimensions: ItemDiff;
  metrics: ItemDiff;
  joins: ItemDiff;
  assertions: ItemDiff;
  /** Scalar model fields (source_table, primary_key, status, …) that differ. */
  model: Array<{ field: string; before: string; after: string }>;
  /** True when nothing at all differs. */
  identical: boolean;
};

const show = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "—" : typeof v === "string" ? v : JSON.stringify(v);

function itemKey(item: NamedItem, fallbackFields: string[]): string {
  if (typeof item.name === "string" && item.name) return item.name;
  // Joins and assertions have no `name`; identify them by their stable parts.
  return fallbackFields.map((f) => show(item[f])).join(" ");
}

function diffItems(
  before: unknown,
  after: unknown,
  opts: { keyFields: string[]; compareFields: string[] },
): ItemDiff {
  const listOf = (v: unknown): NamedItem[] =>
    Array.isArray(v) ? v.filter((x): x is NamedItem => !!x && typeof x === "object") : [];
  const a = new Map(listOf(before).map((x) => [itemKey(x, opts.keyFields), x]));
  const b = new Map(listOf(after).map((x) => [itemKey(x, opts.keyFields), x]));

  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed: FieldChange[] = [];
  for (const [key, prev] of a) {
    const next = b.get(key);
    if (!next) continue;
    const changes = opts.compareFields
      .filter((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(next[f] ?? null))
      .map((f) => ({ field: f, before: show(prev[f]), after: show(next[f]) }));
    if (changes.length > 0) changed.push({ name: key, changes });
  }
  return { added, removed, changed };
}

const MODEL_SCALARS = [
  "name",
  "label",
  "description",
  "source_kind",
  "source_table",
  "connection_id",
  "primary_key",
  "status",
] as const;

/**
 * Diff two stored definitions (rows of semantic_models as jsonb — the shape
 * the version trigger snapshots). Order: `before` is the older one.
 */
export function diffSemanticDefinitions(before: Json, after: Json): SemanticDefinitionDiff {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;

  const dimensions = diffItems(a.dimensions, b.dimensions, {
    keyFields: ["name"],
    compareFields: ["sql", "type", "label", "description"],
  });
  const metrics = diffItems(a.metrics, b.metrics, {
    keyFields: ["name"],
    compareFields: ["agg", "sql", "filters", "format", "label", "description"],
  });
  const joins = diffItems(a.joins, b.joins, {
    keyFields: ["table", "alias"],
    compareFields: ["type", "on", "cardinality"],
  });
  const assertions = diffItems(a.assertions, b.assertions, {
    keyFields: ["label", "metric"],
    compareFields: ["metric", "filters", "expected", "tolerance"],
  });
  const model = MODEL_SCALARS.filter(
    (f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null),
  ).map((f) => ({ field: f, before: show(a[f]), after: show(b[f]) }));

  const identical =
    model.length === 0 &&
    [dimensions, metrics, joins, assertions].every(
      (d) => d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0,
    );

  return { dimensions, metrics, joins, assertions, model, identical };
}
