// The text on a card (R500): a template filled from one row.
//
//   "{{given_name}} **{{family_name}}**"     → George Russell, surname bold
//   "**{{finish_position|ordinal}}** Place"  → 1st Place, the 1st bold
//   "{{points}} points"                      → 25 points
//
// {{column}} is the row's value, numbers formatted the way the visual
// formats them; {{column|ordinal}} writes 1 as "1st"; {{column|upper}} and
// {{column|lower}} change case. **text** is bold. A name the row does not
// have stays visible as written, so a typo shows rather than vanishing.
// Templates never produce markup: the result is text segments, drawn by React.

export type CardSegment = { text: string; bold: boolean };

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const v = Math.abs(Math.trunc(n));
  const teen = v % 100 >= 11 && v % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][v % 10] ?? "th");
  return `${Math.trunc(n)}${suffix}`;
}

function fill(template: string, row: Record<string, unknown>, fmt: (v: unknown) => string): string {
  return template.replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (whole, name, filter) => {
    if (!(name in row)) return whole;
    const v = row[name];
    if (v === null || v === undefined || v === "") return "";
    switch (filter) {
      case "ordinal": {
        const n = Number(v);
        return Number.isFinite(n) ? ordinal(n) : String(v);
      }
      case "upper":
        return String(v).toUpperCase();
      case "lower":
        return String(v).toLowerCase();
      default:
        return typeof v === "number" ? fmt(v) : String(v);
    }
  });
}

/** One line of a template, filled, split into bold and plain segments. */
export function cardLine(
  template: string,
  row: Record<string, unknown>,
  fmt: (v: unknown) => string,
): CardSegment[] {
  const text = fill(template, row, fmt);
  const out: CardSegment[] = [];
  const parts = text.split("**");
  // An unmatched ** leaves its text plain rather than bolding the rest.
  const closed = parts.length % 2 === 1;
  parts.forEach((p, i) => {
    if (!p) return;
    out.push({ text: p, bold: closed && i % 2 === 1 });
  });
  return out;
}

/** Every line of a multi-line template, blank lines dropped. */
export function cardLines(
  template: string | undefined,
  row: Record<string, unknown>,
  fmt: (v: unknown) => string,
): CardSegment[][] {
  if (!template) return [];
  return template
    .split("\n")
    .map((l) => cardLine(l, row, fmt))
    .filter((segs) => segs.some((s) => s.text.trim()));
}

/** The columns a template names, for checking it against the rows. */
export function templateColumns(template: string | undefined): string[] {
  if (!template) return [];
  return [...template.matchAll(/\{\{\s*([^}|]+?)\s*(?:\|\s*\w+\s*)?\}\}/g)].map((m) => m[1]);
}
