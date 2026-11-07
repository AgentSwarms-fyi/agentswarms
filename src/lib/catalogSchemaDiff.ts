// What changed between two versions of a table's columns.
//
// A crawl always knew THAT a schema changed: it compares a fingerprint, and
// that fingerprint was all it kept. So the catalog could announce "changed"
// and could not say what, and a column dropped in March left no trace by May.
// This is what is stored instead, and what the asset's history shows.

export type SchemaColumn = { name: string; type: string };

export type SchemaChanges = {
  added: SchemaColumn[];
  removed: SchemaColumn[];
  retyped: { name: string; from: string; to: string }[];
};

export function diffColumns(prev: SchemaColumn[], next: SchemaColumn[]): SchemaChanges {
  const before = new Map(prev.map((c) => [c.name, c.type]));
  const after = new Map(next.map((c) => [c.name, c.type]));
  return {
    added: next.filter((c) => !before.has(c.name)).map(({ name, type }) => ({ name, type })),
    removed: prev.filter((c) => !after.has(c.name)).map(({ name, type }) => ({ name, type })),
    retyped: next.flatMap((c) => {
      const from = before.get(c.name);
      return from !== undefined && from !== c.type ? [{ name: c.name, from, to: c.type }] : [];
    }),
  };
}

export function isBreaking(c: SchemaChanges): boolean {
  return c.removed.length > 0 || c.retyped.length > 0;
}

/** One line for a timeline: "+2 columns, 1 removed, 1 retyped". */
export function summarizeChanges(c: SchemaChanges): string {
  const parts: string[] = [];
  if (c.added.length) parts.push(`${c.added.length} added`);
  if (c.removed.length) parts.push(`${c.removed.length} removed`);
  if (c.retyped.length) parts.push(`${c.retyped.length} retyped`);
  return parts.length ? parts.join(", ") : "No column changes";
}
