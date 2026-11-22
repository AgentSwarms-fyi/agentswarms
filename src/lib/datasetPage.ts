// What a dataset's page says about it, worked out from facts other parts of
// the app already keep: where its rows come from, whether it can be trusted
// today, how its columns changed, what its columns hold. Pure, so each rule
// is held by a test and the page only lays the answers out.
import { describeFreshness, STALE_AFTER_MS } from "@/lib/biFreshness";
import type { QualityRollup } from "@/lib/dataQualityCore";

/** Who is looking: the dataset's owner, anyone at a bundled sample, or a grantee. */
export type DatasetRole = "owner" | "sample" | "shared";

export type FlowRef = {
  id: string;
  name: string;
  refreshEnabled?: boolean | null;
  refreshEveryMinutes?: number | null;
  lastRefreshAt?: string | null;
  lastRefreshError?: string | null;
};

/** One place the rows come from. */
export type Origin =
  | { kind: "flow"; flow: FlowRef }
  | { kind: "connection"; id: string; name: string | null; stream: string | null }
  | { kind: "warehouse"; source: string }
  | { kind: "upload"; filename: string }
  | { kind: "sample" }
  | { kind: "unknown" };

export type DatasetSourceFields = {
  source_filename?: string | null;
  saas_connection_id?: string | null;
  saas_stream?: string | null;
  is_sample?: boolean | null;
};

/**
 * Where a dataset's rows come from. A flow that writes it wins: its refresh
 * is what keeps the rows current, whatever the file it was first made from.
 */
export function originsOf(
  row: DatasetSourceFields,
  opts: { flowsProducing?: readonly FlowRef[]; connectionName?: string | null } = {},
): Origin[] {
  const out: Origin[] = [];
  for (const flow of opts.flowsProducing ?? []) out.push({ kind: "flow", flow });
  if (row.saas_connection_id) {
    out.push({
      kind: "connection",
      id: row.saas_connection_id,
      name: opts.connectionName ?? null,
      stream: row.saas_stream ?? null,
    });
  }
  const file = (row.source_filename ?? "").trim();
  if (!out.length) {
    if (row.is_sample) out.push({ kind: "sample" });
    else if (file.startsWith("prep:")) {
      // The flow that made it is gone, or is not the reader's to see.
      out.push({
        kind: "flow",
        flow: { id: "", name: file.slice("prep:".length) || "a data-prep flow" },
      });
    } else if (file.startsWith("warehouse:")) {
      out.push({ kind: "warehouse", source: file.slice("warehouse:".length) });
    } else if (file) out.push({ kind: "upload", filename: file });
    else out.push({ kind: "unknown" });
  }
  return out;
}

/** "every hour", "every 6 hours", "daily", "every 3 days". */
export function everyLabel(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes < 60) return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes === 60) return "every hour";
  if (minutes % 1440 === 0) return minutes === 1440 ? "daily" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** One origin as a sentence. */
export function originSentence(o: Origin): string {
  switch (o.kind) {
    case "flow": {
      const every = o.flow.refreshEnabled ? everyLabel(o.flow.refreshEveryMinutes) : null;
      const name = `the data-prep flow “${o.flow.name}”`;
      if (o.flow.lastRefreshError) return `Made by ${name}, whose last refresh failed.`;
      return every
        ? `Made by ${name}, which refreshes it ${every}.`
        : `Made by ${name}; it changes when that flow is run.`;
    }
    case "connection":
      return `Synced from ${o.name ? `the connection “${o.name}”` : "a connection"}${o.stream ? ` (${o.stream})` : ""}.`;
    case "warehouse":
      return `Copied from the warehouse table ${o.source}; it changes only when copied again.`;
    case "upload":
      return `Uploaded from ${o.filename}; it changes only when someone uploads again.`;
    case "sample":
      return "A sample that comes with the app, read-only for everyone.";
    default:
      return "Where its rows came from was not recorded.";
  }
}

/** How old the rows may be before they are called stale, in hours. */
export function staleAfterHours(freshnessSlaHours: number | null | undefined): number {
  return freshnessSlaHours && freshnessSlaHours > 0
    ? freshnessSlaHours
    : STALE_AFTER_MS / 3_600_000;
}

export type TrustInput = {
  role: DatasetRole;
  /** When the rows last changed (data_loaded_at), not when its name did. */
  loadedAt: string | null;
  /** The dataset's own freshness check, in hours, when it has one. */
  freshnessSlaHours?: number | null;
  /** Owner only: its checks, rolled up. */
  quality?: QualityRollup | null;
  origins: readonly Origin[];
  /** How many things of the reader's are built on it. */
  usedBy: number;
  /** A grantee's own grant hides columns / filters rows. */
  masked?: boolean;
  filtered?: boolean;
  now?: number;
};

