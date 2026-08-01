// Pure logic behind the BI builder pane.
//
// Extracted from BiBuilderPane.tsx, which is a 2,700-line component holding
// three modes' worth of state. This module is the first step of splitting it:
// the decisions that are worth testing are moved somewhere they CAN be tested,
// before any JSX moves anywhere.
//
// Nothing here imports React or touches the DOM. If a function in here needs a
// hook, it belongs in the component, not the module.

/**
 * A source-group selection: every member, or an explicit set.
 *
 * "all" is not sugar for "the full set" — it is a distinct state that SURVIVES
 * a list that has not loaded yet. Warehouse schemas and the KB list arrive
 * asynchronously, so a selection captured as a concrete Set before they load
 * would silently mean "none of them". "all" resolves to whatever the list turns
 * out to be, at build time.
 */
export type SelOrAll = "all" | Set<string>;

export type SourceTable = { name: string; cols: string[] };

export const selHas = (sel: SelOrAll, name: string) => sel === "all" || sel.has(name);

/**
 * Tri-state value for a group checkbox. `names` is null while the list loads.
 *
 * The loading case is why this is not a simple size comparison: with "all"
 * selected and nothing loaded yet, the box must read CHECKED, not empty —
 * otherwise the UI tells the user their selection was lost while it is merely
 * unresolved.
 */
export function groupCheckState(
  sel: SelOrAll | undefined,
  names: string[] | null,
): boolean | "indeterminate" {
  if (!sel) return false;
  if (sel === "all") return true;
  if (sel.size === 0) return false;
  if (!names || names.length === 0) return true;
  const n = names.filter((x) => sel.has(x)).length;
  return n === 0 ? false : n === names.length ? true : "indeterminate";
}

/**
 * Toggle one member of a group.
 *
 * Un-ticking a member of an "all" selection has to MATERIALISE the set first —
 * "all minus one" is not representable, and treating it as an empty set would
 * clear every other member along with the one clicked.
 */
export function toggleName(sel: SelOrAll | undefined, names: string[], name: string): SelOrAll {
  const set = sel === "all" ? new Set(names) : new Set(sel ?? []);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  return set;
}

/**
 * A plausible join column between two tables, or null.
 *
 * Preference order is deliberate: a shared `*_id` beats a bare `id`, which
 * beats any shared column at all. Joining two tables on a coincidentally
 * shared `name` or `created_at` produces a cross-product that looks like a
 * result — so the fallback is offered as a SUGGESTION the user edits, never
 * silently trusted.
 */
export function detectJoinKey(a: string[], b: string[]): string | null {
  const setB = new Set(b.map((c) => c.toLowerCase()));
  const common = a.filter((c) => setB.has(c.toLowerCase()));
  return (
    common.find((c) => /_id$/i.test(c)) ?? common.find((c) => /^id$/i.test(c)) ?? common[0] ?? null
  );
}

/**
 * Starter SQL for the selected tables.
 *
 * When no join key can be found the placeholder `<join_key>` is emitted rather
 * than a guess. It does not run, which is the point: a query that fails
 * obviously is better than one that silently returns a cross-product.
 */
export function seedSql(tables: SourceTable[]): string {
  if (tables.length === 0) return "";
  if (tables.length === 1) return `SELECT *\nFROM ${tables[0].name}\nLIMIT 50`;
  const [first, ...rest] = tables;
  const lines = ["SELECT *", `FROM ${first.name}`];
  for (const t of rest) {
    const key = detectJoinKey(first.cols, t.cols);
    lines.push(
      key
        ? `JOIN ${t.name} ON ${first.name}.${key} = ${t.name}.${key}`
        : `JOIN ${t.name} ON ${first.name}.<join_key> = ${t.name}.<join_key>`,
    );
  }
  lines.push("LIMIT 50");
  return lines.join("\n");
}
