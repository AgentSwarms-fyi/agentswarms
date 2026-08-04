// Format detection, type inference and value coercion for uploaded datasets.
//
// Pure — no Supabase, no AlaSQL, no Node built-ins — because both the browser
// (sqlEngine's CSV path) and the streaming server upload need EXACTLY the same
// answers. Two implementations of "is this column a date?" would eventually
// disagree, and the disagreement would show up as a chart that sorts wrongly.

export type ColumnType = "number" | "string" | "date";
export type ColumnDef = {
  name: string;
  type: ColumnType;
  /**
   * Every distinct value, for a STRING column that has few enough of them.
   *
   * This exists for the SQL-writing model. The schema block it is given lists
   * column names and types, and the prompt tells it to match string literals
   * exactly "as they appear in the schema" — but no values ever appeared
   * there, so on a column like `fraud_flag` it had to GUESS, and wrote
   * `= 'Yes'` against data holding `Y`. Measured on the NL-to-SQL eval, that
   * guess was the single largest cause of a query returning zero rows.
   *
   * Absent when the column is not a string, or has more distinct values than
   * are worth putting in a prompt.
   */
  values?: string[];
  /**
   * True when the column has at least one empty or null cell.
   *
   * Same reason `values` exists: the model can only reason about what the
   * schema shows it. A Region column holding three regions and three blanks
   * was rendered `Region (string) values=[AMER|APAC|EMEA]` — indistinguishable
   * from a column where every row has a region. Asked for "each region that
   * has one recorded", the model had no reason to exclude anything, and
   * reported the blank group as a region of its own.
   *
   * Deliberately a flag, not a count: the exact number changes on every
   * refresh and would make an otherwise-stable schema string churn.
   */
  hasBlanks?: boolean;
};

/** Most distinct values worth listing; beyond this a column is free-form. */
const MAX_ENUM_VALUES = 12;
/** Values longer than this are prose, not categories. */
const MAX_ENUM_VALUE_LEN = 40;

export type DatasetFormat = "csv" | "tsv" | "json" | "ndjson" | "xlsx";

/** Formats whose rows can be produced incrementally from a byte stream. */
export const STREAMING_FORMATS: DatasetFormat[] = ["csv", "tsv", "ndjson"];

export function isStreamingFormat(f: DatasetFormat): boolean {
  return STREAMING_FORMATS.includes(f);
}

export const UPLOAD_ACCEPT = ".csv,.tsv,.tab,.json,.ndjson,.jsonl,.xlsx";

/**
 * Prefix for the throwaway dataset an upload streams into before it is
 * promoted. Every listing must exclude it — a staging table is a half-written
 * dataset, not a dataset.
 */
export const STAGING_PREFIX = "__upload_";

/**
 * Decide how to read a file. Extension first — a browser's guess at the MIME
 * type of a .tsv or .ndjson is unreliable, while the extension is what the user
 * actually chose.
 */
export function detectFormat(filename: string, contentType?: string | null): DatasetFormat | null {
  const name = filename.toLowerCase().trim();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".tsv") || name.endsWith(".tab")) return "tsv";
  if (name.endsWith(".ndjson") || name.endsWith(".jsonl")) return "ndjson";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".xlsx")) return "xlsx";
  // .xls is the old binary format, which needs a different reader entirely.
  // Saying so beats failing with a confusing parse error.
  if (name.endsWith(".xls")) return null;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("csv")) return "csv";
  if (ct.includes("tab-separated")) return "tsv";
  if (ct.includes("json")) return "json";
  if (ct.includes("spreadsheetml")) return "xlsx";
  return null;
}

export function formatLabel(f: DatasetFormat): string {
  return { csv: "CSV", tsv: "TSV", json: "JSON", ndjson: "NDJSON", xlsx: "Excel" }[f];
}

export function delimiterFor(f: DatasetFormat): string {
  return f === "tsv" ? "\t" : ",";
}

/**
 * Sanitize a string into a safe SQL identifier — letters, digits and
 * underscores only, starting with a letter, lowercased.
 *
 * Lives here rather than in sqlEngine because the server upload route needs it
 * too, and importing sqlEngine server-side would drag AlaSQL and the browser
 * Supabase client into the server bundle.
 */
export function safeTableName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  if (!cleaned || !/^[a-z]/.test(cleaned)) return `t_${cleaned || "table"}`;
  return cleaned.slice(0, 48);
}

// ── Type inference ───────────────────────────────────────────────────────

export function inferType(value: unknown): ColumnType {
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    if (value === "") return "string";
    // ISO date / common date formats
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) return "date";
    // A LEADING ZERO FOLLOWED BY A DIGIT IS AN IDENTIFIER, NOT A QUANTITY.
    // Number("00123") is 123 and Number("01002") is 1002, so SKUs, ZIP codes,
    // account numbers and phone extensions silently lost their zeros and
    // became integers — the Excel bug people complain about, reproduced here.
    // It is not cosmetic: the value no longer joins against its source, and
    // "01002" displayed as 1002 is a different postcode.
    //
    // Narrow on purpose. "0" is a number, and so is "0.5" — only a zero with
    // another DIGIT after it is treated as an identifier.
    if (/^0\d/.test(value.trim())) return "string";
    const n = Number(value.replace(/,/g, ""));
    if (!Number.isNaN(n) && value.trim() !== "") return "number";
  }
  return "string";
}

