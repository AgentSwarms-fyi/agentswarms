// A model proposed in chat, trained only when its owner says yes (R527).
//
// An agent can SUGGEST a model; it cannot make one. What it suggests is
// checked against the table's real columns before anything is filed, so the
// inbox never holds a proposal that cannot train, and checked again when it
// is approved, because a table can change in between. The approval's text is
// built here from the checked names and fixed words only: never the agent's
// own prose, which could carry what someone typed (approval text is readable
// by the owner's approvers, and only an agent step's words are sealed).
//
// Pure: the server reads the columns and the database; this decides.
import {
  ML_PERIODS,
  ML_TARGET_TASKS,
  ML_TASKS,
  type MlPeriod,
  type MlSource,
  type MlTask,
} from "@/utils/ml/types";

export const ML_TRAIN_ACTION = "ml.train";

export type MlTrainProposal = {
  name: string;
  task: MlTask;
  source: MlSource;
  target_column?: string;
  time_column?: string;
  series_column?: string;
  period?: MlPeriod;
  horizon?: number;
  user_column?: string;
  item_column?: string;
  rating_column?: string;
  n_clusters?: number;
  feature_columns?: string[];
};

export type TableColumn = { name: string; type: string };

type Checked = { ok: true; proposal: MlTrainProposal } | { ok: false; error: string };

const MAX_NAME = 120;
const MAX_FEATURES = 500;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const int = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

/** `"schema"."table"`, schema.table, or a source object; null when not one table. */
export function parseTableRef(v: unknown): MlSource | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const schema = str(o.schema);
    const table = str(o.table);
    return schema && table ? { kind: "lakehouse", schema, table } : null;
  }
  const s = str(v);
  if (!s) return null;
  const unquote = (p: string) => p.trim().replace(/^"(.*)"$/, "$1");
  const at = s.startsWith('"') ? s.indexOf('".') + 1 : s.indexOf(".");
  if (at <= 0) return null;
  const schema = unquote(s.slice(0, at));
  const table = unquote(s.slice(at + 1));
  return schema && table && !table.includes(".") ? { kind: "lakehouse", schema, table } : null;
}

/** A name for the model when none was given, from what it does. */
export function defaultModelName(p: Omit<MlTrainProposal, "name">): string {
  const t = p.source.table;
  const named =
    p.task === "forecast"
      ? `${p.target_column} forecast`
      : p.task === "clustering"
        ? `${t} groups`
        : p.task === "anomaly"
          ? `${t} anomalies`
          : p.task === "recommendation"
            ? `${p.item_column} for each ${p.user_column}`
            : `${p.target_column} from ${t}`;
  return named.slice(0, MAX_NAME);
}

/**
 * The shape of a proposal: from the agent's tool call, or read back from an
 * approval. Checks what can be checked without the table; the columns come
 * next, in checkAgainstColumns.
 */
export function parseProposal(raw: unknown): Checked {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Say what to train: a task, a table and the column to predict." };
  }
  const a = raw as Record<string, unknown>;
  const task = str(a.task)?.toLowerCase() as MlTask | undefined;
  if (!task || !ML_TASKS.includes(task)) {
    return { ok: false, error: `The task must be one of: ${ML_TASKS.join(", ")}.` };
  }
  const source = parseTableRef(a.source ?? a.table);
  if (!source) {
    return { ok: false, error: "Name the table as schema.table, for example analytics.orders." };
  }
  const p: Omit<MlTrainProposal, "name"> = { task, source };
  const col = (k: keyof MlTrainProposal) => str(a[k]);
  if (ML_TARGET_TASKS.includes(task)) {
    p.target_column = col("target_column");
    if (!p.target_column) return { ok: false, error: "Say which column to predict." };
  }
  if (task === "forecast" || task === "classification" || task === "regression") {
    p.time_column = col("time_column");
  }
  if (task === "forecast") {
    if (!p.time_column) {
      return { ok: false, error: "A forecast needs a date or time column to forecast along." };
    }
    p.series_column = col("series_column");
    const period = str(a.period)?.toLowerCase() as MlPeriod | undefined;
    if (period !== undefined) {
      if (!ML_PERIODS.includes(period)) {
        return { ok: false, error: `The period must be one of: ${ML_PERIODS.join(", ")}.` };
      }
      p.period = period;
    }
    const horizon = int(a.horizon);
    if (a.horizon !== undefined && a.horizon !== null) {
      if (horizon === undefined || horizon < 1 || horizon > 1000) {
        return { ok: false, error: "The horizon is a whole number of periods, 1 to 1000." };
      }
      p.horizon = horizon;
    }
  }
  if (task === "recommendation") {
    p.user_column = col("user_column");
    p.item_column = col("item_column");
    if (!p.user_column || !p.item_column) {
      return {
        ok: false,
        error: "A recommendation needs a user column and an item column.",
      };
    }
    p.rating_column = col("rating_column");
  }
  if (task === "clustering" && a.n_clusters !== undefined && a.n_clusters !== null) {
    const n = int(a.n_clusters);
    if (n === undefined || n < 2 || n > 50) {
      return { ok: false, error: "The number of groups is a whole number, 2 to 50." };
    }
    p.n_clusters = n;
  }
  if (a.feature_columns !== undefined && a.feature_columns !== null) {
    if (!Array.isArray(a.feature_columns)) {
      return { ok: false, error: "feature_columns is a list of column names." };
    }
    const names = a.feature_columns.map(str).filter((s): s is string => !!s);
    if (names.length) p.feature_columns = [...new Set(names)].slice(0, MAX_FEATURES);
  }
  const name = (str(a.name) ?? defaultModelName(p)).slice(0, MAX_NAME);
  return { ok: true, proposal: { name, ...p } };
}

