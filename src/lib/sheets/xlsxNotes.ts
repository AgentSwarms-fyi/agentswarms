// Cell notes (Excel's comments) in an .xlsx, read here rather than by the
// file library.
// FOUND IN R152: ExcelJS reads comments only where Excel itself puts them
// (xl/commentsN.xml, named "../commentsN.xml"). openpyxl, which much
// Python-made reporting uses, writes xl/comments/commentN.xml with an
// absolute target, and ExcelJS threw while loading ("Cannot read properties
// of undefined (reading 'comments')"): such a file could not be imported at
// all. Notes are now read from the package directly, whatever the layout,
// and the file library is never shown them.

import { strFromU8, type Unzipped } from "fflate";
import { patchParts, readRels, resolvePart, unescXml } from "./xlsxParts";

const COMMENTS = /\/relationships\/comments$/;
const THREADED = /\/relationships\/threadedComment$/;
const VML = /\/relationships\/vmlDrawing$/;
/** What ExcelJS writes as every note's author (comments-xform.js). */
const EXCELJS_AUTHOR = "Author";

/** The longest note kept, as Excel's own limit on a cell's text. */
export const MAX_NOTE = 32767;

/** The text of a <text> run list: every <t>, in order, entities decoded. */
function runText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g))
    out += unescXml(m[1] ?? "");
  return out;
}

/**
 * A sheet part's notes by A1 reference. A threaded comment (Excel 365) is
 * read from its own part, replies after the first; the legacy note Excel
 * writes beside it for older readers only says to open a newer Excel.
 * The author leads the text, as Excel shows a note ("Asha:" on its own line).
 */
export function sheetNotes(files: Unzipped, sheetPart: string): Map<string, string> {
  const out = new Map<string, string>();
  const rels = readRels(files, sheetPart);
  for (const rel of rels.filter((r) => COMMENTS.test(r.type))) {
    const f = files[resolvePart(sheetPart, rel.target)];
    if (!f) continue;
    const xml = strFromU8(f);
    // ExcelJS, which writes this app's downloads, names every note's author
    // "Author"; read back, that would lead each note with "Author:", again on
    // every round trip. It is a placeholder, not a person.
    const authors = [...xml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) => {
      const a = unescXml(m[1]).trim();
      return a === EXCELJS_AUTHOR ? "" : a;
    });
    for (const m of xml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
      const ref = /\bref="([A-Z]+\d+)"/.exec(m[1])?.[1];
      if (!ref) continue;
      const author = authors[Number(/\bauthorId="(\d+)"/.exec(m[1])?.[1] ?? -1)] ?? "";
      const text = runText(/<text>([\s\S]*?)<\/text>/.exec(m[2])?.[1] ?? "").replace(
        /\r\n?/g,
        "\n",
      );
      out.set(ref, withAuthor(author, text));
    }
  }
  for (const rel of rels.filter((r) => THREADED.test(r.type))) {
    const f = files[resolvePart(sheetPart, rel.target)];
    if (!f) continue;
    const people = personNames(files);
    const threads = new Map<string, string[]>();
    for (const m of strFromU8(f).matchAll(
      /<threadedComment\b([^>]*)>([\s\S]*?)<\/threadedComment>/g,
    )) {
      const ref = /\bref="([A-Z]+\d+)"/.exec(m[1])?.[1];
      if (!ref) continue;
      const who = people.get(/\bpersonId="([^"]*)"/.exec(m[1])?.[1] ?? "") ?? "";
      const text = unescXml(/<text>([\s\S]*?)<\/text>/.exec(m[2])?.[1] ?? "");
      const list = threads.get(ref) ?? [];
      list.push(withAuthor(who, text));
      threads.set(ref, list);
    }
    for (const [ref, list] of threads) out.set(ref, list.join("\n\n"));
  }
  for (const [ref, text] of out) out.set(ref, text.slice(0, MAX_NOTE));
  return out;
}

function withAuthor(author: string, text: string): string {
  const t = text.trim();
  if (!author || t.toLowerCase().startsWith(`${author.toLowerCase()}:`)) return t;
  return `${author}:\n${t}`;
}

/** Excel 365's people, by id, for a threaded comment's author. */
function personNames(files: Unzipped): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (!/^xl\/persons\/[^/]+\.xml$/.test(name)) continue;
    for (const m of strFromU8(data).matchAll(/<person\b([^>]*)\/?>/g)) {
      const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
      const n = /\bdisplayName="([^"]*)"/.exec(m[1])?.[1];
      if (id && n) out.set(id, unescXml(n));
    }
  }
  return out;
}

/**
 * The package without its comment relationships, for the file library to
 * load: the notes are read by sheetNotes, and a layout it does not expect
 * (openpyxl's) no longer stops the whole import. The same buffer comes back
 * when there were none.
 */
export function withoutCommentRels(data: ArrayBuffer): ArrayBuffer {
  return patchParts(
    data,
    (name) => /^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name),
    (_name, xml) =>
      xml.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
        const type = /\bType="([^"]*)"/.exec(rel)?.[1] ?? "";
        return COMMENTS.test(type) || THREADED.test(type) || VML.test(type) ? "" : rel;
      }),
  );
}
