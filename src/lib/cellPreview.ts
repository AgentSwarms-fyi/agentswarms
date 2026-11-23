// One value of a query result, as a grid shows it.
//
// A grid row is one line. Found in R529: a GitHub release's notes (4,000
// characters over 58 lines) and its assets (a 36,751-character JSON array),
// printed in full, made each row about 2,600 px tall and centred the short
// values a screen below the header. The SQL workbench said "10 rows" over what
// looked like an empty table. Every result grid shows a value through this, and
// the whole value is one click away (ResultValue).

/** Characters a cell shows before it shortens the value. */
export const CELL_PREVIEW_CHARS = 80;
/** Characters the whole-value view shows; the copy button copies all of it. */
export const CELL_FULL_CHARS = 200_000;

export type CellPreview = {
  /** One line: runs of whitespace (line breaks included) become one space. */
  text: string;
  /** Whether that line leaves something out: length, or line breaks. */
  clipped: boolean;
  /** Characters in the whole value. */
  length: number;
};

/** The value as text: objects and arrays as JSON, dates as ISO, never "[object Object]". */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === "object") {
    try {
      // DuckDB hands back BIGINTs inside lists and structs; JSON cannot hold them.
      return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? "";
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function cellPreview(v: unknown, max = CELL_PREVIEW_CHARS): CellPreview {
  const raw = valueText(v);
  const line = raw.replace(/\s+/g, " ").trim();
  const long = line.length > max;
  return {
    text: long ? `${line.slice(0, max).trimEnd()}…` : line,
    clipped: long || /[\r\n]/.test(raw.trim()),
    length: raw.length,
  };
}

/**
 * The whole value for reading: JSON (an object, or a string holding one)
 * indented, anything else as it is, capped at CELL_FULL_CHARS. Worked out only
 * when someone opens it.
 */
export function cellFull(v: unknown): string {
  const raw = valueText(v);
  let whole = raw;
  const head = raw.trimStart()[0];
  if (head === "{" || head === "[") {
    try {
      whole = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* text that only starts like JSON */
    }
  }
  return whole.length > CELL_FULL_CHARS ? `${whole.slice(0, CELL_FULL_CHARS)}…` : whole;
}