const NUMERIC =
  /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|INT\d*|FLOAT\d*|REAL|DOUBLE( PRECISION)?|DECIMAL|NUMERIC)\b/i;
const TEMPORAL = /^(DATE|TIMESTAMP)/i;
const FLOATING = /^(FLOAT\d*|REAL|DOUBLE( PRECISION)?|DECIMAL|NUMERIC)\b/i;

export const isNumericType = (t: string) => NUMERIC.test(t.trim());
export const isTemporalType = (t: string) => TEMPORAL.test(t.trim());

/** A short list of a table's columns for an answer that has to name them. */
function listed(cols: TableColumn[], keep?: (c: TableColumn) => boolean): string {
  const shown = (keep ? cols.filter(keep) : cols).map((c) => `${c.name} (${c.type})`);
  if (shown.length === 0) return "none";
  return shown.length > 40 ? `${shown.slice(0, 40).join(", ")}, …` : shown.join(", ");
}

/**
 * The proposal against the table as it is: every named column exists (its
 * real spelling is kept), and each is the kind its role needs.
 */
export function checkAgainstColumns(p: MlTrainProposal, columns: TableColumn[]): Checked {
  const rel = `${p.source.schema}.${p.source.table}`;
  if (columns.length === 0) return { ok: false, error: `${rel} has no columns to train on.` };
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  const find = (name: string): TableColumn | null => byName.get(name.toLowerCase()) ?? null;
  const missing = (name: string) =>
    `${rel} has no column "${name}". Its columns: ${listed(columns)}.`;

  const out: MlTrainProposal = { ...p };
  for (const key of [
    "target_column",
    "time_column",
    "series_column",
    "user_column",
    "item_column",
    "rating_column",
  ] as const) {
    const name = p[key];
    if (!name) continue;
    const c = find(name);
    if (!c) return { ok: false, error: missing(name) };
    out[key] = c.name;
  }

  const target = out.target_column ? find(out.target_column) : null;
  if (target && (p.task === "regression" || p.task === "forecast") && !isNumericType(target.type)) {
    return {
      ok: false,
      error:
        p.task === "regression"
          ? `"${target.name}" holds ${target.type}, not numbers. A regression predicts a number; ` +
            `use classification to predict a category, or pick one of: ${listed(columns, (c) => isNumericType(c.type))}.`
          : `"${target.name}" holds ${target.type}, not numbers, so it cannot be forecast. ` +
            `Numeric columns: ${listed(columns, (c) => isNumericType(c.type))}.`,
    };
  }
  if (target && p.task === "classification" && isTemporalType(target.type)) {
    return {
      ok: false,
      error: `"${target.name}" holds ${target.type}: a date is not a class. Pick the column whose value you want predicted.`,
    };
  }
  const time = out.time_column ? find(out.time_column) : null;
  if (time && !isTemporalType(time.type)) {
    return {
      ok: false,
      error:
        `"${time.name}" holds ${time.type}, not a date or time. ` +
        `Date and time columns: ${listed(columns, (c) => isTemporalType(c.type))}.`,
    };
  }
  if (out.series_column) {
    const s = find(out.series_column)!;
    if (s.name === out.target_column || s.name === out.time_column) {
      return {
        ok: false,
        error: `"${s.name}" is already the ${s.name === out.target_column ? "target" : "time column"}; a series column is a category such as a region.`,
      };
    }
    if (isTemporalType(s.type) || FLOATING.test(s.type.trim())) {
      return {
        ok: false,
        error: `"${s.name}" holds ${s.type}: one forecast per value needs a category, such as a region or a product.`,
      };
    }
  }
  const rating = out.rating_column ? find(out.rating_column) : null;
  if (rating && !isNumericType(rating.type)) {
    return { ok: false, error: `"${rating.name}" holds ${rating.type}; a rating is a number.` };
  }
  if (out.user_column && out.user_column === out.item_column) {
    return { ok: false, error: "The user column and the item column must be different columns." };
  }

  if (p.feature_columns?.length) {
    const roles = new Set(
      [out.target_column, out.time_column, out.user_column, out.item_column, out.rating_column]
        .filter(Boolean)
        .map((s) => s!.toLowerCase()),
    );
    const features: string[] = [];
    for (const f of p.feature_columns) {
      const c = find(f);
      if (!c) return { ok: false, error: missing(f) };
      if (!roles.has(c.name.toLowerCase()) && !features.includes(c.name)) features.push(c.name);
    }
    if (features.length === 0) {
      // FOUND IN THE UI TEST: an agent sent the target as the only feature.
      // The answer says what to do, so the next call is right.
      return {
        ok: false,
        error:
          "feature_columns named only the column being predicted. Leave feature_columns out to read every other column, or name the input columns.",
      };
    }
    out.feature_columns = features;
  }
  return { ok: true, proposal: out };
}

