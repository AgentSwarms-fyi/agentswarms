// Dynamic array formulas in a written .xlsx (R161).
//
// Excel reads a formula in a file as one from before dynamic arrays unless
// its cell says otherwise. Where such a formula expects one value and meets a
// range, Excel takes the value in the formula's own row or column, and shows
// an @ there: =SUM(LEN(A1:A3)) in row 5 is #VALUE!, where this engine, as
// Excel 365 does, adds up all three lengths. An array formula over a range,
// without the mark, is the older Ctrl+Shift+Enter kind, fixed to its size: a
// FILTER that finds more rows in Excel is cut short.
//
// The mark is the cell's cm attribute, pointing at the workbook's metadata
// part: what Excel 365 writes for its own dynamic array formulas. ExcelJS
// writes neither, so both are added to its zip here.

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { sheetParts } from "./xlsxParts";

/** Excel's dynamic-array cell metadata: one XLDAPR record, fDynamic. */
export const DYNAMIC_METADATA_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">' +
  '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" ' +
  'pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" ' +
  'clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>' +
  '<futureMetadata name="XLDAPR" count="1"><bk><extLst>' +
  '<ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">' +
  '<xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>' +
  '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>';

const CT_METADATA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml";
const REL_METADATA =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata";

/**
 * Mark each listed cell as a dynamic array formula: its sheet's name (as in
 * the file) to the A1 addresses of the array formulas that start there.
 */
export function markDynamicArrays(buf: ArrayBuffer, cells: Map<string, string[]>): ArrayBuffer {
  if (![...cells.values()].some((a) => a.length)) return buf;
  const files = unzipSync(new Uint8Array(buf));
  const parts = sheetParts(files);
  let marked = 0;
  for (const [name, addrs] of cells) {
    const part = parts.find((p) => p.name === name)?.part;
    if (!part || !files[part] || !addrs.length) continue;
    const want = new Set(addrs);
    const xml = strFromU8(files[part]).replace(/<c r="([A-Z]+\d+)"/g, (m, at: string) => {
      if (!want.has(at)) return m;
      marked++;
      return `${m} cm="1"`;
    });
    files[part] = strToU8(xml);
  }
  if (!marked) return buf;
  files["xl/metadata.xml"] = strToU8(DYNAMIC_METADATA_XML);
  const ct = strFromU8(files["[Content_Types].xml"]);
  files["[Content_Types].xml"] = strToU8(
    ct.replace(
      "</Types>",
      `<Override PartName="/xl/metadata.xml" ContentType="${CT_METADATA}"/></Types>`,
    ),
  );
  const relsPart = "xl/_rels/workbook.xml.rels";
  const rels = strFromU8(files[relsPart]);
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const id = `rId${Math.max(0, ...ids) + 1}`;
  files[relsPart] = strToU8(
    rels.replace(
      "</Relationships>",
      `<Relationship Id="${id}" Type="${REL_METADATA}" Target="metadata.xml"/></Relationships>`,
    ),
  );
  const out = zipSync(files, { level: 6 });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
