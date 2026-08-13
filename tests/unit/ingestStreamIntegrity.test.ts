// Streamed CSV ingestion must produce EXACTLY the rows the file holds,
// whatever the network chunking.
//
// Found live, not hypothesized: PapaParse's `header: true` streaming mode ran
// its duplicate-HEADER rename against data rows it re-entered at chunk
// boundaries, and a fiscal calendar whose year-start equalled its
// period-start ("2025-01-14" in two columns) came back from upload with
// "2025-01-14_1" stored in three rows — silent value corruption that
// Validate's calendar probe then reported as sequence/start conflicts. The
// fix maps positional rows onto normaliseHeaders() and keeps Papa away from
// header semantics entirely. These tests drive the REAL streamDelimited with
// adversarial chunkings and diff against the whole-file truth.
import { describe, expect, it } from "vitest";

import { streamDelimited } from "@/utils/data/ingest.server";

const collectorSink = () => {
  const rows: Record<string, unknown>[] = [];
  return { rows, push: async (r: Record<string, unknown>) => void rows.push(r) };
};

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
};

// The shape that corrupted live: repeated values ACROSS columns (fy_start ==
// fp_start on every row of a fiscal year's first period) and repeated values
// DOWN columns.
const csv = (() => {
  const days = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(2025, 0, from + i)).toISOString().slice(0, 10),
    );
  const periods = [
    { fy: 1, fys: "2025-01-01", fp: 1, fps: "2025-01-01", ds: days(1, 4) },
    { fy: 1, fys: "2025-01-01", fp: 2, fps: "2025-01-05", ds: days(5, 4) },
    { fy: 1, fys: "2025-01-01", fp: 3, fps: "2025-01-09", ds: days(9, 5) },
    { fy: 2, fys: "2025-01-14", fp: 4, fps: "2025-01-14", ds: days(14, 4) },
    { fy: 2, fys: "2025-01-14", fp: 5, fps: "2025-01-18", ds: days(18, 4) },
    { fy: 2, fys: "2025-01-14", fp: 6, fps: "2025-01-22", ds: days(22, 5) },
  ];
  let out = "d,fy_seq,fy_start,fp_seq,fp_start\n";
  for (const p of periods) for (const d of p.ds) out += `${d},${p.fy},${p.fys},${p.fp},${p.fps}\n`;
  return out;
})();

const expectedRows = csv
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [d, fy_seq, fy_start, fp_seq, fp_start] = line.split(",");
    return { d, fy_seq, fy_start, fp_seq, fp_start };
  });

const CHUNKINGS: Array<{ label: string; chunks: string[] }> = [
  { label: "one chunk (the live corruption case)", chunks: [csv] },
  { label: "64-byte chunks", chunks: csv.match(/[\s\S]{1,64}/g)! },
  { label: "7-byte chunks", chunks: csv.match(/[\s\S]{1,7}/g)! },
  { label: "1-byte chunks", chunks: csv.split("") },
];

describe("streamed CSV rows equal the file, under every chunking", () => {
  for (const { label, chunks } of CHUNKINGS) {
    it(label, async () => {
      const sink = collectorSink();
      await streamDelimited(streamOf(chunks), "csv", sink, 10 * 1024 * 1024);
      expect(sink.rows).toEqual(expectedRows);
    });
  }

  it("no value anywhere gains a rename suffix", async () => {
    const sink = collectorSink();
    await streamDelimited(streamOf([csv]), "csv", sink, 10 * 1024 * 1024);
    const mangled = sink.rows.filter((r) => Object.values(r).some((v) => String(v).includes("_1")));
    expect(mangled).toEqual([]);
  });
});

describe("header handling stays exactly normaliseHeaders'", () => {
  it("blank and duplicate headers get positional/suffixed names; values untouched", async () => {
    const sink = collectorSink();
    await streamDelimited(streamOf(["a,,a\n1,2,3\n"]), "csv", sink, 1024);
    expect(sink.rows).toEqual([{ a: "1", column_2: "2", a_2: "3" }]);
  });

  it("a data row longer than the header keeps its tail as positional columns", async () => {
    const sink = collectorSink();
    await streamDelimited(streamOf(["a,b\n1,2,3\n"]), "csv", sink, 1024);
    expect(sink.rows).toEqual([{ a: "1", b: "2", column_3: "3" }]);
  });

  it("a short row fills missing cells with empty strings", async () => {
    const sink = collectorSink();
    await streamDelimited(streamOf(["a,b,c\n1,2\n"]), "csv", sink, 1024);
    expect(sink.rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("quoted newlines inside cells survive chunk splits", async () => {
    const text = 'a,b\n"line1\nline2",x\n';
    for (const chunks of [[text], text.split("")]) {
      const sink = collectorSink();
      await streamDelimited(streamOf(chunks), "csv", sink, 1024);
      expect(sink.rows).toEqual([{ a: "line1\nline2", b: "x" }]);
    }
  });
});