/** How many non-empty values per column decide its type. */
export const TYPE_SAMPLE_ROWS = 50;

/**
 * Infer a column list from sample rows.
 *
 * Keys are unioned across the sample rather than taken from the first row:
 * JSON and NDJSON records routinely omit null fields, and reading only row one
 * would silently drop every column that happened to be absent there.
 */
export function inferColumns(rows: Record<string, unknown>[]): ColumnDef[] {
  if (rows.length === 0) return [];
  const headers: string[] = [];
  const seenHeader = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seenHeader.has(k)) {
        seenHeader.add(k);
        headers.push(k);
      }
    }
  }
  return headers.map((name) => {
    const counts = { number: 0, string: 0, date: 0 };
    let seen = 0;
    for (const r of rows) {
      const v = r[name];
      if (v === null || v === undefined || v === "") continue;
      counts[inferType(v)]++;
      seen++;
      if (seen >= TYPE_SAMPLE_ROWS) break;
    }
    // Whether ANY cell is empty. Scanned over the whole column rather than the
    // type sample, because a column can be dense at the top and sparse later —
    // which is exactly the shape that misleads anyone reading a preview.
    const hasBlanks = rows.some((r) => {
      const v = r[name];
      return v === null || v === undefined || v === "";
    });
    const blank = hasBlanks ? { hasBlanks: true as const } : {};

    const winner: ColumnType =
      counts.number > counts.string && counts.number >= counts.date
        ? "number"
        : counts.date > counts.string
          ? "date"
          : "string";
    if (winner !== "string") return { name, type: winner, ...blank };

    // Scan the WHOLE column, not the type sample: a category that appears only
    // late is exactly the literal a model would otherwise invent. Bail as soon
    // as the column proves too varied to be an enumeration.
    const distinct = new Set<string>();
    for (const r of rows) {
      const v = r[name];
      if (v === null || v === undefined || v === "") continue;
      const str = String(v);
      if (str.length > MAX_ENUM_VALUE_LEN) return { name, type: winner, ...blank };
      distinct.add(str);
      if (distinct.size > MAX_ENUM_VALUES) return { name, type: winner, ...blank };
    }
    if (distinct.size === 0) return { name, type: winner, ...blank };
    return { name, type: winner, values: [...distinct].sort(), ...blank };
  });
}

/** Coerce values to their inferred type so SQL can SUM, AVG and ORDER BY. */
export function coerceRow(
  row: Record<string, unknown>,
  cols: ColumnDef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const v = row[c.name];
    if (v === null || v === undefined || v === "") {
      out[c.name] = null;
      continue;
    }
    if (c.type === "number" && typeof v === "string") {
      const n = Number(v.replace(/,/g, ""));
      out[c.name] = Number.isNaN(n) ? v : n;
    } else if (v instanceof Date) {
      // Dates only ever reach here from Excel. Store the ISO day so they sort
      // and compare as text, which is what every downstream query assumes.
      out[c.name] = isoDay(v);
    } else if (typeof v === "object") {
      // A nested object/array has no cell representation; JSON keeps it
      // readable and queryable as text rather than rendering "[object Object]".
      out[c.name] = JSON.stringify(v);
    } else {
      out[c.name] = v;
    }
  }
  return out;
}

function isoDay(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  // Midnight UTC means a date-only cell; keep it date-only.
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

// ── Row shaping ──────────────────────────────────────────────────────────

/**
 * Turn one parsed record into a flat row of scalars.
 *
 * Blank and duplicate header names are the two things that break a dataset
 * downstream: an unnamed column cannot be referenced in SQL, and a duplicate
 * silently overwrites its twin.
 */
export function normaliseHeaders(headers: unknown[]): string[] {
  const out: string[] = [];
  const used = new Map<string, number>();
  headers.forEach((h, i) => {
    let name = String(h ?? "").trim();
    if (!name) name = `column_${i + 1}`;
    const seen = used.get(name);
    if (seen === undefined) {
      used.set(name, 1);
    } else {
      used.set(name, seen + 1);
      name = `${name}_${seen + 1}`;
    }
    out.push(name);
  });
  return out;
}

/** A record is worth keeping if it has at least one non-empty value. */
export function isMeaningfulRow(row: Record<string, unknown>): boolean {
  for (const v of Object.values(row)) {
    if (v !== null && v !== undefined && v !== "") return true;
  }
  return false;
}

/** JSON/NDJSON records must be objects; anything else has no columns. */
export function objectFromJson(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
