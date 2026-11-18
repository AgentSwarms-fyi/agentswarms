// Barcodes for paginated reports (R508): Code 128 and QR.
//
// A purchase order, a delivery note and a shelf label carry a code a scanner
// reads. The report draws it as shapes, not as a picture, so it prints as
// sharp as the text beside it at any size: the preview as SVG rectangles, the
// PDF as filled rectangles.
//
// Code 128 is encoded here, because it is one table and a checksum. QR needs
// Reed-Solomon error correction and masking, so it comes from
// qrcode-generator (MIT, no dependencies).
import qrcode from "qrcode-generator";

export type BarcodeFormat = "code128" | "qr";

/**
 * Code 128 symbol patterns, values 0 to 106: the widths of bar, space, bar,
 * space, bar, space in modules. 103-105 start code sets A, B and C; 106 is the
 * stop, which has a seventh element (a final bar). Every pattern spans 11
 * modules (the stop 13) and its bars add up to an even number, which is how a
 * mistyped entry here is caught by the tests.
 */
// prettier-ignore
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/** The most characters a Code 128 block takes; past that a scanner struggles. */
export const CODE128_MAX = 48;

/** Why a value cannot be drawn as Code 128, or null when it can. */
export function code128Problem(value: string): string | null {
  if (!value) return "There is no value to encode";
  if (value.length > CODE128_MAX) return `Code 128 holds ${CODE128_MAX} characters here`;
  if (!/^[\x20-\x7e]*$/.test(value)) {
    return "Code 128 holds letters, digits and ASCII punctuation only";
  }
  return null;
}

/**
 * The symbol values for a value: code set C for runs of four or more digits
 * (two digits a symbol, so an order number stays short), code set B for the
 * rest, then the checksum and the stop.
 */
export function code128Values(value: string): number[] | null {
  if (code128Problem(value)) return null;
  const out: number[] = [];
  let set: "B" | "C" | null = null;
  let i = 0;
  const digitRun = (from: number) => {
    let n = 0;
    while (from + n < value.length && value[from + n] >= "0" && value[from + n] <= "9") n++;
    return n;
  };
  while (i < value.length) {
    const run = digitRun(i);
    // Set C pays off for four digits or more, or for an even run that is the
    // whole value; an odd run leaves its first digit to set B.
    const useC = run >= 4 || (run >= 2 && run === value.length && run % 2 === 0);
    if (useC) {
      const take = run % 2 === 0 ? run : run - 1;
      const start = run % 2 === 0 ? i : i + 1;
      if (start > i) {
        if (set !== "B") {
          out.push(set === null ? START_B : CODE_B);
          set = "B";
        }
        out.push(value.charCodeAt(i) - 32);
      }
      if (set !== "C") {
        out.push(set === null ? START_C : CODE_C);
        set = "C";
      }
      for (let k = start; k < start + take; k += 2) out.push(Number(value.slice(k, k + 2)));
      i = start + take;
      continue;
    }
    if (set !== "B") {
      out.push(set === null ? START_B : CODE_B);
      set = "B";
    }
    out.push(value.charCodeAt(i) - 32);
    i++;
  }
  // The checksum: the start value plus each symbol times its position, mod 103.
  let sum = out[0];
  for (let k = 1; k < out.length; k++) sum += out[k] * k;
  out.push(sum % 103, STOP);
  return out;
}

/**
 * The bars, as runs of modules from left to right: `true` a bar, `false` a
 * space. Quiet zones are the caller's (ten modules each side is the rule).
 */
export function code128Modules(value: string): boolean[] | null {
  const values = code128Values(value);
  if (!values) return null;
  const out: boolean[] = [];
  for (const v of values) {
    const widths = CODE128_PATTERNS[v];
    for (let e = 0; e < widths.length; e++) {
      const bar = e % 2 === 0;
      for (let n = 0; n < Number(widths[e]); n++) out.push(bar);
    }
  }
  return out;
}

/** The most characters a QR block takes here. */
export const QR_MAX = 600;

/** Why a value cannot be drawn as QR, or null when it can. */
export function qrProblem(value: string): string | null {
  if (!value) return "There is no value to encode";
  if (value.length > QR_MAX) return `A QR code holds ${QR_MAX} characters here`;
  return null;
}

/** UTF-8 bytes, as the library's byte mode expects them (its default is Latin-1). */
function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/**
 * The QR matrix for a value, row by row, `true` for a dark module; or null.
 * Error correction M (15% of the code can be lost and still read).
 */
export function qrMatrix(value: string): boolean[][] | null {
  if (qrProblem(value)) return null;
  const encode = qrcode.stringToBytes;
  try {
    qrcode.stringToBytes = utf8Bytes;
    const qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    return Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => qr.isDark(r, c)),
    );
  } catch {
    return null;
  } finally {
    qrcode.stringToBytes = encode;
  }
}

/** Why a value cannot be drawn in this format, or null. */
export function barcodeProblem(format: BarcodeFormat, value: string): string | null {
  return format === "qr" ? qrProblem(value) : code128Problem(value);
}

/** One filled rectangle, in points from the barcode's top-left corner. */
export type BarcodeRect = { x: number; y: number; w: number; h: number };

/**
 * The shapes to draw for a value: its width and height in points and the
 * dark rectangles inside them, or the reason it cannot be drawn. The preview
 * draws these as SVG and the PDF as filled rectangles, so the two cannot
 * disagree about a single bar.
 *
 * Code 128: one point per module (about 0.35 mm, which ordinary scanners
 * read), narrowed to fit `maxWidth`, with ten modules of quiet zone each side.
 * QR: a square `height` points across, four modules of quiet zone around it.
 * Runs of bars are merged into one rectangle each.
 */
export function barcodeShapes(
  format: BarcodeFormat,
  value: string,
  height: number,
  maxWidth: number,
): { width: number; height: number; rects: BarcodeRect[] } | { problem: string } {
  const problem = barcodeProblem(format, value);
  if (problem) return { problem };
  if (format === "qr") {
    const m = qrMatrix(value);
    if (!m) return { problem: "This value does not fit in a QR code" };
    const side = Math.min(height, maxWidth);
    const unit = side / (m.length + 8);
    const rects: BarcodeRect[] = [];
    m.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        if (!row[c]) {
          c++;
          continue;
        }
        let end = c;
        while (end < row.length && row[end]) end++;
        rects.push({ x: (c + 4) * unit, y: (r + 4) * unit, w: (end - c) * unit, h: unit });
        c = end;
      }
    });
    return { width: side, height: side, rects };
  }
  const modules = code128Modules(value);
  if (!modules) return { problem: "This value cannot be drawn as Code 128" };
  const total = modules.length + 20;
  const unit = Math.min(1, maxWidth / total);
  const rects: BarcodeRect[] = [];
  let i = 0;
  while (i < modules.length) {
    if (!modules[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < modules.length && modules[end]) end++;
    rects.push({ x: (i + 10) * unit, y: 0, w: (end - i) * unit, h: height });
    i = end;
  }
  return { width: total * unit, height, rects };
}
