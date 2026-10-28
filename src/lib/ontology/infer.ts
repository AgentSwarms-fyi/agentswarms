// A first draft of an ontology from tables, before any AI is asked.
//
// Most of a model can be read straight off the tables: each table is a kind
// of thing, each column a property, `id` or `<thing>_id` the key, and a
// `customer_id` column on `orders` a link to `customers`. Doing this
// deterministically first means the draft works with no provider connected,
// costs nothing, and is the same every time; the AI pass (server side) only
// adds what names cannot tell — descriptions, synonyms, better labels — and
// the server MEASURES every guessed key and link against the data before the
// draft is shown (is `id` really unique? do 99% of `customer_id`s match?).
import { CORE_KEYWORDS } from "@/lib/ontology/expr";
import { autoLayout } from "@/lib/ontology/layout";
import {
  baseTypeFromSql,
  conceptNameFrom,
  emptySpec,
  memberNameFrom,
  ONTOLOGY_SPEC_VERSION,
  singular,
  type LinkType,
  type ObjectType,
  type OntologyProperty,
  type OntologySpec,
} from "@/lib/ontology/spec";

export type TableInfo = {
  /** `schema.table` */
  table: string;
  columns: { name: string; type: string }[];
  rowCount?: number;
};

const TITLE_HINTS = [
  "name",
  "title",
  "label",
  "display_name",
  "full_name",
  "email",
  "code",
  "sku",
  "description",
];

export type InferredDraft = {
  spec: OntologySpec;
  /** Guesses the server should measure before showing the draft. */
  keyGuesses: { objectType: string; properties: string[] }[];
  linkGuesses: { objectType: string; link: string }[];
};

export function inferFromTables(name: string, tables: TableInfo[]): InferredDraft {
  const spec = emptySpec(name);
  const used = new Set<string>();
  const byTable = new Map<string, ObjectType>();
  for (const info of tables) {
    const tableName = info.table.split(".").pop() ?? info.table;
    let concept = conceptNameFrom(tableName);
    for (let i = 2; used.has(concept.toLowerCase()); i++)
      concept = `${conceptNameFrom(tableName)}${i}`;
    used.add(concept.toLowerCase());

    const seen = new Set<string>();
    const properties: OntologyProperty[] = [];
    for (const col of info.columns) {
      let member = memberNameFrom(col.name);
      for (let i = 2; seen.has(member) || RESERVED.has(member); i++)
        member = `${memberNameFrom(col.name)}_${i}`;
      seen.add(member);
      properties.push({ name: member, type: baseTypeFromSql(col.type), column: col.name });
    }
    const key = guessKey(tableName, properties);
    const title = guessTitle(properties, key);
    const t: ObjectType = {
      name: concept,
      source: { table: info.table },
      primaryKey: key,
      ...(title ? { titleProperty: title } : {}),
      properties,
      metrics: [
        {
          name: "count",
          label: `Number of ${concept}s`,
          expression: "COUNT(*)",
          format: "integer",
        },
      ],
    };
    spec.objectTypes.push(t);
    byTable.set(info.table.toLowerCase(), t);
  }

  const linkGuesses: InferredDraft["linkGuesses"] = [];
  for (const t of spec.objectTypes) {
    for (const p of t.properties) {
      if (t.primaryKey.length === 1 && t.primaryKey[0] === p.name) continue;
      const m = /^(.*?)_?(id|key|code|no|number)$/.exec(p.name);
      if (!m || !m[1]) continue;
      const stem = m[1].replace(/_$/, "");
      const target = spec.objectTypes.find(
        (o) => o !== t && matchesStem(o, stem) && o.primaryKey.length === 1,
      );
      if (!target) continue;
      const toKey = target.primaryKey[0];
      const linkName = uniqueMember(
        t,
        spec.linkTypes,
        stem.replace(/[^a-z0-9_]/g, "_") || "related",
      );
      const inverse = uniqueMember(target, spec.linkTypes, plural(memberNameFrom(t.name)));
      const link: LinkType = {
        name: linkName,
        from: t.name,
        to: target.name,
        inverseName: inverse,
        cardinality: "many_to_one",
        verbalization: `{${t.name}} has {${target.name}}`,
        join: { kind: "foreign_key", fromProperties: [p.name], toProperties: [toKey] },
      };
      spec.linkTypes.push(link);
      linkGuesses.push({ objectType: t.name, link: linkName });
    }
  }

  const positions = autoLayout(spec);
  for (const t of spec.objectTypes) t.position = positions.get(t.name);
  return {
    spec: { ...spec, specVersion: ONTOLOGY_SPEC_VERSION },
    keyGuesses: spec.objectTypes
      .filter((t) => t.primaryKey.length)
      .map((t) => ({ objectType: t.name, properties: t.primaryKey })),
    linkGuesses,
  };
}

const RESERVED = CORE_KEYWORDS;

function guessKey(tableName: string, props: OntologyProperty[]): string[] {
  const stem = memberNameFrom(singular(tableName));
  const names = props.map((p) => p.name);
  for (const candidate of [
    "id",
    `${stem}_id`,
    `${stem}_key`,
    `${stem}_code`,
    `${stem}_no`,
    "key",
    "uuid",
  ]) {
    if (names.includes(candidate)) return [candidate];
  }
  const first = props[0];
  if (first && /_(id|key)$/.test(first.name)) return [first.name];
  return [];
}

function guessTitle(props: OntologyProperty[], key: string[]): string | undefined {
  for (const hint of TITLE_HINTS) {
    const p = props.find((x) => x.name === hint || x.name.endsWith(`_${hint}`));
    if (p && !key.includes(p.name) && p.type === "string") return p.name;
  }
  return props.find((p) => p.type === "string" && !key.includes(p.name))?.name;
}

function matchesStem(t: ObjectType, stem: string): boolean {
  const s = stem.replace(/_/g, "").toLowerCase();
  const n = t.name.toLowerCase();
  const table = (t.source?.table.split(".").pop() ?? "").replace(/_/g, "").toLowerCase();
  return s === n || s === singular(table) || s === table || `${s}s` === table;
}

function uniqueMember(t: ObjectType, links: LinkType[], base: string): string {
  const taken = new Set([
    ...t.properties.map((p) => p.name),
    ...links.filter((l) => l.from === t.name).map((l) => l.name),
    ...links.filter((l) => l.to === t.name && l.inverseName).map((l) => l.inverseName!),
  ]);
  let name = memberNameFrom(base);
  for (let i = 2; taken.has(name) || RESERVED.has(name); i++) name = `${memberNameFrom(base)}_${i}`;
  return name.slice(0, 64);
}

function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}
