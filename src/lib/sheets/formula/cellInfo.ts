// What CELL and INFO tell about a cell and the workbook (R339).
//
// CELL's page in Excel's documentation lists its info types and the codes
// "format" gives for the built-in number formats. Several of them ("format",
// "color", "parentheses", "prefix", "protect", "width", "filename") are "not
// supported in Excel for the web"; Sheets answers them from what it keeps
// about a cell. INFO "is not available in Excel Web App"; Sheets answers
// what a browser can know, and says where its answer is its own.

/** The sections of a number format, split at ; outside quotes and brackets. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\" && !quoted && i + 1 < code.length) {
      cur += ch + code[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A section with its literal text taken out: "…", \x, _x (a space), *x (a fill), [Red]. */
function bare(section: string): string {
  return section
    .replace(/\[(h+|m+|s+)\]/gi, "$1")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[[^\]]*\]/g, "");
}

const COLOR = /\[(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)\]/i;

/** Digits after the decimal point. */
const decimals = (b: string) => b.split(".")[1]?.match(/^[0#?]+/)?.[0].length ?? 0;

/**
 * CELL("format"): the page's code for a number format. General is "G", 0.00
 * is "F2", #,##0 is ",0", $#,##0.00_);($#,##0.00) is "C2", 0% is "P0",
 * 0.00E+00 is "S2", a fraction is "G", and dates and times are D1 to D9 by
 * the page's table. "-" follows when negative numbers have a color, "()"
 * when positive ones are in parentheses. A format of Sheets' own (yyyy-mm-dd)
 * takes the code of the page's format it is most like (m/d/yy: "D4").
 */
export function formatCode(code: string | undefined): string {
  const f = (code ?? "").trim();
  if (!f || /^general$/i.test(f)) return "G";
  const [first, second] = sections(f);
  const b = bare(first).toLowerCase();
  const suffix =
    (second !== undefined && COLOR.test(second) ? "-" : "") + (/\(/.test(b) ? "()" : "");
  if (b.trim() === "@") return "G";
  const hasH = /h/.test(b);
  const hasS = /s/.test(b);
  const hasD = /d/.test(b);
  const hasY = /y/.test(b);
  const named = /mmm/.test(b);
  if (hasD || hasY || named || (!hasH && !hasS && /m/.test(b))) {
    if (named) return hasD && hasY ? "D1" : hasD ? "D2" : "D3";
    return hasY ? "D4" : "D5";
  }
  if (hasH || hasS) {
    const ampm = /am\/pm|a\/p/.test(b);
    return hasS ? (ampm ? "D6" : "D8") : ampm ? "D7" : "D9";
  }
  if (/\?\s*\/|#\s+\?/.test(b)) return "G";
  const n = decimals(b);
  if (/%/.test(b)) return `P${n}${suffix}`;
  if (/e[+-]/.test(b)) return `S${n}${suffix}`;
  if (/\$|€|£|¥|\[\$/.test(first)) return `C${n}${suffix}`;
  if (/,/.test(b.split(".")[0])) return `,${n}${suffix}`;
  return `F${n}${suffix}`;
}

/** CELL("color"): 1 when negative numbers are shown in a color. */
export const negativeColor = (code: string | undefined): 0 | 1 => {
  const second = sections((code ?? "").trim())[1];
  return second !== undefined && COLOR.test(second) ? 1 : 0;
};

/** CELL("parentheses"): 1 when positive numbers, or all, are shown in parentheses. */
export const parentheses = (code: string | undefined): 0 | 1 =>
  /\(/.test(bare(sections((code ?? "").trim())[0])) ? 1 : 0;

/** CELL("prefix"): ' left, " right, ^ centred, for text typed into the cell; "" otherwise. */
export function prefix(isText: boolean, align: "left" | "center" | "right" | undefined): string {
  if (!isText) return "";
  return align === "right" ? '"' : align === "center" ? "^" : "'";
}

/**
 * CELL("width"): the column's width in characters of the default font,
 * rounded, and whether it is the default. Pixels convert as a download writes
 * them (xlsx.ts's pxToWidth: 7 pixels a character, plus 5), so the 104-pixel
 * default is 14.
 */
export const widthInChars = (px: number): number => Math.max(0, Math.round((px - 5) / 7));

/** The default column's width in pixels, as the grid draws it and a download writes it. */
export const DEFAULT_COLUMN_PX = 104;
