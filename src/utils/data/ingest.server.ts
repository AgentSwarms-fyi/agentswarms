// Server-side dataset ingest: parse an uploaded file and materialise it as a
// dataset, without ever holding the whole file — or the whole table — in
// memory.
//
// Why this exists: uploads used to be parsed in the browser with PapaParse and
// inserted row-by-row over RLS from the tab. That capped a "dataset" at
// whatever fitted in a laptop's spare RAM, made a 200k-row CSV a multi-minute
// progress bar, and supported exactly one format.
//
// Two properties are worth protecting when changing this file:
//
//   1. **Streaming.** CSV/TSV/NDJSON are consumed incrementally and flushed in
//      batches, so peak memory is one batch, not one file. JSON arrays and
//      .xlsx are structurally un-streamable (you cannot know the last element
//      of a JSON array without reading it, and .xlsx is a zip), so they are
//      buffered under an explicit byte cap rather than pretending otherwise.
//
//   2. **A failed upload must not destroy the previous dataset.** Rows land in
//      a STAGING table first and are re-pointed to the target in one statement
//      once the parse has fully succeeded. A parse error, a row-cap breach or a
//      dropped connection therefore leaves the existing data exactly as it was.

import { Readable } from "node:stream";
import Papa from "papaparse";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  coerceRow,
  delimiterFor,
  formatLabel,
  inferColumns,
  isMeaningfulRow,
  isStreamingFormat,
  normaliseHeaders,
  objectFromJson,
  STAGING_PREFIX,
  TYPE_SAMPLE_ROWS,
  type ColumnDef,
  type DatasetFormat,
} from "@/lib/datasetParse";

