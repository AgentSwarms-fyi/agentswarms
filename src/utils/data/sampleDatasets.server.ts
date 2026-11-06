// Seeding the shared sample datasets (R454).
//
// Every tenant reads these, so what goes in them is decided here and nowhere else: the
// CSVs this build ships with, written by the service role. The browser used to do this
// through two database functions that took whatever it sent, which let anyone signed in
// write into tables everyone else reads.
import Papa from "papaparse";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { typedDataset, type ColumnDef } from "@/lib/datasetParse";
import { SAMPLE_DATASETS, type SampleDataset } from "@/lib/sampleDatasetNames";
import { countDatasetRows, insertSampleRows } from "@/utils/data/datasetRows.server";

const CSV_DIR = "/src/assets/sample-data";
const CSV = import.meta.glob<string>("/src/assets/sample-data/*.csv", {
  query: "?raw",
  import: "default",
  eager: true,
});

function parseSample(tableName: string) {
  const text = CSV[`${CSV_DIR}/${tableName}.csv`];
  if (!text) throw new Error(`no CSV ships for sample ${tableName}`);
  const { data } = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // as parseCsv: coerced after, so date strings stay strings
  });
  return typedDataset(data);
}

async function registerSample(sample: SampleDataset, columns: ColumnDef[]): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .insert({
      user_id: null,
      name: sample.tableName,
      source_filename: sample.filename,
      columns: columns as unknown as Json,
      is_sample: true,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`could not register sample ${sample.tableName}: ${error?.message}`);
  }
  return data.id;
}

async function hasRows(sample: SampleDataset, tableId: string): Promise<boolean> {
  const { count, error } = await countDatasetRows(tableId);
  // A failed count is not an empty table. Read as 0, it would insert every sample row
  // again on top of the rows already there.
  if (error || count === null) {
    throw new Error(`could not count rows of ${sample.tableName}: ${error?.message}`);
  }
  return count > 0;
}

async function seedOne(sample: SampleDataset, existingId: string | undefined): Promise<boolean> {
  if (existingId && (await hasRows(sample, existingId))) return false;
  const { rows, columns } = parseSample(sample.tableName);
  const tableId = existingId ?? (await registerSample(sample, columns));
  const { error } = await insertSampleRows(tableId, rows);
  if (error) throw new Error(`could not seed sample ${sample.tableName}: ${error.message}`);
  return true;
}

async function seedAll(refill: boolean): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name")
    .eq("is_sample", true)
    .is("user_id", null);
  // A failed check is not an absent sample: seeding on it would register them all again.
  if (error) throw new Error(`could not check for samples: ${error.message}`);
  const known = new Map((data ?? []).map((t) => [t.name, t.id]));

  let seeded = false;
  for (const sample of SAMPLE_DATASETS) {
    const existingId = known.get(sample.tableName);
    if (existingId && !refill) continue;
    if (await seedOne(sample, existingId)) seeded = true;
  }
  return seeded;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Add any sample that is missing. With `refill`, also fill one that exists but has no
 * rows. Returns whether anything was seeded. A page load asks for this every time, so
 * callers arriving together share one run.
 */
export function seedSampleDatasets({ refill }: { refill: boolean }): Promise<boolean> {
  inFlight ??= seedAll(refill).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