/** What approving would do, in the words the inbox and the chat both show. */
export function describeProposal(p: MlTrainProposal): { title: string; lines: string[] } {
  const rel = `${p.source.schema}.${p.source.table}`;
  const per = p.period && p.period !== "auto" ? p.period : "period";
  const title =
    p.task === "classification"
      ? `Train "${p.name}": predict ${p.target_column}`
      : p.task === "regression"
        ? `Train "${p.name}": predict ${p.target_column} (a number)`
        : p.task === "forecast"
          ? `Train "${p.name}": forecast ${p.target_column} per ${per}`
          : p.task === "clustering"
            ? `Train "${p.name}": group the rows of ${p.source.table}`
            : p.task === "anomaly"
              ? `Train "${p.name}": find unusual rows in ${p.source.table}`
              : `Train "${p.name}": recommend ${p.item_column} to each ${p.user_column}`;
  const lines = [`From ${rel}.`];
  if (p.task === "forecast") {
    lines.push(
      `Along ${p.time_column}, ${p.horizon ?? 12} ${per}${(p.horizon ?? 12) === 1 ? "" : "s"} ahead.`,
    );
    if (p.series_column) lines.push(`One forecast per ${p.series_column}, beside the total.`);
  } else if (p.time_column) {
    lines.push(`Rows in time order by ${p.time_column}: tested on the latest ones.`);
  }
  if (p.task === "clustering") {
    lines.push(
      p.n_clusters
        ? `Into ${p.n_clusters} groups.`
        : "The number of groups is found from the data.",
    );
  }
  if (p.rating_column) lines.push(`Weighted by ${p.rating_column}.`);
  if (p.task !== "forecast" && p.task !== "recommendation") {
    lines.push(
      p.feature_columns?.length
        ? `Reading ${p.feature_columns.length === 1 ? "one column" : `${p.feature_columns.length} columns`}: ${p.feature_columns.slice(0, 12).join(", ")}${p.feature_columns.length > 12 ? ", …" : ""}.`
        : "Reading every other column.",
    );
  }
  lines.push(
    "Approving makes the model yours and starts training within the platform's limits; rejecting makes nothing.",
  );
  return { title: title.slice(0, 200), lines };
}

/** The proposal an approval holds, or null when it holds none. */
export function proposalFromPayload(payload: unknown): MlTrainProposal | null {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).proposal
      : null;
  const parsed = parseProposal(p);
  return parsed.ok ? parsed.proposal : null;
}

/** Two proposals for the same model (by name) are one question. */
export const sameModelName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