/** Largest upload accepted, in bytes. */
export function uploadMaxBytes(): number {
  const n = Number(process.env.UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 100 * 1024 * 1024;
}

/** Largest dataset accepted, in rows. */
export function uploadMaxRows(): number {
  const n = Number(process.env.UPLOAD_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? n : 500_000;
}

const INSERT_BATCH = 500;

export type IngestResult = {
  tableId: string;
  tableName: string;
  rowCount: number;
  columns: ColumnDef[];
  format: DatasetFormat;
  /** Rows skipped because they had no usable content. */
  skipped: number;
};

class IngestError extends Error {}

/**
 * Rows arrive one at a time; columns are decided once, from the first sample.
 *
 * Inference has to happen before the first flush — the alternative is holding
 * every row until the end, which is the thing this whole module avoids. The
 * sample size matches the browser path exactly, so an upload's schema does not
 * depend on which code path read it.
 */
class RowSink {
  private sample: Record<string, unknown>[] = [];
  private buffer: Record<string, unknown>[] = [];
  columns: ColumnDef[] | null = null;
  count = 0;
  skipped = 0;

  constructor(
    private readonly stagingId: string,
    private readonly maxRows: number,
  ) {}

  async push(raw: Record<string, unknown>): Promise<void> {
    if (!isMeaningfulRow(raw)) {
      this.skipped++;
      return;
    }
    if (this.count >= this.maxRows) {
      throw new IngestError(
        `This file has more than ${this.maxRows.toLocaleString()} rows, the configured import limit. ` +
          `Split the file, or raise UPLOAD_MAX_ROWS.`,
      );
    }
    this.count++;

    if (!this.columns) {
      this.sample.push(raw);
      if (this.sample.length >= TYPE_SAMPLE_ROWS) this.decideColumns();
      return;
    }
    this.buffer.push(coerceRow(raw, this.columns));
    if (this.buffer.length >= INSERT_BATCH) await this.flush();
  }

  private decideColumns(): void {
    this.columns = inferColumns(this.sample);
    for (const r of this.sample) this.buffer.push(coerceRow(r, this.columns));
    this.sample = [];
  }

  /** Flush the buffer, then any rows still held for type inference. */
  async finish(): Promise<void> {
    if (!this.columns && this.sample.length > 0) this.decideColumns();
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const slice = this.buffer;
    this.buffer = [];
    const { error } = await supabaseAdmin
      .from("user_data_rows")
      .insert(slice.map((row) => ({ table_id: this.stagingId, row: row as unknown as Json })));
    if (error) throw new IngestError(error.message);
  }
}

/** A byte counter that refuses to exceed the upload cap. */
function guardedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new IngestError(
              `This file is larger than the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB upload limit. ` +
                `Raise UPLOAD_MAX_BYTES to accept it.`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function readAll(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = guardedStream(body, maxBytes).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ── Per-format readers ───────────────────────────────────────────────────

/** CSV / TSV via PapaParse's Node stream interface (quoted newlines included). */
async function streamDelimited(
  body: ReadableStream<Uint8Array>,
  format: DatasetFormat,
  sink: RowSink,
  maxBytes: number,
): Promise<void> {
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    skipEmptyLines: true,
    // We coerce ourselves, so date-looking strings must stay strings.
    dynamicTyping: false,
    delimiter: delimiterFor(format),
    transformHeader: (h, i) => (String(h ?? "").trim() ? String(h).trim() : `column_${i + 1}`),
  });

  const node = Readable.fromWeb(
    guardedStream(body, maxBytes) as Parameters<typeof Readable.fromWeb>[0],
  );
  // `pipe` does not forward errors, so a byte-cap breach upstream would
  // otherwise hang the consumer below instead of failing it.
  node.on("error", (e) => parser.destroy(e));
  node.pipe(parser);

  // Iterating the stream is what makes this genuinely streamed: the loop pulls
  // the next row only once the previous batch has been written, so Papa cannot
  // outrun the database and peak memory stays at one batch.
  for await (const row of parser as AsyncIterable<Record<string, unknown>>) {
    await sink.push(row);
  }
}

/**
 * NDJSON: one JSON value per line. Splitting on "\n" is safe because a literal
 * newline cannot appear inside a JSON string — it must be escaped as \n.
 */
async function streamNdjson(
  body: ReadableStream<Uint8Array>,
  sink: RowSink,
  maxBytes: number,
): Promise<void> {
  const reader = guardedStream(body, maxBytes).getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let lineNo = 0;

  const handle = async (line: string) => {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new IngestError(`Line ${lineNo} is not valid JSON.`);
    }
    const obj = objectFromJson(parsed);
    if (!obj) throw new IngestError(`Line ${lineNo} is not a JSON object, so it has no columns.`);
    await sink.push(obj);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    let nl = carry.indexOf("\n");
    while (nl !== -1) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      await handle(line);
      nl = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (carry.trim()) await handle(carry);
}

/** JSON array (or {data:[...]}/{rows:[...]}) — buffered; a JSON array has no
 *  incremental end. */
async function readJsonArray(
  body: ReadableStream<Uint8Array>,
  sink: RowSink,
  maxBytes: number,
): Promise<void> {
  const buf = await readAll(body, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new IngestError(`The file is not valid JSON: ${(e as Error).message}`);
  }
  let arr: unknown[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") {
    // Wrapped payloads are the single most common real-world shape.
    for (const key of ["data", "rows", "records", "items", "results"]) {
      const v = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }
  if (!arr) {
    throw new IngestError(
      "Expected a JSON array of objects, or an object with a data/rows/records array.",
    );
  }
  for (const item of arr) {
    const obj = objectFromJson(item);
    if (!obj) {
      throw new IngestError(
        "Every element must be a JSON object — arrays of values have no columns.",
      );
    }
    await sink.push(obj);
  }
}

/** .xlsx — buffered, because the format is a zip archive. First sheet only. */
async function readXlsx(
  body: ReadableStream<Uint8Array>,
  sink: RowSink,
  maxBytes: number,
): Promise<void> {
  const buf = await readAll(body, maxBytes);
  const { default: readXlsxFile } = await import("read-excel-file/node");
  let parsed: unknown;
  try {
    parsed = await readXlsxFile(Readable.from(buf));
  } catch (e) {
    throw new IngestError(`Could not read the workbook: ${(e as Error).message}`);
  }

  // Given a stream the reader cannot be told which sheet to use, so it returns
  // every sheet as { sheet, data }. We take the first — a workbook is a
  // document, a dataset is one table, and silently concatenating sheets with
  // different columns would produce nonsense.
  const sheets = Array.isArray(parsed) ? parsed : [];
  const first = sheets[0] as { data?: unknown[][] } | unknown[][] | undefined;
  const grid: unknown[][] = Array.isArray(first)
    ? (first as unknown[][])
    : Array.isArray(first?.data)
      ? first.data
      : [];
  if (grid.length === 0) throw new IngestError("The first sheet is empty.");
  const headers = normaliseHeaders(grid[0]);
  for (let i = 1; i < grid.length; i++) {
    const row: Record<string, unknown> = {};
    headers.forEach((h, c) => {
      row[h] = grid[i][c] ?? null;
    });
    await sink.push(row);
  }
}

// ── Orchestration ────────────────────────────────────────────────────────

/**
 * Parse `body` and replace (or create) the dataset called `tableName`.
 *
 * The previous contents are snapshotted as a restorable version before being
 * replaced, and are left untouched if anything goes wrong.
 */
export async function ingestUpload(args: {
  userId: string;
  tableName: string;
  sourceFilename: string;
  format: DatasetFormat;
  body: ReadableStream<Uint8Array>;
}): Promise<IngestResult> {
  const maxBytes = uploadMaxBytes();
  const maxRows = uploadMaxRows();

  // Staging dataset: real rows, throwaway parent. Named so the scheduled sweep
  // can recognise an orphan left behind by a crashed process.
  const stagingName = `${STAGING_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { data: staging, error: stErr } = await supabaseAdmin
    .from("user_data_tables")
    .insert({
      user_id: args.userId,
      name: stagingName,
      source_filename: args.sourceFilename.slice(0, 200),
      columns: [] as unknown as Json,
      is_sample: false,
    })
    .select("id")
    .single();
  if (stErr || !staging) throw new Error(stErr?.message ?? "Could not start the upload");

  const sink = new RowSink(staging.id, maxRows);
  try {
    if (args.format === "csv" || args.format === "tsv") {
      await streamDelimited(args.body, args.format, sink, maxBytes);
    } else if (args.format === "ndjson") {
      await streamNdjson(args.body, sink, maxBytes);
    } else if (args.format === "json") {
      await readJsonArray(args.body, sink, maxBytes);
    } else {
      await readXlsx(args.body, sink, maxBytes);
    }
    await sink.finish();

    if (sink.count === 0 || !sink.columns || sink.columns.length === 0) {
      throw new IngestError(`No rows found in this ${formatLabel(args.format)} file.`);
    }

    const result = await promoteStaging({
      userId: args.userId,
      stagingId: staging.id,
      tableName: args.tableName,
      sourceFilename: args.sourceFilename,
      columns: sink.columns,
    });
    return {
      ...result,
      rowCount: sink.count,
      columns: sink.columns,
      format: args.format,
      skipped: sink.skipped,
    };
  } catch (e) {
    // Deleting the staging parent cascades to its rows. The real dataset was
    // never touched, which is the entire point of staging.
    await supabaseAdmin.from("user_data_tables").delete().eq("id", staging.id);
    throw e instanceof IngestError ? new Error(e.message) : e;
  }
}

/**
 * Replace (or create) a dataset from a stream of already-parsed rows.
 *
 * The SaaS sync path's entry point. It shares the ENTIRE staging lifecycle with
 * file upload — same RowSink, same type inference from the same sample size,
 * same snapshot-then-swap, same mirror refresh — because a dataset's behaviour
 * must not depend on whether the rows arrived from a CSV or from an API. A
 * second implementation would drift on exactly the details that are invisible
 * until they are wrong: which rows count as empty, when columns are decided,
 * and whether a failure leaves the previous data intact.
 *
 * Rows are consumed lazily, so a connector can page through a large source
 * without holding it in memory.
 */
export async function ingestRows(args: {
  userId: string;
  tableName: string;
  /** Shown as the dataset's origin, e.g. "Google Sheets · Q3 Budget". */
  sourceLabel: string;
  rows: AsyncIterable<Record<string, unknown>>;
}): Promise<IngestResult> {
  const maxRows = uploadMaxRows();
  const stagingName = `${STAGING_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { data: staging, error: stErr } = await supabaseAdmin
    .from("user_data_tables")
    .insert({
      user_id: args.userId,
      name: stagingName,
      source_filename: args.sourceLabel.slice(0, 200),
      columns: [] as unknown as Json,
      is_sample: false,
    })
    .select("id")
    .single();
  if (stErr || !staging) throw new Error(stErr?.message ?? "Could not start the sync");

  const sink = new RowSink(staging.id, maxRows);
  try {
    for await (const row of args.rows) await sink.push(row);
    await sink.finish();

    if (sink.count === 0 || !sink.columns || sink.columns.length === 0) {
      throw new IngestError(`No rows returned by ${args.sourceLabel}.`);
    }

    const result = await promoteStaging({
      userId: args.userId,
      stagingId: staging.id,
      tableName: args.tableName,
      sourceFilename: args.sourceLabel,
      columns: sink.columns,
    });
    return {
      ...result,
      rowCount: sink.count,
      columns: sink.columns,
      format: "json",
      skipped: sink.skipped,
    };
  } catch (e) {
    // Same guarantee as an upload: the live dataset is never touched unless
    // the whole sync succeeded.
    await supabaseAdmin.from("user_data_tables").delete().eq("id", staging.id);
    throw e instanceof IngestError ? new Error(e.message) : e;
  }
}

/** Rebuild the columnar mirror; never fails the upload that just succeeded. */
async function refreshMirror(userId: string, tableId: string): Promise<void> {
  await import("@/utils/data/parquet.server")
    .then((m) => m.refreshDatasetMirror({ userId, tableId }))
    .catch(() => null);
}

/**
 * Swap staged rows onto the real dataset.
 *
 * Re-pointing `table_id` moves every row in one statement instead of
 * re-inserting them, so promotion costs the same whether the upload was a
 * hundred rows or half a million.
 */
async function promoteStaging(args: {
  userId: string;
  stagingId: string;
  tableName: string;
  sourceFilename: string;
  columns: ColumnDef[];
}): Promise<{ tableId: string; tableName: string }> {
  const { data: existing } = await supabaseAdmin
    .from("user_data_tables")
    .select("id")
    .eq("user_id", args.userId)
    .eq("name", args.tableName)
    .maybeSingle();

  const now = new Date().toISOString();

  if (!existing) {
    // Nothing to replace — the staging row simply becomes the dataset.
    const { error } = await supabaseAdmin
      .from("user_data_tables")
      .update({
        name: args.tableName,
        source_filename: args.sourceFilename.slice(0, 200),
        columns: args.columns as unknown as Json,
        data_loaded_at: now,
      })
      .eq("id", args.stagingId);
    if (error) throw new Error(error.message);
    await refreshMirror(args.userId, args.stagingId);
    return { tableId: args.stagingId, tableName: args.tableName };
  }

  const { snapshotDatasetQuiet } = await import("@/utils/bi/versions.server");
  await snapshotDatasetQuiet({
    userId: args.userId,
    tableId: existing.id,
    reason: "upload",
    note: `Replaced by ${args.sourceFilename}`.slice(0, 300),
  });

  const { error: delErr } = await supabaseAdmin
    .from("user_data_rows")
    .delete()
    .eq("table_id", existing.id);
  if (delErr) throw new Error(delErr.message);

  const { error: moveErr } = await supabaseAdmin
    .from("user_data_rows")
    .update({ table_id: existing.id })
    .eq("table_id", args.stagingId);
  if (moveErr) throw new Error(moveErr.message);

  const { error: metaErr } = await supabaseAdmin
    .from("user_data_tables")
    .update({
      source_filename: args.sourceFilename.slice(0, 200),
      columns: args.columns as unknown as Json,
      data_loaded_at: now,
    })
    .eq("id", existing.id);
  if (metaErr) throw new Error(metaErr.message);

  await supabaseAdmin.from("user_data_tables").delete().eq("id", args.stagingId);
  await refreshMirror(args.userId, existing.id);
  return { tableId: existing.id, tableName: args.tableName };
}

/**
 * Remove staging datasets orphaned by a crashed or killed upload.
 *
 * Without this a process that dies mid-parse leaves rows nobody can see and
 * nobody will ever delete — invisible storage that only grows.
 */
export async function sweepAbandonedUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id")
    .like("name", `${STAGING_PREFIX}%`)
    .lt("created_at", cutoff)
    .limit(100);
  if (error || !data || data.length === 0) return 0;
  await supabaseAdmin
    .from("user_data_tables")
    .delete()
    .in(
      "id",
      data.map((t) => t.id),
    );
  return data.length;
}

/** Guard against a format we accepted at the door but cannot actually stream. */
export function describeStreaming(format: DatasetFormat): string {
  return isStreamingFormat(format)
    ? "streamed"
    : "buffered (this format cannot be read incrementally)";
}
