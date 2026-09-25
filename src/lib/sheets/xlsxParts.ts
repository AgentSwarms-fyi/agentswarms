// Reading an .xlsx package's own parts, for what ExcelJS reads wrongly or not
// at all: the sheets' XML by sheet name, their relationships, and the raw
// text of data validation limits (ExcelJS turns a formula limit into NaN).

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";

export const unescXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** A relationship target resolved against the folder of the part that names it. */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The relationships part of a part: xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels. */
export const relsOf = (part: string) => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
};

export function readRels(
  files: Unzipped,
  part: string,
): { id: string; type: string; target: string }[] {
  const f = files[relsOf(part)];
  if (!f) return [];
  const out: { id: string; type: string; target: string }[] = [];
  for (const m of strFromU8(f).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    out.push({ id: attr("Id"), type: attr("Type"), target: unescXml(attr("Target")) });
  }
  return out;
}

/** Each sheet's name and its part, in workbook order. */
export function sheetParts(files: Unzipped): { name: string; part: string }[] {
  const wb = files["xl/workbook.xml"];
  if (!wb) return [];
  const rels = readRels(files, "xl/workbook.xml");
  const out: { name: string; part: string }[] = [];
  for (const m of strFromU8(wb).matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    const rel = rels.find((r) => r.id === rid);
    if (rel) out.push({ name, part: resolvePart("xl/workbook.xml", rel.target) });
  }
  return out;
}

/** The workbook's parts that describe sheets and what hangs off them (not the shared strings or styles). */
export function unzipSheetParts(data: ArrayBuffer): Unzipped | null {
  try {
    return unzipSync(new Uint8Array(data), {
      filter: (f) =>
        f.name === "xl/workbook.xml" ||
        f.name.endsWith(".rels") ||
        f.name.startsWith("xl/worksheets/") ||
        f.name.startsWith("xl/drawings/") ||
        f.name.startsWith("xl/charts/"),
    });
  } catch {
    return null;
  }
}

/**
 * Each data validation's limits as the file writes them, by the first cell
 * of its range ("B2"): the text ExcelJS parses into numbers and dates.
 */
export function validationFormulas(sheetXml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sheetXml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
    const sqref = /\bsqref="([^"]*)"/.exec(m[1])?.[1];
    if (!sqref) continue;
    const f1 = /<(?:x14:)?formula1>(?:<xm:f>)?([\s\S]*?)(?:<\/xm:f>)?<\/(?:x14:)?formula1>/.exec(
      m[2],
    );
    const f2 = /<(?:x14:)?formula2>(?:<xm:f>)?([\s\S]*?)(?:<\/xm:f>)?<\/(?:x14:)?formula2>/.exec(
      m[2],
    );
    const list = [f1, f2].filter((x): x is RegExpExecArray => !!x).map((x) => unescXml(x[1]));
    for (const ref of sqref.split(/\s+/)) {
      const first = ref.replace(/\$/g, "").split(":")[0];
      if (first) out.set(first, list);
    }
  }
  return out;
}

/**
 * Rewrite some parts of a written .xlsx. Only the named parts are touched;
 * the zip is rebuilt only when one of them changed.
 */
export function patchParts(
  buf: ArrayBuffer,
  wanted: (name: string) => boolean,
  patch: (name: string, xml: string) => string,
): ArrayBuffer {
  const files = unzipSync(new Uint8Array(buf));
  let changed = false;
  for (const name of Object.keys(files)) {
    if (!wanted(name)) continue;
    const before = strFromU8(files[name]);
    const after = patch(name, before);
    if (after !== before) {
      files[name] = strToU8(after);
      changed = true;
    }
  }
  if (!changed) return buf;
  const out = zipSync(files, { level: 6 });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Excel's text rules carry the text they look for (and "contains" its
 * operator) as attributes; ExcelJS writes only the formula. Put them back,
 * from the formula's own text, so Excel's rule dialog shows the rule.
 */
export function addTextRuleAttributes(xml: string): string {
  return xml.replace(
    /<cfRule\b([^>]*\btype="(containsText|notContainsText|beginsWith|endsWith)"[^>]*)>([\s\S]*?)<\/cfRule>/g,
    (whole, attrs: string, type: string, inner: string) => {
      if (/\btext="/.test(attrs)) return whole;
      const f = /<formula>([\s\S]*?)<\/formula>/.exec(inner)?.[1];
      const m = f ? /(?:SEARCH|LEN)\(&quot;((?:(?!&quot;,|&quot;\)).)*)&quot;/.exec(f) : null;
      if (!m) return whole;
      const text = unescXml(m[1]).replace(/""/g, '"');
      const op =
        type === "containsText"
          ? "containsText"
          : type === "notContainsText"
            ? "notContains"
            : type;
      const withOp = /\boperator="/.test(attrs) ? attrs : `${attrs} operator="${op}"`;
      return `<cfRule${withOp} text="${escAttr(text)}">${inner}</cfRule>`;
    },
  );
}