export type Trust = {
  /** good: fresh and every check passing; attention: stale or failing; unknown: too little known. */
  tone: "good" | "attention" | "unknown";
  headline: string;
  lines: string[];
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One plain verdict, and the facts it rests on. Not a score: a number out of
 * 100 would ask the reader to trust the formula instead of the facts, and the
 * facts are short enough to read.
 */
export function datasetTrust(t: TrustInput): Trust {
  const now = t.now ?? Date.now();
  const lines: string[] = [];
  const fresh = describeFreshness(t.loadedAt, now);
  const limitH = staleAfterHours(t.freshnessSlaHours);
  const stale = fresh ? fresh.ageMs > limitH * 3_600_000 : false;
  const expect = t.freshnessSlaHours
    ? ` (its check expects at least every ${t.freshnessSlaHours} h)`
    : "";

  if (!fresh) lines.push("Its rows have no load time recorded.");
  else if (t.role === "sample") lines.push(`A fixed sample, loaded ${fresh.relative}.`);
  else lines.push(`Rows last loaded ${fresh.relative}${expect}.`);

  const q = t.quality;
  if (t.role === "owner") {
    if (!q || q.status === "unknown") lines.push("No checks have run on it yet.");
    else if (q.status === "pass") lines.push(`All ${plural(q.passed, "check")} passed.`);
    else {
      const parts = [
        q.failed && `${q.failed} failing`,
        q.warned && `${q.warned} warning`,
        q.errored && `${q.errored} could not run`,
      ].filter(Boolean);
      lines.push(`Of ${plural(q.total, "check")}: ${parts.join(", ")}.`);
    }
  }

  if (t.role === "shared") {
    if (t.masked || t.filtered) {
      const what = [t.filtered && "some rows", t.masked && "some columns"].filter(Boolean);
      lines.push(`Shared with you without ${what.join(" and ")}.`);
    } else lines.push("Shared with you, all rows and columns.");
  }

  if (t.usedBy > 0)
    lines.push(
      `${plural(t.usedBy, "thing")} of yours ${t.usedBy === 1 ? "is" : "are"} built on it.`,
    );

  const flowFailed = t.origins.some((o) => o.kind === "flow" && o.flow.lastRefreshError);
  let tone: Trust["tone"];
  let headline: string;
  if (t.role === "sample") {
    tone = "good";
    headline = "A sample to try things on";
  } else if (!fresh) {
    tone = "unknown";
    headline = "Not loaded yet";
  } else if (q && (q.status === "fail" || q.status === "error")) {
    tone = "attention";
    headline = q.status === "fail" ? "Checks are failing" : "Some checks could not run";
  } else if (flowFailed) {
    tone = "attention";
    headline = "Its last refresh failed";
  } else if (stale) {
    tone = "attention";
    headline = `Stale: last loaded ${fresh.relative}`;
  } else if (t.role === "owner" && (!q || q.status === "unknown")) {
    tone = "unknown";
    headline = "Fresh, with nothing checking it";
  } else if (q?.status === "warn") {
    tone = "attention";
    headline = "Fresh, with warnings";
  } else {
    tone = "good";
    headline = t.role === "owner" ? "Fresh, and every check passed" : "Fresh";
  }
  return { tone, headline, lines };
}

// ── Schema history ─────────────────────────────────────────────────────────

export type SchemaVersion = { at: string; columns: readonly string[] };
export type SchemaChange = { at: string; added: string[]; removed: string[] };

/**
 * How the columns changed, newest first: each kept version against the one
 * after it, and the newest against the columns today. Versions are kept
 * before every overwrite, so a change between two of them is a real change.
 */
export function schemaChanges(
  versions: readonly SchemaVersion[],
  current: { at: string | null; columns: readonly string[] },
): SchemaChange[] {
  const ordered = [...versions].sort((a, b) => a.at.localeCompare(b.at));
  const states = [
    ...ordered,
    ...(current.at ? [{ at: current.at, columns: current.columns }] : []),
  ];
  const out: SchemaChange[] = [];
  for (let i = 1; i < states.length; i++) {
    const before = new Set(states[i - 1].columns);
    const after = new Set(states[i].columns);
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    if (added.length || removed.length) out.push({ at: states[i].at, added, removed });
  }
  return out.reverse();
}

// ── Column profile ─────────────────────────────────────────────────────────

export type ColumnProfile = {
  name: string;
  /** Rows in the sample the profile was read from. */
  rows: number;
  empty: number;
  distinct: number;
  /** "number", "date", "text", "true/false", or "empty" when every value is. */
  looks: "number" | "date" | "text" | "true/false" | "empty";
  min?: string;
  max?: string;
  /** Up to three of the most common values, with how often. */
  common: Array<{ value: string; count: number }>;
};

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && !v.trim());

