// Where search reads names from, and the rule for each read.
//
// One row per kind. Three things this file is careful about:
//
// 1. THE READER'S OWN CLIENT. Every table here is read with the caller's token,
//    so row-level security decides what comes back — the same answer each list
//    page gets. Search never shows a name its page would not.
//
// 2. COLUMNS BY NAME. Reading every column of mcp_servers would carry `auth_token`
//    and on embed_keys the `key` itself. Each source lists the handful of
//    columns a search row needs, and a test refuses a source that names a
//    secret.
//
// 3. A FAILED READ IS NOT AN EMPTY KIND. A source that errors is reported by
//    name; the rest of the index still loads.
//
// 4. NEVER A SEALED VALUE. Some names are stored sealed under the owner's key
//    (a saved analysis's title). Those are opened by the caller-supplied opener
//    for their kind; a name that is still sealed afterwards — no opener, or one
//    that failed — is left out. Found from the UI: the first search page listed
//    an analysis as "ck1:eef4de9bca22:1Iy0…".
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ObjectEntry, ObjectKindId } from "@/lib/objectKinds";

/** How many of one kind the index holds: the most recently changed. */
export const INDEX_CAP = 400;

/**
 * Columns search must never read, whatever table they are on: credentials, and
 * the bodies of things (a prompt's text, a dashboard's widgets). Search knows
 * names, not contents.
 */
export const NEVER_READ = [
  "auth_token",
  "auth_token_enc",
  "key",
  "key_hash",
  "secret",
  "config",
  "body",
  "content",
  "turns",
  "widgets",
  "pages",
  "spec",
];

type Row = Record<string, unknown>;

