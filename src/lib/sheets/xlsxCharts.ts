// Charts into and out of an .xlsx. ExcelJS reads and writes cells, styles
// and tables but not charts, so charts travel as their own DrawingML parts,
// added to (or read from) the zip ExcelJS writes: a drawing per sheet anchors
// each chart to cells, and each chart part names the ranges it plots, which
// is what Excel reads and recalculates.

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { readRels, relsOf, resolvePart, sheetParts, unescXml as unesc } from "./xlsxParts";
import { colIndex, colLetters, parseRangeA1, rangeA1, type RangeAddr } from "./a1";
import {
  chartLayout,
  SERIES_COLORS,
  type ChartDef,
  type ChartLayout,
  type ChartType,
} from "./charts";
import type { Scalar } from "./formula/values";

const EMU_PER_PX = 9525;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function absRef(sheet: string, r: RangeAddr): string {
  const a = `$${colLetters(r.c0)}$${r.r0 + 1}`;
  const b = `$${colLetters(r.c1)}$${r.r1 + 1}`;
  return `${quoteSheet(sheet)}!${a === b ? a : `${a}:${b}`}`;
}

/** The references each series plots, following the same reading as charts.ts. */
export type SeriesRefs = { name?: string; cat?: string; val: string; x?: string };

export function seriesRefs(
  sheet: string,
  range: RangeAddr,
  layout: ChartLayout,
  scatter: boolean,
): SeriesRefs[] {
  const d0 = range.r0 + (layout.headerRow ? 1 : 0);
  const c0 = range.c0 + (layout.labelCol ? 1 : 0);
  const out: SeriesRefs[] = [];
  const cell = (r: number, c: number) => absRef(sheet, { r0: r, r1: r, c0: c, c1: c });
  if (scatter) {
    for (let c = range.c0 + 1; c <= range.c1; c++)
      out.push({
        name: layout.headerRow ? cell(range.r0, c) : undefined,
        x: absRef(sheet, { r0: d0, r1: range.r1, c0: range.c0, c1: range.c0 }),
        val: absRef(sheet, { r0: d0, r1: range.r1, c0: c, c1: c }),
      });
    return out;
  }
  if (layout.byCols) {
    for (let c = c0; c <= range.c1; c++)
      out.push({
        name: layout.headerRow ? cell(range.r0, c) : undefined,
        cat: layout.labelCol
          ? absRef(sheet, { r0: d0, r1: range.r1, c0: range.c0, c1: range.c0 })
          : undefined,
        val: absRef(sheet, { r0: d0, r1: range.r1, c0: c, c1: c }),
      });
  } else {
    for (let r = d0; r <= range.r1; r++)
      out.push({
        name: layout.labelCol ? cell(r, range.c0) : undefined,
        cat: layout.headerRow
          ? absRef(sheet, { r0: range.r0, r1: range.r0, c0: c0, c1: range.c1 })
          : undefined,
        val: absRef(sheet, { r0: r, r1: r, c0: c0, c1: range.c1 }),
      });
  }
  return out;
}

function serXml(
  s: SeriesRefs,
  i: number,
  type: ChartType,
  labels: boolean,
  smooth: boolean,
): string {
  const color = SERIES_COLORS[i % SERIES_COLORS.length].slice(1);
  const tx = s.name ? `<c:tx><c:strRef><c:f>${esc(s.name)}</c:f></c:strRef></c:tx>` : "";
  const line = type === "line" || type === "radar" || type === "scatter";
  const sp = line
    ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="${type === "scatter" ? "circle" : "none"}"/></c:marker>`
    : type === "pie" || type === "doughnut"
      ? ""
      : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
  const pct = type === "pie" || type === "doughnut";
  const dl = labels
    ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="${pct ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${pct ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
    : "";
  const cat = s.cat ? `<c:cat><c:strRef><c:f>${esc(s.cat)}</c:f></c:strRef></c:cat>` : "";
  const sm = `<c:smooth val="${smooth ? 1 : 0}"/>`;
  if (type === "scatter")
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}${dl}<c:xVal><c:numRef><c:f>${esc(s.x!)}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${esc(s.val)}</c:f></c:numRef></c:yVal>${sm}</c:ser>`;
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}${dl}${cat}<c:val><c:numRef><c:f>${esc(s.val)}</c:f></c:numRef></c:val>${type === "line" ? sm : ""}</c:ser>`;
}

const axisTitle = (t?: string) =>
  t
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    : "";

function axes(def: ChartDef, catId: number, valId: number, bar = false, scatter = false): string {
  const first = scatter
    ? `<c:valAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axisTitle(def.xTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
    : `<c:catAx><c:axId val="${catId}"/><c:scaling><c:orientation val="${bar ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${bar ? "l" : "b"}"/>${axisTitle(def.xTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`;
  const val = `<c:valAx><c:axId val="${valId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${bar ? "b" : "l"}"/><c:majorGridlines/>${axisTitle(def.yTitle)}<c:numFmt formatCode="${def.stacked === "percent" ? "0%" : "General"}" sourceLinked="${def.stacked === "percent" ? 0 : 1}"/><c:tickLblPos val="nextTo"/><c:crossAx val="${catId}"/><c:crosses val="${bar ? "max" : "autoZero"}"/><c:crossBetween val="${scatter ? "midCat" : "between"}"/></c:valAx>`;
  return first + val;
}