/**
 * What each column holds, read from the sample the page already shows. Says
 * so: these are facts about the first rows, not the whole dataset.
 */
export function profileColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
  /** The types the dataset declares, by column: "date" lets 6/13/2024 read as a date. */
  declared: ReadonlyMap<string, string> = new Map(),
): ColumnProfile[] {
  return columns.map((name) => {
    const values = rows.map((r) => r[name]);
    const present = values.filter((v) => !isEmpty(v));
    const counts = new Map<string, number>();
    for (const v of present) {
      const k = typeof v === "object" ? JSON.stringify(v) : String(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const nums = present
      .map((v) => (typeof v === "number" ? v : Number(v)))
      .filter(Number.isFinite);
    const isBool =
      present.length > 0 &&
      present.every((v) => typeof v === "boolean" || v === "true" || v === "false");
    const isNum = !isBool && present.length > 0 && nums.length === present.length;
    // ISO dates always; any form the date parser reads when the dataset
    // says the column holds dates (US-style 6/13/2024, for one).
    const saysDate = /date|time/i.test(declared.get(name) ?? "");
    const dates = isNum
      ? []
      : present
          .filter(
            (v) =>
              typeof v === "string" &&
              (/^\d{4}-\d{2}-\d{2}/.test(v) || (saysDate && Number.isFinite(Date.parse(v)))),
          )
          // A bare ISO day is read as that day, not as midnight UTC shifted
          // into the reader's zone (which can be the day before).
          .map((v) =>
            /^\d{4}-\d{2}-\d{2}$/.test(String(v))
              ? new Date(`${v}T00:00:00`)
              : new Date(Date.parse(String(v))),
          );
    const isDate =
      present.length > 0 &&
      dates.length === present.length &&
      dates.every((d) => Number.isFinite(d.getTime()));
    const looks: ColumnProfile["looks"] = !present.length
      ? "empty"
      : isBool
        ? "true/false"
        : isNum
          ? "number"
          : isDate
            ? "date"
            : "text";
    const profile: ColumnProfile = {
      name,
      rows: rows.length,
      empty: values.length - present.length,
      distinct: counts.size,
      looks,
      common: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .filter(([, n]) => n > 1)
        .map(([value, count]) => ({ value: value.slice(0, 60), count })),
    };
    if (isNum) {
      profile.min = String(Math.min(...nums));
      profile.max = String(Math.max(...nums));
    } else if (isDate) {
      const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
      const day = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      profile.min = day(sorted[0]);
      profile.max = day(sorted[sorted.length - 1]);
    }
    return profile;
  });
}

// ── Access ─────────────────────────────────────────────────────────────────

/** "Only rows where region is EU or UK." */
export function filterSentence(rowFilter: unknown): string | null {
  const rf = rowFilter as { column?: unknown; values?: unknown } | null;
  if (!rf || typeof rf.column !== "string") return null;
  const values = Array.isArray(rf.values) ? rf.values.map(String) : [];
  if (!values.length) return `Only rows with a value in ${rf.column}.`;
  return `Only rows where ${rf.column} is ${values.length === 1 ? values[0] : `one of ${values.join(", ")}`}.`;
}

// ── What is built on it ────────────────────────────────────────────────────

/** Things that name the dataset, and how many read every dataset of the reader's. */
export type ReadersOf = { named: Array<{ id: string; name: string }>; everything: number };

/** AI analysts reading this dataset: by name, or all local datasets (an empty list). */
export function analystsReading(
  analysts: ReadonlyArray<{ id: string; name: string; source: unknown }>,
  tableName: string,
): ReadersOf {
  const out: ReadersOf = { named: [], everything: 0 };
  for (const a of analysts) {
    const src = a.source as { kind?: unknown; tables?: unknown } | null;
    if (!src || src.kind !== "local") continue;
    const tables = Array.isArray(src.tables) ? src.tables.filter((t) => typeof t === "string") : [];
    if (tables.length === 0) out.everything++;
    else if (tables.includes(tableName)) out.named.push({ id: a.id, name: a.name });
  }
  return out;
}

/** Agents whose SQL tool may read this dataset: listed by name, or all (no list). */
export function agentsReading(
  agents: ReadonlyArray<{ id: string; name: string; tools: unknown }>,
  tableName: string,
): ReadersOf {
  const out: ReadersOf = { named: [], everything: 0 };
  for (const a of agents) {
    const tools = (a.tools ?? {}) as {
      sql_query?: unknown;
      toolConfigs?: { sql_query?: { table_names?: unknown } };
    };
    if (tools.sql_query !== true) continue;
    const names = tools.toolConfigs?.sql_query?.table_names;
    const list = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n.trim()) : [];
    if (list.length === 0) out.everything++;
    else if (list.includes(tableName)) out.named.push({ id: a.id, name: a.name });
  }
  return out;
}