export type TableSource = {
  kind: ObjectKindId;
  table: string;
  /** The column the name is in, and the one a description is in. */
  name: string;
  detail?: string;
  /** Newest-first by this column. */
  time: string;
  owner: string;
  /** Extra columns the mapping reads. */
  extra?: string[];
  /** Rows whose name matches this LIKE pattern are left out. */
  hideNamesLike?: string;
  /** Keep a row? Runs after the read, for rules a filter cannot say. */
  keep?: (row: Row, userId: string) => boolean;
  /** Overrides for the entry built from a row. */
  shape?: (row: Row, userId: string) => Partial<ObjectEntry>;
};

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export const TABLE_SOURCES: TableSource[] = [
  {
    kind: "agent",
    table: "agents",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "swarm",
    table: "swarms",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "knowledge_base",
    table: "knowledge_bases",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
    extra: ["is_sample"],
    shape: (r) => ({ sample: r.is_sample === true }),
  },
  {
    kind: "mcp_app",
    table: "mcp_apps",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "prompt",
    table: "user_prompts",
    name: "title",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "skill",
    table: "agent_skills",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "evaluation",
    table: "eval_datasets",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "dataset",
    table: "user_data_tables",
    name: "name",
    time: "updated_at",
    owner: "user_id",
    extra: ["is_sample"],
    // An upload in progress is staged under this prefix; it is not a dataset
    // yet and the catalog hides it the same way.
    hideNamesLike: "__upload_%",
    shape: (r) => ({ sample: r.is_sample === true }),
  },
  {
    kind: "etl_pipeline",
    table: "etl_pipelines",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "sql_model",
    table: "sql_models",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "ontology",
    table: "ontologies",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
    extra: ["published_version"],
    // Somebody else's ontology is listed once it is published, not before —
    // the ontology page's own rule.
    keep: (r, userId) => r.user_id === userId || r.published_version != null,
  },
  {
    kind: "data_monitor",
    table: "data_monitors",
    name: "name",
    detail: "kind",
    time: "updated_at",
    owner: "user_id",
    shape: (r) => ({
      detail: text(r.kind) ? `${String(r.kind).replace(/_/g, " ")} check` : undefined,
    }),
  },
  {
    kind: "ai_analyst",
    table: "ai_analysts",
    name: "name",
    detail: "model",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "analysis",
    table: "ai_analyst_threads",
    name: "title",
    time: "updated_at",
    owner: "user_id",
    extra: ["analyst_id"],
    shape: (r) => ({ parentId: text(r.analyst_id) }),
  },
  {
    kind: "dashboard",
    table: "bi_dashboards",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "report",
    table: "bi_reports",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "workbook",
    table: "sheet_workbooks",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "ml_model",
    table: "ml_models",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "workflow",
    table: "workflows",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "notebook",
    table: "user_python_notebooks",
    name: "title",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  {
    kind: "mcp_server",
    table: "mcp_servers",
    name: "name",
    detail: "description",
    time: "updated_at",
    owner: "user_id",
  },
  { kind: "embed", table: "embed_keys", name: "name", time: "updated_at", owner: "user_id" },
];

/** The columns one source reads, as a PostgREST select list. */
export function columnsOf(s: TableSource): string {
  const cols = ["id", s.name, s.time, s.owner, ...(s.detail ? [s.detail] : []), ...(s.extra ?? [])];
  return [...new Set(cols)].join(", ");
}

export function entryFromRow(s: TableSource, row: Row, userId: string): ObjectEntry | null {
  const id = text(row.id);
  const name = text(row[s.name]);
  if (!id || !name) return null;
  return {
    kind: s.kind,
    id,
    name,
    detail: s.detail ? text(row[s.detail]) : undefined,
    updatedAt: text(row[s.time]) ?? null,
    mine: row[s.owner] === userId,
    ...(s.shape ? s.shape(row, userId) : {}),
  };
}

export type IndexResult = {
  entries: ObjectEntry[];
  /** Kinds that hit the cap: more exist than the index holds. */
  capped: ObjectKindId[];
  /** Kinds whose read failed, so their absence means nothing. */
  failed: ObjectKindId[];
};

// The table read is chosen at run time, one per kind, so this is the client
// without a schema: the generated types only accept a table name known when
// the code is compiled.
type AnyClient = SupabaseClient;

/** Escape a LIKE pattern's own wildcards in what somebody typed. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One entry made readable, or null when it cannot be: its name opened by the
 * kind's opener when there is one, and dropped if it is sealed all the same.
 */
async function readable(
  e: ObjectEntry,
  open?: (row: { id: string; name: string }) => Promise<string | null>,
): Promise<ObjectEntry | null> {
  let name: string | null = e.name;
  if (open) {
    try {
      name = await open({ id: e.id, name: e.name });
    } catch {
      return null;
    }
  }
  if (!name || !name.trim() || looksSealed(name)) return null;
  return { ...e, name: name.trim(), detail: looksSealed(e.detail) ? undefined : e.detail };
}

async function readSource(
  sb: AnyClient,
  s: TableSource,
  userId: string,
  nameContains?: string,
  open?: (row: { id: string; name: string }) => Promise<string | null>,
  ids?: readonly string[],
): Promise<{ entries: ObjectEntry[]; capped: boolean }> {
  let q = sb.from(s.table).select(columnsOf(s));
  if (s.hideNamesLike) q = q.not(s.name, "like", s.hideNamesLike);
  if (nameContains) q = q.ilike(s.name, `%${likeEscape(nameContains)}%`);
  if (ids) q = q.in("id", [...ids]);
  const { data, error } = await q.order(s.time, { ascending: false }).limit(INDEX_CAP);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Row[];
  const made: ObjectEntry[] = [];
  for (const row of rows) {
    if (s.keep && !s.keep(row, userId)) continue;
    const e = entryFromRow(s, row, userId);
    if (e) made.push(e);
  }
  const entries = (await Promise.all(made.map((e) => readable(e, open)))).filter(
    (e): e is ObjectEntry => e !== null,
  );
  return { entries, capped: rows.length >= INDEX_CAP };
}

/**
 * Semantic models, and the metrics inside them. A metric has no row of its
 * own: it is found by its model's name and its own, which is how the metrics
 * page looks one up.
 */
async function readSemantic(
  sb: AnyClient,
  userId: string,
): Promise<{ models: ObjectEntry[]; metrics: ObjectEntry[]; capped: boolean }> {
  const { data, error } = await sb
    .from("semantic_models")
    .select("id, name, label, description, updated_at, user_id, metrics")
    .order("updated_at", { ascending: false })
    .limit(INDEX_CAP);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Row[];
  const models: ObjectEntry[] = [];
  const metrics: ObjectEntry[] = [];
  for (const r of rows) {
    const id = text(r.id);
    const name = text(r.name);
    if (!id || !name) continue;
    const label = text(r.label);
    const mine = r.user_id === userId;
    const updatedAt = text(r.updated_at) ?? null;
    models.push({
      kind: "semantic_model",
      id,
      name: label ?? name,
      detail:
        [label ? name : undefined, text(r.description)].filter(Boolean).join(" — ") || undefined,
      updatedAt,
      mine,
    });
    if (!Array.isArray(r.metrics)) continue;
    for (const m of r.metrics as Row[]) {
      const metric = text(m?.name);
      if (!metric) continue;
      metrics.push({
        kind: "metric",
        id: `${name}.${metric}`,
        name: text(m.label) ?? metric,
        detail: [`in ${label ?? name}`, text(m.description)].filter(Boolean).join(" — "),
        updatedAt,
        mine,
        parentId: id,
      });
    }
  }
  return { models, metrics, capped: rows.length >= INDEX_CAP };
}

/** A value sealed under a data key: `ck<version>:<key id>:<ciphertext>`. */
export function looksSealed(v: unknown): boolean {
  return typeof v === "string" && /^ck\d+:[^:\s]+:[^:\s]+:/.test(v);
}

/** Extra sources that are not one table read with the reader's own client. */
export type IndexExtras = {
  /**
   * Opens a stored name that is sealed, per kind. Returns the readable name;
   * throws (or returns null) when it cannot be opened, and that row is left out.
   */
  openName?: Partial<
    Record<ObjectKindId, (row: { id: string; name: string }) => Promise<string | null>>
  >;
  /** Datasets shared with the reader, masked ones included (shared_datasets()). */
  sharedDatasets?: () => Promise<Array<{ id: string; name: string }>>;
  /** Workbooks shared with the reader: only the server can list those. */
  sharedWorkbooks?: () => Promise<ObjectEntry[]>;
};

/**
 * Every name the reader may search, newest first within each kind. Reads run
 * side by side; one that fails is named in `failed` and the rest still return.
 */
export async function loadObjectIndex(
  sb: AnyClient,
  userId: string,
  extras: IndexExtras = {},
): Promise<IndexResult> {
  const entries: ObjectEntry[] = [];
  const capped: ObjectKindId[] = [];
  const failed: ObjectKindId[] = [];

  const tasks: Array<Promise<void>> = TABLE_SOURCES.map(async (s) => {
    try {
      const r = await readSource(sb, s, userId, undefined, extras.openName?.[s.kind]);
      entries.push(...r.entries);
      if (r.capped) capped.push(s.kind);
    } catch {
      failed.push(s.kind);
    }
  });

  tasks.push(
    (async () => {
      try {
        const r = await readSemantic(sb, userId);
        entries.push(...r.models, ...r.metrics);
        if (r.capped) capped.push("semantic_model", "metric");
      } catch {
        failed.push("semantic_model", "metric");
      }
    })(),
  );

  let shared: Array<{ id: string; name: string }> = [];
  if (extras.sharedDatasets) {
    tasks.push(
      (async () => {
        try {
          shared = await extras.sharedDatasets!();
        } catch {
          if (!failed.includes("dataset")) failed.push("dataset");
        }
      })(),
    );
  }

  let sharedBooks: ObjectEntry[] = [];
  if (extras.sharedWorkbooks) {
    tasks.push(
      (async () => {
        try {
          sharedBooks = await extras.sharedWorkbooks!();
        } catch {
          if (!failed.includes("workbook")) failed.push("workbook");
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // A share the direct read already returned (an unmasked one) is the same
  // dataset; the function's row wins nothing here, since only names are kept.
  const have = new Set(entries.map((e) => `${e.kind}:${e.id}`));
  for (const d of shared) {
    if (!d?.id || !d?.name || have.has(`dataset:${d.id}`)) continue;
    entries.push({ kind: "dataset", id: d.id, name: d.name, mine: false, updatedAt: null });
    have.add(`dataset:${d.id}`);
  }
  for (const w of sharedBooks) {
    if (have.has(`workbook:${w.id}`)) continue;
    entries.push(w);
    have.add(`workbook:${w.id}`);
  }

  // An analysis is told apart by the analyst it was run with: several are
  // often titled with the same question.
  const analysts = new Map(
    entries.filter((e) => e.kind === "ai_analyst").map((e) => [e.id, e.name]),
  );
  for (const e of entries) {
    if (e.kind !== "analysis" || e.detail || !e.parentId) continue;
    const analyst = analysts.get(e.parentId);
    if (analyst) e.detail = `with ${analyst}`;
  }

  return { entries, capped: [...new Set(capped)], failed: [...new Set(failed)] };
}

/** How many ids of one kind may be asked for at once. */
export const BY_ID_CAP = 200;

/** The shape of an id in every table search reads: a uuid. */
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The entries with these ids, for marks (a favourite, something opened) on
 * objects older than the index holds. Read with the reader's own client like
 * everything else here, so an id the reader may not see returns nothing —
 * asking for an id is not a way to learn a name.
 */
export async function readObjectsByIds(
  sb: AnyClient,
  userId: string,
  wanted: Partial<Record<ObjectKindId, readonly string[]>>,
  openName: IndexExtras["openName"] = {},
): Promise<ObjectEntry[]> {
  const out: ObjectEntry[] = [];
  await Promise.all(
    TABLE_SOURCES.map(async (s) => {
      // An id that is not a row id would fail the whole read of its kind.
      const ids = [...new Set(wanted[s.kind] ?? [])].filter((id) => ROW_ID.test(id));
      if (!ids.length) return;
      try {
        const r = await readSource(
          sb,
          s,
          userId,
          undefined,
          openName?.[s.kind],
          ids.slice(0, BY_ID_CAP),
        );
        out.push(...r.entries);
      } catch {
        /* a kind that cannot be read adds nothing */
      }
    }),
  );
  return out;
}

/**
 * Names containing `q`, for kinds the index could not hold in full. The index
 * keeps the newest INDEX_CAP of a kind; this finds an older one by name.
 */
export async function searchCappedKinds(
  sb: AnyClient,
  userId: string,
  q: string,
  kinds: readonly ObjectKindId[],
  /** Kinds whose names are stored sealed: the database cannot match those. */
  sealedKinds: readonly ObjectKindId[] = [],
): Promise<ObjectEntry[]> {
  const needle = q.trim();
  if (needle.length < 2) return [];
  const wanted = new Set(kinds);
  const sealed = new Set(sealedKinds);
  const out: ObjectEntry[] = [];
  await Promise.all(
    TABLE_SOURCES.filter((s) => wanted.has(s.kind) && !sealed.has(s.kind)).map(async (s) => {
      try {
        out.push(...(await readSource(sb, s, userId, needle)).entries);
      } catch {
        /* a kind that cannot be searched further adds nothing */
      }
    }),
  );
  return out;
}