/** One chart part (xl/charts/chartN.xml). */
export function chartXml(def: ChartDef, refs: SeriesRefs[]): string {
  const grouping =
    def.stacked === "percent"
      ? "percentStacked"
      : def.stacked === "normal"
        ? "stacked"
        : "clustered";
  const lineGrouping =
    def.stacked === "percent"
      ? "percentStacked"
      : def.stacked === "normal"
        ? "stacked"
        : "standard";
  const overlap = def.stacked && def.stacked !== "none" ? `<c:overlap val="100"/>` : "";
  const labels = !!def.labels;
  const sers = (type: ChartType, from = 0, to = refs.length) =>
    refs
      .slice(from, to)
      .map((s, i) => serXml(s, from + i, type, labels, !!def.smooth))
      .join("");
  let plot: string;
  switch (def.type) {
    case "column":
    case "bar":
      plot = `<c:barChart><c:barDir val="${def.type === "bar" ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers(def.type)}<c:gapWidth val="150"/>${overlap}<c:axId val="10"/><c:axId val="20"/></c:barChart>${axes(def, 10, 20, def.type === "bar")}`;
      break;
    case "line":
      plot = `<c:lineChart><c:grouping val="${lineGrouping}"/><c:varyColors val="0"/>${sers("line")}<c:marker val="1"/><c:axId val="10"/><c:axId val="20"/></c:lineChart>${axes(def, 10, 20)}`;
      break;
    case "area":
      plot = `<c:areaChart><c:grouping val="${lineGrouping}"/><c:varyColors val="0"/>${sers("area")}<c:axId val="10"/><c:axId val="20"/></c:areaChart>${axes(def, 10, 20)}`;
      break;
    case "pie":
      plot = `<c:pieChart><c:varyColors val="1"/>${sers("pie", 0, 1)}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case "doughnut":
      plot = `<c:doughnutChart><c:varyColors val="1"/>${sers("doughnut", 0, 1)}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
      break;
    case "radar":
      plot = `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${sers("radar")}<c:axId val="10"/><c:axId val="20"/></c:radarChart>${axes(def, 10, 20)}`;
      break;
    case "scatter":
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers("scatter")}<c:axId val="10"/><c:axId val="20"/></c:scatterChart>${axes(def, 10, 20, false, true)}`;
      break;
    case "combo":
      // The first series as columns, the rest as lines, on one pair of axes.
      plot = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers("column", 0, 1)}<c:gapWidth val="150"/><c:axId val="10"/><c:axId val="20"/></c:barChart><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers("line", 1)}<c:marker val="1"/><c:axId val="10"/><c:axId val="20"/></c:lineChart>${axes(def, 10, 20)}`;
      break;
  }
  const title = def.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(def.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;
  const legendPos = def.legend === "top" ? "t" : def.legend === "right" ? "r" : "b";
  const legend =
    def.legend === "none"
      ? ""
      : `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/></c:legend>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

type Anchor = { col: number; colOff: number; row: number; rowOff: number };

/** The cell a pixel position falls in, and the offset into it (EMU). */
export function anchorAt(px: number, size: (i: number) => number, max: number): Anchor["col"][] {
  let i = 0;
  let at = 0;
  while (i < max - 1 && at + size(i) <= px) {
    at += size(i);
    i++;
  }
  return [i, Math.round((px - at) * EMU_PER_PX)];
}

function drawingXml(anchors: { from: Anchor; to: Anchor; rId: string; name: string }[]): string {
  const pt = (a: Anchor) =>
    `<xdr:col>${a.col}</xdr:col><xdr:colOff>${a.colOff}</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${a.rowOff}</xdr:rowOff>`;
  const one = (a: (typeof anchors)[number], i: number) =>
    `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${pt(a.from)}</xdr:from><xdr:to>${pt(a.to)}</xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${esc(a.name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${a.rId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map(one).join("")}</xdr:wsDr>`;
}

const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const RELS_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;

/** Where <drawing> goes in a worksheet: before the elements the schema puts after it. */
export function insertDrawingElement(sheetXml: string, rId: string): string {
  const el = `<drawing r:id="${rId}"/>`;
  let xml = sheetXml;
  // The r: prefix must be declared on the worksheet.
  if (!/<worksheet[^>]*xmlns:r=/.test(xml))
    xml = xml.replace(
      /<worksheet\b/,
      '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    );
  for (const tag of [
    "<legacyDrawing",
    "<legacyDrawingHF",
    "<drawingHF",
    "<picture",
    "<oleObjects",
    "<controls",
    "<webPublishItems",
    "<tableParts",
    "<extLst",
  ]) {
    const i = xml.indexOf(tag);
    if (i >= 0) return xml.slice(0, i) + el + xml.slice(i);
  }
  const end = xml.lastIndexOf("</worksheet>");
  return xml.slice(0, end) + el + xml.slice(end);
}

export type ChartSheet = {
  /** The sheet's name in the file (after any shortening). */
  name: string;
  charts: ChartDef[];
  value: (row: number, col: number) => Scalar;
  colPx: (c: number) => number;
  rowPx: (r: number) => number;
};

/** Add every sheet's charts to a written .xlsx. */
export function addChartsToXlsx(buf: ArrayBuffer, sheets: ChartSheet[]): ArrayBuffer {
  if (!sheets.some((s) => s.charts.length)) return buf;
  const files = unzipSync(new Uint8Array(buf));
  const parts = sheetParts(files);
  let ct = strFromU8(files["[Content_Types].xml"]);
  let chartNo = 0;
  let drawingNo = 0;
  const taken = (p: string) => p in files;
  for (const s of sheets) {
    if (!s.charts.length) continue;
    const part = parts.find((p) => p.name === s.name)?.part;
    if (!part || !files[part]) continue;
    do drawingNo++;
    while (taken(`xl/drawings/drawing${drawingNo}.xml`));
    const drawingPart = `xl/drawings/drawing${drawingNo}.xml`;
    const anchors: { from: Anchor; to: Anchor; rId: string; name: string }[] = [];
    const drawingRels: string[] = [];
    s.charts.forEach((def, i) => {
      const range = parseRangeA1(def.range.replace(/\$/g, ""));
      if (!range) return;
      do chartNo++;
      while (taken(`xl/charts/chart${chartNo}.xml`));
      const layout = chartLayout(def, range, s.value);
      const refs = seriesRefs(s.name, range, layout, def.type === "scatter");
      if (!refs.length) return;
      files[`xl/charts/chart${chartNo}.xml`] = strToU8(chartXml(def, refs));
      ct = ct.replace(
        "</Types>",
        `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="${CT_CHART}"/></Types>`,
      );
      const rId = `rId${i + 1}`;
      drawingRels.push(
        `<Relationship Id="${rId}" Type="${REL_CHART}" Target="../charts/chart${chartNo}.xml"/>`,
      );
      const [fc, fco] = anchorAt(def.x, s.colPx, 16_384);
      const [fr, fro] = anchorAt(def.y, s.rowPx, 1_048_576);
      const [tc, tco] = anchorAt(def.x + def.w, s.colPx, 16_384);
      const [tr, tro] = anchorAt(def.y + def.h, s.rowPx, 1_048_576);
      anchors.push({
        from: { col: fc, colOff: fco, row: fr, rowOff: fro },
        to: { col: tc, colOff: tco, row: tr, rowOff: tro },
        rId,
        name: def.title || `Chart ${i + 1}`,
      });
    });
    if (!anchors.length) continue;
    files[drawingPart] = strToU8(drawingXml(anchors));
    files[relsOf(drawingPart)] = strToU8(`${RELS_HEAD}${drawingRels.join("")}</Relationships>`);
    ct = ct.replace(
      "</Types>",
      `<Override PartName="/${drawingPart}" ContentType="${CT_DRAWING}"/></Types>`,
    );
    // The sheet points at its drawing.
    const sheetRels = relsOf(part);
    const existing = files[sheetRels]
      ? strFromU8(files[sheetRels])
      : `${RELS_HEAD}</Relationships>`;
    let rid = "rIdDrawing1";
    for (let k = 1; existing.includes(`Id="${rid}"`); k++) rid = `rIdDrawing${k + 1}`;
    files[sheetRels] = strToU8(
      existing.replace(
        "</Relationships>",
        `<Relationship Id="${rid}" Type="${REL_DRAWING}" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`,
      ),
    );
    files[part] = strToU8(insertDrawingElement(strFromU8(files[part]), rid));
  }
  files["[Content_Types].xml"] = strToU8(ct);
  const out = zipSync(files, { level: 6 });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** A reference in a chart ("Sheet1!$B$2:$B$13") as its sheet and range. */
function parseRef(f: string): { sheet: string; range: RangeAddr } | null {
  const m =
    /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(
      f.trim(),
    );
  if (!m) return null;
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
  const c0 = colIndex(m[3]);
  const r0 = Number(m[4]) - 1;
  const c1 = m[5] ? colIndex(m[5]) : c0;
  const r1 = m[6] ? Number(m[6]) - 1 : r0;
  return {
    sheet,
    range: {
      r0: Math.min(r0, r1),
      r1: Math.max(r0, r1),
      c0: Math.min(c0, c1),
      c1: Math.max(c0, c1),
    },
  };
}

function chartFromXml(
  xml: string,
  sheet: string,
): { def: Omit<ChartDef, "id" | "x" | "y" | "w" | "h"> | null; why?: string } {
  const has = (tag: string) => new RegExp(`<c:${tag}\\b`).test(xml);
  let type: ChartType | null = null;
  const barDir = /<c:barDir val="(\w+)"/.exec(xml)?.[1];
  if (has("barChart") && has("lineChart")) type = "combo";
  else if (has("barChart")) type = barDir === "bar" ? "bar" : "column";
  else if (has("lineChart")) type = "line";
  else if (has("areaChart")) type = "area";
  else if (has("doughnutChart")) type = "doughnut";
  else if (has("pieChart")) type = "pie";
  else if (has("scatterChart")) type = "scatter";
  else if (has("radarChart")) type = "radar";
  if (!type) return { def: null, why: "a chart type Sheets does not draw yet" };
  const grouping = /<c:grouping val="(\w+)"/.exec(xml)?.[1];
  const stacked =
    grouping === "percentStacked" ? "percent" : grouping === "stacked" ? "normal" : undefined;
  // Every reference the series plot; the chart's range is the block they cover.
  const refs = [...xml.matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((m) => parseRef(unesc(m[1])));
  if (!refs.length || refs.some((r) => !r))
    return { def: null, why: "a chart whose data is not a plain range" };
  if (refs.some((r) => r!.sheet.toLowerCase() !== sheet.toLowerCase()))
    return { def: null, why: "a chart of another sheet's data" };
  const all = refs.map((r) => r!.range);
  const range = {
    r0: Math.min(...all.map((r) => r.r0)),
    r1: Math.max(...all.map((r) => r.r1)),
    c0: Math.min(...all.map((r) => r.c0)),
    c1: Math.max(...all.map((r) => r.c1)),
  };
  // Series values down a column each, or along a row each.
  const vals = [...xml.matchAll(/<c:(?:val|yVal)>\s*<c:numRef>\s*<c:f>([^<]*)<\/c:f>/g)]
    .map((m) => parseRef(unesc(m[1]))?.range)
    .filter((r): r is RangeAddr => !!r);
  const seriesIn: ChartDef["seriesIn"] =
    type === "scatter" || !vals.length
      ? "auto"
      : vals.every((r) => r.c0 === r.c1) && !vals.every((r) => r.r0 === r.r1)
        ? "cols"
        : vals.every((r) => r.r0 === r.r1) && !vals.every((r) => r.c0 === r.c1)
          ? "rows"
          : "auto";
  // The chart's own title (not an axis's): the first <c:title> directly under <c:chart>.
  const chartTitle = /<c:chart>\s*<c:title>([\s\S]*?)<\/c:title>/.exec(xml)?.[1];
  const title = chartTitle
    ? [...chartTitle.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unesc(m[1])).join("") || undefined
    : undefined;
  const axisTitles = [...xml.matchAll(/<c:(?:catAx|valAx)>([\s\S]*?)<\/c:(?:catAx|valAx)>/g)].map(
    (m) => {
      const t = /<c:title>([\s\S]*?)<\/c:title>/.exec(m[1])?.[1];
      return t ? [...t.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => unesc(x[1])).join("") : "";
    },
  );
  const legendPos = /<c:legendPos val="(\w+)"/.exec(xml)?.[1];
  const legend: ChartDef["legend"] = !has("legend")
    ? "none"
    : legendPos === "t"
      ? "top"
      : legendPos === "r"
        ? "right"
        : "bottom";
  const labels = /<c:showVal val="1"\/>|<c:showPercent val="1"\/>/.test(xml) || undefined;
  const smooth = /<c:smooth val="1"\/>/.test(xml) || undefined;
  return {
    def: {
      type,
      range: rangeA1(range),
      ...(title ? { title } : {}),
      ...(seriesIn !== "auto" ? { seriesIn } : {}),
      ...(stacked && type !== "pie" && type !== "doughnut" ? { stacked } : {}),
      legend,
      ...(labels ? { labels } : {}),
      ...(smooth ? { smooth } : {}),
      ...(axisTitles[0] ? { xTitle: axisTitles[0] } : {}),
      ...(axisTitles[1] ? { yTitle: axisTitles[1] } : {}),
    },
  };
}

/**
 * The charts in an .xlsx, per sheet name, placed in 100%-zoom pixels by the
 * sheet's own widths and heights. A chart this grid cannot draw (another
 * sheet's data, a type it lacks) is left out with a reason.
 */
export function readXlsxCharts(
  files: Unzipped | null,
  sizes: (sheet: string) => { colPx: (c: number) => number; rowPx: (r: number) => number } | null,
): { charts: Map<string, ChartDef[]>; skipped: string[] } {
  const charts = new Map<string, ChartDef[]>();
  const skipped: string[] = [];
  if (!files) return { charts, skipped };
  let n = 0;
  for (const { name, part } of sheetParts(files)) {
    const size = sizes(name);
    if (!size) continue;
    const drawingRel = readRels(files, part).find((r) => r.type === REL_DRAWING);
    if (!drawingRel) continue;
    const drawingPart = resolvePart(part, drawingRel.target);
    const dxml = files[drawingPart] ? strFromU8(files[drawingPart]) : "";
    const drels = readRels(files, drawingPart);
    const px = (a: string, which: "col" | "row") => {
      const i = Number(new RegExp(`<xdr:${which}>(\\d+)</xdr:${which}>`).exec(a)?.[1] ?? 0);
      const off = Number(
        new RegExp(`<xdr:${which}Off>(-?\\d+)</xdr:${which}Off>`).exec(a)?.[1] ?? 0,
      );
      const f = which === "col" ? size.colPx : size.rowPx;
      let at = 0;
      for (let k = 0; k < Math.min(i, which === "col" ? 16_384 : 100_000); k++) at += f(k);
      return at + off / EMU_PER_PX;
    };
    for (const m of dxml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g)) {
      const a = m[0];
      const rid = /<c:chart\b[^>]*r:id="([^"]*)"/.exec(a)?.[1];
      if (!rid) continue;
      const rel = drels.find((r) => r.id === rid);
      const cpart = rel ? resolvePart(drawingPart, rel.target) : "";
      const cxml = files[cpart] ? strFromU8(files[cpart]) : "";
      const { def, why } = chartFromXml(cxml, name);
      if (!def) {
        skipped.push(`${name}: ${why}`);
        continue;
      }
      const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(a)?.[1] ?? "";
      const to = /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(a)?.[1];
      const ext = /<xdr:ext cx="(\d+)" cy="(\d+)"/.exec(a);
      const x = Math.round(px(from, "col"));
      const y = Math.round(px(from, "row"));
      const w = to ? Math.round(px(to, "col") - x) : Math.round(Number(ext?.[1] ?? 0) / EMU_PER_PX);
      const h = to ? Math.round(px(to, "row") - y) : Math.round(Number(ext?.[2] ?? 0) / EMU_PER_PX);
      const list = charts.get(name) ?? [];
      list.push({
        id: `c${++n}`,
        ...def,
        x,
        y,
        w: Math.max(200, w || 480),
        h: Math.max(140, h || 300),
      });
      charts.set(name, list);
    }
  }
  return { charts, skipped };
}
